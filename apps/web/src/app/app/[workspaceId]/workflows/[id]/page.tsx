"use client";

import "@xyflow/react/dist/style.css";
import {
  addEdge,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  api,
  type Channel,
  type Contact,
  type Page,
  type Sequence,
} from "@/lib/api";
import {
  EVENTS,
  LABELS,
  NODE_TYPES,
  TRIGGER_LABELS,
  type TriggerType,
  fromFlow,
  summary,
  toFlow,
  type Config,
  type Execution,
  type ExecutionDetail,
  type Workflow,
} from "@/lib/workflow";

function StepNode({ data, selected }: NodeProps) {
  const d = data as { kind: string; config: Config };
  return (
    <div
      className={`min-w-44 rounded-md border bg-card p-2 text-xs shadow-sm ${selected ? "ring-2 ring-signal" : ""}`}
      data-kind={d.kind}
    >
      {d.kind !== "trigger" && <Handle type="target" position={Position.Top} />}
      <div className="font-medium">{LABELS[d.kind] ?? d.kind}</div>
      <div className="max-w-52 truncate text-muted-foreground">
        {summary(d.kind, d.config)}
      </div>
      {d.kind === "condition" ? (
        <>
          <Handle
            type="source"
            id="true"
            position={Position.Bottom}
            style={{ left: "28%" }}
          />
          <Handle
            type="source"
            id="false"
            position={Position.Bottom}
            style={{ left: "72%" }}
          />
          <div className="mt-1 flex justify-between px-2 text-[10px] text-muted-foreground">
            <span>true</span>
            <span>false</span>
          </div>
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  );
}
const nodeTypes = { step: StepNode };

const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const toRecord = (s: string, sep: string) =>
  Object.fromEntries(
    lines(s)
      .map((l) => [
        l.slice(0, l.indexOf(sep)).trim(),
        l.slice(l.indexOf(sep) + 1).trim(),
      ])
      .filter(([k]) => k),
  );
const fromRecord = (r: unknown, sep: string) =>
  Object.entries((r as Record<string, string>) ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n");

function ConfigForm({
  kind,
  config,
  onChange,
  sequences,
  channels,
}: {
  kind: string;
  config: Config;
  onChange: (c: Config) => void;
  sequences: Sequence[];
  channels: Channel[];
}) {
  const set = (patch: Config) => onChange({ ...config, ...patch });
  const field = (label: string, el: React.ReactNode, id: string) => (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      {el}
    </div>
  );
  switch (kind) {
    case "wait":
      return field(
        "Minutes to wait",
        <Input
          id="cfg-minutes"
          type="number"
          min={0}
          value={Number(config.minutes ?? 0)}
          onChange={(e) => set({ minutes: Number(e.target.value) })}
        />,
        "cfg-minutes",
      );
    case "condition":
      return (
        <div className="grid gap-3">
          {field(
            "Value",
            <Input
              id="cfg-left"
              value={String(config.left ?? "")}
              onChange={(e) => set({ left: e.target.value })}
            />,
            "cfg-left",
          )}
          {field(
            "Operator",
            <select
              id="cfg-op"
              className="rounded-md border bg-transparent p-2 text-sm"
              value={String(config.op ?? "eq")}
              onChange={(e) => set({ op: e.target.value })}
            >
              {[
                "eq",
                "neq",
                "contains",
                "not_contains",
                "gt",
                "lt",
                "exists",
                "not_exists",
              ].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>,
            "cfg-op",
          )}
          {field(
            "Compare to",
            <Input
              id="cfg-right"
              value={String(config.right ?? "")}
              onChange={(e) => set({ right: e.target.value })}
            />,
            "cfg-right",
          )}
          <p className="text-xs text-muted-foreground">
            Connect the green handle for &quot;true&quot; and the other for
            &quot;false&quot;.
          </p>
        </div>
      );
    case "tag":
      return (
        <div className="grid gap-3">
          {field(
            "Add tags (comma separated)",
            <Input
              id="cfg-add"
              value={((config.add as string[]) ?? []).join(", ")}
              onChange={(e) => set({ add: csv(e.target.value) })}
            />,
            "cfg-add",
          )}
          {field(
            "Remove tags",
            <Input
              id="cfg-remove"
              value={((config.remove as string[]) ?? []).join(", ")}
              onChange={(e) => set({ remove: csv(e.target.value) })}
            />,
            "cfg-remove",
          )}
        </div>
      );
    case "update_contact":
      return field(
        "Fields (one per line: name=…, phone=…, source=…, custom.key=…)",
        <Textarea
          id="cfg-fields"
          rows={4}
          value={fromRecord(config.fields, "=")}
          onChange={(e) => set({ fields: toRecord(e.target.value, "=") })}
        />,
        "cfg-fields",
      );
    case "create_task":
      return (
        <div className="grid gap-3">
          {field(
            "Title",
            <Input
              id="cfg-title"
              value={String(config.title ?? "")}
              onChange={(e) => set({ title: e.target.value })}
            />,
            "cfg-title",
          )}
          {field(
            "Due in (hours, optional)",
            <Input
              id="cfg-due"
              type="number"
              min={0}
              value={
                config.dueInHours === undefined ? "" : Number(config.dueInHours)
              }
              onChange={(e) =>
                set({
                  dueInHours:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
            />,
            "cfg-due",
          )}
        </div>
      );
    case "add_note":
      return field(
        "Note",
        <Textarea
          id="cfg-body"
          rows={4}
          value={String(config.body ?? "")}
          onChange={(e) => set({ body: e.target.value })}
        />,
        "cfg-body",
      );
    case "http":
      return (
        <div className="grid gap-3">
          {field(
            "URL",
            <Input
              id="cfg-url"
              value={String(config.url ?? "")}
              onChange={(e) => set({ url: e.target.value })}
            />,
            "cfg-url",
          )}
          {field(
            "Method",
            <select
              id="cfg-method"
              className="rounded-md border bg-transparent p-2 text-sm"
              value={String(config.method ?? "POST")}
              onChange={(e) => set({ method: e.target.value })}
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>,
            "cfg-method",
          )}
          {field(
            "Headers (Name: value per line)",
            <Textarea
              id="cfg-headers"
              rows={2}
              value={fromRecord(config.headers, ": ")}
              onChange={(e) => set({ headers: toRecord(e.target.value, ":") })}
            />,
            "cfg-headers",
          )}
          {field(
            "Body",
            <Textarea
              id="cfg-hbody"
              rows={3}
              value={String(config.body ?? "")}
              onChange={(e) => set({ body: e.target.value })}
            />,
            "cfg-hbody",
          )}
        </div>
      );
    case "send_sms":
    case "voice_call":
      return (
        <div className="grid gap-3">
          {field(
            "Channel",
            <select
              id="cfg-channel"
              className="rounded-md border bg-transparent p-2 text-sm"
              value={String(config.channelId ?? "")}
              onChange={(e) => set({ channelId: e.target.value })}
            >
              <option value="">Choose…</option>
              {channels
                .filter((c) =>
                  kind === "voice_call"
                    ? c.type === "retell"
                    : c.type !== "retell",
                )
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.address})
                  </option>
                ))}
            </select>,
            "cfg-channel",
          )}
          {field(
            "To",
            <Input
              id="cfg-to"
              value={String(config.to ?? "")}
              onChange={(e) => set({ to: e.target.value })}
            />,
            "cfg-to",
          )}
          {kind === "send_sms"
            ? field(
                "Message",
                <Textarea
                  id="cfg-msg"
                  rows={3}
                  value={String(config.body ?? "")}
                  onChange={(e) => set({ body: e.target.value })}
                />,
                "cfg-msg",
              )
            : field(
                "Agent id (optional)",
                <Input
                  id="cfg-agent"
                  value={String(config.agentId ?? "")}
                  onChange={(e) =>
                    set({ agentId: e.target.value || undefined })
                  }
                />,
                "cfg-agent",
              )}
        </div>
      );
    case "ai":
      return (
        <div className="grid gap-3">
          {field(
            "Prompt",
            <Textarea
              id="cfg-prompt"
              rows={4}
              value={String(config.prompt ?? "")}
              onChange={(e) => set({ prompt: e.target.value })}
            />,
            "cfg-prompt",
          )}
          {field(
            "System instructions (optional)",
            <Textarea
              id="cfg-system"
              rows={2}
              value={String(config.system ?? "")}
              onChange={(e) => set({ system: e.target.value || undefined })}
            />,
            "cfg-system",
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!config.json}
              onChange={(e) => set({ json: e.target.checked })}
            />{" "}
            Ask for JSON
          </label>
          <p className="text-xs text-muted-foreground">
            The answer is available to later steps as{" "}
            {"{{steps.<id>.output.text}}"}.
          </p>
        </div>
      );
    case "enroll_sequence":
      return field(
        "Sequence",
        <select
          id="cfg-seq"
          className="rounded-md border bg-transparent p-2 text-sm"
          value={String(config.sequenceId ?? "")}
          onChange={(e) => set({ sequenceId: e.target.value })}
        >
          <option value="">Choose…</option>
          {sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>,
        "cfg-seq",
      );
    default:
      return (
        <p className="text-xs text-muted-foreground">
          This is where the workflow starts. Set when it starts above.
        </p>
      );
  }
}

// Loads the workflow, then mounts the editor with it as its starting state.
export default function WorkflowPage() {
  const { workspaceId, id } = useParams<{ workspaceId: string; id: string }>();
  const wf = useQuery({
    queryKey: [workspaceId, "workflow", id],
    queryFn: () => api<Workflow>(`/api/w/${workspaceId}/workflows/${id}`),
  });
  if (wf.isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (!wf.data) return <p>Workflow not found.</p>;
  return <Editor wf={wf.data} />;
}

function Editor({ wf: initial }: { wf: Workflow }) {
  const { workspaceId, id } = useParams<{ workspaceId: string; id: string }>();
  const base = `/api/w/${workspaceId}`;
  const qc = useQueryClient();
  const [flow] = useState(() => toFlow(initial.graph));
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(flow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(flow.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState(initial.name);
  const [triggerType, setTriggerType] = useState<TriggerType>(
    initial.triggerType,
  );
  const [scheduleMinutes, setScheduleMinutes] = useState(
    initial.scheduleMinutes ?? 60,
  );
  const [triggerEvent, setTriggerEvent] = useState(
    initial.triggerEvent ?? EVENTS[0]!,
  );
  const [problems, setProblems] = useState<string[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const counter = useRef(1);
  const flowRef = useRef<ReactFlowInstance | null>(null);

  // Status/version come from the server; the canvas state above is the user's working copy.
  const wf = useQuery({
    queryKey: [workspaceId, "workflow", id],
    queryFn: () => api<Workflow>(`${base}/workflows/${id}`),
    initialData: initial,
  });
  const sequences = useQuery({
    queryKey: [workspaceId, "sequences"],
    queryFn: () => api<Sequence[]>(`${base}/sequences`),
  });
  const channels = useQuery({
    queryKey: [workspaceId, "channels"],
    queryFn: () => api<Channel[]>(`${base}/channels`),
  });
  const runs = useQuery({
    queryKey: [workspaceId, "workflow", id, "runs"],
    queryFn: () =>
      api<Page<Execution>>(`${base}/workflows/${id}/executions?limit=10`),
    refetchInterval: 5_000,
  });
  const detail = useQuery({
    queryKey: [workspaceId, "execution", openRun],
    queryFn: () => api<ExecutionDetail>(`${base}/executions/${openRun}`),
    enabled: !!openRun,
    refetchInterval: 5_000,
  });

  const refresh = () =>
    qc.invalidateQueries({ queryKey: [workspaceId, "workflow", id] });
  const showError = (e: Error) => {
    const body =
      e instanceof ApiError
        ? (e.body as { problems?: string[] } | undefined)
        : undefined;
    setProblems(body?.problems ?? []);
    toast.error(e.message);
  };

  const save = useMutation({
    mutationFn: () =>
      api<Workflow>(`${base}/workflows/${id}`, {
        method: "PATCH",
        body: {
          name,
          triggerType,
          triggerEvent: triggerType === "event" ? triggerEvent : null,
          scheduleMinutes: triggerType === "schedule" ? scheduleMinutes : null,
          graph: fromFlow(nodes, edges),
        },
      }),
    onSuccess: () => {
      setProblems([]);
      toast.success("Workflow saved");
      void refresh();
    },
    onError: showError,
  });
  const setStatus = useMutation({
    mutationFn: (action: "activate" | "pause") =>
      api(`${base}/workflows/${id}/${action}`, { body: {} }),
    onSuccess: () => void refresh(),
    onError: showError,
  });
  const run = useMutation({
    mutationFn: async (email: string) => {
      let contactId: string | undefined;
      if (email) {
        const page = await api<Page<Contact>>(
          `${base}/contacts?q=${encodeURIComponent(email)}&limit=5`,
        );
        contactId = page.items.find((c) => c.email === email.toLowerCase())?.id;
        if (!contactId) throw new Error(`No contact with the email ${email}`);
      }
      return api<Execution>(`${base}/workflows/${id}/run`, {
        body: contactId ? { contactId } : {},
      });
    },
    onSuccess: (e) => {
      toast.success("Run started");
      setOpenRun(e.id);
      void qc.invalidateQueries({
        queryKey: [workspaceId, "workflow", id, "runs"],
      });
    },
    onError: showError,
  });

  const selected = nodes.find((n) => n.id === selectedId);
  const selectedData = selected?.data as
    { kind: string; config: Config } | undefined;

  function addStep(type: string) {
    const def = NODE_TYPES.find((n) => n.type === type)!;
    const nodeId = `${type}_${counter.current++}`;
    // New steps stack under the last one (so they are always on screen); drag to rearrange.
    const maxY = Math.max(0, ...nodes.map((n) => n.position.y));
    setNodes((ns) => [
      ...ns,
      {
        id: nodeId,
        type: "step",
        position: { x: 0, y: maxY + 130 },
        data: { kind: type, config: structuredClone(def.defaults) },
      },
    ]);
    setSelectedId(nodeId);
    setTimeout(() => void flowRef.current?.fitView({ padding: 0.3 }), 60);
  }

  function onConnect(c: Connection) {
    setEdges((es) =>
      addEdge(
        {
          ...c,
          label:
            c.sourceHandle === "true" || c.sourceHandle === "false"
              ? c.sourceHandle
              : undefined,
        },
        es,
      ),
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/app/${workspaceId}/workflows`}
          className="text-sm underline"
        >
          ← Workflows
        </Link>
        <Input
          aria-label="Workflow name"
          className="w-64"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Badge variant={wf.data.status === "active" ? "default" : "secondary"}>
          {wf.data.status}
        </Badge>
        <span className="text-xs text-muted-foreground">
          v{wf.data.version}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </Button>
          {wf.data.status === "active" ? (
            <Button variant="outline" onClick={() => setStatus.mutate("pause")}>
              Pause
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => setStatus.mutate("activate")}
            >
              Activate
            </Button>
          )}
        </div>
      </div>

      {problems.length > 0 && (
        <ul
          role="alert"
          className="list-disc rounded-md border border-destructive/40 bg-destructive/10 p-3 pl-6 text-sm text-destructive"
        >
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Add step:</span>
            {NODE_TYPES.map((n) => (
              <Button
                key={n.type}
                size="sm"
                variant="outline"
                title={n.help}
                onClick={() => addStep(n.type)}
              >
                {n.label}
              </Button>
            ))}
          </div>
          <div className="h-112 rounded-md border" aria-label="Workflow canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onInit={(instance) => (flowRef.current = instance)}
              onNodeClick={(_, n) => setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              fitView
            >
              <Background />
              <Controls />
            </ReactFlow>
          </div>
        </div>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">When it starts</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <select
                aria-label="Trigger type"
                className="rounded-md border bg-transparent p-2 text-sm"
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value as TriggerType)}
              >
                {Object.entries(TRIGGER_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              {triggerType === "schedule" && (
                <Label className="grid gap-1 text-xs">
                  Every (minutes, 5 or more)
                  <Input
                    type="number"
                    min={5}
                    value={scheduleMinutes}
                    onChange={(e) => setScheduleMinutes(Number(e.target.value))}
                  />
                </Label>
              )}
              {triggerType === "webhook" && (
                <p className="break-all text-xs text-muted-foreground">
                  {wf.data.webhookToken
                    ? `POST ${typeof window === "undefined" ? "" : window.location.origin}/api/hooks/${workspaceId}/workflows/${wf.data.webhookToken}`
                    : "Save to get the webhook URL."}{" "}
                  A JSON body becomes the event data; an <code>email</code>{" "}
                  field links (or creates) the contact.
                </p>
              )}
              {triggerType === "event" && (
                <select
                  aria-label="Trigger event"
                  className="rounded-md border bg-transparent p-2 text-sm"
                  value={triggerEvent}
                  onChange={(e) => setTriggerEvent(e.target.value)}
                >
                  {EVENTS.map((ev) => (
                    <option key={ev}>{ev}</option>
                  ))}
                </select>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                {selectedData ? LABELS[selectedData.kind] : "Step settings"}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {!selectedData && (
                <p className="text-sm text-muted-foreground">
                  Select a step on the canvas.
                </p>
              )}
              {selectedData && selected && (
                <>
                  <ConfigForm
                    kind={selectedData.kind}
                    config={selectedData.config}
                    sequences={sequences.data ?? []}
                    channels={channels.data ?? []}
                    onChange={(config) =>
                      setNodes((ns) =>
                        ns.map((n) =>
                          n.id === selected.id
                            ? { ...n, data: { ...n.data, config } }
                            : n,
                        ),
                      )
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Templates: {"{{contact.email}}"},{" "}
                    {"{{contact.name | fallback}}"}, {"{{event.data.title}}"},{" "}
                    {"{{steps.<id>.output.status}}"}
                  </p>
                  {selectedData.kind !== "trigger" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="justify-self-start"
                      onClick={() => {
                        setNodes((ns) =>
                          ns.filter((n) => n.id !== selected.id),
                        );
                        setEdges((es) =>
                          es.filter(
                            (e) =>
                              e.source !== selected.id &&
                              e.target !== selected.id,
                          ),
                        );
                        setSelectedId(null);
                      }}
                    >
                      Delete step
                    </Button>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Runs</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate(
                String(new FormData(e.currentTarget).get("email") ?? "").trim(),
              );
            }}
          >
            <Input
              name="email"
              aria-label="Contact email to run for"
              placeholder="Contact email (optional)"
              className="w-64"
            />
            <Button type="submit" variant="outline" disabled={run.isPending}>
              Run now
            </Button>
          </form>
          {runs.data?.items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No runs yet. Save, then activate or run it.
            </p>
          )}
          {runs.data?.items.map((r) => (
            <div key={r.id} className="grid gap-2 text-sm">
              <button
                className="flex items-center gap-2 text-left"
                onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
              >
                <Badge
                  variant={r.status === "failed" ? "default" : "secondary"}
                >
                  {r.status}
                </Badge>
                <span>{new Date(r.startedAt).toLocaleString()}</span>
                <span className="text-muted-foreground">
                  v{r.workflowVersion}
                </span>
                {r.error && (
                  <span className="truncate text-destructive">{r.error}</span>
                )}
              </button>
              {openRun === r.id && detail.data && (
                <ul
                  className="grid gap-1 rounded-md border p-2"
                  aria-label="Run steps"
                >
                  {detail.data.steps.map((s) => (
                    <li
                      key={s.id}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <Badge variant="secondary">{s.status}</Badge>
                      <span className="font-medium">{s.nodeId}</span>
                      {s.error && (
                        <span className="text-destructive">{s.error}</span>
                      )}
                      {s.output && Object.keys(s.output).length > 0 && (
                        <code className="truncate text-xs text-muted-foreground">
                          {JSON.stringify(s.output)}
                        </code>
                      )}
                    </li>
                  ))}
                  <li className="flex gap-2 pt-1">
                    {r.status === "running" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          api(`${base}/executions/${r.id}/cancel`, {
                            body: {},
                          }).then(() => runs.refetch())
                        }
                      >
                        Cancel
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        api<Execution>(`${base}/executions/${r.id}/replay`, {
                          body: {},
                        }).then((e) => {
                          setOpenRun(e.id);
                          void runs.refetch();
                        })
                      }
                    >
                      Replay
                    </Button>
                  </li>
                </ul>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
