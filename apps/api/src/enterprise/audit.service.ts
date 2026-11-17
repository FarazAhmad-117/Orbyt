import { Inject, Injectable } from "@nestjs/common";
import { auditLogs } from "@orbyt/db";
import { DbService } from "../db.service";
import type { Scope } from "../scope";

/**
 * Who did what. Recording is always on (it is cheap and cannot be added retroactively); reading
 * the log is an entitlement (see EntitlementsService). Recording never fails the request it
 * describes: a broken audit insert is logged to stderr instead.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  async record(
    scope: Scope,
    action: string,
    target?: { type: string; id?: string },
    data: Record<string, unknown> = {},
  ) {
    try {
      await this.dbs.inWorkspace(scope, (tx) =>
        tx.insert(auditLogs).values({
          workspaceId: scope.workspaceId,
          actorId: scope.userId,
          actorVia: scope.via,
          action,
          targetType: target?.type ?? null,
          targetId: target?.id ?? null,
          data,
        }),
      );
    } catch (err) {
      console.error(`[audit] ${action}:`, err);
    }
  }
}
