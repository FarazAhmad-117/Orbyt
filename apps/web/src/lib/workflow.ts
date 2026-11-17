import type { Edge, Node } from "@xyflow/react";

export type Config = Record<string, unknown>;
export interface GraphNode {
  id: string;
  type: string;
  config: Config;
}
export interface GraphEdge {
  from: string;
  to: string;
  label?: "true" | "false";
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface Workflow {
  id: string;
  name: string;
  status: "draft" | "active" | "paused";
  triggerType: "event" | "manual";
  triggerEvent: string | null;
  graph: Graph;
  version: number;
}
export interface Execution {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  error: string | null;
  startedAt: string;
  workflowVersion: number;
}
export interface ExecutionDetail extends Execution {
  steps: {
    id: string;
    nodeId: string;
    status: string;
    attempts: number;
    error: string | null;
    output: Config | null;
  }[];
}

export const EVENTS = [
  "contact.created",
  "contact.updated",
  "contact.tagged",
  "contact.unsubscribed",
  "contacts.imported",
  "company.created",
  "deal.created",
  "deal.moved",
  "deal.won",
  "deal.lost",
  "task.created",
  "task.completed",
  "note.added",
  "email.sent",
  "email.replied",
  "email.bounced",
  "sequence.enrolled",
];

export const NODE_TYPES: {
  type: string;
  label: string;
  help: string;
  defaults: Config;
}[] = [
  {
    type: "wait",
    label: "Wait",
    help: "Pause the flow",
    defaults: { minutes: 60 },
  },
  {
    type: "condition",
    label: "If / else",
    help: "Branch on a value",
    defaults: { left: "{{contact.email}}", op: "contains", right: "" },
  },
  {
    type: "tag",
    label: "Tag contact",
    help: "Add or remove tags",
    defaults: { add: [], remove: [] },
  },
  {
    type: "update_contact",
    label: "Update contact",
    help: "Set fields",
    defaults: { fields: { source: "workflow" } },
  },
  {
    type: "create_task",
    label: "Create task",
    help: "Add a to-do",
    defaults: { title: "Follow up with {{contact.name | the contact}}" },
  },
  {
    type: "add_note",
    label: "Add note",
    help: "Write a note",
    defaults: { body: "" },
  },
  {
    type: "http",
    label: "HTTP request",
    help: "Call a URL",
    defaults: { url: "https://", method: "POST", headers: {}, body: "" },
  },
  {
    type: "enroll_sequence",
    label: "Enroll in sequence",
    help: "Start an email sequence",
    defaults: { sequenceId: "" },
  },
  {
    type: "send_sms",
    label: "Send SMS / WhatsApp",
    help: "Text a contact",
    defaults: {
      channelId: "",
      to: "{{contact.phone}}",
      body: "Hi {{contact.name | there}}!",
    },
  },
  {
    type: "voice_call",
    label: "Voice call",
    help: "Place an AI voice call",
    defaults: { channelId: "", to: "{{contact.phone}}" },
  },
  {
    type: "ai",
    label: "AI step",
    help: "Ask your AI provider",
    defaults: {
      prompt: "Summarise this contact: {{contact.name}} {{contact.email}}",
      json: false,
    },
  },
];
export const LABELS: Record<string, string> = {
  trigger: "Trigger",
  ...Object.fromEntries(NODE_TYPES.map((n) => [n.type, n.label])),
};

/** One-line summary shown on a node card. */
export function summary(type: string, c: Config): string {
  switch (type) {
    case "wait":
      return `${c.minutes ?? 0} min`;
    case "condition":
      return `${c.left ?? ""} ${c.op ?? ""} ${c.right ?? ""}`.trim();
    case "tag":
      return [
        (c.add as string[] | undefined)?.length
          ? `+${(c.add as string[]).join(", ")}`
          : "",
        (c.remove as string[] | undefined)?.length
          ? `-${(c.remove as string[]).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    case "update_contact":
      return Object.keys((c.fields as object) ?? {}).join(", ");
    case "create_task":
      return String(c.title ?? "");
    case "add_note":
      return String(c.body ?? "").slice(0, 40);
    case "http":
      return `${c.method ?? "POST"} ${c.url ?? ""}`;
    case "ai":
      return String(c.prompt ?? "").slice(0, 40);
    case "send_sms":
      return `${c.to ?? ""}: ${String(c.body ?? "").slice(0, 30)}`;
    case "voice_call":
      return String(c.to ?? "");
    default:
      return "";
  }
}

/** Layered auto-layout: x by depth from the trigger, y by order within a depth. */
export function toFlow(graph: Graph): { nodes: Node[]; edges: Edge[] } {
  const depth = new Map<string, number>();
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  const queue: string[] = trigger ? [trigger.id] : [];
  if (trigger) depth.set(trigger.id, 0);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of graph.edges.filter((x) => x.from === cur)) {
      const d = (depth.get(cur) ?? 0) + 1;
      if (!depth.has(e.to) || d > depth.get(e.to)!) {
        depth.set(e.to, d);
        queue.push(e.to);
      }
    }
  }
  const rows = new Map<number, number>();
  return {
    nodes: graph.nodes.map((n) => {
      const d = depth.get(n.id) ?? 0;
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);
      return {
        id: n.id,
        type: "step",
        position: { x: row * 260, y: d * 130 },
        data: { kind: n.type, config: n.config },
      };
    }),
    edges: graph.edges.map((e) => ({
      id: `${e.from}->${e.to}${e.label ? `:${e.label}` : ""}`,
      source: e.from,
      target: e.to,
      sourceHandle: e.label,
      label: e.label,
    })),
  };
}

export function fromFlow(nodes: Node[], edges: Edge[]): Graph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: (n.data as { kind: string }).kind,
      config: (n.data as { config: Config }).config,
    })),
    edges: edges.map((e) => ({
      from: e.source,
      to: e.target,
      ...(e.sourceHandle === "true" || e.sourceHandle === "false"
        ? { label: e.sourceHandle }
        : {}),
    })),
  };
}
