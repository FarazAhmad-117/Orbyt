import {
  BadRequestException,
  Body,
  ConflictException,
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
import {
  and,
  asc,
  deals,
  desc,
  eq,
  lt,
  pipelines,
  pipelineStages,
  sql,
  type Tx,
} from "@orbyt/db";
import { z } from "zod";
import { DbService } from "./db.service";
import { EventsService } from "./events.service";
import { idParam, notFoundIfEmpty, parse } from "./http";
import {
  assertCompany,
  assertContact,
  assertPipeline,
  assertStage,
} from "./refs";
import { Ctx, type Scope, WorkspaceGuard } from "./scope";

const name = z.string().trim().min(1).max(100);

async function writeOrder(tx: Tx, orderedIds: string[]) {
  for (const [position, id] of orderedIds.entries())
    await tx
      .update(pipelineStages)
      .set({ position })
      .where(eq(pipelineStages.id, id));
}

async function stagesOf(tx: Tx, pipelineId: string) {
  return tx
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipelineId))
    .orderBy(asc(pipelineStages.position));
}

@Controller("api/w/:workspaceId/pipelines")
@UseGuards(WorkspaceGuard)
export class PipelinesController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, async (tx) => {
      const ps = await tx.select().from(pipelines).orderBy(asc(pipelines.id));
      const stages = await tx
        .select()
        .from(pipelineStages)
        .orderBy(asc(pipelineStages.position));
      return ps.map((p) => ({
        ...p,
        stages: stages.filter((s) => s.pipelineId === p.id),
      }));
    });
  }

  @Post()
  create(@Ctx() scope: Scope, @Body() body: unknown) {
    const data = parse(
      z.object({ name, stages: z.array(name).min(1).max(30) }),
      body,
    );
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [p] = await tx
        .insert(pipelines)
        .values({ workspaceId: scope.workspaceId, name: data.name })
        .returning();
      const stages = await tx
        .insert(pipelineStages)
        .values(
          data.stages.map((n, position) => ({
            workspaceId: scope.workspaceId,
            pipelineId: p!.id,
            name: n,
            position,
          })),
        )
        .returning();
      return { ...p!, stages: stages.sort((a, b) => a.position - b.position) };
    });
  }

  @Patch(":id")
  async rename(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const data = parse(z.object({ name }), body);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .update(pipelines)
        .set({ name: data.name })
        .where(eq(pipelines.id, id))
        .returning(),
    );
    return notFoundIfEmpty(rows, "Pipeline");
  }

  // Deleting a pipeline deletes its deals, so it needs ?force=true when deals exist.
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Query("force") force?: string,
  ) {
    const id = idParam(rawId);
    await this.dbs.inWorkspace(scope, async (tx) => {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(deals)
        .where(eq(deals.pipelineId, id));
      if (n > 0 && force !== "true")
        throw new ConflictException(
          `Pipeline has ${n} deal(s); pass ?force=true to delete them too`,
        );
      // Stages are referenced by deals (no cascade), so deals go first.
      await tx.delete(deals).where(eq(deals.pipelineId, id));
      notFoundIfEmpty(
        await tx.delete(pipelines).where(eq(pipelines.id, id)).returning(),
        "Pipeline",
      );
    });
  }

  @Post(":id/stages")
  async addStage(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const data = parse(
      z.object({ name, position: z.number().int().min(0).optional() }),
      body,
    );
    return this.dbs.inWorkspace(scope, async (tx) => {
      await assertPipeline(tx, id);
      const existing = await stagesOf(tx, id);
      const [stage] = await tx
        .insert(pipelineStages)
        .values({
          workspaceId: scope.workspaceId,
          pipelineId: id,
          name: data.name,
          position: existing.length,
        })
        .returning();
      const order = existing.map((s) => s.id);
      order.splice(
        Math.min(data.position ?? order.length, order.length),
        0,
        stage!.id,
      );
      await writeOrder(tx, order);
      return (await stagesOf(tx, id)).find((s) => s.id === stage!.id)!;
    });
  }
}

@Controller("api/w/:workspaceId/stages")
@UseGuards(WorkspaceGuard)
export class StagesController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Patch(":id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const data = parse(
      z.object({
        name: name.optional(),
        position: z.number().int().min(0).optional(),
      }),
      body,
    );
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [stage] = await tx
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.id, id));
      if (!stage) throw new BadRequestException("Unknown stage");
      if (data.name !== undefined)
        await tx
          .update(pipelineStages)
          .set({ name: data.name })
          .where(eq(pipelineStages.id, id));
      if (data.position !== undefined) {
        const order = (await stagesOf(tx, stage.pipelineId))
          .map((s) => s.id)
          .filter((x) => x !== id);
        order.splice(Math.min(data.position, order.length), 0, id);
        await writeOrder(tx, order);
      }
      return (
        await tx.select().from(pipelineStages).where(eq(pipelineStages.id, id))
      )[0]!;
    });
  }

  // 409 (via the FK) while deals still sit in the stage.
  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    await this.dbs.inWorkspace(scope, async (tx) => {
      const [stage] = await tx
        .delete(pipelineStages)
        .where(eq(pipelineStages.id, id))
        .returning();
      if (!stage) throw new BadRequestException("Unknown stage");
      await writeOrder(
        tx,
        (await stagesOf(tx, stage.pipelineId)).map((s) => s.id),
      );
    });
  }
}

const dealInput = z.object({
  pipelineId: z.uuid(),
  stageId: z.uuid().optional(),
  title: z.string().trim().min(1).max(200),
  valueCents: z.number().int().min(0).max(1e13).default(0),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. USD")
    .default("USD"),
  contactId: z.uuid().nullish(),
  companyId: z.uuid().nullish(),
});
const dealPatch = z.object({
  title: dealInput.shape.title.optional(),
  valueCents: z.number().int().min(0).max(1e13).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  contactId: z.uuid().nullish(),
  companyId: z.uuid().nullish(),
  status: z.enum(["open", "won", "lost"]).optional(),
});
const dealList = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
  pipelineId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
});

@Controller("api/w/:workspaceId/deals")
@UseGuards(WorkspaceGuard)
export class DealsController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  @Get()
  list(@Ctx() scope: Scope, @Query() rawQuery: unknown) {
    const q = parse(dealList, rawQuery);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(deals)
        .where(
          and(
            q.cursor ? lt(deals.id, q.cursor) : undefined,
            q.pipelineId ? eq(deals.pipelineId, q.pipelineId) : undefined,
            q.stageId ? eq(deals.stageId, q.stageId) : undefined,
            q.contactId ? eq(deals.contactId, q.contactId) : undefined,
            q.status ? eq(deals.status, q.status) : undefined,
          ),
        )
        .orderBy(desc(deals.id))
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
    const data = parse(dealInput, body);
    const deal = await this.dbs.inWorkspace(scope, async (tx) => {
      await assertPipeline(tx, data.pipelineId);
      let stageId = data.stageId;
      if (stageId) await assertStage(tx, stageId, data.pipelineId);
      else {
        const first = (await stagesOf(tx, data.pipelineId))[0];
        if (!first) throw new BadRequestException("Pipeline has no stages");
        stageId = first.id;
      }
      if (data.contactId) await assertContact(tx, data.contactId);
      if (data.companyId) await assertCompany(tx, data.companyId);
      const [row] = await tx
        .insert(deals)
        .values({
          workspaceId: scope.workspaceId,
          pipelineId: data.pipelineId,
          stageId,
          title: data.title,
          valueCents: data.valueCents,
          currency: data.currency,
          contactId: data.contactId ?? null,
          companyId: data.companyId ?? null,
          ownerId: scope.userId,
        })
        .returning();
      return row!;
    });
    await this.events.emit(scope, {
      type: "deal.created",
      dealId: deal.id,
      contactId: deal.contactId,
      data: { title: deal.title, valueCents: deal.valueCents },
    });
    return deal;
  }

  @Get(":id")
  async get(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(deals).where(eq(deals.id, id)),
    );
    return notFoundIfEmpty(rows, "Deal");
  }

  @Patch(":id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const data = parse(dealPatch, body);
    const deal = await this.dbs.inWorkspace(scope, async (tx) => {
      const [existing] = await tx.select().from(deals).where(eq(deals.id, id));
      if (!existing) return null;
      if (data.contactId) await assertContact(tx, data.contactId);
      if (data.companyId) await assertCompany(tx, data.companyId);
      const set: Partial<typeof deals.$inferInsert> = {};
      if (data.title !== undefined) set.title = data.title;
      if (data.valueCents !== undefined) set.valueCents = data.valueCents;
      if (data.currency !== undefined) set.currency = data.currency;
      if (data.contactId !== undefined) set.contactId = data.contactId;
      if (data.companyId !== undefined) set.companyId = data.companyId;
      if (data.status !== undefined) {
        set.status = data.status;
        set.closedAt = data.status === "open" ? null : new Date();
      }
      if (Object.keys(set).length === 0)
        return { before: existing, after: existing };
      const [after] = await tx
        .update(deals)
        .set(set)
        .where(eq(deals.id, id))
        .returning();
      return { before: existing, after: after! };
    });
    if (!deal) throw notFoundIfEmpty([], "Deal");
    const { before, after } = deal;
    if (before.status !== after.status && after.status !== "open")
      await this.events.emit(scope, {
        type: after.status === "won" ? "deal.won" : "deal.lost",
        dealId: id,
        contactId: after.contactId,
        data: { title: after.title, valueCents: after.valueCents },
      });
    else if (before !== after)
      await this.events.emit(scope, {
        type: "deal.updated",
        dealId: id,
        contactId: after.contactId,
        data: { fields: Object.keys(data) },
      });
    return after;
  }

  @Post(":id/move")
  async move(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const { stageId } = parse(z.object({ stageId: z.uuid() }), body);
    const result = await this.dbs.inWorkspace(scope, async (tx) => {
      const [existing] = await tx.select().from(deals).where(eq(deals.id, id));
      if (!existing) return null;
      await assertStage(tx, stageId, existing.pipelineId);
      const [after] = await tx
        .update(deals)
        .set({ stageId })
        .where(eq(deals.id, id))
        .returning();
      return { from: existing.stageId, after: after! };
    });
    if (!result) throw notFoundIfEmpty([], "Deal");
    if (result.from !== stageId)
      await this.events.emit(scope, {
        type: "deal.moved",
        dealId: id,
        contactId: result.after.contactId,
        data: { from: result.from, to: stageId },
      });
    return result.after;
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.delete(deals).where(eq(deals.id, id)).returning(),
    );
    notFoundIfEmpty(rows, "Deal");
  }
}
