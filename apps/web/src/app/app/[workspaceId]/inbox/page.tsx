"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, type Conversation, type MailMessage, type Page } from "@/lib/api";

type Thread = Conversation & { messages: MailMessage[] };

export default function InboxPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/api/w/${workspaceId}/inbox`;
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<"open" | "unread" | "closed">("open");
  const refresh = () =>
    qc.invalidateQueries({ queryKey: [workspaceId, "inbox"] });
  const fail = (e: Error) => toast.error(e.message);

  const params =
    filter === "unread" ? "status=open&unread=true" : `status=${filter}`;
  const list = useQuery({
    queryKey: [workspaceId, "inbox", "list", filter],
    queryFn: () =>
      api<Page<Conversation>>(`${base}/conversations?${params}&limit=50`),
    refetchInterval: 5_000, // new replies show up without a manual refresh
    refetchOnWindowFocus: true,
  });
  const thread = useQuery({
    queryKey: [workspaceId, "inbox", "thread", selected],
    queryFn: () => api<Thread>(`${base}/conversations/${selected}`),
    enabled: !!selected,
  });

  const sync = useMutation({
    mutationFn: () =>
      api<{ processed: number; errors: { error: string }[] }>(`${base}/sync`, {
        body: {},
      }),
    onSuccess: (r) => {
      toast.success(
        r.processed ? `${r.processed} new message(s)` : "No new mail",
      );
      r.errors.forEach((e) => toast.error(e.error));
      void refresh();
    },
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: (body: { status?: "open" | "closed"; read?: boolean }) =>
      api(`${base}/conversations/${selected}`, { method: "PATCH", body }),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const reply = useMutation({
    mutationFn: (body: string) =>
      api(`${base}/conversations/${selected}/reply`, { body: { body } }),
    onSuccess: () => {
      toast.success("Reply sent");
      void refresh();
    },
    onError: fail,
  });

  const replyRef = useRef<HTMLTextAreaElement>(null);
  const classify = useMutation({
    mutationFn: () =>
      api<{ label: string; summary: string }>(
        `/api/w/${workspaceId}/ai/conversations/${selected}/classify`,
        { body: {} },
      ),
    onSuccess: (r) => {
      toast.success(`${r.label.replace("_", " ")}: ${r.summary}`);
      void refresh();
    },
    onError: fail,
  });
  const draft = useMutation({
    mutationFn: () =>
      api<{ draft: string }>(
        `/api/w/${workspaceId}/ai/conversations/${selected}/draft`,
        { body: {} },
      ),
    onSuccess: (r) => {
      // Never sent automatically: it lands in the reply box for a human to read and edit.
      if (replyRef.current) replyRef.current.value = r.draft;
    },
    onError: fail,
  });

  function open(c: Conversation) {
    setSelected(c.id);
    if (c.hasUnread)
      void api(`${base}/conversations/${c.id}`, {
        method: "PATCH",
        body: { read: true },
      }).then(() => refresh());
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">Inbox</h1>
        {(["open", "unread", "closed"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f[0]!.toUpperCase() + f.slice(1)}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
        >
          {sync.isPending ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <ul className="grid content-start gap-2" aria-label="Conversations">
          {list.data?.items.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => open(c)}
                aria-current={selected === c.id ? "true" : undefined}
                className={`w-full rounded-md border p-3 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 ${
                  selected === c.id ? "bg-zinc-100 dark:bg-zinc-800" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`truncate ${c.hasUnread ? "font-semibold" : ""}`}
                  >
                    {c.contactEmail ?? "Unknown sender"}
                  </span>
                  {c.hasUnread && <Badge>new</Badge>}
                  {c.channel !== "email" && (
                    <Badge variant="secondary">{c.channel}</Badge>
                  )}
                  {c.aiLabel && (
                    <Badge variant="secondary">
                      {c.aiLabel.replace("_", " ")}
                    </Badge>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-zinc-500">
                    {new Date(c.lastMessageAt).toLocaleDateString()}
                  </span>
                </div>
                <div className="truncate">{c.subject}</div>
                <div className="truncate text-zinc-500">{c.snippet}</div>
              </button>
            </li>
          ))}
          {list.data && list.data.items.length === 0 && (
            <li className="text-sm text-zinc-500">Nothing here.</li>
          )}
        </ul>

        <Card>
          <CardContent className="grid gap-4 pt-6">
            {!selected && (
              <p className="text-sm text-zinc-500">Select a conversation.</p>
            )}
            {thread.data && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="mr-auto text-lg font-medium">
                    {thread.data.subject}
                  </h2>
                  {thread.data.aiLabel && (
                    <Badge
                      variant="secondary"
                      title={thread.data.aiSummary ?? undefined}
                    >
                      {thread.data.aiLabel.replace("_", " ")}
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => classify.mutate()}
                    disabled={classify.isPending}
                  >
                    {classify.isPending ? "Classifying…" : "Classify"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => draft.mutate()}
                    disabled={draft.isPending}
                  >
                    {draft.isPending ? "Drafting…" : "Draft with AI"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      patch.mutate({
                        status:
                          thread.data!.status === "open" ? "closed" : "open",
                      })
                    }
                  >
                    {thread.data.status === "open" ? "Close" : "Reopen"}
                  </Button>
                </div>
                <div className="grid gap-3">
                  {thread.data.messages.map((m) => (
                    <article
                      key={m.id}
                      className={`rounded-md border p-3 text-sm ${m.direction === "out" ? "bg-zinc-50 dark:bg-zinc-900" : ""}`}
                    >
                      <div className="mb-1 flex gap-2 text-xs text-zinc-500">
                        <span>
                          {m.direction === "out" ? "You" : m.fromEmail}
                        </span>
                        <span className="ml-auto">
                          {new Date(m.at).toLocaleString()}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap">{m.bodyText}</p>
                    </article>
                  ))}
                </div>
                <form
                  className="grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const el = e.currentTarget.elements.namedItem(
                      "reply",
                    ) as HTMLTextAreaElement;
                    if (!el.value.trim()) return;
                    reply.mutate(el.value.trim(), {
                      onSuccess: () => (el.value = ""),
                    });
                  }}
                >
                  <Textarea
                    ref={replyRef}
                    name="reply"
                    aria-label="Reply"
                    placeholder="Write a reply…"
                    rows={4}
                  />
                  <Button
                    type="submit"
                    className="justify-self-start"
                    disabled={reply.isPending}
                  >
                    Send reply
                  </Button>
                </form>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
