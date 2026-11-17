import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import {
  and,
  eq,
  inArray,
  organizationMembers,
  organizations,
  users,
  withUser,
  workspaceMembers,
  workspaces,
} from "@orbyt/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AUTH, toHeaders, type Auth } from "./auth";
import { DbService } from "./db.service";
import { EntitlementsService } from "./enterprise/entitlements.service";
import { EventsService } from "./events.service";
import { idParam, parse } from "./http";
import { AdminGuard, Ctx, type Scope, WorkspaceGuard } from "./scope";

/** Organizations (agencies) the signed-in user belongs to, and creating sub-account workspaces in them. */
@Controller("api/orgs")
export class OrgsController {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EntitlementsService) private readonly ent: EntitlementsService,
  ) {}

  private async userId(req: FastifyRequest) {
    const session = await this.auth.api.getSession({ headers: toHeaders(req) });
    if (!session) throw new UnauthorizedException();
    return session.user.id;
  }

  @Get()
  async mine(@Req() req: FastifyRequest) {
    const me = await this.userId(req);
    return withUser(this.dbs.db, me, (tx) =>
      tx
        .select({
          id: organizations.id,
          name: organizations.name,
          role: organizationMembers.role,
        })
        .from(organizations)
        .innerJoin(
          organizationMembers,
          eq(organizationMembers.organizationId, organizations.id),
        )
        .where(eq(organizationMembers.userId, me)),
    );
  }

  /** Agency mode: an organization owner/admin creates another workspace (a client's sub-account). */
  @Post(":orgId/workspaces")
  async createWorkspace(
    @Req() req: FastifyRequest,
    @Param("orgId") rawOrg: string,
    @Body() body: unknown,
  ) {
    const me = await this.userId(req);
    const orgId = idParam(rawOrg);
    const { name } = parse(
      z.object({ name: z.string().trim().min(1).max(100) }),
      body,
    );
    const [membership] = await withUser(this.dbs.db, me, (tx) =>
      tx
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, orgId),
            eq(organizationMembers.userId, me),
          ),
        ),
    );
    if (!membership) throw new NotFoundException(); // not revealing other tenants' organizations
    if (membership.role === "member")
      throw new ForbiddenException(
        "Only organization owners and admins can create workspaces",
      );
    await this.ent.assertCanAddWorkspace(orgId);
    // System operation (RLS gives orbyt_app read-only access to these tables).
    return this.dbs.db.transaction(async (tx) => {
      const [ws] = await tx
        .insert(workspaces)
        .values({ organizationId: orgId, name })
        .returning();
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: ws!.id, userId: me, role: "admin" });
      return ws!;
    });
  }
}

/** Who can use this workspace. Adding people needs an existing Orbyt account (there is no invite email yet). */
@Controller("api/w/:workspaceId/members")
@UseGuards(WorkspaceGuard)
export class MembersController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  @Get()
  async list(@Ctx() scope: Scope) {
    // Names and emails live in the auth tables, which the restricted app role cannot read: this is a
    // system query, made safe by the guard (the caller is already a member of this workspace).
    const direct = await this.dbs.db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, scope.workspaceId));
    const [ws] = await this.dbs.db
      .select({ org: workspaces.organizationId })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId));
    const agency = ws
      ? await this.dbs.db
          .select({ userId: users.id, name: users.name, email: users.email })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(
            and(
              eq(organizationMembers.organizationId, ws.org),
              inArray(organizationMembers.role, ["owner", "admin"]),
            ),
          )
      : [];
    const seen = new Set(direct.map((d) => d.userId));
    return [
      ...direct.map((d) => ({ ...d, via: "workspace" as const })),
      // Agency owners/admins reach every workspace of the organization without being listed in it.
      ...agency
        .filter((a) => !seen.has(a.userId))
        .map((a) => ({
          ...a,
          role: "admin" as const,
          via: "organization" as const,
        })),
    ];
  }

  @Post()
  @UseGuards(AdminGuard)
  async add(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(
      z.object({
        email: z.string().trim().toLowerCase().pipe(z.email()),
        role: z.enum(["admin", "member"]).default("member"),
      }),
      body,
    );
    const [user] = await this.dbs.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.email, d.email));
    if (!user)
      throw new NotFoundException(
        "No Orbyt account with that email yet. Ask them to sign up first.",
      );
    await this.dbs.db
      .insert(workspaceMembers)
      .values({ workspaceId: scope.workspaceId, userId: user.id, role: d.role })
      .onConflictDoUpdate({
        target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        set: { role: d.role },
      });
    await this.events.emit(scope, {
      type: "member.added",
      data: { userId: user.id, role: d.role },
    });
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      role: d.role,
      via: "workspace" as const,
    };
  }

  @Delete(":userId")
  @HttpCode(204)
  @UseGuards(AdminGuard)
  async remove(@Ctx() scope: Scope, @Param("userId") rawUser: string) {
    const userId = idParam(rawUser);
    await this.dbs.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, scope.workspaceId));
      const target = rows.find((r) => r.userId === userId);
      if (!target)
        throw new NotFoundException("Not a member of this workspace");
      if (
        target.role === "admin" &&
        rows.filter((r) => r.role === "admin").length === 1
      )
        throw new BadRequestException("A workspace needs at least one admin");
      await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, scope.workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );
    });
  }
}
