"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, money, type Deal, type Page, type Pipeline } from "@/lib/api";

export default function DealsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/api/w/${workspaceId}`;
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = () =>
    qc.invalidateQueries({ queryKey: [workspaceId, "deals"] });
  const fail = (e: Error) => toast.error(e.message);

  const pipelines = useQuery({
    queryKey: [workspaceId, "deals", "pipelines"],
    queryFn: () => api<Pipeline[]>(`${base}/pipelines`),
  });
  const pipeline =
    pipelines.data?.find((p) => p.id === selected) ?? pipelines.data?.[0];
  const deals = useQuery({
    queryKey: [workspaceId, "deals", "list", pipeline?.id],
    queryFn: () =>
      api<Page<Deal>>(`${base}/deals?pipelineId=${pipeline!.id}&limit=200`),
    enabled: !!pipeline,
  });

  const createPipeline = useMutation({
    mutationFn: () =>
      api(`${base}/pipelines`, {
        body: {
          name: "Sales",
          stages: ["Lead", "Qualified", "Proposal", "Closed"],
        },
      }),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const addDeal = useMutation({
    mutationFn: (body: { title: string; valueCents: number }) =>
      api(`${base}/deals`, { body: { ...body, pipelineId: pipeline!.id } }),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const move = useMutation({
    mutationFn: (v: { id: string; stageId: string }) =>
      api(`${base}/deals/${v.id}/move`, { body: { stageId: v.stageId } }),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: Deal["status"] }) =>
      api(`${base}/deals/${v.id}`, {
        method: "PATCH",
        body: { status: v.status },
      }),
    onSuccess: () => void refresh(),
    onError: fail,
  });

  if (pipelines.isLoading) return <p className="text-zinc-500">Loading…</p>;
  if (!pipeline)
    return (
      <div className="grid gap-4">
        <h1 className="text-2xl font-semibold">Deals</h1>
        <p className="text-zinc-600">You have no pipeline yet.</p>
        <Button
          className="justify-self-start"
          onClick={() => createPipeline.mutate()}
        >
          Create a default sales pipeline
        </Button>
      </div>
    );

  const stages = [...pipeline.stages].sort((a, b) => a.position - b.position);
  const items = deals.data?.items ?? [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold">Deals</h1>
        {pipelines.data!.length > 1 && (
          <select
            aria-label="Pipeline"
            className="rounded-md border bg-transparent p-2 text-sm"
            value={pipeline.id}
            onChange={(e) => setSelected(e.target.value)}
          >
            {pipelines.data!.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            addDeal.mutate({
              title: String(f.get("title")),
              valueCents: Math.round(Number(f.get("value") || 0) * 100),
            });
            e.currentTarget.reset();
          }}
        >
          <Input
            name="title"
            aria-label="Deal title"
            placeholder="New deal"
            required
            className="w-48"
          />
          <Input
            name="value"
            aria-label="Deal value"
            type="number"
            min="0"
            step="0.01"
            placeholder="Value"
            className="w-28"
          />
          <Button type="submit" disabled={addDeal.isPending}>
            Add deal
          </Button>
        </form>
      </div>

      <div className="grid gap-4 md:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
        {stages.map((stage, i) => (
          <Card key={stage.id} data-testid={`stage-${stage.name}`}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-sm">
                {stage.name}
                <Badge variant="secondary">
                  {items.filter((d) => d.stageId === stage.id).length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {items
                .filter((d) => d.stageId === stage.id)
                .map((d) => (
                  <div
                    key={d.id}
                    className="grid gap-2 rounded-md border p-3 text-sm"
                  >
                    <div className="font-medium">{d.title}</div>
                    <div className="flex items-center justify-between text-zinc-500">
                      <span>{money(d.valueCents, d.currency)}</span>
                      {d.status !== "open" && <Badge>{d.status}</Badge>}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Move ${d.title} back`}
                        disabled={i === 0}
                        onClick={() =>
                          move.mutate({ id: d.id, stageId: stages[i - 1]!.id })
                        }
                      >
                        ◀
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Move ${d.title} forward`}
                        disabled={i === stages.length - 1}
                        onClick={() =>
                          move.mutate({ id: d.id, stageId: stages[i + 1]!.id })
                        }
                      >
                        ▶
                      </Button>
                      {d.status === "open" ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setStatus.mutate({ id: d.id, status: "won" })
                            }
                          >
                            Won
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setStatus.mutate({ id: d.id, status: "lost" })
                            }
                          >
                            Lost
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setStatus.mutate({ id: d.id, status: "open" })
                          }
                        >
                          Reopen
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
