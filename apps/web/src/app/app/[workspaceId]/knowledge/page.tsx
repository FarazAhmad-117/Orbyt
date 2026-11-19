"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

interface Doc {
  id: string;
  title: string;
  size: number;
}
interface Agent {
  id: string;
  name: string;
  welcome: string;
  systemPrompt: string;
  status: "active" | "paused";
  url: string;
}

const fail = (e: Error) => toast.error(e.message);

function Documents({
  base,
  workspaceId,
}: {
  base: string;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const key = [workspaceId, "kb"];
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const docs = useQuery({
    queryKey: key,
    queryFn: () => api<Doc[]>(`${base}/kb`),
  });
  const add = useMutation({
    mutationFn: (body: { title: string; body: string }) =>
      api(`${base}/kb`, { body }),
    onSuccess: () => {
      toast.success("Document added");
      refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${base}/kb/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: fail,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Knowledge base</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          Facts about your business. Chat agents answer from these, and email
          reply drafts use them too.
        </p>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            add.mutate({
              title: String(f.get("title")),
              body: String(f.get("body")),
            });
            e.currentTarget.reset();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="kb-title">Title</Label>
            <Input
              id="kb-title"
              name="title"
              required
              placeholder="Opening hours"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="kb-body">Content</Label>
            <Textarea
              id="kb-body"
              name="body"
              required
              rows={4}
              placeholder="We are open 9 to 5 on weekdays…"
            />
          </div>
          <Button
            type="submit"
            className="justify-self-start"
            disabled={add.isPending}
          >
            Add document
          </Button>
        </form>
        {docs.data?.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{d.title}</span>
            <span className="text-muted-foreground">{d.size} characters</span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => remove.mutate(d.id)}
            >
              Delete
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Ask({ base }: { base: string }) {
  const [answer, setAnswer] = useState<{
    answer: string;
    sources: { id: string; title: string }[];
  } | null>(null);
  const ask = useMutation({
    mutationFn: (question: string) =>
      api<{ answer: string; sources: { id: string; title: string }[] }>(
        `${base}/kb/ask`,
        { body: { question } },
      ),
    onSuccess: setAnswer,
    onError: fail,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Try it</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <form
          className="flex flex-wrap gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            ask.mutate(String(new FormData(e.currentTarget).get("q")));
          }}
        >
          <Input
            name="q"
            required
            aria-label="Question"
            placeholder="Ask a question a customer might ask"
            className="min-w-64 flex-1"
          />
          <Button type="submit" disabled={ask.isPending}>
            Ask
          </Button>
        </form>
        {answer && (
          <div
            role="status"
            className="rounded-md border p-3 text-sm"
            data-testid="kb-answer"
          >
            <p>{answer.answer}</p>
            {answer.sources.length > 0 && (
              <p className="mt-2 text-muted-foreground">
                From: {answer.sources.map((s) => s.title).join(", ")}
              </p>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Needs an AI provider (Settings → AI providers).
        </p>
      </CardContent>
    </Card>
  );
}

function Agents({ base, workspaceId }: { base: string; workspaceId: string }) {
  const qc = useQueryClient();
  const key = [workspaceId, "chat-agents"];
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const agents = useQuery({
    queryKey: key,
    queryFn: () => api<Agent[]>(`${base}/chat-agents`),
  });
  const add = useMutation({
    mutationFn: (body: object) => api(`${base}/chat-agents`, { body }),
    onSuccess: () => {
      toast.success("Chat agent created");
      refresh();
    },
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) =>
      api(`${base}/chat-agents/${id}`, { method: "PATCH", body }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`${base}/chat-agents/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: fail,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat agents</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          A public endpoint for a website chat widget: visitors ask, the agent
          answers from your knowledge base, and anyone who leaves an email
          becomes a contact. Uses your AI provider and monthly cap.
        </p>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            add.mutate({
              name: String(f.get("name")),
              systemPrompt: String(f.get("prompt") ?? ""),
            });
            e.currentTarget.reset();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="ag-name">Name</Label>
            <Input id="ag-name" name="name" required placeholder="Support" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ag-prompt">Instructions (optional)</Label>
            <Input
              id="ag-prompt"
              name="prompt"
              placeholder="Friendly, concise, never promise discounts"
            />
          </div>
          <Button
            type="submit"
            className="justify-self-start"
            disabled={add.isPending}
          >
            Create agent
          </Button>
        </form>
        {agents.data?.map((a) => (
          <div key={a.id} className="grid gap-2 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="mr-auto text-base font-medium">{a.name}</span>
              <Badge variant={a.status === "active" ? "default" : "secondary"}>
                {a.status}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  patch.mutate({
                    id: a.id,
                    body: {
                      status: a.status === "active" ? "paused" : "active",
                    },
                  })
                }
              >
                {a.status === "active" ? "Pause" : "Resume"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => remove.mutate(a.id)}
              >
                Delete
              </Button>
            </div>
            <span className="text-muted-foreground">
              POST <code className="break-all">{a.url}</code> with{" "}
              <code>{`{"message": "…", "email": "optional"}`}</code>
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function KnowledgePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/api/w/${workspaceId}`;
  return (
    <div className="grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold">Knowledge &amp; chat</h1>
      <Documents base={base} workspaceId={workspaceId} />
      <Ask base={base} />
      <Agents base={base} workspaceId={workspaceId} />
    </div>
  );
}
