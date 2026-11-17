import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  contacts,
  desc,
  executions,
  executionSteps,
  eq,
  inArray,
  lt,
  sequences,
  workflows,
  type Tx,
  type WorkflowGraph,
} from "@orbyt/db";
import { z } from "zod";
import { DbService } from "../db.service";
import { EventsService } from "../events.service";
import { idParam, notFoundIfEmpty, parse } from "../http";
import { ContactsService } from "../contacts.service";
import { Ctx, type Scope, systemScope, WorkspaceGuard } from "../scope";
import { graphSchema, validateGraph } from "./graph";
import { WorkflowService } from "./workflow.service";

const eventName = z
  .string()
  .regex(/^[a-z_]+\.[a-z_]+$/, "Use an event name like contact.created");
const base = z.object({
  name: z.string().trim().min(1).max(200),
  triggerType: z.enum(["event", "manual", "webhook", "schedule"]),
  triggerEvent: eventName.nullish(),
  // shortcut: fixed intervals (min 5 minutes), no cron expressions; upgrade when someone needs "weekdays 9am".
  scheduleMinutes: z.number().int().min(5).max(525_600).nullish(),
  graph: graphSchema,
});
const createInput = base;
const patchInput = base.partial();

/** Schema + structure + references (sequences must exist in THIS workspace). */
async function checkWorkflow(
  tx: Tx,
  d: {
    triggerType?: string;
    triggerEvent?: string | null;
    scheduleMinutes?: number | null;
    graph?: WorkflowGraph;
  },
  current?: {
    triggerType: string;
    triggerEvent: string | null;
    scheduleMinutes: number | null;
  },
) {
  const type = d.triggerType ?? current?.triggerType;
  const event =
    d.triggerEvent === undefined ? current?.triggerEvent : d.triggerEvent;
  const minutes =
    d.scheduleMinutes === undefined
      ? current?.scheduleMinutes
      : d.scheduleMinutes;
  if (type === "event" && !event)
    throw new BadRequestException("An event workflow needs triggerEvent");
  if (type === "schedule" && !minutes)
    throw new BadRequestException(
      "A scheduled workflow needs scheduleMinutes (at least 5)",
    );
  if (d.graph) {
    const problems = validateGraph(d.graph);
    if (problems.length)
      throw new BadRequestException({ message: "Invalid workflow", problems });
    const seqIds = [
      ...new Set(
        d.graph.nodes
          .filter((n) => n.type === "enroll_sequence")
          .map((n) => String((n.config as { sequenceId: string }).sequenceId)),
      ),
    ];
    if (seqIds.length) {
      const found = await tx
        .select({ id: sequences.id })
        .from(sequences)
        .where(inArray(sequences.id, seqIds));
      if (found.length !== seqIds.length)
        throw new BadRequestException(
          "A step refers to a sequence that does not exist",
        );
    }
  }
}

@Controller("api/w/:workspaceId/workflows")
@UseGuards(WorkspaceGuard)
export class WorkflowsController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(WorkflowService) private readonly engine: WorkflowService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(workflows).orderBy(desc(workflows.id)),
    );
  }

  @Post()
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(createInput, body);
    return this.dbs.inWorkspace(scope, async (tx) => {
      await checkWorkflow(tx, d);
      const [row] = await tx
        .insert(workflows)
        .values({
          workspaceId: scope.workspaceId,
          name: d.name,
          triggerType: d.triggerType,
          triggerEvent:
            d.triggerType === "event" ? (d.triggerEvent ?? null) : null,
          webhookToken:
            d.triggerType === "webhook"
              ? randomBytes(24).toString("hex")
              : null,
          scheduleMinutes:
            d.triggerType === "schedule" ? (d.scheduleMinutes ?? null) : null,
          graph: d.graph as WorkflowGraph,
        })
        .returning();
      return row!;
    });
  }

  @Get(":id")
  async get(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(workflows).where(eq(workflows.id, id)),
    );
    return notFoundIfEmpty(rows, "Workflow");
  }

  @Patch(":id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const d = parse(patchInput, body);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [current] = await tx
        .select()
        .from(workflows)
        .where(eq(workflows.id, id));
      if (!current) throw new NotFoundException("Workflow not found");
      await checkWorkflow(tx, d, current);
      const triggerType = d.triggerType ?? current.triggerType;
      const set: Partial<typeof workflows.$inferInsert> = {};
      if (d.name !== undefined) set.name = d.name;
      if (d.triggerType !== undefined) set.triggerType = d.triggerType;
      if (d.triggerEvent !== undefined || d.triggerType !== undefined)
        set.triggerEvent =
          triggerType === "event"
            ? (d.triggerEvent ?? current.triggerEvent)
            : null;
      set.scheduleMinutes =
        triggerType === "schedule"
          ? d.scheduleMinutes === undefined
            ? current.scheduleMinutes
            : d.scheduleMinutes
          : null;
      if (triggerType === "webhook")
        set.webhookToken =
          current.webhookToken ?? randomBytes(24).toString("hex");
      else set.webhookToken = null;
      if (d.graph) {
        set.graph = d.graph as WorkflowGraph;
        set.version = current.version + 1; // running executions keep their own snapshot
      }
      if (Object.keys(set).length === 0) return current;
      return (
        await tx
          .update(workflows)
          .set(set)
          .where(eq(workflows.id, id))
          .returning()
      )[0]!;
    });
  }

  @Post(":id/activate")
  @HttpCode(200)
  async activate(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [wf] = await tx
        .select()
        .from(workflows)
        .where(eq(workflows.id, id));
      if (!wf) throw new NotFoundException("Workflow not found");
      await checkWorkflow(tx, {
        graph: wf.graph,
        triggerType: wf.triggerType,
        triggerEvent: wf.triggerEvent,
        scheduleMinutes: wf.scheduleMinutes,
      });
      return (
        await tx
          .update(workflows)
          .set({
            status: "active",
            nextRunAt:
              wf.triggerType === "schedule"
                ? new Date(Date.now() + wf.scheduleMinutes! * 60_000)
                : null,
          })
          .where(eq(workflows.id, id))
          .returning()
      )[0]!;
    });
  }

  @Post(":id/pause")
  @HttpCode(200)
  async pause(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .update(workflows)
        .set({ status: "paused" })
        .where(eq(workflows.id, id))
        .returning(),
    );
    return notFoundIfEmpty(rows, "Workflow");
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .delete(workflows)
        .where(eq(workflows.id, id))
        .returning({ id: workflows.id }),
    );
    notFoundIfEmpty(rows, "Workflow");
  }

  /** Start a run now, optionally for a contact (works for any non-paused workflow, including drafts). */
  @Post(":id/run")
  async run(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const { contactId } = parse(
      z.object({ contactId: z.uuid().optional() }),
      body ?? {},
    );
    const wf = await this.dbs.inWorkspace(scope, async (tx) => {
      const [row] = await tx
        .select()
        .from(workflows)
        .where(eq(workflows.id, id));
      if (!row) throw new NotFoundException("Workflow not found");
      if (row.status === "paused")
        throw new BadRequestException("The workflow is paused");
      if (contactId) {
        const found = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(eq(contacts.id, contactId));
        if (found.length === 0)
          throw new BadRequestException("Unknown contactId");
      }
      return row;
    });
    const exec = await this.engine.start(scope, wf, {
      event: { type: "manual.run", data: {} },
      contactId,
    });
    await this.events.emit(scope, {
      type: "workflow.started",
      contactId,
      data: { workflowId: id, executionId: exec.id },
    });
    return exec;
  }

  @Get(":id/executions")
  executions(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Query() rawQuery: unknown,
  ) {
    const id = idParam(rawId);
    const q = parse(
      z.object({
        status: z
          .enum(["running", "completed", "failed", "cancelled"])
          .optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.uuid().optional(),
      }),
      rawQuery,
    );
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select({
          id: executions.id,
          status: executions.status,
          workflowVersion: executions.workflowVersion,
          contactId: executions.contactId,
          error: executions.error,
          startedAt: executions.startedAt,
          finishedAt: executions.finishedAt,
        })
        .from(executions)
        .where(
          and(
            eq(executions.workflowId, id),
            q.status ? eq(executions.status, q.status) : undefined,
            q.cursor ? lt(executions.id, q.cursor) : undefined,
          ),
        )
        .orderBy(desc(executions.id))
        .limit(q.limit + 1);
      const items = rows.slice(0, q.limit);
      return {
        items,
        nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null,
      };
    });
  }
}

/**
 * Public inbound webhooks. The URL itself is the credential (unguessable token, one per workflow).
 * A JSON body becomes `event.data`; if it has an `email`, that contact is found or created and
 * the run is attached to it.
 */
@Controller("api/hooks")
export class WorkflowHooksController {
  constructor(
    @Inject(WorkflowService) private readonly engine: WorkflowService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
  ) {}

  @Post(":workspaceId/workflows/:token")
  @HttpCode(202)
  async receive(
    @Param("workspaceId") workspaceId: string,
    @Param("token") token: string,
    @Body() body: unknown,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId) || !/^[0-9a-f]{48}$/.test(token))
      throw new NotFoundException();
    const payload = parse(z.record(z.string(), z.unknown()), body ?? {});
    const scope = systemScope(workspaceId);
    let contactId: string | null = null;
    if (typeof payload.email === "string") {
      const { contact } = await this.contacts.findOrCreate(scope, {
        email: payload.email,
        name: typeof payload.name === "string" ? payload.name : undefined,
        phone: typeof payload.phone === "string" ? payload.phone : undefined,
        source: "webhook",
      });
      contactId = contact.id;
    }
    const exec = await this.engine.startFromWebhook(
      workspaceId,
      token,
      payload,
      contactId,
    );
    if (!exec) throw new NotFoundException();
    return { executionId: exec.id };
  }
}

@Controller("api/w/:workspaceId/executions")
@UseGuards(WorkspaceGuard)
export class ExecutionsController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(WorkflowService) private readonly engine: WorkflowService,
  ) {}

  @Get(":id")
  async get(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [exec] = await tx
        .select()
        .from(executions)
        .where(eq(executions.id, id));
      if (!exec) throw new NotFoundException("Execution not found");
      const steps = await tx
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.executionId, id))
        .orderBy(asc(executionSteps.runAt), asc(executionSteps.id));
      return { ...exec, steps };
    });
  }

  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [exec] = await tx
        .update(executions)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(and(eq(executions.id, id), eq(executions.status, "running")))
        .returning();
      if (!exec) {
        const [existing] = await tx
          .select({ id: executions.id })
          .from(executions)
          .where(eq(executions.id, id));
        throw existing
          ? new BadRequestException("Only running executions can be cancelled")
          : new NotFoundException("Execution not found");
      }
      await tx
        .update(executionSteps)
        .set({ status: "skipped", finishedAt: new Date() })
        .where(
          and(
            eq(executionSteps.executionId, id),
            eq(executionSteps.status, "pending"),
          ),
        );
      return exec;
    });
  }

  /** Run it again from the start with the same trigger data and the same graph snapshot. */
  @Post(":id/replay")
  async replay(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const [exec] = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(executions).where(eq(executions.id, id)),
    );
    if (!exec) throw new NotFoundException("Execution not found");
    const context = exec.context as {
      event?: { type: string; data?: Record<string, unknown> } | null;
      dealId?: string | null;
    };
    return this.engine.start(
      scope,
      { id: exec.workflowId, version: exec.workflowVersion, graph: exec.graph },
      {
        event: context.event ?? undefined,
        contactId: exec.contactId,
        dealId: context.dealId,
        depth: exec.depth,
      },
      exec.graph,
    );
  }
}
