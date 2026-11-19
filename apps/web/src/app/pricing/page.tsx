import type { Metadata } from "next";
import Link from "next/link";
import { cn } from "cn";
import { H2, SiteFooter, SiteHeader } from "@/components/marketing";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Pricing · Orbyt",
  description:
    "Orbyt is free to self-host with no limits. Hosted plans only limit workspaces and mailboxes.",
};

// The limits are the ones in apps/api/src/enterprise/plans.ts; "unlimited" is how a community install behaves.
const PLANS = [
  {
    name: "Self-hosted",
    tag: "Free · AGPL-3.0",
    workspaces: "Unlimited",
    mailboxes: "Unlimited",
    adds: "The whole product. You bring the server, mail provider and AI keys.",
  },
  {
    name: "Self-hosted with a licence key",
    tag: "Commercial tier",
    workspaces: "Set by licence",
    mailboxes: "Set by licence",
    adds: "Single sign-on (OpenID Connect), audit log, white-label.",
  },
  {
    name: "Hosted Free",
    tag: "Hosted",
    workspaces: "1",
    mailboxes: "2",
    adds: "Everything else in the product.",
  },
  {
    name: "Hosted Pro",
    tag: "Hosted",
    workspaces: "3",
    mailboxes: "10",
    adds: "Everything else in the product.",
  },
  {
    name: "Hosted Agency",
    tag: "Hosted",
    workspaces: "100",
    mailboxes: "200",
    adds: "Audit log and white-label (name, logo, colour, custom domain).",
  },
] as const;

const QUESTIONS = [
  [
    "What does it cost to self-host?",
    "Nothing for the software. You pay for your own server, your mail provider and your AI keys. The code is AGPL-3.0.",
  ],
  [
    "Why are there no prices on this page?",
    "Billing is built, but no price is set in the code. A hosted installation takes its prices from the Stripe products its operator creates, so there is nothing true to print here yet.",
  ],
  [
    "Do plans cap anything besides workspaces and mailboxes?",
    "No. Sending is limited separately: each mailbox has its own daily and hourly limit with a warm-up ramp, and workspaces in their first days have an abuse cap the operator can change.",
  ],
  [
    "What needs a licence key?",
    "Single sign-on, the audit log and white-label. Everything else works on a plain community install.",
  ],
] as const;

export default function PricingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="mx-auto w-full max-w-6xl px-4 pt-12 pb-12 sm:px-6 sm:pt-20">
          <h1 className="max-w-4xl text-[clamp(2.5rem,8vw,5rem)] leading-[0.95] font-extrabold tracking-[-0.012em] text-balance font-stretch-condensed">
            Free to run. Plans only limit workspaces and mailboxes.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-pretty text-muted-foreground sm:text-xl">
            There is no per-seat price. Self-hosted installs have no limits at
            all.
          </p>
        </section>

        <section
          aria-labelledby="plans"
          className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6"
        >
          <h2 id="plans" className="sr-only">
            Plans and limits
          </h2>
          <div
            className="hidden grid-cols-[15rem_8rem_8rem_1fr] gap-8 border-b-2 border-ink pb-2 text-[0.72rem] font-bold tracking-[0.08em] text-muted-foreground uppercase md:grid"
            aria-hidden
          >
            <span>Plan</span>
            <span>Workspaces</span>
            <span>Mailboxes</span>
            <span>Adds</span>
          </div>
          <ul>
            {PLANS.map((p) => (
              <li
                key={p.name}
                className="grid gap-x-8 gap-y-1 border-b border-border py-5 md:grid-cols-[15rem_8rem_8rem_1fr] md:items-baseline"
              >
                <div>
                  <h3 className="text-xl font-extrabold tracking-[-0.01em] font-stretch-condensed">
                    {p.name}
                  </h3>
                  <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {p.tag}
                  </p>
                </div>
                <p className="tabular text-lg font-bold">
                  <span className="mr-2 text-sm font-medium text-muted-foreground md:hidden">
                    Workspaces
                  </span>
                  {p.workspaces}
                </p>
                <p className="tabular text-lg font-bold">
                  <span className="mr-2 text-sm font-medium text-muted-foreground md:hidden">
                    Mailboxes
                  </span>
                  {p.mailboxes}
                </p>
                <p className="text-pretty">{p.adds}</p>
              </li>
            ))}
          </ul>
          <p className="mt-6 max-w-3xl text-sm text-pretty text-muted-foreground">
            Hosted plans only apply on an installation whose operator has turned
            billing on. Prices are set by that operator in Stripe, so none are
            shown here.
          </p>
        </section>

        <section
          aria-labelledby="questions"
          className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6"
        >
          <h2 id="questions" className={H2}>
            Questions
          </h2>
          <dl className="mt-10">
            {QUESTIONS.map(([q, a]) => (
              <div
                key={q}
                className="grid gap-1 border-b border-border py-5 md:grid-cols-[1fr_1.4fr] md:gap-8"
              >
                <dt className="text-xl font-extrabold tracking-[-0.01em] font-stretch-condensed">
                  {q}
                </dt>
                <dd className="text-pretty">{a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="bg-ink text-white">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-6 px-4 py-16 sm:px-6">
            <h2 className={cn(H2, "mr-auto")}>Open a workspace</h2>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/sign-up"
                className={buttonVariants({ variant: "signal", size: "lg" })}
              >
                Create an account
              </Link>
              <Link
                href="/self-host"
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  "border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white",
                )}
              >
                Self-host it
              </Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
