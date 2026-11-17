import type { WorkflowGraph } from "@orbyt/db";
import { z } from "zod";

const id = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,40}$/, "Node ids use letters, digits, - and _");
const text = (max = 2000) => z.string().max(max);

export const CONDITION_OPS = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "gt",
  "lt",
  "exists",
  "not_exists",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

// Each node type has its own config schema; unknown types are rejected.
export const nodeSchema = z.discriminatedUnion("type", [
  z.object({
    id,
    type: z.literal("trigger"),
    config: z.object({}).default({}),
  }),
  z.object({
    id,
    type: z.literal("wait"),
    config: z.object({ minutes: z.number().int().min(0).max(525_600) }),
  }),
  z.object({
    id,
    type: z.literal("condition"),
    config: z.object({
      left: text(),
      op: z.enum(CONDITION_OPS),
      right: text().optional(),
    }),
  }),
  z.object({
    id,
    type: z.literal("tag"),
    config: z.object({
      add: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
      remove: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
    }),
  }),
  z.object({
    id,
    type: z.literal("update_contact"),
    config: z.object({ fields: z.record(z.string().max(80), text()) }),
  }),
  z.object({
    id,
    type: z.literal("create_task"),
    config: z.object({
      title: text(300).min(1),
      dueInHours: z
        .number()
        .min(0)
        .max(24 * 365)
        .optional(),
    }),
  }),
  z.object({
    id,
    type: z.literal("add_note"),
    config: z.object({ body: text(10_000).min(1) }),
  }),
  z.object({
    id,
    type: z.literal("http"),
    config: z.object({
      url: z.url().max(2000),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
      headers: z.record(z.string(), z.string()).default({}),
      body: text(20_000).optional(),
    }),
  }),
  z.object({
    id,
    type: z.literal("enroll_sequence"),
    config: z.object({ sequenceId: z.uuid() }),
  }),
  z.object({
    id,
    type: z.literal("send_sms"),
    // Works for SMS and WhatsApp channel accounts.
    config: z.object({
      channelId: z.uuid(),
      to: text(100).min(1),
      body: text(1600).min(1),
    }),
  }),
  z.object({
    id,
    type: z.literal("voice_call"),
    config: z.object({
      channelId: z.uuid(),
      to: text(100).min(1),
      agentId: text(100).optional(),
    }),
  }),
  z.object({
    id,
    type: z.literal("ai"),
    config: z.object({
      prompt: text(10_000).min(1),
      system: text(5000).optional(),
      json: z.boolean().default(false),
      providerId: z.uuid().optional(),
    }),
  }),
]);
export type WorkflowNode = z.infer<typeof nodeSchema>;

export const graphSchema = z.object({
  nodes: z.array(nodeSchema).min(1).max(100),
  edges: z
    .array(
      z.object({
        from: id,
        to: id,
        label: z.enum(["true", "false"]).optional(),
      }),
    )
    .max(300),
});

/** Structural checks beyond the schema. Returns human-readable problems (empty = valid). */
export function validateGraph(graph: WorkflowGraph): string[] {
  const problems: string[] = [];
  const byId = new Map<string, WorkflowGraph["nodes"][number]>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) problems.push(`Duplicate node id "${n.id}"`);
    byId.set(n.id, n);
  }
  const triggers = graph.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1)
    problems.push(
      `A workflow needs exactly one trigger node (found ${triggers.length})`,
    );

  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    const from = byId.get(e.from);
    if (!from || !byId.has(e.to)) {
      problems.push(
        `Edge ${e.from} -> ${e.to} points at a node that does not exist`,
      );
      continue;
    }
    if (byId.get(e.to)!.type === "trigger")
      problems.push(
        `Nothing can lead into the trigger ("${e.from}" -> "${e.to}")`,
      );
    if (from.type === "condition" && !e.label)
      problems.push(
        `Edges leaving condition "${e.from}" must be labelled "true" or "false"`,
      );
    if (from.type !== "condition" && e.label)
      problems.push(
        `Only condition nodes have labelled edges ("${e.from}" -> "${e.to}")`,
      );
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }
  if (problems.length || triggers.length !== 1) return problems;

  // Reachability from the trigger, and cycle detection (loops are not supported yet).
  const seen = new Set<string>();
  const stack = new Set<string>();
  let cyclic = false;
  const visit = (nodeId: string) => {
    if (stack.has(nodeId)) {
      cyclic = true;
      return;
    }
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    stack.add(nodeId);
    for (const next of out.get(nodeId) ?? []) visit(next);
    stack.delete(nodeId);
  };
  visit(triggers[0]!.id);
  if (cyclic)
    problems.push("The workflow contains a loop; steps must flow forward only");
  for (const n of graph.nodes)
    if (!seen.has(n.id))
      problems.push(
        `Node "${n.id}" can never run: it is not reachable from the trigger`,
      );
  return problems;
}

export const successors = (
  graph: WorkflowGraph,
  nodeId: string,
  branch?: "true" | "false",
) =>
  graph.edges
    .filter(
      (e) => e.from === nodeId && (branch === undefined || e.label === branch),
    )
    .map((e) => e.to);

// ---- Templating: {{ contact.email }}, {{ event.data.title | fallback }}, {{ steps.node1.output.status }} ----

export function resolvePath(ctx: unknown, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function renderCtx(template: string, ctx: unknown): string {
  return template.replace(
    /\{\{\s*([\w.-]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g,
    (_m, path: string, fallback?: string) => {
      const v = resolvePath(ctx, path);
      return v === undefined || v === null || v === ""
        ? (fallback ?? "")
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
    },
  );
}

export function evaluate(op: ConditionOp, left: string, right = ""): boolean {
  switch (op) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "contains":
      return left.toLowerCase().includes(right.toLowerCase());
    case "not_contains":
      return !left.toLowerCase().includes(right.toLowerCase());
    case "gt":
      return (
        left.trim() !== "" &&
        right.trim() !== "" &&
        Number(left) > Number(right)
      );
    case "lt":
      return (
        left.trim() !== "" &&
        right.trim() !== "" &&
        Number(left) < Number(right)
      );
    case "exists":
      return left !== "";
    case "not_exists":
      return left === "";
  }
}
