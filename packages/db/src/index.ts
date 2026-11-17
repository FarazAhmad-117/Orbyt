import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as crmSchema from "./schema-crm.js";
import * as aiSchema from "./schema-ai.js";
import * as channelSchema from "./schema-channels.js";
import * as emailSchema from "./schema-email.js";
import * as platformSchema from "./schema-platform.js";
import * as workflowSchema from "./schema-workflows.js";
import * as baseSchema from "./schema.js";

export * from "./schema.js";
export * from "./schema-ai.js";
export * from "./schema-channels.js";
export * from "./schema-crm.js";
export * from "./schema-email.js";
export * from "./schema-platform.js";
export * from "./schema-workflows.js";
// Add each new schema-*.ts file here and in the export list above.
const schema = {
  ...baseSchema,
  ...crmSchema,
  ...emailSchema,
  ...workflowSchema,
  ...aiSchema,
  ...channelSchema,
  ...platformSchema,
};
export { schema };
export { uuidv7 } from "uuidv7";
// Re-exported so apps use THIS drizzle-orm copy (a second copy breaks the types).
export {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

export type Db = NodePgDatabase<typeof schema>;
// The transaction handle passed to withWorkspace/withUser callbacks (same query API as Db).
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(connectionString: string, options?: { max?: number }) {
  const pool = new pg.Pool({ connectionString, max: options?.max });
  return { db: drizzle(pool, { schema }), pool };
}

// Serialises concurrent migrators (several API replicas booting, parallel test runs).
const MIGRATION_LOCK_ID = 727274001;

/** Apply pending migrations under an advisory lock. Safe to call on every boot. */
export async function migrateDb(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  } finally {
    // If unlock fails, release(err) destroys the connection, which drops the lock too.
    await client
      .query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
      .then(
        () => client.release(),
        (e: Error) => client.release(e),
      );
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Runs `fn` as the RLS-restricted `orbyt_app` role with `setting` set for this transaction only
// (SET LOCAL semantics), so it cannot leak across pooled connections.
async function scoped<T>(
  db: Db,
  setting: string,
  label: string,
  value: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(value)) throw new Error(`invalid ${label}`);
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role orbyt_app`);
    await tx.execute(sql`select set_config(${setting}, ${value}, true)`);
    return fn(tx);
  });
}

/**
 * Tenant-data access: all rows visible are limited to `workspaceId` (RLS on `app.workspace_id`).
 * The CALLER must have checked the user may use this workspace (see apps/api).
 *
 * ALL tenant-data access must go through this or withUser. Queries on the bare `db` run as the
 * connection user (the table owner), which bypasses RLS. shortcut: in production connect as
 * `orbyt_app` directly so a stray bare query fails closed; revisit when the API is hardened.
 */
export function withWorkspace<T>(
  db: Db,
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return scoped(db, "app.workspace_id", "workspace id", workspaceId, fn);
}

/** Membership-scoped reads: organizations/workspaces/members visible to `userId` (RLS on `app.user_id`). */
export function withUser<T>(
  db: Db,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return scoped(db, "app.user_id", "user id", userId, fn);
}

/**
 * System operation (runs on the bare connection, bypassing RLS): create an organization with its
 * first workspace and make `userId` the owner/admin. Used at sign-up.
 */
export function provisionTenant(
  db: Db,
  input: { userId: string; organizationName: string; workspaceName: string },
) {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(schema.organizations)
      .values({ name: input.organizationName })
      .returning();
    const [ws] = await tx
      .insert(schema.workspaces)
      .values({ organizationId: org!.id, name: input.workspaceName })
      .returning();
    await tx.insert(schema.organizationMembers).values({
      organizationId: org!.id,
      userId: input.userId,
      role: "owner",
    });
    await tx.insert(schema.workspaceMembers).values({
      workspaceId: ws!.id,
      userId: input.userId,
      role: "admin",
    });
    return { organizationId: org!.id, workspaceId: ws!.id };
  });
}
