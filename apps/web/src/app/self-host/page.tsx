import type { Metadata } from "next";
import Link from "next/link";
import { cn } from "cn";
import { H2, SiteFooter, SiteHeader } from "@/components/marketing";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Self-host · Orbyt",
  description:
    "Run Orbyt on your own server: one API, one web app, one Postgres. Steps, settings and what is not verified yet.",
};

const SETTINGS = [
  ["DATABASE_URL", "Postgres connection string.", "Required"],
  ["BETTER_AUTH_SECRET", "Session signing secret, 32+ characters.", "Required"],
  [
    "BETTER_AUTH_URL",
    "The public address of the web app. Also used in invitation, unsubscribe and tracking links.",
    "Required",
  ],
  [
    "ORBYT_ENCRYPTION_KEY",
    "32 random bytes, base64. Encrypts mailbox, AI and channel credentials.",
    "Set in production",
  ],
  [
    "ORBYT_SMTP_URL",
    "Sends team invitations by email. The link is always shown in the app too.",
    "Optional",
  ],
] as const;

const COMPOSE =
  "cp .env.example .env\ndocker compose --profile apps up -d --build";
const SOURCE = `pnpm install
cp .env.example .env
docker compose up -d
pnpm --filter @orbyt/db build
pnpm --filter @orbyt/api dev
pnpm --filter @orbyt/web dev`;

const STEP_NUMBER =
  "tabular inline-grid size-12 place-items-center rounded-sm bg-ink text-xl font-extrabold text-white font-stretch-condensed";
const STEP_ROW =
  "grid gap-4 border-b border-border py-8 md:grid-cols-[6rem_1fr] md:gap-8";
const STEP_TITLE = cn(H2, "text-3xl sm:text-3xl");

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-ink p-4 font-mono text-sm leading-relaxed text-white">
      <code>{children}</code>
    </pre>
  );
}

export default function SelfHostPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="mx-auto w-full max-w-6xl px-4 pt-12 pb-12 sm:px-6 sm:pt-20">
          <h1 className="max-w-4xl text-[clamp(2.5rem,8vw,5rem)] leading-[0.95] font-extrabold tracking-[-0.012em] text-balance font-stretch-condensed">
            You run it. You keep it.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-pretty text-muted-foreground sm:text-xl">
            One API, one web app and one Postgres. Your contacts, mailboxes and
            AI keys stay on your server.
          </p>
        </section>

        <section
          aria-labelledby="status"
          className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6"
        >
          <div className="rounded-md border-l-4 border-ink bg-muted p-5">
            <h2
              id="status"
              className="text-lg font-extrabold font-stretch-condensed"
            >
              Where it stands
            </h2>
            <p className="mt-1 max-w-3xl text-pretty">
              Orbyt is a feature-complete v0 that has not been released.
              Prebuilt images are not published yet, so it builds from source.
              The Docker build has not been confirmed end to end on a clean
              machine, so if Compose fails, run it from source below.
            </p>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6">
          <ol className="border-t-2 border-ink">
            <li className={STEP_ROW}>
              <span className={STEP_NUMBER}>01</span>
              <div className="grid gap-3">
                <h2 className={STEP_TITLE}>Get the code</h2>
                <p className="max-w-2xl text-pretty">
                  Clone the repository and open its folder. You need Docker for
                  the database. Running from source also needs Node 22.12+ and
                  pnpm 10+.
                </p>
              </div>
            </li>
            <li className={STEP_ROW}>
              <span className={STEP_NUMBER}>02</span>
              <div className="grid gap-4">
                <h2 className={STEP_TITLE}>Set the secrets</h2>
                <p className="max-w-2xl text-pretty">
                  Copy <code className="font-mono text-sm">.env.example</code>{" "}
                  to <code className="font-mono text-sm">.env</code> and fill in
                  these. The example file lists the rest.
                </p>
                <dl>
                  {SETTINGS.map(([name, what, need]) => (
                    <div
                      key={name}
                      className="grid gap-1 border-t border-border py-3 md:grid-cols-[16rem_1fr_9rem] md:gap-6"
                    >
                      <dt className="font-mono text-sm font-bold break-all">
                        {name}
                      </dt>
                      <dd className="text-sm text-pretty">{what}</dd>
                      <dd className="text-xs font-semibold tracking-wide text-muted-foreground uppercase md:text-right">
                        {need}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </li>
            <li className={STEP_ROW}>
              <span className={STEP_NUMBER}>03</span>
              <div className="grid gap-4">
                <h2 className={STEP_TITLE}>Start it</h2>
                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="grid content-start gap-2">
                    <h3 className="font-bold">With Docker Compose</h3>
                    <Code>{COMPOSE}</Code>
                  </div>
                  <div className="grid content-start gap-2">
                    <h3 className="font-bold">From source</h3>
                    <Code>{SOURCE}</Code>
                  </div>
                </div>
              </div>
            </li>
            <li className={STEP_ROW}>
              <span className={STEP_NUMBER}>04</span>
              <div className="grid gap-3">
                <h2 className={STEP_TITLE}>Open it</h2>
                <p className="max-w-2xl text-pretty">
                  Go to{" "}
                  <code className="font-mono text-sm">
                    http://localhost:3000
                  </code>{" "}
                  and create an account. It gets an organization and a Default
                  workspace. Then connect a mailbox under Mailboxes.
                </p>
              </div>
            </li>
            <li className={STEP_ROW}>
              <span className={STEP_NUMBER}>05</span>
              <div className="grid gap-3">
                <h2 className={STEP_TITLE}>Keep it running</h2>
                <p className="max-w-2xl text-pretty">
                  There is a health check at{" "}
                  <code className="font-mono text-sm">/health</code>, a status
                  page at <code className="font-mono text-sm">/api/status</code>
                  , an optional Prometheus endpoint, and backup and restore
                  scripts. Details are in{" "}
                  <code className="font-mono text-sm">docs/operations.md</code>{" "}
                  in the repository.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section className="bg-ink text-white">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-6 px-4 py-16 sm:px-6">
            <h2 className={cn(H2, "mr-auto")}>Plans and limits</h2>
            <Link
              href="/pricing"
              className={cn(
                buttonVariants({ variant: "outline", size: "lg" }),
                "border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white",
              )}
            >
              See the table
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
