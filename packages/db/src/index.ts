import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };

export type Db = NodePgDatabase<typeof schema>;
// The transaction handle passed to withWorkspace callbacks (same query API as Db).
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(connectionString: string, options?: { max?: number }) {
  const pool = new pg.Pool({ connectionString, max: options?.max });
  return { db: drizzle(pool, { schema }), pool };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` as the RLS-restricted `orbyt_app` role with `app.workspace_id` set for this
 * transaction only (SET LOCAL semantics), so it cannot leak across pooled connections.
 *
 * ALL tenant-data access must go through this. Queries on the bare `db` run as the connection
 * user (the table owner), which bypasses RLS. shortcut: in production connect as `orbyt_app`
 * directly so a stray bare query fails closed; revisit when the API is built.
 */
export async function withWorkspace<T>(
  db: Db,
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(workspaceId))
    throw new Error("withWorkspace: invalid workspace id");
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role orbyt_app`);
    await tx.execute(
      sql`select set_config('app.workspace_id', ${workspaceId}, true)`,
    );
    return fn(tx);
  });
}
