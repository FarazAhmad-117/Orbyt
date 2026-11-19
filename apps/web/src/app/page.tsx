"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { cn } from "cn";
import { DepartureBoard } from "@/components/departure-board";
import { InboxSample } from "@/components/inbox-sample";
import { SiteFooter, SiteHeader } from "@/components/marketing";
import { StationClock } from "@/components/station-clock";
import { buttonVariants } from "@/components/ui/button";
import { authClient } from "@/lib/api";

// The route a lead takes through Orbyt, in the order it happens.
const STOPS = [
  ["Capture", "A form, a webhook or a CSV import puts someone in your CRM."],
  [
    "Reach",
    "Sequences send inside each timezone’s window from rotating, warmed-up mailboxes.",
  ],
  [
    "Reply",
    "Replies and bounces are detected, threaded and the sequence stops by itself.",
  ],
  [
    "Automate",
    "Workflows tag, assign and notify on events, webhooks or a schedule.",
  ],
  [
    "Answer",
    "AI drafts the reply from your knowledge base. You decide whether it goes out.",
  ],
  [
    "Close",
    "Deals move through your pipeline; a won deal can start what is next.",
  ],
] as const;

const SERVICES = [
  [
    "CRM",
    "Contacts, companies, pipelines, deals, tasks and a timeline of everything that happened.",
    "CSV import and export, custom fields, tags, GoHighLevel import",
  ],
  [
    "Cold email",
    "Multi-step sequences that send inside working hours and stop when someone replies.",
    "Mailbox rotation, warm-up ramp, SPF, DKIM and DMARC checks, one-click unsubscribe",
  ],
  [
    "Inbox",
    "One threaded inbox for email, SMS, WhatsApp and voice calls.",
    "Reply in place, classified replies, AI-drafted answers",
  ],
  [
    "Workflows",
    "A canvas for automations that survive restarts and can be replayed.",
    "Event, webhook and schedule triggers, waits, branches, HTTP, templates",
  ],
  [
    "Forms and chat",
    "Lead capture and a chat agent for your own website.",
    "Paste-in HTML form, spam trap, answers from your knowledge base",
  ],
  [
    "AI",
    "Bring your own provider and keep the bill under control.",
    "Anthropic, OpenAI, Gemini or Ollama, usage ledger, monthly cap",
  ],
  [
    "Agencies",
    "Client workspaces isolated by Postgres row-level security.",
    "Invitations, roles; white-label, SSO and audit log with a license",
  ],
  [
    "Self-hosting",
    "One API, one web app, one Postgres.",
    "Docker Compose, backups, Prometheus metrics, AGPL-3.0",
  ],
] as const;

export default function Home() {
  const router = useRouter();
  const session = authClient.useSession();
  useEffect(() => {
    if (session.data) router.replace("/app");
  }, [session.data, router]);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        <section className="mx-auto grid w-full max-w-6xl gap-10 px-4 pt-12 pb-10 sm:px-6 sm:pt-20 lg:grid-cols-[1fr_21rem] lg:items-center lg:gap-14">
          <div>
            <h1 className="max-w-4xl text-[clamp(2.75rem,8vw,5.5rem)] leading-[0.94] font-extrabold tracking-[-0.012em] text-balance font-stretch-condensed">
              Every send, reply and{" "}
              <span className="whitespace-nowrap">follow-up</span>, on schedule.
            </h1>
            <p className="mt-6 max-w-2xl text-lg text-pretty text-muted-foreground sm:text-xl">
              Orbyt is the open-source platform that runs your CRM, cold email,
              inbox and automations on one board. You host it. You own the data.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/sign-up"
                className={buttonVariants({ variant: "signal", size: "lg" })}
              >
                Create an account
              </Link>
              <Link
                href="/sign-in"
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                )}
              >
                Sign in
              </Link>
              <span className="text-sm text-muted-foreground">
                Free to self-host · AGPL-3.0
              </span>
            </div>
          </div>
          <StationClock className="hidden w-full max-w-[21rem] justify-self-end lg:block" />
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6">
          <DepartureBoard />
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6">
          <h2 className="mb-6 max-w-3xl text-4xl leading-none font-extrabold tracking-[-0.02em] text-balance font-stretch-condensed sm:text-5xl">
            Replies land in one inbox
          </h2>
          <InboxSample />
        </section>

        <section
          id="line"
          className="mx-auto w-full max-w-6xl scroll-mt-6 px-4 pb-24 sm:px-6"
        >
          <h2 className="max-w-3xl text-4xl leading-none font-extrabold tracking-[-0.02em] text-balance font-stretch-condensed sm:text-5xl">
            One line from first touch to closed deal
          </h2>
          <ol className="relative mt-12 grid gap-8 md:grid-cols-6 md:gap-5">
            <div
              aria-hidden
              className="absolute top-4 bottom-4 left-[1.1rem] w-0.5 bg-ink md:inset-x-0 md:top-[1.1rem] md:bottom-auto md:left-0 md:h-0.5 md:w-auto"
            />
            {STOPS.map(([name, body], i) => (
              <li key={name} className="relative pl-14 md:pt-14 md:pl-0">
                <span
                  aria-hidden
                  className={`tabular absolute top-0 left-0 inline-grid size-9 place-items-center rounded-sm text-sm font-extrabold text-white font-stretch-condensed ${
                    i === 0 ? "bg-signal" : "bg-ink"
                  }`}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="text-xl font-extrabold tracking-[-0.01em] font-stretch-condensed">
                  {name}
                </h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section
          id="services"
          className="mx-auto w-full max-w-6xl scroll-mt-6 px-4 pb-24 sm:px-6"
        >
          <h2 className="max-w-3xl text-4xl leading-none font-extrabold tracking-[-0.02em] text-balance font-stretch-condensed sm:text-5xl">
            What runs on it
          </h2>
          <div className="mt-10">
            <div
              className="hidden grid-cols-[12rem_1.2fr_1fr] gap-8 border-b-2 border-ink pb-2 text-[0.72rem] font-bold tracking-[0.08em] text-muted-foreground uppercase md:grid"
              aria-hidden
            >
              <span>Service</span>
              <span>What it does</span>
              <span>Includes</span>
            </div>
            <ul>
              {SERVICES.map(([name, what, includes]) => (
                <li
                  key={name}
                  className="grid gap-1 border-b border-border py-5 md:grid-cols-[12rem_1.2fr_1fr] md:gap-8"
                >
                  <h3 className="text-xl font-extrabold tracking-[-0.01em] font-stretch-condensed">
                    {name}
                  </h3>
                  <p className="text-pretty">{what}</p>
                  <p className="text-sm text-pretty text-muted-foreground md:pt-0.5">
                    {includes}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="own" className="scroll-mt-6 bg-ink text-white">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-20 sm:px-6 md:grid-cols-[1.1fr_1fr] md:items-center">
            <div>
              <h2 className="text-4xl leading-none font-extrabold tracking-[-0.02em] text-balance font-stretch-condensed sm:text-5xl">
                You run it. You keep it.
              </h2>
              <p className="mt-5 max-w-xl text-lg text-pretty text-white/75">
                No per-seat pricing and no vendor holding your contacts. Start
                it with Docker Compose and bring your own database, mail servers
                and AI keys.
              </p>
            </div>
            <div className="grid gap-3">
              <pre className="rounded-md border border-white/20 bg-black/30 p-4 font-mono text-sm leading-relaxed break-all whitespace-pre-wrap">
                <code>
                  {
                    "cp .env.example .env\ndocker compose --profile apps up -d --build"
                  }
                </code>
              </pre>
              <p className="text-sm text-white/60">
                Prebuilt images are not published yet, so today it builds from
                source.
              </p>
            </div>
          </div>
        </section>

        <section className="border-t-2 border-ink">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-6 px-4 py-16 sm:px-6">
            <div className="mr-auto max-w-xl">
              <h2 className="text-4xl leading-none font-extrabold tracking-[-0.02em] text-balance font-stretch-condensed sm:text-5xl">
                Open a workspace
              </h2>
              <p className="mt-3 text-lg text-muted-foreground">
                Create an account and you land in a ready workspace: add a
                contact, connect a mailbox, build the first sequence.
              </p>
            </div>
            <Link
              href="/sign-up"
              className={buttonVariants({ variant: "signal", size: "lg" })}
            >
              Create an account
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
