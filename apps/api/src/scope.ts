import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { eq, withUser, workspaces } from "@orbyt/db";
import type { FastifyRequest } from "fastify";
import { AUTH, toHeaders, type Auth } from "./auth";
import { DbService } from "./db.service";

/** Who is calling and which workspace the call is scoped to. */
export interface Scope {
  workspaceId: string;
  userId: string | null; // null for API keys and background jobs
  via: "session" | "api_key" | "system";
}

/** Scope for background work (scheduler, inbox sync) acting inside one workspace. */
export const systemScope = (workspaceId: string): Scope => ({
  workspaceId,
  userId: null,
  via: "system",
});
export type ScopedRequest = FastifyRequest & { scope?: Scope };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authenticates the request (session cookie OR `Authorization: Bearer <api key>`) and checks it
 * may use `:workspaceId`. Sessions are authorised by RLS itself: if the workspace row is not
 * visible to the user, they are not a member (404, so ids of other tenants are not revealed).
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DbService) private readonly dbs: DbService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ScopedRequest>();
    const workspaceId = (req.params as { workspaceId?: string }).workspaceId;
    if (!workspaceId || !UUID_RE.test(workspaceId))
      throw new NotFoundException();

    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (bearer) {
      const key = await this.dbs.verifyApiKey(bearer);
      if (!key || key.workspaceId !== workspaceId)
        throw new UnauthorizedException();
      req.scope = { workspaceId, userId: null, via: "api_key" };
      return true;
    }

    const session = await this.auth.api.getSession({ headers: toHeaders(req) });
    if (!session) throw new UnauthorizedException();
    const rows = await withUser(this.dbs.db, session.user.id, (tx) =>
      tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId)),
    );
    if (rows.length === 0) throw new NotFoundException();
    req.scope = { workspaceId, userId: session.user.id, via: "session" };
    return true;
  }
}

/** For endpoints an API key must not call (managing API keys themselves). Use after WorkspaceGuard. */
@Injectable()
export class SessionOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ScopedRequest>();
    if (req.scope?.via !== "session") throw new ForbiddenException();
    return true;
  }
}

/**
 * Workspace admins only (and organization owners/admins). For credentials, API keys, webhooks, AI
 * providers and team management. Requires a signed-in user: API keys never pass. Use after WorkspaceGuard.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ScopedRequest>();
    if (req.scope?.via !== "session" || !req.scope.userId)
      throw new ForbiddenException();
    if (
      (await this.dbs.roleIn(req.scope.userId, req.scope.workspaceId)) !==
      "admin"
    )
      throw new ForbiddenException("Only workspace admins can do this");
    return true;
  }
}

export const Ctx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Scope =>
    context.switchToHttp().getRequest<ScopedRequest>().scope!,
);
