"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  type Contact,
  type Mailbox,
  type Page,
  type Sequence,
  type SequenceStep,
} from "@/lib/api";

const DAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
] as const;

interface Stats {
  enrollments: Record<string, number>;
  events: Record<string, { total: number; unique: number }>;
  replyRate: number;
  bounceRate: number;
}

function StatsPanel({ base, id }: { base: string; id: string }) {
  const stats = useQuery({
    queryKey: [base, "stats", id],
    queryFn: () => api<Stats>(`${base}/sequences/${id}/stats`),
    refetchInterval: 5_000, // live numbers while emails go out and replies come in
    refetchOnMount: "always",
  });
  if (!stats.data)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  const s = stats.data;
  const cell = (label: string, value: number | string) => (
    <div className="rounded-md border p-3 text-center">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
  return (
    <div className="grid gap-3" aria-label="Sequence stats">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {cell(
          "Enrolled",
          Object.values(s.enrollments).reduce((a, b) => a + b, 0),
        )}
        {cell("Sent", s.events.sent?.total ?? 0)}
        {cell("Replies", s.events.reply?.unique ?? 0)}
        {cell(
          "Bounces",
          (s.events.bounce_hard?.unique ?? 0) +
            (s.events.bounce_soft?.unique ?? 0),
        )}
        {cell("Unsubscribed", s.events.unsubscribe?.unique ?? 0)}
      </div>
      <p className="text-xs text-muted-foreground">
        Reply rate {(s.replyRate * 100).toFixed(1)}% · bounce rate{" "}
        {(s.bounceRate * 100).toFixed(1)}%
        {Object.keys(s.enrollments).length > 0 &&
          ` · ${Object.entries(s.enrollments)
            .map(([k, v]) => `${v} ${k}`)
            .join(", ")}`}
      </p>
    </div>
  );
}

export default function SequencesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/api/w/${workspaceId}`;
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: [workspaceId, "sequences"] });
  const fail = (e: Error) => toast.error(e.message);
  const [creating, setCreating] = useState(false);
  const [steps, setSteps] = useState<SequenceStep[]>([
    { delayHours: 0, subject: "", body: "" },
  ]);
  const [enrollFor, setEnrollFor] = useState<string | null>(null);
  const [statsFor, setStatsFor] = useState<string | null>(null);

  const sequences = useQuery({
    queryKey: [workspaceId, "sequences"],
    queryFn: () => api<Sequence[]>(`${base}/sequences`),
  });
  const boxes = useQuery({
    queryKey: [workspaceId, "mailboxes"],
    queryFn: () => api<Mailbox[]>(`${base}/mailboxes`),
  });

  const create = useMutation({
    mutationFn: (body: object) => api(`${base}/sequences`, { body }),
    onSuccess: () => {
      toast.success("Sequence created as a draft");
      setCreating(false);
      setSteps([{ delayHours: 0, subject: "", body: "" }]);
      void refresh();
    },
    onError: fail,
  });
  const act = useMutation({
    mutationFn: (v: { id: string; action: "activate" | "pause" }) =>
      api(`${base}/sequences/${v.id}/${v.action}`, { body: {} }),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`${base}/sequences/${id}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const enroll = useMutation({
    mutationFn: async (v: { id: string; emails: string[] }) => {
      const ids: string[] = [];
      const missing: string[] = [];
      for (const email of v.emails) {
        const page = await api<Page<Contact>>(
          `${base}/contacts?q=${encodeURIComponent(email)}&limit=5`,
        );
        const hit = page.items.find((c) => c.email === email.toLowerCase());
        if (hit) ids.push(hit.id);
        else missing.push(email);
      }
      const result = ids.length
        ? await api<{ enrolled: number; skipped: { reason: string }[] }>(
            `${base}/sequences/${v.id}/enroll`,
            { body: { contactIds: ids } },
          )
        : { enrolled: 0, skipped: [] };
      return { ...result, missing };
    },
    onSuccess: (r) => {
      toast.success(
        `Enrolled ${r.enrolled}` +
          (r.skipped.length ? `, skipped ${r.skipped.length}` : "") +
          (r.missing.length
            ? `, not in contacts: ${r.missing.join(", ")}`
            : ""),
      );
      setEnrollFor(null);
      void qc.invalidateQueries({ queryKey: [base, "stats"] });
    },
    onError: fail,
  });

  return (
    <div className="grid max-w-3xl gap-6">
      <div className="flex items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold">Sequences</h1>
        <Button
          variant={creating ? "outline" : "signal"}
          onClick={() => setCreating((v) => !v)}
        >
          {creating ? "Cancel" : "New sequence"}
        </Button>
      </div>

      {creating && (
        <Card>
          <CardHeader>
            <CardTitle>New sequence</CardTitle>
            <CardDescription>
              Merge tags: {"{{first_name}}"}, {"{{last_name}}"}, {"{{company}}"}
              , {"{{email}}"}, or {"{{first_name | there}}"} for a fallback.
              Leave a follow-up&apos;s subject empty to reply in the same
              thread.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                create.mutate({
                  name: String(f.get("name")),
                  mailboxIds: f.getAll("mailbox").map(String),
                  timezone: String(f.get("timezone")),
                  windowStartHour: Number(f.get("start")),
                  windowEndHour: Number(f.get("end")),
                  sendDays: f.getAll("day").map(Number),
                  stopOnReply: f.get("stopOnReply") === "on",
                  trackOpens: f.get("trackOpens") === "on",
                  trackClicks: f.get("trackClicks") === "on",
                  footer: String(f.get("footer") ?? ""),
                  steps: steps.map((s) => ({
                    delayHours: s.delayHours,
                    subject: s.subject,
                    body: s.body,
                  })),
                });
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="sq-name">Name</Label>
                <Input id="sq-name" name="name" required />
              </div>

              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">
                  Send from (rotates between mailboxes)
                </legend>
                {boxes.data?.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Connect a mailbox first.
                  </p>
                )}
                {boxes.data?.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="mailbox"
                      value={m.id}
                      defaultChecked={boxes.data!.length === 1}
                    />
                    {m.email}
                  </label>
                ))}
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="sq-tz">Timezone</Label>
                  <Input
                    id="sq-tz"
                    name="timezone"
                    defaultValue={
                      Intl.DateTimeFormat().resolvedOptions().timeZone
                    }
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sq-start">Send from hour</Label>
                  <Input
                    id="sq-start"
                    name="start"
                    type="number"
                    min={0}
                    max={23}
                    defaultValue={9}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sq-end">Until hour</Label>
                  <Input
                    id="sq-end"
                    name="end"
                    type="number"
                    min={1}
                    max={24}
                    defaultValue={17}
                  />
                </div>
              </div>
              <fieldset className="flex flex-wrap gap-3">
                <legend className="mb-1 text-sm font-medium">Send on</legend>
                {DAYS.map(([n, label]) => (
                  <label key={n} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      name="day"
                      value={n}
                      defaultChecked={n <= 5}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>

              <div className="grid gap-3">
                <div className="text-sm font-medium">Steps</div>
                {steps.map((s, i) => (
                  <div key={i} className="grid gap-2 rounded-md border p-3">
                    <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
                      <div className="grid gap-1">
                        <Label htmlFor={`st-delay-${i}`}>
                          {i === 0 ? "Delay (hours)" : "Wait (hours)"}
                        </Label>
                        <Input
                          id={`st-delay-${i}`}
                          type="number"
                          min={0}
                          value={s.delayHours}
                          onChange={(e) =>
                            setSteps(
                              steps.map((x, j) =>
                                j === i
                                  ? { ...x, delayHours: Number(e.target.value) }
                                  : x,
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="grid gap-1">
                        <Label htmlFor={`st-subject-${i}`}>
                          Subject{i > 0 && " (empty = same thread)"}
                        </Label>
                        <Input
                          id={`st-subject-${i}`}
                          value={s.subject}
                          required={i === 0}
                          onChange={(e) =>
                            setSteps(
                              steps.map((x, j) =>
                                j === i ? { ...x, subject: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </div>
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor={`st-body-${i}`}>Email {i + 1}</Label>
                      <Textarea
                        id={`st-body-${i}`}
                        rows={4}
                        required
                        value={s.body}
                        onChange={(e) =>
                          setSteps(
                            steps.map((x, j) =>
                              j === i ? { ...x, body: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </div>
                    {steps.length > 1 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="justify-self-start"
                        onClick={() =>
                          setSteps(steps.filter((_, j) => j !== i))
                        }
                      >
                        Remove step
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  className="justify-self-start"
                  onClick={() =>
                    setSteps([
                      ...steps,
                      { delayHours: 72, subject: "", body: "" },
                    ])
                  }
                >
                  Add follow-up
                </Button>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="sq-footer">
                  Footer with your postal address (required to activate)
                </Label>
                <Textarea
                  id="sq-footer"
                  name="footer"
                  rows={2}
                  placeholder="Acme Inc, 1 Main St, Springfield, USA"
                />
              </div>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="stopOnReply" defaultChecked />{" "}
                  Stop when they reply
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="trackOpens" /> Track opens (can
                  hurt deliverability)
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="trackClicks" /> Track clicks
                </label>
              </div>
              <Button
                type="submit"
                className="justify-self-start"
                disabled={create.isPending}
              >
                Save draft
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3">
        {sequences.data?.length === 0 && (
          <EmptyState
            title="No sequences yet."
            actions={
              <Button onClick={() => setCreating(true)}>New sequence</Button>
            }
          >
            A sequence is a series of emails that sends inside working hours and
            stops by itself when someone replies.
          </EmptyState>
        )}
        {sequences.data?.map((s) => (
          <Card key={s.id}>
            <CardContent className="grid gap-3 pt-6">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="mr-auto text-base font-medium">{s.name}</span>
                <Badge
                  variant={s.status === "active" ? "default" : "secondary"}
                >
                  {s.status}
                </Badge>
                <span className="text-muted-foreground">
                  {s.steps.length} step(s)
                </span>
                {s.status === "active" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => act.mutate({ id: s.id, action: "pause" })}
                  >
                    Pause
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => act.mutate({ id: s.id, action: "activate" })}
                  >
                    Activate
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEnrollFor(enrollFor === s.id ? null : s.id)}
                >
                  Enroll
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setStatsFor(statsFor === s.id ? null : s.id)}
                >
                  Stats
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (confirm(`Delete "${s.name}" and its enrollments?`))
                      remove.mutate(s.id);
                  }}
                >
                  Delete
                </Button>
              </div>
              {enrollFor === s.id && (
                <form
                  className="grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = String(
                      new FormData(e.currentTarget).get("emails") ?? "",
                    );
                    const emails = [
                      ...new Set(
                        text
                          .split(/[\s,;]+/)
                          .map((x) => x.trim().toLowerCase())
                          .filter(Boolean),
                      ),
                    ];
                    if (emails.length) enroll.mutate({ id: s.id, emails });
                  }}
                >
                  <Label htmlFor={`en-${s.id}`}>
                    Contact emails (must already be in your contacts)
                  </Label>
                  <Textarea
                    id={`en-${s.id}`}
                    name="emails"
                    rows={3}
                    placeholder="ada@example.com, grace@example.com"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    className="justify-self-start"
                    disabled={enroll.isPending}
                  >
                    Enroll contacts
                  </Button>
                </form>
              )}
              {statsFor === s.id && <StatsPanel base={base} id={s.id} />}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
