# Orbyt

The open-source growth platform: **CRM + cold-email outreach + unified inbox + visual workflow automation + forms + AI chat**, in one self-hostable product. An open-source alternative to GoHighLevel / Instantly / n8n for agencies and growth teams.

> **Status: feature-complete v0, not yet released.** Everything below is built and tested (see [What is tested](#what-is-tested)). Things that are **not** built or **not verified yet** are listed honestly in [Status and limits](#status-and-limits). The roadmap and design live in [orbyt-project-plan.md](orbyt-project-plan.md).

## What it does

- **Multi-tenant by design.** Organization (agency) → workspaces (client sub-accounts). Isolation is enforced by Postgres row-level security, not just app code. Roles: workspace admin / member; agency owners and admins reach every workspace. Invite people by link or email.
- **CRM.** Contacts, companies, tags, custom fields, CSV import/export, pipelines and deals, tasks, notes, an activity timeline.
- **Email outreach.** Connect SMTP + IMAP mailboxes **or sign in with Google / Microsoft (OAuth)**; credentials are encrypted. Multi-step sequences, sending windows by timezone, per-mailbox daily/hourly limits, **warm-up ramp**, mailbox rotation, merge tags, reply / bounce / auto-reply detection that stops sequences, one-click unsubscribe (RFC 8058), suppression list, optional open/click tracking (off by default), a deliverability checker (SPF, DKIM, DMARC, MX, blocklist) and a **unified inbox** you can reply from.
- **Workflows.** A visual builder (React Flow) on a durable executor. Triggers: an event, a **webhook URL**, a **schedule**, or manual. Steps: wait, if/else, tag, update contact, task, note, HTTP request, enroll in sequence, AI step, send SMS/WhatsApp, voice call. Runs survive restarts, can be cancelled and replayed. Ready-made **templates**.
- **Forms.** Public lead-capture forms (a paste-in HTML snippet or JSON): each submission creates or updates a contact, adds your tags and can start a workflow. Honeypot + rate limit built in.
- **AI (bring your own key).** Anthropic, OpenAI, Gemini or self-hosted Ollama. Classify replies, draft replies (never sent automatically, grounded in your **knowledge base**), AI steps in workflows, **chat agents** that answer website visitors from the knowledge base, per-workspace prompt overrides, a usage ledger and a monthly token cap.
- **SMS, WhatsApp and voice.** Twilio (send + signature-verified inbound webhooks, STOP/START handling) and Retell voice calls, in the same inbox.
- **Moving from GoHighLevel.** Import its Contacts and Opportunities CSV exports (safe to repeat), and rebuild automations from the workflow templates.
- **API.** REST under `/api`, workspace API keys, signed webhooks (HMAC, retries, SSRF-protected), OpenAPI at `/api/openapi.json` and a docs page at `/api/docs`.
- **Commercial tier** (needs a license key, see [docs/enterprise.md](docs/enterprise.md)): single sign-on (OpenID Connect), audit log, white-label (name, logo, colour, custom domain), and for the hosted cloud Stripe billing with plans and limits.
- **Operations.** `/health`, `/api/status`, an optional Prometheus endpoint, backup/restore scripts, a cap for brand-new workspaces ([docs/operations.md](docs/operations.md)).

## Run it

Needs Node 22.12+, pnpm 10+ and Docker.

```sh
pnpm install
cp .env.example .env            # set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d            # Postgres + Redis (infra only)

export DATABASE_URL=postgres://orbyt:orbyt@127.0.0.1:5432/orbyt
export BETTER_AUTH_SECRET=...   # 32+ chars
export BETTER_AUTH_URL=http://localhost:3000
pnpm --filter @orbyt/db build
pnpm --filter @orbyt/api dev    # API on :3001, applies DB migrations on start
pnpm --filter @orbyt/web dev    # web on :3000, proxies /api to the API
```

Open <http://localhost:3000>, create an account (it gets an organization and a "Default" workspace), then connect a mailbox under **Mailboxes**.

If port 5432 is taken on your machine, set `POSTGRES_PORT` (and adjust `DATABASE_URL`).

### Docker images (planned)

`docker compose --profile apps up --build` builds and runs the whole stack. Publishing prebuilt images to GHCR on version tags is wired up (`.github/workflows/release.yml`) but **has not been run yet**, and the Dockerfiles have not been built successfully on the development machine (container TLS to the npm registry is blocked there). The `Docker` GitHub Actions job is the first real test. See plan §16 and [docs/self-hosting.md](docs/self-hosting.md).

### Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (required) |
| `BETTER_AUTH_SECRET` | Session signing secret, 32+ chars (required) |
| `BETTER_AUTH_URL` | Public URL of the web app (also used in invitation, unsubscribe and tracking links, and as the OAuth/Stripe return address) |
| `ORBYT_ENCRYPTION_KEY` | 32 random bytes, base64: encrypts mailbox, AI and channel credentials. Set it in production |
| `ORBYT_ALLOW_PRIVATE_URLS` | `true` to allow mailboxes/webhooks/AI endpoints on private networks (e.g. local Ollama). Keep `false` on shared hosting |
| `API_INTERNAL_URL` | Where the web app forwards `/api` (default `http://127.0.0.1:3001`) |
| `ORBYT_SCHEDULER`, `ORBYT_SYNC`, `ORBYT_WORKFLOWS` | `off` disables that background loop on this instance |
| `ORBYT_SMTP_URL`, `ORBYT_MAIL_FROM` | Send team invitations by email (the link is always shown in the app too) |
| `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET/TENANT` | Enable "Connect Google / Microsoft" mailboxes |
| `ORBYT_LICENSE_KEY`, `ORBYT_LICENSE_PUBLIC_KEY` | Unlock the commercial tier ([docs/enterprise.md](docs/enterprise.md)) |
| `ORBYT_SSO_DISCOVERY_URL/CLIENT_ID/CLIENT_SECRET/NAME` | Single sign-on through any OpenID Connect provider (needs an `sso` license) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO/AGENCY` | Hosted cloud only: billing and plan limits |
| `ORBYT_METRICS_TOKEN` | Enables `/api/metrics` (Prometheus), protected by this bearer token |
| `ORBYT_NEW_TENANT_DAILY_LIMIT`, `ORBYT_NEW_TENANT_DAYS` | Abuse cap: total emails per day for workspaces younger than N days (default 7) |

More in [.env.example](.env.example).

## Develop and test

```sh
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build
docker compose --profile test up -d mail     # GreenMail: SMTP :3025 / IMAP :3143 for the email tests
DATABASE_URL=... pnpm test                   # unit + integration (db, api)
pnpm --filter @orbyt/e2e exec playwright install chromium
DATABASE_URL=... pnpm e2e                    # real-browser end-to-end (build api + web first)
```

Layout: `apps/api` (NestJS + Fastify), `apps/web` (Next.js + shadcn/ui), `packages/db` (Drizzle schema, migrations, RLS), `e2e` (Playwright), `scripts` (license tool, backup), `docs`. The commercial-tier code lives in `apps/api/src/enterprise/` until the `ee/` license is drafted (see [docs/enterprise.md](docs/enterprise.md)). Architecture notes and decisions: [orbyt-project-plan.md](orbyt-project-plan.md).

### What is tested

- **db:** row-level-security guard (fails if any new table is unprotected), tenancy and membership.
- **api:** tenant isolation on every resource, auth, CRM, CSV, webhooks, API keys, the email engine against a real SMTP/IMAP server (limits, rotation, windows, warm-up, replies, bounces, unsubscribe, tracking), OAuth mailboxes against a mock provider and an XOAUTH2 SMTP server, the workflow engine (waits, retries, replay, loop guard, webhook and schedule triggers), forms, knowledge base and chat, invitations, GoHighLevel import, AI adapters against mock servers, Twilio/Retell with real signature verification, roles and agency workspaces, licenses (Ed25519), audit log, plans and Stripe billing against a mock Stripe with real signature checks, single sign-on against a mock OpenID Connect provider, and metrics.
- **e2e:** real-browser tests: sign-up/sign-in, contacts, deals, tasks, API key through the proxy, tenant isolation, agency workspaces, the full email flow (connect mailbox → sequence → send → reply → answer from the inbox), the workflow builder, invitations (invite → sign up → join), forms, knowledge and chat agents, the GoHighLevel import, workflow templates and webhook workflows.

## Status and limits

Built and tested, but know what it is not:

- **Not verified:** Docker image builds and the release workflow (see above); the GitHub Actions workflows have never run on GitHub; **real** Gmail / Microsoft 365 / Stripe / OpenID Connect providers, Twilio/Retell/LLM accounts (only mocks and a local mail server were used; OAuth IMAP login with XOAUTH2 was not exercised against any server, only the SMTP side); behaviour with a non-superuser database role.
- **Not built:** automatic mailbox/domain **provisioning and purchase**, a cross-customer warm-up **peer pool** (warm-up is a daily-limit ramp only), deliverability dashboards backed by Postmaster Tools, bring-your-own-MTA automation, booking/calendar and funnels/sites modules, a community node registry and templates marketplace (there is a built-in template list), a sandboxed code node, per-organization SSO (SSO is configured per installation), a hosted status page UI (the `/api/status` data exists), and the legal side of the commercial license.
- **Known shortcuts** are marked `shortcut:` in the code (single-stage Docker images, in-memory CSV export, in-process webhook retries, DNS pinning for SSRF, per-workspace scheduler scan, at-least-once delivery, an in-memory rate limiter for public endpoints, keyword search instead of embeddings for the knowledge base, interval-only schedules).
- **Deliverability is not guaranteed.** Warm domains, keep volumes low and clean your lists; passing the DNS checks does not guarantee inbox placement. You are responsible for compliance (CAN-SPAM, GDPR, CASL, TCPA for SMS and calls); the product always adds an unsubscribe link and requires a postal-address footer to activate a sequence.
- **Imports from GoHighLevel** cover contacts and opportunities only. Its workflows, funnels, calendars and conversations have no export format.

## License

Core: [AGPL-3.0](LICENSE). Code under `ee/` will be proprietary ([ee/LICENSE](ee/LICENSE), a placeholder), so the commercial-tier code currently sits in `apps/api/src/enterprise/` (marked, and easy to move once counsel approves the terms). Contributions require a [CLA](CLA.md) (the final text is not drafted yet, so external pull requests are not being merged).
