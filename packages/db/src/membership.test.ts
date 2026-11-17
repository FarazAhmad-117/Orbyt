import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  migrateDb,
  organizationMembers,
  organizations,
  provisionTenant,
  users,
  uuidv7,
  withUser,
  workspaceMembers,
  workspaces,
} from "./index.js";

const url =
  process.env.DATABASE_URL ?? "postgres://orbyt:orbyt@127.0.0.1:5432/orbyt";
const { db, pool } = createDb(url, { max: 1 });

const errText = (e: unknown) =>
  String(
    (e as { cause?: { message?: string } }).cause?.message ??
      (e as Error).message,
  );

// Layout:
//   orgA (u1 owner)  -> wA1 (u2 member), wA2
//   orgA also has u3 as plain org "member" (no workspace access)
//   orgB (u3 owner)  -> wB1
let u1: string, u2: string, u3: string;
let orgA: string, orgB: string;
let wA1: string, wA2: string, wB1: string;

beforeAll(async () => {
  await migrateDb(pool);
  const mk = async (name: string) => {
    const [u] = await db
      .insert(users)
      .values({ name, email: `${uuidv7()}@example.test` })
      .returning();
    return u!.id;
  };
  [u1, u2, u3] = [await mk("u1"), await mk("u2"), await mk("u3")];
  const a = await provisionTenant(db, {
    userId: u1,
    organizationName: "orgA",
    workspaceName: "wA1",
  });
  const b = await provisionTenant(db, {
    userId: u3,
    organizationName: "orgB",
    workspaceName: "wB1",
  });
  orgA = a.organizationId;
  wA1 = a.workspaceId;
  orgB = b.organizationId;
  wB1 = b.workspaceId;
  const [w2] = await db
    .insert(workspaces)
    .values({ organizationId: orgA, name: "wA2" })
    .returning();
  wA2 = w2!.id;
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: wA1, userId: u2, role: "member" });
  await db
    .insert(organizationMembers)
    .values({ organizationId: orgA, userId: u3, role: "member" });
});

afterAll(async () => {
  await db.delete(organizations).where(inArray(organizations.id, [orgA, orgB]));
  await db.delete(users).where(inArray(users.id, [u1, u2, u3]));
  await pool.end();
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("membership-based access (RLS)", () => {
  it("org owner sees their org and every workspace in it, nothing else", async () => {
    const orgs = await withUser(db, u1, (tx) =>
      tx.select().from(organizations),
    );
    const wss = await withUser(db, u1, (tx) => tx.select().from(workspaces));
    expect(ids(orgs)).toEqual([orgA]);
    expect(ids(wss)).toEqual([wA1, wA2].sort());
  });

  it("a workspace-only member sees just that workspace and no organization", async () => {
    const orgs = await withUser(db, u2, (tx) =>
      tx.select().from(organizations),
    );
    const wss = await withUser(db, u2, (tx) => tx.select().from(workspaces));
    expect(orgs).toEqual([]);
    expect(ids(wss)).toEqual([wA1]);
  });

  it("a plain org member sees the org but not its workspaces (only their own org's)", async () => {
    const orgs = await withUser(db, u3, (tx) =>
      tx.select().from(organizations),
    );
    const wss = await withUser(db, u3, (tx) => tx.select().from(workspaces));
    expect(ids(orgs)).toEqual([orgA, orgB].sort());
    expect(ids(wss)).toEqual([wB1]);
  });

  it("members lists are limited to workspaces the user can open", async () => {
    const rows = await withUser(db, u2, (tx) =>
      tx.select().from(workspaceMembers),
    );
    expect(new Set(rows.map((r) => r.workspaceId))).toEqual(new Set([wA1]));
    const none = await withUser(db, u3, (tx) =>
      tx
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, wA1)),
    );
    expect(none).toEqual([]);
  });

  it("is read-only for the app role", async () => {
    const err = await withUser(db, u1, (tx) =>
      tx
        .insert(workspaceMembers)
        .values({ workspaceId: wA2, userId: u2, role: "member" }),
    ).catch((e: unknown) => e);
    expect(errText(err)).toMatch(/permission denied/);
  });

  it("cannot read the auth tables", async () => {
    const err = await withUser(db, u1, (tx) => tx.select().from(users)).catch(
      (e: unknown) => e,
    );
    expect(errText(err)).toMatch(/permission denied/);
  });

  it("sees nothing without a user context, and rejects a malformed user id", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role orbyt_app`);
      return tx.select().from(workspaces);
    });
    expect(rows).toEqual([]);
    await expect(withUser(db, "nope", async () => 1)).rejects.toThrow(
      "invalid user id",
    );
  });
});
