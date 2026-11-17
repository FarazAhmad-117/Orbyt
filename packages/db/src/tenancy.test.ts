import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contacts,
  createDb,
  organizations,
  withWorkspace,
  workspaces,
} from "./index.js";

const url =
  process.env.DATABASE_URL ?? "postgres://orbyt:orbyt@127.0.0.1:5432/orbyt";
// max: 1 forces every call onto the SAME pooled connection: the scenario where a leaked
// session setting would expose one tenant's rows to the next request.
const { db, pool } = createDb(url, { max: 1 });

let orgId: string;
let wsA: string;
let wsB: string;
let contactA: string;

beforeAll(async () => {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  const [org] = await db
    .insert(organizations)
    .values({ name: "test-org" })
    .returning();
  orgId = org!.id;
  const [a, b] = await db
    .insert(workspaces)
    .values([
      { organizationId: orgId, name: "A" },
      { organizationId: orgId, name: "B" },
    ])
    .returning();
  wsA = a!.id;
  wsB = b!.id;
  const [c] = await withWorkspace(db, wsA, (tx) =>
    tx
      .insert(contacts)
      .values({ workspaceId: wsA, email: "a@example.com" })
      .returning(),
  );
  contactA = c!.id;
});

afterAll(async () => {
  // Contacts first via their own workspace: don't rely on bare-connection privileges.
  for (const ws of [wsA, wsB])
    await withWorkspace(db, ws, (tx) => tx.delete(contacts));
  await db.delete(organizations).where(eq(organizations.id, orgId)); // cascades to workspaces
  await pool.end();
});

describe("workspace isolation (RLS)", () => {
  it("a workspace sees its own rows", async () => {
    const rows = await withWorkspace(db, wsA, (tx) =>
      tx.select().from(contacts),
    );
    expect(rows.map((r) => r.email)).toEqual(["a@example.com"]);
  });

  it("another workspace sees none of them", async () => {
    const rows = await withWorkspace(db, wsB, (tx) =>
      tx.select().from(contacts),
    );
    expect(rows).toEqual([]);
  });

  it("cannot update or delete another workspace's rows", async () => {
    const updated = await withWorkspace(db, wsB, (tx) =>
      tx
        .update(contacts)
        .set({ name: "hacked" })
        .where(eq(contacts.id, contactA))
        .returning(),
    );
    const deleted = await withWorkspace(db, wsB, (tx) =>
      tx.delete(contacts).where(eq(contacts.id, contactA)).returning(),
    );
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    const [still] = await withWorkspace(db, wsA, (tx) =>
      tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, contactA), sql`${contacts.name} is null`)),
    );
    expect(still).toBeDefined();
  });

  it("cannot insert a row into another workspace", async () => {
    const err = await withWorkspace(db, wsA, (tx) =>
      tx
        .insert(contacts)
        .values({ workspaceId: wsB, email: "evil@example.com" }),
    ).catch(
      (e: unknown) => e as { message: string; cause?: { message: string } },
    );
    expect(String((err as { cause?: Error }).cause?.message ?? err)).toMatch(
      /row-level security/,
    );
  });

  it("returns nothing when no workspace is set, and the setting does not leak after a transaction", async () => {
    // pool max is 1, so this runs on the connection withWorkspace just used.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role orbyt_app`);
      return tx.select().from(contacts);
    });
    expect(rows).toEqual([]);
  });

  it("rejects a malformed workspace id before touching the database", async () => {
    await expect(
      withWorkspace(db, "x'; drop table contacts; --", async () => 1),
    ).rejects.toThrow("invalid workspace id");
  });

  it("guard: every table with a workspace_id column has RLS enabled and forced", async () => {
    const { rows } = await db.execute(sql`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped
      where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace`);
    const tables = rows as {
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }[];
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables)
      expect([t.relname, t.relrowsecurity && t.relforcerowsecurity]).toEqual([
        t.relname,
        true,
      ]);
  });
});
