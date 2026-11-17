"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import {
  EVENTS,
  TRIGGER_LABELS,
  type TriggerType,
  type Workflow,
} from "@/lib/workflow";

export default function WorkflowsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/api/w/${workspaceId}`;
  const router = useRouter();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [triggerType, setTriggerType] = useState<TriggerType>("event");

  const list = useQuery({
    queryKey: [workspaceId, "workflows"],
    queryFn: () => api<Workflow[]>(`${base}/workflows`),
  });
  const create = useMutation({
    mutationFn: (body: object) => api<Workflow>(`${base}/workflows`, { body }),
    onSuccess: (wf) => router.push(`/app/${workspaceId}/workflows/${wf.id}`),
    onError: (e: Error) => toast.error(e.message),
  });
  const templates = useQuery({
    queryKey: [workspaceId, "workflow-templates"],
    queryFn: () =>
      api<{ key: string; name: string; description: string }[]>(
        `${base}/workflow-templates`,
      ),
  });
  const fromTemplate = useMutation({
    mutationFn: (key: string) =>
      api<Workflow>(`${base}/workflow-templates/${key}/use`, { body: {} }),
    onSuccess: (wf) => router.push(`/app/${workspaceId}/workflows/${wf.id}`),
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`${base}/workflows/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: [workspaceId, "workflows"] }),
  });

  return (
    <div className="grid max-w-3xl gap-6">
      <div className="flex items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold">Workflows</h1>
        <Button onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "New workflow"}
        </Button>
      </div>

      {creating && (
        <Card>
          <CardHeader>
            <CardTitle>New workflow</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                create.mutate({
                  name: String(f.get("name")),
                  triggerType,
                  ...(triggerType === "event"
                    ? { triggerEvent: String(f.get("event")) }
                    : {}),
                  ...(triggerType === "schedule"
                    ? { scheduleMinutes: Number(f.get("minutes")) }
                    : {}),
                  graph: {
                    nodes: [{ id: "trigger", type: "trigger", config: {} }],
                    edges: [],
                  },
                });
              }}
            >
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="wf-name">Name</Label>
                <Input id="wf-name" name="name" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="wf-trigger">Starts</Label>
                <select
                  id="wf-trigger"
                  className="rounded-md border bg-transparent p-2 text-sm"
                  value={triggerType}
                  onChange={(e) =>
                    setTriggerType(e.target.value as TriggerType)
                  }
                >
                  {Object.entries(TRIGGER_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {triggerType === "schedule" && (
                <div className="grid gap-2">
                  <Label htmlFor="wf-minutes">Every (minutes, 5 or more)</Label>
                  <Input
                    id="wf-minutes"
                    name="minutes"
                    type="number"
                    min={5}
                    defaultValue={60}
                    required
                  />
                </div>
              )}
              {triggerType === "event" && (
                <div className="grid gap-2">
                  <Label htmlFor="wf-event">Event</Label>
                  <select
                    id="wf-event"
                    name="event"
                    className="rounded-md border bg-transparent p-2 text-sm"
                  >
                    {EVENTS.map((ev) => (
                      <option key={ev}>{ev}</option>
                    ))}
                  </select>
                </div>
              )}
              <Button
                type="submit"
                className="justify-self-start"
                disabled={create.isPending}
              >
                Create and open editor
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {creating && (
        <Card>
          <CardHeader>
            <CardTitle>Or start from a template</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {templates.data?.map((t) => (
              <div
                key={t.key}
                className="grid gap-2 rounded-md border p-3 text-sm"
              >
                <span className="font-medium">{t.name}</span>
                <span className="text-zinc-500">{t.description}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="justify-self-start"
                  disabled={fromTemplate.isPending}
                  onClick={() => fromTemplate.mutate(t.key)}
                >
                  Use this template
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3">
        {list.data?.length === 0 && (
          <p className="text-zinc-500">No workflows yet.</p>
        )}
        {list.data?.map((w) => (
          <Card key={w.id}>
            <CardContent className="flex flex-wrap items-center gap-3 pt-6 text-sm">
              <Link
                href={`/app/${workspaceId}/workflows/${w.id}`}
                className="mr-auto text-base font-medium underline"
              >
                {w.name}
              </Link>
              <span className="text-zinc-500">
                {w.triggerType === "event"
                  ? w.triggerEvent
                  : w.triggerType === "schedule"
                    ? `every ${w.scheduleMinutes} min`
                    : w.triggerType}
              </span>
              <span className="text-zinc-500">
                {w.graph.nodes.length - 1} step(s)
              </span>
              <Badge variant={w.status === "active" ? "default" : "secondary"}>
                {w.status}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (confirm(`Delete "${w.name}"?`)) remove.mutate(w.id);
                }}
              >
                Delete
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
