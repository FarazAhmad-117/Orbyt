import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./columns.js";
import { contacts } from "./schema-crm.js";
import { workspaces } from "./schema.js";

// Workspace data: RLS is applied in the migration (app_enable_workspace_rls).
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
type Json = Record<string, unknown>;

export interface WorkflowGraph {
  nodes: { id: string; type: string; config: Json }[];
  edges: { from: string; to: string; label?: "true" | "false" }[];
}

export const workflows = pgTable(
  "workflows",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    status: text("status").notNull().default("draft"),
    // "event": starts when a domain event of `triggerEvent` happens; "manual": started via the API.
    triggerType: text("trigger_type").notNull().default("manual"),
    triggerEvent: text("trigger_event"),
    graph: jsonb("graph").$type<WorkflowGraph>().notNull(),
    // Bumped on every graph edit. Running executions keep the graph snapshot they started with.
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("workflows_trigger_idx").on(t.workspaceId, t.status, t.triggerEvent),
    check(
      "workflows_status_check",
      sql`${t.status} in ('draft', 'active', 'paused')`,
    ),
    check(
      "workflows_trigger_check",
      sql`${t.triggerType} in ('event', 'manual')`,
    ),
  ],
);

export const executions = pgTable(
  "executions",
  {
    id: pk(),
    workspaceId: workspaceId(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    workflowVersion: integer("workflow_version").notNull(),
    status: text("status").notNull().default("running"),
    graph: jsonb("graph").$type<WorkflowGraph>().notNull(),
    // What started it: { event: {type, data}, contactId, dealId }.
    context: jsonb("context").$type<Json>().notNull().default({}),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    // How many workflow->event->workflow hops led here (loop guard).
    depth: integer("depth").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("executions_workflow_idx").on(t.workflowId, t.startedAt),
    check(
      "executions_status_check",
      sql`${t.status} in ('running', 'completed', 'failed', 'cancelled')`,
    ),
  ],
);

// One row per node per execution: durable, resumable state. unique(execution, node) makes every
// node run at most once per execution (merges after a branch do not double-run).
export const executionSteps = pgTable(
  "execution_steps",
  {
    id: pk(),
    workspaceId: workspaceId(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    status: text("status").notNull().default("pending"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    output: jsonb("output").$type<Json>(),
    error: text("error"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("execution_steps_node_uniq").on(t.executionId, t.nodeId),
    index("execution_steps_due_idx").on(t.workspaceId, t.status, t.runAt),
    check(
      "execution_steps_status_check",
      sql`${t.status} in ('pending', 'done', 'failed', 'skipped')`,
    ),
  ],
);
