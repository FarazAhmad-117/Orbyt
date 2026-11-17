# Orbyt

The open-source growth platform: **CRM + cold-email outreach + unified inbox + visual workflow automation + AI**, in one self-hostable product. An open-source alternative to GoHighLevel / Instantly / n8n for agencies and growth teams.

> **Status: working v0, not yet released.** Everything below is built and tested (see [What is tested](#what-is-tested)). Things that are **not** built or **not verified yet** are listed honestly in [Status and limits](#status-and-limits). The roadmap and design live in [orbyt-project-plan.md](orbyt-project-plan.md).

## What it does

- **Multi-tenant by design.** Organization (agency) → workspaces (client sub-accounts). Isolation is enforced by Postgres row-level security, not just app code. Roles: workspace admin / member; agency owners and admins reach every workspace.
- **CRM.** Contacts, companies, tags, custom fields, CSV import/export, pipelines and deals, tasks, notes, an activity timeline.
- **Email outreach.** Connect SMTP + IMAP mailboxes (credentials encrypted), multi-step sequences, sending windows by timezone, per-mailbox daily/hourly limits, mailbox rotation, merge tags, reply / bounce / auto-reply detection that stops sequences, one-click unsubscribe (RFC 8058), suppression list, optional open/click tracking (off by default), a deliverability checker (SPF, DKIM, DMARC, MX, blocklist) and a **unified inbox** you can reply from.
- **Workflows.** A visual builder (React Flow) on a durable executor: event or manual triggers, wait, if/else, tag, update contact, task, note, HTTP request, enroll in sequence, AI step, send SMS/WhatsApp, voice call. Runs survive restarts, can be cancelled and replayed.
- **AI (bring your own key).** Anthropic, OpenAI, Gemini or self-hosted Ollama. Classify replies, draft replies (never sent automatically), AI steps in workflows, per-workspace prompt overrides, a usage ledger and a monthly token cap.
- **SMS, WhatsApp and voice.** Twilio (send + signature-verified inbound webhooks, STOP/START handling) and Retell voice calls, in the same inbox.
- **API.** REST under `/api`, workspace API keys, signed webhooks (HMAC, retries, SSRF-protected), OpenAPI at `/api/openapi.json` and a docs page at `/api/docs`.

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

`docker compose --profile apps up --build` builds and runs the whole stack. Publishing prebuilt images to GHCR on version tags is wired up (`.github/workflows/release.yml`) but **has not been run yet**, and the Dockerfiles have not been built successfully on the development machine (container TLS to the npm registry is blocked there). The `Docker` GitHub Actions job is the first real test. See plan §16.

### Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (required) |
| `BETTER_AUTH_SECRET` | Session signing secret, 32+ chars (required) |
| `BETTER_AUTH_URL` | Public URL of the web app (also used in unsubscribe/tracking links) |
| `ORBYT_ENCRYPTION_KEY` | 32 random bytes, base64: encrypts mailbox, AI and channel credentials. Set it in production |
| `ORBYT_ALLOW_PRIVATE_URLS` | `true` to allow mailboxes/webhooks/AI endpoints on private networks (e.g. local Ollama). Keep `false` on shared hosting |
| `API_INTERNAL_URL` | Where the web app forwards `/api` (default `http://127.0.0.1:3001`) |
| `ORBYT_SCHEDULER`, `ORBYT_SYNC`, `ORBYT_WORKFLOWS` | `off` disables that background loop on this instance |

## Develop and test

```sh
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build
docker compose --profile test up -d mail     # GreenMail: SMTP :3025 / IMAP :3143 for the email tests
DATABASE_URL=... pnpm test                   # unit + integration (db, api)
pnpm --filter @orbyt/e2e exec playwright install chromium
DATABASE_URL=... pnpm --filter @orbyt/e2e e2e   # real-browser end-to-end (build api + web first)
```

Layout: `apps/api` (NestJS + Fastify), `apps/web` (Next.js + shadcn/ui), `packages/db` (Drizzle schema, migrations, RLS), `e2e` (Playwright). Architecture notes and decisions: [orbyt-project-plan.md](orbyt-project-plan.md).

### What is tested

- **db:** 15 tests, including a guard that fails if any new table is not row-level-security protected.
- **api:** 177 tests: tenant isolation on every resource, auth, CRM, CSV, webhooks, API keys, the email engine against a real SMTP/IMAP server (limits, rotation, windows, replies, bounces, unsubscribe, tracking), the workflow engine (waits, retries, replay, loop guard), AI adapters against mock servers, Twilio/Retell with real signature verification, roles and agency workspaces.
- **e2e:** 10 real-browser tests: sign-up/sign-in, contacts, deals, tasks, API key through the proxy, tenant isolation, agency workspaces, the full email flow (connect mailbox → sequence → send → reply → answer from the inbox) and the workflow builder.

## Status and limits

Built and tested, but know what it is not:

- **Not verified:** Docker image builds and the release workflow (see above); the GitHub Actions workflows have never run on GitHub; real Gmail/Microsoft mailboxes, real Twilio/Retell/LLM accounts (only mocks and a local mail server were used); behaviour with a non-superuser database role.
- **Not built:** Gmail/Microsoft **OAuth** (mailboxes use SMTP/IMAP; Google Workspace and Microsoft 365 need an app password), invitation **emails** (you add existing users by email), SSO, audit logs, billing/Stripe, white-label, mailbox provisioning and warm-up, a GHL importer, a forms/booking module, a community node registry. The commercial `ee/` folder is intentionally empty until its license is drafted.
- **Known shortcuts** are marked `shortcut:` in the code (single-stage Docker images, in-memory CSV export, in-process webhook retries, DNS pinning for SSRF, per-workspace scheduler scan, at-least-once delivery).
- **Deliverability is not guaranteed.** Warm domains, keep volumes low and clean your lists; passing the DNS checks does not guarantee inbox placement. You are responsible for compliance (CAN-SPAM, GDPR, CASL); the product always adds an unsubscribe link and requires a postal-address footer to activate a sequence.

## License

Core: [AGPL-3.0](LICENSE). Code under `ee/` will be proprietary ([ee/LICENSE](ee/LICENSE), a placeholder). Contributions require a [CLA](CLA.md) (the final text is not drafted yet, so external pull requests are not being merged).
