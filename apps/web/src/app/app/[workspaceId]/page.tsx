"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  api,
  type Activity,
  type Conversation,
  type Mailbox,
  type Page,
  type Sequence,
  type Workspace,
} from "@/lib/api";
import type { Workflow } from "@/lib/workflow";

type Tone = "ok" | "warn" | "destructive" | "secondary";
interface Service {
  slug: string;
  name: string;
  tone: Tone;
  status: string;
  detail: string;
  /** The number that matters for this service: connected, active, unread, live. */
  count: number;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

// "email.replied" -> "Email replied": the event names the API emits, read as plain words.
const humanize = (type: string) => {
  const s = type.replace(/[._]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const whatItWas = (a: Activity) => {
  const d = a.data;
  for (const k of ["email", "title", "name", "subject"])
    if (typeof d[k] === "string" && d[k]) return String(d[k]);
  return "";
};
const stamp = (iso: string) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${time}`;
};

/** The workspace at a glance: is everything running, and what has just happened. */
export default function TodayPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/api/w/${workspaceId}`;
  const key = (k: string) => [workspaceId, "today", k];

  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<Workspace[]>("/api/me/workspaces"),
  });
  const mailboxes = useQuery({
    queryKey: key("mailboxes"),
    queryFn: () => api<Mailbox[]>(`${base}/mailboxes`),
  });
  const sequences = useQuery({
    queryKey: key("sequences"),
    queryFn: () => api<Sequence[]>(`${base}/sequences`),
  });
  const workflows = useQuery({
    queryKey: key("workflows"),
    queryFn: () => api<Workflow[]>(`${base}/workflows`),
  });
  const forms = useQuery({
    queryKey: key("forms"),
    queryFn: () => api<{ status: string }[]>(`${base}/forms`),
  });
  const inbox = useQuery({
    queryKey: key("inbox"),
    queryFn: () =>
      api<Page<Conversation>>(`${base}/conversations?status=open&limit=50`),
  });
  const feed = useQuery({
    queryKey: key("feed"),
    queryFn: () => api<Page<Activity>>(`${base}/timeline?limit=12`),
    refetchInterval: 15_000,
  });

  const boxes = mailboxes.data ?? [];
  const broken = boxes.filter((m) => m.status === "error").length;
  const activeSeq = (sequences.data ?? []).filter(
    (s) => s.status === "active",
  ).length;
  const activeWf = (workflows.data ?? []).filter(
    (w) => w.status === "active",
  ).length;
  const activeForms = (forms.data ?? []).filter(
    (f) => f.status === "active",
  ).length;
  const unread = (inbox.data?.items ?? []).filter((c) => c.hasUnread).length;

  const services: Service[] = [
    {
      slug: "mailboxes",
      name: "Mailboxes",
      count: boxes.length,
      tone: boxes.length === 0 ? "warn" : broken ? "destructive" : "ok",
      status:
        boxes.length === 0
          ? "Not set up"
          : broken
            ? "Needs attention"
            : "Running",
      detail:
        boxes.length === 0
          ? "Connect a mailbox to start sending."
          : `${plural(boxes.length, "mailbox", "mailboxes")} connected${broken ? `, ${broken} failing` : ""}.`,
    },
    {
      slug: "sequences",
      name: "Sequences",
      count: activeSeq,
      tone: activeSeq ? "ok" : "secondary",
      status: activeSeq ? "Sending" : "None running",
      detail: activeSeq
        ? `${plural(activeSeq, "sequence")} active.`
        : "Create a sequence and switch it on.",
    },
    {
      slug: "inbox",
      name: "Inbox",
      count: unread,
      tone: unread ? "warn" : "ok",
      status: unread ? `${unread} unread` : "All read",
      detail: `${plural(inbox.data?.items.length ?? 0, "open conversation")}.`,
    },
    {
      slug: "workflows",
      name: "Workflows",
      count: activeWf,
      tone: activeWf ? "ok" : "secondary",
      status: activeWf ? "Running" : "None running",
      detail: activeWf
        ? `${plural(activeWf, "workflow")} active.`
        : "Start from a template.",
    },
    {
      slug: "forms",
      name: "Forms",
      count: activeForms,
      tone: activeForms ? "ok" : "secondary",
      status: activeForms ? "Collecting" : "None live",
      detail: activeForms
        ? `${plural(activeForms, "form")} live.`
        : "Capture leads from your website.",
    },
  ];

  const workspace = workspaces.data?.find((w) => w.id === workspaceId);
  const events = feed.data?.items ?? [];

  return (
    <div className="grid gap-10">
      <div className="grid gap-1.5">
        <h1>Today</h1>
        <p className="text-sm text-muted-foreground">
          {workspace?.name ?? "Workspace"} ·{" "}
          {new Date().toLocaleDateString("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </p>
      </div>

      <section aria-labelledby="services" className="grid gap-3">
        <h2
          id="services"
          className="text-xl font-extrabold tracking-[-0.01em] font-stretch-condensed"
        >
          Services
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="hidden sm:table-cell">
                What is happening
              </TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {services.map((s) => (
              <TableRow key={s.slug}>
                <TableCell className="font-semibold">{s.name}</TableCell>
                <TableCell>
                  <Badge variant={s.tone}>{s.status}</Badge>
                </TableCell>
                <TableCell className="tabular text-right font-bold">
                  {s.count}
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {s.detail}
                </TableCell>
                <TableCell className="text-right">
                  {s.tone === "warn" || s.tone === "destructive" ? (
                    // The one thing that needs doing gets the one red button.
                    <Link
                      href={`/app/${workspaceId}/${s.slug}`}
                      className={buttonVariants({
                        variant: "signal",
                        size: "sm",
                      })}
                    >
                      {s.slug === "inbox" ? "Read" : "Set up"}
                      <span className="sr-only"> {s.name}</span>
                    </Link>
                  ) : (
                    <Link
                      href={`/app/${workspaceId}/${s.slug}`}
                      className="font-semibold underline decoration-border hover:decoration-signal"
                    >
                      Open<span className="sr-only"> {s.name}</span>
                    </Link>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section
        aria-labelledby="departures"
        className="overflow-hidden rounded-lg bg-ink text-white"
      >
        <div className="flex items-baseline gap-3 border-b-2 border-white/25 px-5 py-3">
          <h2
            id="departures"
            className="text-lg font-extrabold tracking-[-0.01em] font-stretch-condensed"
          >
            Recent departures
          </h2>
          <span className="text-xs text-white/60">
            The latest things that happened in this workspace
          </span>
        </div>
        {events.length === 0 ? (
          <p className="px-5 py-6 text-sm text-white/70">
            Nothing has happened yet. Contacts added, emails sent, replies and
            workflow runs show up here as they happen.
          </p>
        ) : (
          <ol>
            {events.map((a) => (
              <li
                key={a.id}
                className="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-4 border-t border-white/12 px-5 py-2.5 first:border-t-0 sm:grid-cols-[7rem_14rem_1fr]"
              >
                <span className="tabular text-sm font-bold text-board-amber">
                  {stamp(a.createdAt)}
                </span>
                <span className="text-sm font-semibold">
                  {humanize(a.type)}
                </span>
                <span className="col-start-2 truncate text-sm text-white/70 sm:col-start-auto">
                  {whatItWas(a)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
