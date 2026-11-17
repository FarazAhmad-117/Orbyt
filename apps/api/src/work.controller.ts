import {
  BadRequestException,
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
import {
  activities,
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  notes,
  tasks,
} from "@orbyt/db";
import { z } from "zod";
import { DbService } from "./db.service";
import { EventsService } from "./events.service";
import { idParam, notFoundIfEmpty, parse } from "./http";
import { assertContact, assertDeal } from "./refs";
import { Ctx, type Scope, WorkspaceGuard } from "./scope";

const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
};

const taskInput = z.object({
  title: z.string().trim().min(1).max(300),
  dueAt: z.iso.datetime({ offset: true }).nullish(),
  contactId: z.uuid().nullish(),
  dealId: z.uuid().nullish(),
  assigneeId: z.uuid().nullish(),
});

@Controller("api/w/:workspaceId/tasks")
@UseGuards(WorkspaceGuard)
export class TasksController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private async checkAssignee(scope: Scope, assigneeId?: string | null) {
    if (
      assigneeId &&
      !(await this.dbs.canAccessWorkspace(assigneeId, scope.workspaceId))
    )
      throw new BadRequestException(
        "assigneeId is not a member of this workspace",
      );
  }

  @Get()
  list(@Ctx() scope: Scope, @Query() rawQuery: unknown) {
    const q = parse(
      z.object({
        ...page,
        contactId: z.uuid().optional(),
        dealId: z.uuid().optional(),
        done: z.enum(["true", "false"]).optional(),
      }),
      rawQuery,
    );
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(tasks)
        .where(
          and(
            q.cursor ? lt(tasks.id, q.cursor) : undefined,
            q.contactId ? eq(tasks.contactId, q.contactId) : undefined,
            q.dealId ? eq(tasks.dealId, q.dealId) : undefined,
            q.done === "true"
              ? isNotNull(tasks.doneAt)
              : q.done === "false"
                ? isNull(tasks.doneAt)
                : undefined,
          ),
        )
        .orderBy(desc(tasks.id))
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
    const data = parse(taskInput, body);
    await this.checkAssignee(scope, data.assigneeId);
    const task = await this.dbs.inWorkspace(scope, async (tx) => {
      if (data.contactId) await assertContact(tx, data.contactId);
      if (data.dealId) await assertDeal(tx, data.dealId);
      const [row] = await tx
        .insert(tasks)
        .values({
          workspaceId: scope.workspaceId,
          title: data.title,
          dueAt: data.dueAt ? new Date(data.dueAt) : null,
          contactId: data.contactId ?? null,
          dealId: data.dealId ?? null,
          assigneeId: data.assigneeId ?? scope.userId,
        })
        .returning();
      return row!;
    });
    await this.events.emit(scope, {
      type: "task.created",
      contactId: task.contactId,
      dealId: task.dealId,
      data: { id: task.id, title: task.title },
    });
    return task;
  }

  @Patch(":id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const data = parse(
      taskInput
        .pick({ title: true, dueAt: true, assigneeId: true })
        .partial()
        .extend({ done: z.boolean().optional() }),
      body,
    );
    await this.checkAssignee(scope, data.assigneeId);
    const set: Partial<typeof tasks.$inferInsert> = {};
    if (data.title !== undefined) set.title = data.title;
    if (data.dueAt !== undefined)
      set.dueAt = data.dueAt ? new Date(data.dueAt) : null;
    if (data.assigneeId !== undefined) set.assigneeId = data.assigneeId;
    if (data.done !== undefined) set.doneAt = data.done ? new Date() : null;
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      Object.keys(set).length
        ? tx.update(tasks).set(set).where(eq(tasks.id, id)).returning()
        : tx.select().from(tasks).where(eq(tasks.id, id)),
    );
    const task = notFoundIfEmpty(rows, "Task");
    if (data.done === true)
      await this.events.emit(scope, {
        type: "task.completed",
        contactId: task.contactId,
        dealId: task.dealId,
        data: { id, title: task.title },
      });
    return task;
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.delete(tasks).where(eq(tasks.id, id)).returning(),
    );
    notFoundIfEmpty(rows, "Task");
  }
}

@Controller("api/w/:workspaceId/notes")
@UseGuards(WorkspaceGuard)
export class NotesController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  @Get()
  list(@Ctx() scope: Scope, @Query() rawQuery: unknown) {
    const q = parse(
      z.object({
        ...page,
        contactId: z.uuid().optional(),
        dealId: z.uuid().optional(),
      }),
      rawQuery,
    );
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(notes)
        .where(
          and(
            q.cursor ? lt(notes.id, q.cursor) : undefined,
            q.contactId ? eq(notes.contactId, q.contactId) : undefined,
            q.dealId ? eq(notes.dealId, q.dealId) : undefined,
          ),
        )
        .orderBy(desc(notes.id))
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
    const data = parse(
      z
        .object({
          body: z.string().trim().min(1).max(10_000),
          contactId: z.uuid().optional(),
          dealId: z.uuid().optional(),
        })
        .refine((v) => v.contactId || v.dealId, "Provide contactId or dealId"),
      body,
    );
    const note = await this.dbs.inWorkspace(scope, async (tx) => {
      if (data.contactId) await assertContact(tx, data.contactId);
      if (data.dealId) await assertDeal(tx, data.dealId);
      const [row] = await tx
        .insert(notes)
        .values({
          workspaceId: scope.workspaceId,
          body: data.body,
          contactId: data.contactId ?? null,
          dealId: data.dealId ?? null,
          authorId: scope.userId,
        })
        .returning();
      return row!;
    });
    await this.events.emit(scope, {
      type: "note.added",
      contactId: note.contactId,
      dealId: note.dealId,
      data: { id: note.id },
    });
    return note;
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.delete(notes).where(eq(notes.id, id)).returning(),
    );
    notFoundIfEmpty(rows, "Note");
  }
}

@Controller("api/w/:workspaceId/timeline")
@UseGuards(WorkspaceGuard)
export class TimelineController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  // Newest first; filter to one contact or deal, or leave both off for the whole workspace feed.
  @Get()
  list(@Ctx() scope: Scope, @Query() rawQuery: unknown) {
    const q = parse(
      z.object({
        ...page,
        contactId: z.uuid().optional(),
        dealId: z.uuid().optional(),
      }),
      rawQuery,
    );
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(activities)
        .where(
          and(
            q.cursor ? lt(activities.id, q.cursor) : undefined,
            q.contactId ? eq(activities.contactId, q.contactId) : undefined,
            q.dealId ? eq(activities.dealId, q.dealId) : undefined,
          ),
        )
        .orderBy(desc(activities.id))
        .limit(q.limit + 1);
      const items = rows.slice(0, q.limit);
      return {
        items,
        nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null,
      };
    });
  }
}
