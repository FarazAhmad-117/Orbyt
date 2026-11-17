import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { and, companies, desc, eq, ilike, lt } from "@orbyt/db";
import { z } from "zod";
import { DbService } from "./db.service";
import { EventsService } from "./events.service";
import { idParam, notFoundIfEmpty, parse } from "./http";
import { Ctx, type Scope, WorkspaceGuard } from "./scope";

const input = z.object({
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(253).nullish(),
});
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
});

@Controller("api/w/:workspaceId/companies")
@UseGuards(WorkspaceGuard)
export class CompaniesController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  @Get()
  list(@Ctx() scope: Scope, @Query() rawQuery: unknown) {
    const q = parse(listQuery, rawQuery);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(companies)
        .where(
          and(
            q.cursor ? lt(companies.id, q.cursor) : undefined,
            q.q
              ? ilike(companies.name, `%${q.q.replace(/[\\%_]/g, "\\$&")}%`)
              : undefined,
          ),
        )
        .orderBy(desc(companies.id))
        .limit(q.limit + 1);
      const items = rows.slice(0, q.limit);
      return {
        items,
        nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null,
      };
    });
  }

  @Post()
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const data = parse(input, body);
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .insert(companies)
        .values({
          workspaceId: scope.workspaceId,
          name: data.name,
          domain: data.domain ?? null,
        })
        .returning(),
    );
    await this.events.emit(scope, {
      type: "company.created",
      data: { id: row!.id, name: row!.name },
    });
    return row;
  }

  @Get(":id")
  async get(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(companies).where(eq(companies.id, id)),
    );
    return notFoundIfEmpty(rows, "Company");
  }

  @Patch(":id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const data = parse(input.partial(), body);
    const set: Partial<typeof companies.$inferInsert> = {};
    if (data.name !== undefined) set.name = data.name;
    if (data.domain !== undefined) set.domain = data.domain;
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      Object.keys(set).length
        ? tx.update(companies).set(set).where(eq(companies.id, id)).returning()
        : tx.select().from(companies).where(eq(companies.id, id)),
    );
    return notFoundIfEmpty(rows, "Company");
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.delete(companies).where(eq(companies.id, id)).returning(),
    );
    notFoundIfEmpty(rows, "Company");
  }
}
