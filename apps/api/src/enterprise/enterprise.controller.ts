import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { and, auditLogs, desc, eq, lt, organizations } from "@orbyt/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { DbService } from "../db.service";
import { idParam, parse } from "../http";
import { AdminGuard, Ctx, type Scope, WorkspaceGuard } from "../scope";
import { EntitlementsService } from "./entitlements.service";
import { OrgAccessService } from "./org-access.service";

/** The audit log (entitlement: audit_logs). Entries are written by AuditInterceptor / AuditService. */
@Controller("api/w/:workspaceId/audit-logs")
@UseGuards(WorkspaceGuard, AdminGuard)
export class AuditLogsController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EntitlementsService) private readonly ent: EntitlementsService,
  ) {}

  @Get()
  async list(@Ctx() scope: Scope, @Query() rawQuery: unknown) {
    await this.ent.assertFeature(scope.workspaceId, "audit_logs");
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.uuid().optional(),
        action: z.string().max(100).optional(),
      }),
      rawQuery,
    );
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(auditLogs)
        .where(
          and(
            q.action ? eq(auditLogs.action, q.action) : undefined,
            q.cursor ? lt(auditLogs.id, q.cursor) : undefined,
          ),
        )
        .orderBy(desc(auditLogs.id))
        .limit(q.limit + 1);
      const items = rows.slice(0, q.limit);
      return {
        items,
        nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null,
      };
    });
  }
}

/** What this workspace's organization may use (the web app hides what is not included). */
@Controller("api/w/:workspaceId/entitlements")
@UseGuards(WorkspaceGuard)
export class EntitlementsController {
  constructor(
    @Inject(EntitlementsService) private readonly ent: EntitlementsService,
  ) {}

  @Get()
  async get(@Ctx() scope: Scope) {
    const org = await this.ent.orgOf(scope.workspaceId);
    const e = org ? await this.ent.forOrg(org) : null;
    return {
      cloud: this.ent.cloud,
      organizationId: org,
      plan: e?.plan ?? "community",
      features: [...(e?.features ?? [])],
      maxWorkspaces: e?.maxWorkspaces ?? null,
      maxMailboxes: e?.maxMailboxes ?? null,
    };
  }
}

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/,
    "Use a host name like app.youragency.com",
  );
const brandingInput = z.object({
  brandName: z.string().trim().min(1).max(80).nullish(),
  brandLogoUrl: z.url().max(2000).nullish(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a color like #1a73e8")
    .nullish(),
  customDomain: hostname.nullish(),
});

/** White-label (entitlement: white_label): the agency's own name, logo, color and domain. */
@Controller("api")
export class BrandingController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EntitlementsService) private readonly ent: EntitlementsService,
    @Inject(OrgAccessService) private readonly access: OrgAccessService,
  ) {}

  /** Public: the sign-in page asks for the branding of the host it is served from. */
  @Get("branding")
  async forHost(
    @Query("host") queryHost: string | undefined,
    @Headers("x-forwarded-host") forwarded: string | undefined,
    @Headers("host") host: string | undefined,
  ) {
    const h = (queryHost ?? forwarded ?? host ?? "")
      .split(",")[0]!
      .trim()
      .toLowerCase()
      .replace(/:\d+$/, "");
    const none = { brandName: null, brandLogoUrl: null, brandColor: null };
    if (!h) return none;
    const [org] = await this.dbs.db
      .select()
      .from(organizations)
      .where(eq(organizations.customDomain, h));
    if (!org || !(await this.ent.forOrg(org.id)).features.has("white_label"))
      return none;
    return {
      brandName: org.brandName,
      brandLogoUrl: org.brandLogoUrl,
      brandColor: org.brandColor,
    };
  }

  @Get("orgs/:orgId/branding")
  async get(@Req() req: FastifyRequest, @Param("orgId") rawOrg: string) {
    const orgId = idParam(rawOrg);
    await this.access.requireAdmin(req, orgId);
    const [org] = await this.dbs.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId));
    return {
      brandName: org?.brandName ?? null,
      brandLogoUrl: org?.brandLogoUrl ?? null,
      brandColor: org?.brandColor ?? null,
      customDomain: org?.customDomain ?? null,
    };
  }

  @Put("orgs/:orgId/branding")
  async set(
    @Req() req: FastifyRequest,
    @Param("orgId") rawOrg: string,
    @Body() body: unknown,
  ) {
    const orgId = idParam(rawOrg);
    await this.access.requireAdmin(req, orgId);
    await this.ent.assertOrgFeature(orgId, "white_label");
    const d = parse(brandingInput, body);
    const [row] = await this.dbs.db
      .update(organizations)
      .set({
        brandName: d.brandName ?? null,
        brandLogoUrl: d.brandLogoUrl ?? null,
        brandColor: d.brandColor ?? null,
        customDomain: d.customDomain ?? null,
      })
      .where(eq(organizations.id, orgId))
      .returning();
    return {
      brandName: row!.brandName,
      brandLogoUrl: row!.brandLogoUrl,
      brandColor: row!.brandColor,
      customDomain: row!.customDomain,
    };
  }
}
