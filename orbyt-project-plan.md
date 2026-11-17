# Orbyt — Open-Source GoHighLevel Alternative

> Working name: **Orbyt** (placeholder until trademark/domain checks pass — see §14).
> One-line pitch: *The open-source growth platform: CRM + email outreach + visual automation + AI agents, in one self-hostable product.*
> Status: planning. Last updated: 2026-11-17.

---

## 0. TL;DR

- **What:** An open-source (AGPL-3.0 core) alternative to GoHighLevel that also replaces Instantly/Smartlead (cold email + mailbox management) and part of n8n (visual workflows), with built-in AI agents (chat + voice).
- **How we make money:** Paid **cloud** version (managed hosting, billing, agency sub-accounts, white-label, SSO, AI credits). **Community edition** is free to self-host.
- **Wedge (MVP):** CRM + email outreach + unified inbox. Not funnels, not websites, not memberships.
- **Positioning:** we keep the "GoHighLevel alternative" framing. Be honest about scope: v0.1 covers the CRM + cold-email + inbox slice of GHL (no funnels, booking or reviews yet); fuller parity is a v1.0+ goal.
- **Stack:** TypeScript monorepo — NestJS API, Next.js (React) web, Postgres (+ row-level security), Redis + BullMQ, Docker Compose for self-hosting.
- **First customer:** Indepth Solution itself (dogfood: move our own agency workflows off GHL).
- **Biggest technical risk:** email deliverability. **Biggest business risk:** scope creep.

---

## 1. Decisions already made

| Decision | Choice | Notes |
|---|---|---|
| License | **AGPL-3.0 core + commercial license** for enterprise/white-label | Requires a **CLA** from every outside contributor *before* the first external PR is merged, otherwise we cannot relicense their code commercially. |
| Scope | Start narrow (CRM + email + workflows + AI), expand later | Agreed: do not clone all of GHL. |
| Business model | Open core: free community edition, paid cloud + `ee/` features | Same shape as n8n / Cal.com / Twenty. |
| Backend | NestJS (TypeScript) | Same family GHL uses; strong module/DI structure for a plugin-heavy product. |
| Frontend | React / Next.js | Largest contributor pool; already our core skill. |
| Database | Postgres | Relational CRM data, RLS multi-tenancy, one DB to self-host. |
| AI access | BYOK + cloud-managed AI credits | **Do not** use consumers' Claude/ChatGPT login tokens — against provider terms, will get blocked (see Appendix A). |
| Positioning | Keep "GHL alternative" framing | Be explicit that v0.1 is the CRM + cold-email + inbox slice; full GHL parity is v1.0+. |
| Inbox sync | **Polling by default**, push optional | Gmail History API / Graph delta queries every 1–2 min keep self-host free of Pub/Sub and public webhooks (principle 4). Push (Pub/Sub, Graph webhooks) is an optional cloud optimisation. |
| Timelines | Keep phase estimates, plan at **1.5–2×** | §13 is a throwaway spike, not a replacement for Phases 0–1. |

---

## 2. Competitive landscape (checked 2026-11-17)

No single open-source product combines CRM + workflows + cold email + AI agents + agency sub-accounts. Pieces exist:

| Project | License | Slice it covers | Threat |
|---|---|---|---|
| **Warmbly** | Apache-2.0 | Cold email, warmup, unified inbox, CRM; has a hosted cloud | **High** (email side). Study it; consider whether any code is reusable. |
| **SeldonFrame** | AGPL-3.0 | "Open-source GHL alternative" for local service businesses (AI receptionist, site, CRM, booking) | Medium — same positioning, tiny so far. |
| **OpenLevel** | open source | Early GHL-style CRM | Low (early). |
| **Twenty** | AGPL-3.0 | Modern CRM (~25k stars) | Medium (could add marketing features). Not agency/multi-tenant. |
| **Mautic** | OSS (PHP) | Marketing automation, ~10k stars | Medium; older stack, weak UX. |
| **Dittofeed** | MIT | Multi-channel messaging automation | Low-medium. |
| **Plunk** | AGPL-3.0 | Email platform (transactional/marketing/workflows) | Low. |
| **Cleanmails** | paid one-time | Self-hosted cold email | Low (closed). |
| **Genius Campaign** | MIT | Self-hosted outreach | Low. |
| **Groundhogg** | OSS | WordPress-based CRM/automation | Low (different category). |
| **n8n / Activepieces** | fair-code / MIT | General workflow automation | Complementary — we embed workflows tuned for CRM/outreach. |

**Our differentiation**
1. One product instead of GHL + Instantly + n8n.
2. Agency mode (sub-accounts, white-label) as a first-class concept — GHL's real moat. Sub-accounts are in core from Phase 1; white-label and SaaS-mode billing are `ee/` (Phase 5).
3. AI + voice agents built in (Retell-style telephony nodes).
4. Truly self-hostable (`docker compose up`), AGPL.

**Action:** before committing, do your own GitHub/Product Hunt search; this scan was shallow.

---

## 3. Product scope

### 3.1 MVP (v0.1 — "worth open-sourcing")
- Auth, organizations (agencies) → workspaces (sub-accounts), roles/permissions
- Contacts, companies, tags, custom fields, import/export CSV
- Pipelines / deals / tasks
- **Email**: connect Gmail, Microsoft 365, SMTP/IMAP; sequences (multi-step); per-mailbox limits; rotation; reply detection; unsubscribe/suppression; open/click tracking
- **Unified inbox** (email first)
- Basic dashboards (sent, replies, bounces)
- REST API + webhooks
- `docker compose up` self-host

### 3.2 v0.2–v0.3
- Visual **workflow builder** (triggers → conditions → actions, wait/delay, branches)
- Node SDK + first integrations (Webhook, HTTP, Stripe, Slack, Google Sheets, Retell)
- SMS (Twilio), WhatsApp (Cloud API)
- AI: BYOK agents, reply classification, AI email drafting, AI chat agent
- Voice agent node (Retell)

### 3.3 v1.0 (cloud)
- Billing (Stripe), usage metering, AI credits
- Agency sub-accounts + white-label (ee)
- SSO/SAML, audit logs (ee)
- Mailbox provisioning (Google Workspace/M365 APIs) + domain/DNS automation
- Warm-up (ramp scheduler first, peer pool later)

### 3.4 Explicit non-goals (for now)
Funnel/website builder, memberships/courses, social planner, invoicing/ecommerce, reputation/reviews management, native mobile app. Revisit after v1.0 only if users ask.

---

## 4. Architecture

### 4.1 High-level

```
                    ┌─────────────────────────────────────────────┐
                    │                 Web App (Next.js)           │
                    │ Inbox · Contacts · Pipelines · Campaigns ·  │
                    │ Workflow Builder (React Flow) · Settings    │
                    └───────────────┬─────────────────────────────┘
                                    │ REST / WebSocket
                    ┌───────────────▼─────────────────────────────┐
                    │              API (NestJS)                   │
                    │ Auth · RBAC · Tenancy · REST · Webhooks     │
                    └───┬───────────┬───────────┬─────────────┬───┘
                        │           │           │             │
              ┌─────────▼──┐ ┌──────▼─────┐ ┌───▼──────┐ ┌────▼──────────┐
              │ Postgres   │ │   Redis    │ │  Object  │ │ Event Bus     │
              │ (RLS)      │ │ (BullMQ)   │ │ Storage  │ │ (internal)    │
              └────────────┘ └──────┬─────┘ └──────────┘ └────┬──────────┘
                                    │                          │
        ┌───────────────────────────┴──────────────────────────┴──────────┐
        │                         Workers                                  │
        │  Workflow engine · Email sender · Inbox sync · Tracking ·        │
        │  Warm-up scheduler · AI gateway · Channel adapters (SMS/Voice)   │
        └───────────────┬───────────────────────┬──────────────────────────┘
                        │                       │
              ┌─────────▼────────┐    ┌─────────▼──────────────────────────┐
              │ Mail providers   │    │ External: Twilio, Retell, LLMs,    │
              │ Gmail/MS/SMTP/SES│    │ Stripe, Cloudflare DNS, registrars │
              └──────────────────┘    └────────────────────────────────────┘
```

### 4.2 Core principles
1. **Everything is an event.** Email opened, reply received, deal moved, form submitted → emitted to an internal event bus. Workflows and webhooks subscribe.
2. **Adapters for everything external.** Email providers, SMS, voice, LLMs, payments are all behind interfaces so swapping never touches core logic.
3. **Multi-tenant from day one.** `organization_id` (agency) and `workspace_id` (sub-account) on every tenant table; enforced with Postgres RLS, not just app code.
4. **Self-host first.** Single `docker-compose.yml` must work. No cloud-vendor-specific services in the core.
5. **`ee/` boundary.** Enterprise/cloud features live in an `ee/` folder under a commercial license; everything else is AGPL.
6. **At-least-once + idempotent.** Jobs may run twice; every action uses idempotency keys.

### 4.3 Multi-tenancy model
```
Organization (agency / account owner)
 └── Workspace (sub-account / client)   ← data isolation boundary
      └── Users via Membership (role per workspace)
```
- Agency can create/switch into sub-accounts ("SaaS mode" = billing and white-label in `ee/`).
- RLS policy: `workspace_id = current_setting('app.workspace_id')::uuid`, set per request/job.
- RLS must-haves: the app connects as a **non-owner, non-superuser role** (or tables use `FORCE ROW LEVEL SECURITY`); set the value with `SET LOCAL` inside a transaction so it cannot leak across pooled connections; agency-wide (cross-workspace) views use a separate org-level policy keyed on `organization_id` + membership.

### 4.4 Workflow engine (v0.2)
- A workflow = versioned graph of nodes (trigger, condition, action, wait, branch, loop, sub-workflow).
- An **execution** is a persisted record; each **step** persisted before/after running (durable, resumable).
- `Wait` steps = scheduled delayed jobs (BullMQ delayed jobs; resume by execution id).
- Retry policy per node; dead-letter queue; manual replay from UI.
- Code/JS nodes run **sandboxed** (isolated-vm or separate container), never in the API process.
- **Sequences ≠ workflows at first.** Ship simple linear sequences in MVP (fast, reliable). Later, compile sequences into workflows so there is one engine.

### 4.5 Node / plugin SDK
- A node = `{ type, version, credentialsSchema, inputSchema (JSON Schema), execute(ctx) }`.
- Published as npm packages (`@orbyt/node-*`); community nodes installable in self-hosted.
- Versioned so old workflows keep running on old node versions.

### 4.6 Email engine
Components:
- **Provider adapters:** Gmail API, Microsoft Graph, SMTP/IMAP, SES (opt-in/transactional only).
- **Scheduler:** per-mailbox daily caps, sending windows by recipient timezone, jitter, rotation across mailboxes, ramp-up curves for new mailboxes.
- **Inbox sync:** polling by default (Gmail History API, Graph delta queries, IMAP IDLE/poll) → normalized `messages` + threading. Push (Gmail `watch` via Pub/Sub, Graph webhooks) is optional and used on cloud only, so self-host needs no Google Cloud project or public webhook endpoint.
- **Reply & bounce detection:** classify (reply, OOO, bounce hard/soft, unsubscribe); auto-pause sequence on reply.
- **Compliance:** `List-Unsubscribe` + one-click (RFC 8058) headers, global/workspace suppression list, physical address footer, per-workspace complaint tracking.
- **Tracking:** custom tracking domain per workspace (never share one tracking domain across tenants — reputation bleed). Make open tracking optional (pixels hurt deliverability and are unreliable).
- **Deliverability tooling:** SPF/DKIM/DMARC checker, blacklist monitoring, Google Postmaster Tools integration, seed testing later.

### 4.7 Mailboxes & IP reputation (how it works)
Reputation attaches to **domain, IP and behavior** (complaints, bounces, replies, volume consistency). Three sending models:

| Model | Reputation owner | Difficulty | Use in Orbyt |
|---|---|---|---|
| A. Google Workspace / M365 mailboxes | Google/Microsoft (shared IPs); you build domain reputation | Medium | **Primary** for cold outreach |
| B. Own mail server (Stalwart/Postal/Mailcow) on dedicated IPs | You | Hard (IP warm-up, port 25, abuse handling) | Phase 4, enterprise / bring-your-own-IP only |
| C. ESP relay (SES/Postmark/Mailgun) | Provider | Easy | Opt-in & transactional only (cold email violates their policies) |

**Phasing**
1. **Connect-only** (OAuth/SMTP/IMAP) — MVP.
2. **Provision mailboxes** via Workspace/M365 admin APIs + buy domain + automate DNS (Cloudflare/Namecheap APIs). Users bring their own tenant (or we resell with agreements). Terms of service must put compliance on the user.
3. **Warm-up:** ramp scheduler first; opt-in peer pool among users later (check Warmbly's Apache-2.0 code for reuse — verify license and quality).
4. **Own MTA** only for those who bring IPs.

Honest limits: warm-up helps new domains ramp but is not magic; providers detect artificial patterns. Never promise inbox placement. Rules of thumb to bake into defaults: low per-mailbox volume, spread across many domains, clean lists, keep complaints well under 0.1%.

Gmail OAuth for a *public* multi-tenant app needs Google's restricted-scope security review (CASA). Self-hosters register their own Google OAuth app. Plan for the review early — it takes weeks.

### 4.8 AI gateway
- Provider-agnostic interface (Claude, OpenAI, Gemini, local Ollama) with **BYOK per workspace**.
- **Cloud credits:** we hold platform keys, meter token usage per workspace in a `usage_ledger`, bill with margin. Users never see a key.
- Features: reply classification, draft/rewrite, summarization, lead scoring, chat agent (knowledge base + tools), voice agent via Retell.
- Prompt templates are versioned and workspace-overridable.
- Guardrails: per-workspace spend caps, PII redaction option, logging with opt-out.

### 4.9 Channels (v0.2+)
Twilio SMS, WhatsApp Cloud API, Retell voice — each as an adapter feeding the same `conversations/messages` tables so the unified inbox is channel-agnostic.

---

## 5. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere (Go later for hot paths only if needed) | One language, large contributor pool |
| API | NestJS (Fastify adapter) | Modules, DI, guards; OpenAPI generation |
| ORM / migrations | Drizzle or Prisma (pick one in Phase 0 — prefer the one with good RLS/raw-SQL ergonomics) | Typed queries, migrations |
| DB | Postgres 16+ | RLS, JSONB, full-text search |
| Queue/cache | Redis + BullMQ | Delayed jobs, retries, rate limiting |
| Web | Next.js + React + Tailwind + shadcn/ui | Fast to build, easy to theme (white-label) |
| Workflow canvas | React Flow | Standard for node editors |
| Email parse/send | nodemailer, mailparser, googleapis, MS Graph SDK | Mature |
| Auth | Own (email/password + OAuth) via a maintained library such as better-auth or Passport (check maintenance status before choosing); SSO in ee | Keep self-host dependency-free |
| Realtime | WebSocket (Socket.IO) or SSE | Inbox updates |
| Storage | Local disk by default; S3-compatible optional (MinIO's official images are no longer published — verified 2026-11-17) | Attachments, assets |
| Observability | OpenTelemetry + Prometheus/Grafana (optional), Sentry | |
| CI/CD | GitHub Actions; Docker images on GHCR | |
| Cloud hosting | Start simple: VPS/Render/Fly + managed Postgres; Kubernetes only when needed | Avoid premature infra |

---

## 6. Monorepo structure

```
orbyt/
├── apps/
│   ├── web/                 # Next.js app
│   ├── api/                 # NestJS API
│   └── worker/              # BullMQ workers (workflow, email, sync)
├── packages/
│   ├── db/                  # schema, migrations, RLS policies
│   ├── core/                # domain logic shared by api/worker
│   ├── email-engine/        # provider adapters, scheduler, tracking
│   ├── workflow-engine/     # executor, node runtime
│   ├── node-sdk/            # public SDK for building nodes
│   ├── nodes/               # built-in nodes (http, webhook, slack, ...)
│   ├── ai-gateway/          # LLM adapters, credits metering
│   ├── channels/            # sms, whatsapp, voice adapters
│   ├── ui/                  # shared React components
│   └── config/              # eslint, tsconfig, shared config
├── ee/                      # commercial license: billing, SSO, white-label, audit
├── docker/                  # Dockerfiles, compose files
├── docs/                    # docs site (Docusaurus/Nextra)
├── LICENSE                  # AGPL-3.0
├── ee/LICENSE               # commercial (Orbyt Enterprise License)
├── CLA.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
└── turbo.json / pnpm-workspace.yaml
```
Tooling: pnpm + Turborepo, ESLint/Prettier, Vitest/Jest, Playwright for e2e, Changesets for releases.

---

## 7. Core data model (initial)

Tenant & auth
- `organizations`, `workspaces`, `users`, `memberships(role)`, `api_keys`, `audit_logs (ee)`

CRM
- `contacts`, `companies`, `contact_company`, `tags`, `contact_tags`, `custom_fields`, `custom_field_values`
- `pipelines`, `pipeline_stages`, `deals`, `tasks`, `notes`, `activities`

Messaging
- `conversations`, `messages` (channel: email/sms/whatsapp/voice), `attachments`

Email
- `domains` (SPF/DKIM/DMARC status), `mailboxes` (provider, limits, warm-up state, encrypted credentials), `email_templates`
- `campaigns`, `sequences`, `sequence_steps`, `enrollments`, `email_events` (sent/open/click/reply/bounce/unsub), `suppressions`

Automation
- `workflows`, `workflow_versions`, `executions`, `execution_steps`, `credentials` (encrypted), `webhooks`

AI & billing
- `ai_agents`, `ai_providers` (BYOK keys, encrypted), `usage_ledger`, `plans/subscriptions (ee)`

Conventions: UUIDv7 primary keys (generated in the app; native `uuidv7()` needs Postgres 18+ — verify), `created_at/updated_at`, soft-delete where undo matters, every tenant table has `workspace_id` + RLS policy, secrets encrypted with envelope encryption (AES-256-GCM; master key from env/KMS).

---

## 8. Security & compliance

- RLS on all tenant tables; integration tests that attempt cross-tenant reads.
- Encrypt OAuth tokens/API keys at rest; never log secrets; rotate keys.
- SSRF protection on HTTP node (block private IP ranges, metadata endpoints).
- Sandboxed code execution; resource limits.
- Rate limiting + brute-force protection; 2FA (TOTP) in community, SSO in ee.
- Email law: CAN-SPAM (unsubscribe, physical address, honest headers), GDPR/ePrivacy for EU contacts (lawful basis, deletion/export), CASL if Canada. Ship templates + defaults that make compliance easy; ToS puts responsibility on senders.
- Abuse handling for cloud: account verification, sending limits for new tenants, complaint-rate auto-suspension.
- Publish `SECURITY.md` and a responsible-disclosure address before launch.

---

## 9. Licensing & monetization

**Licenses**
- Core: AGPL-3.0.
- `ee/`: proprietary "Orbyt Enterprise License" — usable only with a paid license key.
- CLA: use an established CLA (e.g., Apache ICLA-style or CLA Assistant bot) so contributions can be relicensed commercially. Set up *before* accepting external PRs.
- Trademark: register/protect the name; publish a trademark policy (AGPL does not grant brand rights).

**Revenue streams**
1. **Orbyt Cloud** subscriptions (per workspace + usage).
2. **Agency plan:** unlimited sub-accounts, white-label domain/branding, SaaS-mode billing (ee).
3. **AI credits** (usage-based, margin over provider cost).
4. **Add-on usage:** email volume, SMS/voice pass-through with margin, mailbox/domain provisioning fees.
5. **Enterprise license:** SSO, audit logs, SLA, priority support.
6. **Services:** migration from GHL, custom nodes, hosting — via Indepth Solution.

**Free community edition:** full core features for self-hosting, community support, no seat limits.

---

## 10. Roadmap

Time estimates assume a small team (founder + 1–2 contributors) working part-time alongside other work; treat as ranges, not promises. **Planning rule: multiply every estimate by 1.5–2×** (Phases 0–5 sum to ~29–40 weeks as written).

### Phase 0 — Foundation (≈ 1–2 weeks)
- [ ] Finalize name: domain, GitHub org, npm scope, social handles, trademark search (see §14)
- [ ] Create GitHub org + repo, AGPL `LICENSE`, `CLA.md`, CLA bot, `CONTRIBUTING.md`, `SECURITY.md`
- [x] Monorepo scaffold (pnpm + Turborepo), CI (format, typecheck, test, build; ESLint arrives with the first app)
- [ ] Docker Compose: Postgres, Redis, api, worker, web (Postgres + Redis done; object storage deferred — MinIO images are gone, see §15 Q9)
- [x] Choose ORM; write RLS helper + a cross-tenant test — **Drizzle**; `packages/db` (`withWorkspace()`, forced RLS on `contacts`, 7 isolation tests incl. a guard that fails if any `workspace_id` table lacks RLS)
- [ ] Decide auth library; basic design system (Tailwind + shadcn)
- [ ] Study Warmbly, Twenty, Dittofeed, Mautic for UX and architecture ideas (copy code only if the license is compatible and quality is verified — see §4.7)
- [ ] **Start Google OAuth app + restricted-scope (CASA) review prep** — longest lead time in the plan; needs domain, privacy policy, ToS

### Phase 1 — Core CRM & tenancy (≈ 4–6 weeks)
- [ ] Orgs/workspaces/users/roles; agency → sub-account switcher
- [ ] Contacts, companies, tags, custom fields, CSV import/export
- [ ] Pipelines/deals/tasks/notes
- [ ] REST API + OpenAPI + API keys + webhooks
- [ ] Settings UI, audit-friendly activity timeline
- **Exit:** demo CRM usable end-to-end; self-host works with one command.

### Phase 2 — Email MVP (≈ 6–8 weeks) → **public v0.1 release**
- [ ] Gmail + M365 OAuth, SMTP/IMAP connect
- [ ] Mailbox limits, rotation, sending windows, jitter
- [ ] Sequences (multi-step, delays, conditions on reply/open)
- [ ] Inbox sync, threading, reply/bounce detection, auto-pause
- [ ] Unsubscribe, suppression, tracking domain, optional open/click tracking
- [ ] Unified inbox UI; campaign analytics
- [ ] SPF/DKIM/DMARC checker + blacklist check
- [ ] Google OAuth verification: started in Phase 0; track review status here
- **Exit:** Indepth Solution runs a real campaign from Orbyt. Announce: GitHub, Product Hunt, r/selfhosted, Hacker News "Show HN".

### Phase 3 — Workflow engine (≈ 6–8 weeks)
- [ ] Durable executor, wait/branch/loop, retries, replay UI
- [ ] React Flow builder; triggers (event, webhook, schedule; `form` trigger arrives with the forms module in Phase 7)
- [ ] Node SDK + built-ins: HTTP, Webhook, Email, Tag/Update contact, Slack, Google Sheets, Stripe
- [ ] Sandboxed code node
- [ ] Migrate sequences onto the engine (or run side by side)

### Phase 4 — AI, SMS, voice (≈ 6–8 weeks)
- [ ] AI gateway (BYOK), reply classification, draft assist
- [ ] Chat agent with knowledge base
- [ ] Twilio SMS, WhatsApp
- [ ] Compliance before launch: US 10DLC registration for SMS; consent/TCPA rules for AI voice and outbound calls; legal review
- [ ] Retell voice node (inbound/outbound, call logging, transcripts into inbox)

### Phase 5 — Cloud & monetization (≈ 6–8 weeks)
- [ ] Stripe billing, plans, usage metering, AI credits
- [ ] Agency SaaS mode, white-label (custom domain, logo/colors)
- [ ] SSO, audit logs (ee), license-key enforcement
- [ ] Abuse controls and new-tenant sending limits
- [ ] Status page, backups, observability, on-call basics

### Phase 6 — Mail infrastructure (≈ ongoing)
- [ ] Workspace/M365 mailbox provisioning + domain purchase + DNS automation
- [ ] Warm-up ramp scheduler → opt-in peer pool
- [ ] Deliverability dashboard (Postmaster Tools, seed tests)
- [ ] Optional own-MTA support (Stalwart/Postal) for bring-your-own-IP

### Phase 7 — Ecosystem
- [ ] Community node registry, templates marketplace
- [ ] GHL → Orbyt importer (contacts, pipelines, workflows where possible)
- [ ] Docs site, tutorials, video series, Discord/community
- [ ] Forms/booking/calendar module; funnels/sites only if demanded

---

## 11. Go-to-market

1. **Dogfood:** move Indepth Solution's own outreach and a couple of friendly client accounts onto Orbyt.
2. **Open-source launch (v0.1):** README with a 60-second demo GIF, one-command install, honest "what's missing" list.
3. **Channels:** GitHub, r/selfhosted, Hacker News, Product Hunt, YouTube walkthroughs, AI-automation and GHL-agency communities.
4. **Content:** "Leave GoHighLevel" migration guides, deliverability guides, build-in-public updates.
5. **Cloud waitlist** from day one; early-bird pricing for agencies.
6. **Services upsell:** migration and custom builds via Indepth Solution (cash flow while the product matures).

---

## 12. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Deliverability disappointments | High | Honest docs, conservative defaults, deliverability tooling, no inbox-placement promises |
| Scope creep (GHL has everything) | High | Strict MVP; written non-goals; ship v0.1 early |
| Google/Microsoft policy changes on cold email or API access | High | Support SMTP/IMAP everywhere; keep provider adapters swappable |
| Gmail OAuth restricted-scope review delays cloud launch | Medium | Apply early; self-host works without it |
| Competitors (Warmbly, SeldonFrame) move first | Medium | Focus on agency mode + workflows + voice, ship fast |
| Cloud clones of AGPL code | Medium | AGPL + `ee/` features + trademark + brand/community |
| Contributors without CLA | High | CLA bot from first PR |
| Solo-founder bandwidth | High | Small team, ruthless prioritization, Indepth team as early contributors |
| Abuse / spam on cloud | High | Verification, send limits, complaint auto-suspension, ToS |
| Legal exposure (CAN-SPAM/GDPR) | Medium | Compliance defaults, clear ToS, legal review before cloud launch |

---

## 13. Start here — first 14 days

> This is a throwaway **spike** to prove the stack end to end. It does not replace Phases 0–1, which keep their own (1.5–2× padded) estimates.

**Days 1–2 — name & legal**
- Verify **Orbyt** availability: `.com`/`.io`/`.dev` domains, GitHub org, npm scope `@orbyt`, X/LinkedIn handles, USPTO/WIPO trademark search. If it fails, backups: Cadenza, Hivemail, Leadforge (check each the same way).
- Create GitHub org + empty repo; add AGPL-3.0 `LICENSE`.
- Set up CLA (CLA Assistant or similar).

**Days 3–5 — scaffold**
- `pnpm create` monorepo per §6; CI green on an empty build.
- `docker compose up` brings up Postgres, Redis, MinIO.
- NestJS API skeleton with health check; Next.js skeleton; shared UI package.

**Days 6–9 — tenancy & auth**
- Schema: organizations, workspaces, users, memberships.
- Auth (email/password + Google OAuth login), session handling.
- RLS policies + an automated test that proves tenant isolation.

**Days 10–14 — first vertical slice**
- Contacts CRUD with custom fields and tags, CSV import.
- API key auth + OpenAPI docs.
- README with architecture diagram and roadmap; public issues board with `good first issue` labels.

**Definition of done for week 2:** a new developer can clone, run `docker compose up`, sign up, create a workspace, import contacts, and call the API.

---

## 14. Naming

**Pick: Orbyt** (availability checks still open) — customers orbiting your pipeline; short, invented (like n8n), not tied to email only so it can grow. (Brand spelling with "y" is for domain/handle availability — check before committing.)

Names checked in a quick web search and **rejected** because the name is already in use in the CRM/automation space:
- *Outpost* — existing AI CRM (Outpost CRM) and a shared-inbox product (Outpost).
- *Flowdesk* — existing automation/ops company.
- *Relayr* — too close to Relay.app (workflow automation).

Backups (not yet checked): **Cadenza**, **Hivemail**, **Leadforge**, **Pulsar**.

Checklist before locking: domain(s), GitHub org, npm scope, Docker Hub/GHCR namespace, social handles, USPTO + WIPO trademark search in software classes (9, 42), a general web search for confusingly similar products.

---

## 15. Open questions (decide in Phase 0–1)

1. ORM: **resolved — Drizzle** (transaction-scoped `SET LOCAL` + hand-written RLS SQL migrations fit cleanly).
2. Auth library choice and session strategy.
3. Sequences vs workflows: ship both separately first, or build sequences on the workflow engine from the start?
4. Where does open tracking default — off (better deliverability) or on (what users expect)?
5. Reseller path for Google Workspace/M365 (own agreements vs bring-your-own-tenant only).
6. Hosting for the cloud edition (VPS/Fly/Render vs Kubernetes) and target regions.
7. Pricing model: per workspace, per mailbox, per contact, or usage-based?
8. How much of the workflow builder UX to borrow in spirit from n8n vs GHL's simpler style for non-technical agency users.
9. Object storage for self-host: **resolved for now** — `minio/minio` can no longer be pulled from Docker Hub or Quay (checked 2026-11-17), so local disk is the default. Revisit an S3-compatible option (e.g. Garage, SeaweedFS) when attachments land in Phase 2.

---

## Appendix A — Using Claude "without an API key"

Do **not** build on end-users' consumer subscription login tokens. Provider terms do not allow using subscription OAuth tokens inside third-party products, and enforcement can break the feature overnight. Instead:
- **BYOK** (user pastes their own API key) for community edition.
- **Managed credits** on cloud: Orbyt holds the API key, meters usage per workspace, bills with margin.
- Keep the gateway provider-agnostic (Claude, OpenAI, Gemini, Ollama) so no single vendor is a dependency.
- Re-read each provider's current terms before launch.

## Appendix B — Reference products to study
Warmbly (email + warmup), Twenty (CRM architecture, AGPL precedent), n8n (node SDK, fair-code model), Activepieces (MIT workflow engine), Dittofeed (multi-channel journeys), Mautic (campaign model), Cal.com (open-core + CLA + commercial licensing).
