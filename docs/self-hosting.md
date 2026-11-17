# Self-hosting Orbyt

Orbyt is one API (NestJS), one web app (Next.js) and one Postgres database. Everything else (email sending, inbox sync, workflows, schedules) runs inside the API process and keeps its state in Postgres, so there is nothing else to operate.

## 1. With Docker Compose

> The published images (`ghcr.io/<org>/orbyt-api` and `-web`) are wired up in `.github/workflows/release.yml` but have **not been published yet**. Until the first release tag, build locally with `--build`.

```sh
cp .env.example .env
# edit .env: set BETTER_AUTH_SECRET and ORBYT_ENCRYPTION_KEY (openssl rand -base64 32 for each),
# and BETTER_AUTH_URL to the address people will open (e.g. https://crm.example.com)
docker compose --profile apps up -d --build
```

Open the `BETTER_AUTH_URL`, create the first account, and you are in. Put a reverse proxy with HTTPS (Caddy, nginx, Traefik) in front of the **web** container (port 3000): it forwards `/api` to the API itself, so only one public address is needed.

Postgres data lives in the `pgdata` volume. **Back it up** (see [operations.md](operations.md)) and keep your `ORBYT_ENCRYPTION_KEY`: without it the mailbox passwords, AI keys and channel credentials in a backup cannot be read.

## 2. Required and recommended settings

| Variable | Notes |
|---|---|
| `BETTER_AUTH_SECRET` | Required, 32+ characters. Signs sessions. |
| `BETTER_AUTH_URL` | The public web address. Used in invitation, unsubscribe, tracking and OAuth/Stripe return links. Must be right or those links break. |
| `ORBYT_ENCRYPTION_KEY` | Set explicitly in production. If unset a key is derived from `BETTER_AUTH_SECRET`, and rotating that secret would lock stored credentials. |
| `ORBYT_ALLOW_PRIVATE_URLS` | Keep `false` on shared hosting (blocks requests to private networks). Set `true` to use a local Ollama or an SMTP server on your LAN. |

Optional features (invitation emails, Google/Microsoft mailboxes, SSO, billing, metrics) are all off while their variables are empty; see the table in the [README](../README.md#configuration).

## 3. Email sending basics

- Connect real mailboxes under **Mailboxes** (SMTP + IMAP, or Google/Microsoft sign-in once configured).
- Use **Warm up** on new mailboxes: the daily limit ramps from 5/day by about 20% a day up to the limit you set.
- Run the **Deliverability check** for each sending domain (SPF, DKIM, DMARC, MX, blocklist).
- Bring-your-own-MTA works: Postal, Stalwart or any SMTP/IMAP server can be added as an ordinary mailbox.

## 4. Updating

Pull the new images (or code) and restart. The API applies database migrations on start under an advisory lock, so several replicas can boot at once. Always take a backup first.

## 5. Running several API replicas

The scheduler, inbox sync and workflow executor claim work with `FOR UPDATE SKIP LOCKED`, so replicas are safe. To run the background loops on one dedicated instance, set `ORBYT_SCHEDULER=off ORBYT_SYNC=off ORBYT_WORKFLOWS=off` on the others. Public-endpoint rate limits are per process.
