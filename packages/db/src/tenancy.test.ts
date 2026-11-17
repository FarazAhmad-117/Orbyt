import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contacts,
  createDb,
  migrateDb,
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
  await migrateDb(pool);
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

  it("guard: every public table has RLS unless explicitly classified, and data tables FORCE it", async () => {
    // Fail-closed: a NEW table is not in either set, so it must enable + force RLS (or be
    // classified here on purpose, in review).
    const authOnly = new Set([
      "users",
      "sessions",
      "accounts",
      "verifications",
    ]); // never granted to orbyt_app
    const enableOnly = new Set([
      "organizations",
      "workspaces",
      "organization_members",
      "workspace_members",
      "api_keys", // looked up by key hash before a workspace is known
      "channel_accounts", // looked up by inbound-webhook token before a workspace is known
      "invitations", // looked up by invite-token hash before the invitee is a member
      "subscriptions", // organization-level billing state, read via org membership
    ]); // see 0003_membership_rls.sql for why these are not FORCEd
    const { rows } = await db.execute(sql`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace`);
    const tables = rows as {
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }[];
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      if (authOnly.has(t.relname)) continue;
      const ok =
        t.relrowsecurity &&
        (enableOnly.has(t.relname) || t.relforcerowsecurity);
      expect([t.relname, ok]).toEqual([t.relname, true]);
    }
  });

  it("guard: orbyt_app has no privileges on the auth tables", async () => {
    for (const table of ["users", "sessions", "accounts", "verifications"]) {
      const { rows } = await db.execute(
        sql`select has_table_privilege('orbyt_app', ${table}, 'SELECT') as ok`,
      );
      expect([table, (rows[0] as { ok: boolean }).ok]).toEqual([table, false]);
    }
  });
});
