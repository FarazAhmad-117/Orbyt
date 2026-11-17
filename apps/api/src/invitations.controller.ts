import {
  BadRequestException,
  Body,
  ConflictException,
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
  gt,
  invitations,
  isNull,
  users,
  workspaceMembers,
  workspaces,
} from "@orbyt/db";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AUTH, toHeaders, type Auth } from "./auth";
import { DbService } from "./db.service";
import { AuditService } from "./enterprise/audit.service";
import { idParam, parse } from "./http";
import { NotifyService } from "./notify.service";
import { AdminGuard, Ctx, type Scope, WorkspaceGuard } from "./scope";

const INVITE_DAYS = 7;
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const baseUrl = () =>
  (
    process.env.PUBLIC_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");

/** Invite people (by email) to a workspace. Admins only; the link is also emailed when ORBYT_SMTP_URL is set. */
@Controller("api/w/:workspaceId/invitations")
@UseGuards(WorkspaceGuard, AdminGuard)
export class InvitationsController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(NotifyService) private readonly notify: NotifyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, scope.workspaceId),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      );
  }

  @Post()
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(
      z.object({
        email: z.string().trim().toLowerCase().pipe(z.email()),
        role: z.enum(["admin", "member"]).default("member"),
      }),
      body,
    );
    const [already] = await this.dbs.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
      .where(
        and(
          eq(users.email, d.email),
          eq(workspaceMembers.workspaceId, scope.workspaceId),
        ),
      );
    if (already)
      throw new ConflictException("That person is already in this workspace");

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    const row = await this.dbs.db.transaction(async (tx) => {
      // Inviting again replaces the earlier pending invitation (its link stops working).
      await tx
        .delete(invitations)
        .where(
          and(
            eq(invitations.workspaceId, scope.workspaceId),
            eq(invitations.email, d.email),
            isNull(invitations.acceptedAt),
          ),
        );
      const [inv] = await tx
        .insert(invitations)
        .values({
          workspaceId: scope.workspaceId,
          email: d.email,
          role: d.role,
          tokenHash: hash(token),
          invitedBy: scope.userId,
          expiresAt,
        })
        .returning();
      return inv!;
    });
    const [ws] = await this.dbs.db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId));
    const acceptUrl = `${baseUrl()}/accept-invite?token=${token}`;
    const emailed = await this.notify.send(
      d.email,
      `You are invited to ${ws?.name ?? "an Orbyt workspace"}`,
      `You have been invited to join "${ws?.name ?? "a workspace"}" on Orbyt as ${d.role}.\n\nAccept the invitation (valid for ${INVITE_DAYS} days):\n${acceptUrl}\n`,
    );
    await this.audit.record(
      scope,
      "invitation.created",
      { type: "invitation", id: row.id },
      { email: d.email, role: d.role },
    );
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt,
      acceptUrl,
      emailed,
    };
  }

  @Delete(":id")
  @HttpCode(204)
  async revoke(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.db
      .delete(invitations)
      .where(
        and(
          eq(invitations.id, id),
          eq(invitations.workspaceId, scope.workspaceId),
        ),
      )
      .returning({ id: invitations.id });
    if (rows.length === 0) throw new NotFoundException("Invitation not found");
    await this.audit.record(scope, "invitation.revoked", {
      type: "invitation",
      id,
    });
  }
}

/** Accepting an invitation: the token proves the link was delivered, the signed-in account must match the invited email. */
@Controller("api/invitations")
export class InviteAcceptController {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DbService) private readonly dbs: DbService,
  ) {}

  private async pending(token: string) {
    if (!/^[\w-]{43}$/.test(token)) throw new NotFoundException();
    const [inv] = await this.dbs.db
      .select({
        id: invitations.id,
        workspaceId: invitations.workspaceId,
        email: invitations.email,
        role: invitations.role,
        workspaceName: workspaces.name,
      })
      .from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
      .where(
        and(
          eq(invitations.tokenHash, hash(token)),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      );
    if (!inv) throw new NotFoundException("This invitation is no longer valid");
    return inv;
  }

  /** Lets the sign-up/sign-in page show who is being invited to what. */
  @Get(":token")
  async info(@Param("token") token: string) {
    const { email, role, workspaceName } = await this.pending(token);
    return { email, role, workspaceName };
  }

  @Post("accept")
  @HttpCode(200)
  async accept(@Req() req: FastifyRequest, @Body() body: unknown) {
    const { token } = parse(z.object({ token: z.string().max(100) }), body);
    const session = await this.auth.api.getSession({ headers: toHeaders(req) });
    if (!session) throw new UnauthorizedException();
    const inv = await this.pending(token);
    if (session.user.email.toLowerCase() !== inv.email)
      throw new ForbiddenException(
        "This invitation was sent to a different email address",
      );
    await this.dbs.db.transaction(async (tx) => {
      // The claim: only one request can flip acceptedAt from null.
      const claimed = await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt)))
        .returning({ id: invitations.id });
      if (claimed.length === 0)
        throw new BadRequestException("This invitation was already used");
      await tx
        .insert(workspaceMembers)
        .values({
          workspaceId: inv.workspaceId,
          userId: session.user.id,
          role: inv.role,
        })
        .onConflictDoNothing(); // never downgrade someone who is already an admin
    });
    return { workspaceId: inv.workspaceId };
  }
}
