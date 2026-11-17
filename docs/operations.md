# Operations

## Health and status

- `GET /health`: liveness (used by the Docker healthcheck). Always cheap.
- `GET /api/status`: readiness and a status-page data source: database reachability and latency, version (`ORBYT_VERSION`), uptime, and when the scheduler, inbox sync and workflow loops last finished a pass. Returns 503 when the database is down. A monitor should also alert when a loop's `lastRunAt` is older than a few minutes.

## Metrics (Prometheus)

Set `ORBYT_METRICS_TOKEN` and scrape `GET /api/metrics` with `Authorization: Bearer <token>`. Without a token the endpoint answers 404. Exposed: `orbyt_up`, `orbyt_database_up`, `orbyt_process_uptime_seconds`, `orbyt_process_resident_memory_bytes`, `orbyt_emails_sent_total`, `orbyt_inbound_messages_total`, `orbyt_workflow_steps_total`, `orbyt_loop_errors_total{loop}` and `orbyt_loop_last_run_timestamp_seconds{loop}`. Counters are per process: scrape every replica and sum.

Useful alerts: `orbyt_database_up == 0`; `time() - orbyt_loop_last_run_timestamp_seconds > 300`; `increase(orbyt_loop_errors_total[15m]) > 0`.

## Backups

Everything is in Postgres.

```sh
DATABASE_URL=postgres://... ./scripts/backup.sh backups/            # pg_dump -Fc
./scripts/backup.sh --docker backups/                               # from the compose postgres container
pg_restore --no-owner --clean --if-exists -d "$DATABASE_URL" backups/orbyt-<timestamp>.dump
```

The script fails loudly on an empty dump. Schedule it (cron, systemd timer, your platform's scheduler), copy dumps off the machine, and **test a restore** into a scratch database now and then. Keep `ORBYT_ENCRYPTION_KEY` (and `BETTER_AUTH_SECRET`) with your backups: stored mailbox passwords, AI keys and channel credentials are encrypted with them.

## Abuse controls for shared / cloud hosting

- `ORBYT_NEW_TENANT_DAILY_LIMIT=50` caps the **total** emails per rolling 24 hours for workspaces younger than `ORBYT_NEW_TENANT_DAYS` (default 7), across all their mailboxes. Off when unset.
- `ORBYT_ALLOW_PRIVATE_URLS=false` (default) blocks mailbox hosts, webhooks and AI endpoints that resolve to private networks.
- Public endpoints (forms, chat, workflow webhooks) are token-addressed and the form/chat ones are rate limited per visitor (in memory, per process).
- Suppression, unsubscribe and bounce handling are always on; a rejected login parks a mailbox instead of burning through contacts.
- Hosted plans cap workspaces and mailboxes ([enterprise.md](enterprise.md#plans-and-billing-hosted-cloud)).

## Incident basics

- Mail not sending: check `/api/status` loops, then Mailboxes for `error` status and its message (revoked OAuth grant, wrong password, unreadable credentials after a key change).
- Workflows stuck: open the workflow's runs; failed steps show their error; running ones continue after a restart. Cancel or replay from the run view.
- Roll back a release: restore the previous image; migrations are forward-only, so restore the pre-update backup if a migration must be undone.
