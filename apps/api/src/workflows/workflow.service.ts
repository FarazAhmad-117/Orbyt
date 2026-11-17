import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  and,
  asc,
  contacts,
  executions,
  executionSteps,
  eq,
  lte,
  sql,
  workflows,
  workspaces,
  type Tx,
  type WorkflowGraph,
} from "@orbyt/db";
import { AiService } from "../ai/ai.service";
import { ChannelsService } from "../channels/channels.service";
import { DbService } from "../db.service";
import { EventsService, type DomainEvent } from "../events.service";
import { systemScope, type Scope } from "../scope";
import { successors, type WorkflowNode } from "./graph";
import { runNode, type RunEnv } from "./nodes";

/** Workflow -> event -> workflow hops allowed before the engine refuses to start another run. */
export const MAX_DEPTH = 3;
const MAX_ATTEMPTS = 3;

type Workflow = typeof workflows.$inferSelect;
export interface StartInput {
  event?: { type: string; data?: Record<string, unknown> };
  contactId?: string | null;
  dealId?: string | null;
  depth?: number;
}

/**
 * Durable workflow executor. Every node of every execution is a row in execution_steps; a tick
 * claims due rows with `FOR UPDATE SKIP LOCKED` (so several API replicas are safe), runs the node
 * inside a savepoint (a failing node leaves no half-done side effects) and schedules its
 * successors. `wait` nodes simply schedule their successors later, so nothing is held in memory
 * and executions survive restarts. Delivery is at-least-once: nodes should be idempotent (the HTTP
 * node sends an Idempotency-Key header).
 */
@Injectable()
export class WorkflowService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(ChannelsService) private readonly channels: ChannelsService,
  ) {
    events.subscribe((scope, event) => this.onEvent(scope, event));
  }

  onModuleInit() {
    if (process.env.ORBYT_WORKFLOWS === "off") return; // tests drive tick() themselves
    const every = Number(process.env.ORBYT_WORKFLOWS_INTERVAL_MS ?? 5_000);
    this.timer = setInterval(
      () => void this.tick().catch((e) => console.error("[workflows]", e)),
      every,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- starting executions ----

  private async onEvent(scope: Scope, event: DomainEvent) {
    const depth = event.origin?.depth ?? 0;
    if (depth >= MAX_DEPTH) return; // a chain of workflows triggering workflows: stop it here
    const matching = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.status, "active"),
            eq(workflows.triggerType, "event"),
            eq(workflows.triggerEvent, event.type),
          ),
        ),
    );
    for (const wf of matching)
      await this.start(scope, wf, {
        event: { type: event.type, data: event.data ?? {} },
        contactId: event.contactId,
        dealId: event.dealId,
        depth,
      });
  }

  /** Creates an execution (using `graph` if given, e.g. a replay) and schedules the first nodes. */
  async start(
    scope: Scope,
    wf: Pick<Workflow, "id" | "version" | "graph">,
    input: StartInput,
    graph: WorkflowGraph = wf.graph,
    now = new Date(),
  ) {
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [exec] = await tx
        .insert(executions)
        .values({
          workspaceId: scope.workspaceId,
          workflowId: wf.id,
          workflowVersion: wf.version,
          graph,
          context: { event: input.event ?? null, dealId: input.dealId ?? null },
          contactId: input.contactId ?? null,
          depth: input.depth ?? 0,
          startedAt: now,
        })
        .returning();
      const trigger = graph.nodes.find((n) => n.type === "trigger")!;
      const first = successors(graph, trigger.id);
      if (first.length === 0)
        await tx
          .update(executions)
          .set({ status: "completed", finishedAt: now })
          .where(eq(executions.id, exec!.id));
      else
        await tx.insert(executionSteps).values(
          first.map((nodeId) => ({
            workspaceId: scope.workspaceId,
            executionId: exec!.id,
            nodeId,
            runAt: now,
          })),
        );
      return exec!;
    });
  }

  // ---- running them ----

  /** One pass over all workspaces (or just `only`). Returns how many nodes ran. */
  async tick(now = new Date(), only?: string): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const rows = await this.dbs.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(only ? eq(workspaces.id, only) : undefined);
      let ran = 0;
      for (const { id } of rows)
        try {
          for (let i = 0; i < 500; i++) {
            if (!(await this.processNext(id, now))) break;
            ran++;
          }
        } catch (err) {
          // One workspace's failure must not stall the others.
          console.error(`[workflows] workspace ${id}:`, err);
        }
      return ran;
    } finally {
      this.ticking = false;
    }
  }

  private async processNext(workspaceId: string, now: Date): Promise<boolean> {
    const scope = systemScope(workspaceId);
    const emitted: DomainEvent[] = [];
    const ran = await this.dbs.inWorkspace(scope, async (tx) => {
      const [due] = await tx
        .select({ step: executionSteps, exec: executions })
        .from(executionSteps)
        .innerJoin(executions, eq(executions.id, executionSteps.executionId))
        .where(
          and(
            eq(executionSteps.status, "pending"),
            lte(executionSteps.runAt, now),
            eq(executions.status, "running"),
          ),
        )
        .orderBy(asc(executionSteps.runAt))
        .limit(1)
        .for("update", { of: executionSteps, skipLocked: true });
      if (!due) return false;
      await this.runStep(tx, scope, due.exec, due.step, now, emitted);
      return true;
    });
    for (const event of emitted) await this.events.emit(scope, event);
    return ran;
  }

  private async runStep(
    tx: Tx,
    scope: Scope,
    exec: typeof executions.$inferSelect,
    step: typeof executionSteps.$inferSelect,
    now: Date,
    emitted: DomainEvent[],
  ) {
    const node = exec.graph.nodes.find((n) => n.id === step.nodeId) as
      WorkflowNode | undefined;
    if (!node)
      return this.fail(
        tx,
        exec,
        step,
        "Node no longer exists in the workflow",
        now,
      );

    // Everything a template can reference.
    const [contact] = exec.contactId
      ? await tx.select().from(contacts).where(eq(contacts.id, exec.contactId))
      : [];
    const done = await tx
      .select({ nodeId: executionSteps.nodeId, output: executionSteps.output })
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.executionId, exec.id),
          eq(executionSteps.status, "done"),
        ),
      );
    const ctx = {
      contact: contact ?? null,
      event: (exec.context as { event?: unknown }).event ?? null,
      steps: Object.fromEntries(
        done.map((d) => [d.nodeId, { output: d.output ?? {} }]),
      ),
      execution: { id: exec.id },
    };
    const nodeEvents: DomainEvent[] = [];
    const env: RunEnv = {
      tx: undefined as unknown as Tx, // replaced inside the savepoint below
      scope,
      now,
      executionId: exec.id,
      nodeId: node.id,
      contactId: exec.contactId,
      depth: exec.depth,
      ctx,
      emit: (e) => nodeEvents.push(e),
      ai: (o) => this.ai.run(scope, { kind: "workflow", ...o }),
      channels: {
        send: (channelId, to, body) =>
          this.channels.send(scope, channelId, to, body),
        call: (channelId, to, agentId) =>
          this.channels.call(scope, channelId, to, {
            agentId,
            contactId: exec.contactId,
          }),
      },
    };

    try {
      // Savepoint: if the node throws, everything it wrote is rolled back.
      const result = await tx.transaction(async (sp) =>
        runNode(node, { ...env, tx: sp as unknown as Tx }),
      );
      await tx
        .update(executionSteps)
        .set({
          status: "done",
          output: result.output ?? {},
          finishedAt: now,
          error: null,
        })
        .where(eq(executionSteps.id, step.id));
      const runAt = new Date(
        now.getTime() + (result.waitMinutes ?? 0) * 60_000,
      );
      const next = successors(
        exec.graph,
        node.id,
        node.type === "condition" ? result.branch : undefined,
      );
      if (next.length)
        await tx
          .insert(executionSteps)
          .values(
            next.map((nodeId) => ({
              workspaceId: scope.workspaceId,
              executionId: exec.id,
              nodeId,
              runAt,
            })),
          )
          .onConflictDoNothing();
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.executionId, exec.id),
            eq(executionSteps.status, "pending"),
          ),
        );
      if (n === 0)
        await tx
          .update(executions)
          .set({ status: "completed", finishedAt: now })
          .where(eq(executions.id, exec.id));
      emitted.push(...nodeEvents);
    } catch (err) {
      const message = (err as Error).message;
      const attempts = step.attempts + 1;
      if (attempts < MAX_ATTEMPTS)
        // 1 min, then 2 min: transient errors (a slow webhook) get another go.
        await tx
          .update(executionSteps)
          .set({
            attempts,
            error: message,
            runAt: new Date(now.getTime() + 60_000 * 2 ** (attempts - 1)),
          })
          .where(eq(executionSteps.id, step.id));
      else await this.fail(tx, exec, { ...step, attempts }, message, now);
    }
  }

  private async fail(
    tx: Tx,
    exec: typeof executions.$inferSelect,
    step: typeof executionSteps.$inferSelect,
    message: string,
    now: Date,
  ) {
    await tx
      .update(executionSteps)
      .set({
        status: "failed",
        attempts: step.attempts,
        error: message,
        finishedAt: now,
      })
      .where(eq(executionSteps.id, step.id));
    await tx
      .update(executionSteps)
      .set({ status: "skipped", finishedAt: now })
      .where(
        and(
          eq(executionSteps.executionId, exec.id),
          eq(executionSteps.status, "pending"),
        ),
      );
    await tx
      .update(executions)
      .set({
        status: "failed",
        error: `${step.nodeId}: ${message}`,
        finishedAt: now,
      })
      .where(eq(executions.id, exec.id));
  }
}
