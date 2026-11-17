import {
  Controller,
  Get,
  Inject,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { withUser, workspaces } from "@orbyt/db";
import type { FastifyRequest } from "fastify";
import { AUTH, toHeaders, type Auth } from "./auth";
import { DbService } from "./db.service";

@Controller("api/me")
export class MeController {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DbService) private readonly dbs: DbService,
  ) {}

  // Workspaces the signed-in user may open. Authorisation IS the RLS policy: the query runs as the
  // restricted role with app.user_id set, so it can only return rows the user is a member of.
  @Get("workspaces")
  async workspaces(@Req() req: FastifyRequest) {
    const session = await this.auth.api.getSession({ headers: toHeaders(req) });
    if (!session) throw new UnauthorizedException();
    return withUser(this.dbs.db, session.user.id, (tx) =>
      tx
        .select({
          id: workspaces.id,
          name: workspaces.name,
          organizationId: workspaces.organizationId,
        })
        .from(workspaces),
    );
  }
}
