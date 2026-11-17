import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  and,
  apiKeys,
  createDb,
  eq,
  inArray,
  migrateDb,
  organizationMembers,
  withUser,
  withWorkspace,
  workspaceMembers,
  workspaces,
  type Tx,
} from "@orbyt/db";
import { hashApiKey } from "./apikeys";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly handle = createDb(requireEnv("DATABASE_URL"));

  get db() {
    return this.handle.db;
  }

  /** Run `fn` with RLS limited to the caller's workspace. Use for ALL workspace data. */
  inWorkspace<T>(scope: { workspaceId: string }, fn: (tx: Tx) => Promise<T>) {
    return withWorkspace(this.db, scope.workspaceId, fn);
  }

  /**
   * The user's role in a workspace: "admin" for workspace admins and for organization owners/admins
   * (the agency), "member" for other members, null for outsiders. Decided under RLS, like everything else.
   */
  async roleIn(
    userId: string,
    workspaceId: string,
  ): Promise<"admin" | "member" | null> {
    return withUser(this.db, userId, async (tx) => {
      const [m] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );
      if (m?.role === "admin") return "admin";
      const [o] = await tx
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .innerJoin(
          workspaces,
          eq(workspaces.organizationId, organizationMembers.organizationId),
        )
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(organizationMembers.userId, userId),
            inArray(organizationMembers.role, ["owner", "admin"]),
          ),
        );
      if (o) return "admin";
      return m ? "member" : null;
    });
  }

  /** Can this user open the workspace? Decided by the same RLS policy the API uses everywhere. */
  async canAccessWorkspace(userId: string, workspaceId: string) {
    const rows = await withUser(this.db, userId, (tx) =>
      tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId)),
    );
    return rows.length > 0;
  }

  /**
   * System lookup (bare connection): which workspace does this API key belong to? The key is
   * matched by its sha256 hash; api_keys is RLS-enabled but not forced for exactly this reason.
   */
  async verifyApiKey(raw: string) {
    const [row] = await this.db
      .select({ id: apiKeys.id, workspaceId: apiKeys.workspaceId })
      .from(apiKeys)
      .where(eq(apiKeys.hash, hashApiKey(raw)));
    if (!row) return null;
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id))
      .catch(() => undefined);
    return row;
  }

  // Applies pending migrations on every boot (advisory-locked, so replicas are safe). This is
  // what lets `docker run` work with no manual migration step.
  onModuleInit() {
    return migrateDb(this.handle.pool);
  }

  onModuleDestroy() {
    return this.handle.pool.end();
  }
}
