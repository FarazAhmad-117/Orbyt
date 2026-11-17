import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq, organizationMembers, withUser } from "@orbyt/db";
import type { FastifyRequest } from "fastify";
import { AUTH, toHeaders, type Auth } from "../auth";
import { DbService } from "../db.service";

/** "Signed-in owner/admin of this organization" for org-level endpoints (branding, billing). */
@Injectable()
export class OrgAccessService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DbService) private readonly dbs: DbService,
  ) {}

  async user(req: FastifyRequest): Promise<string> {
    const session = await this.auth.api.getSession({ headers: toHeaders(req) });
    if (!session) throw new UnauthorizedException();
    return session.user.id;
  }

  async requireAdmin(req: FastifyRequest, orgId: string): Promise<string> {
    const me = await this.user(req);
    const [m] = await withUser(this.dbs.db, me, (tx) =>
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
    if (!m) throw new NotFoundException(); // do not reveal other tenants' organizations
    if (m.role === "member")
      throw new ForbiddenException(
        "Only organization owners and admins can do this",
      );
    return me;
  }
}
