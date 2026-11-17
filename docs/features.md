# Feature guide

Short how-tos for the parts that are not obvious from the screens.

## Connect Google or Microsoft mailboxes (OAuth)

1. Create an OAuth app with Google (Google Cloud console, scope `https://mail.google.com/`) and/or Microsoft (Entra ID app registration, delegated `SMTP.Send` and `IMAP.AccessAsUser.All`, plus `offline_access`).
2. Register the redirect URI `<BETTER_AUTH_URL>/api/oauth/callback` with each.
3. Set `GOOGLE_CLIENT_ID/SECRET` and/or `MICROSOFT_CLIENT_ID/SECRET` (`MICROSOFT_TENANT` defaults to `common`).
4. **Mailboxes → Connect Google / Microsoft.** The mailbox address comes from the provider; only the refresh token is stored (encrypted).

Google's restricted `mail.google.com` scope needs the provider's app verification before more than a handful of users can use your app. If a grant is revoked, the mailbox is parked with a message; connect it again to revive it.

## Workflow triggers

| Trigger | How it starts |
|---|---|
| Event | Any domain event: `contact.created`, `deal.won`, `email.replied`, `form.submitted`, `chat.message`, ... |
| Webhook | `POST /api/hooks/<workspaceId>/workflows/<token>` with JSON. An `email` field finds or creates the contact; the whole body is `event.data` in templates. Only while the workflow is **active**. |
| Schedule | Every N minutes (5 or more) while active. After downtime it runs once, then resumes its cadence. |
| Manual | The Run button or `POST /workflows/:id/run`. |

Templates use `{{ contact.email }}`, `{{ event.data.field | fallback }}` and `{{ steps.<node>.output.<key> }}`. The **template list** (New workflow → templates) gives six working starting points.

## Forms

**Forms → New form** creates a public endpoint. Either paste the generated HTML snippet into any page (a plain `<form method="post">`, no JavaScript) or post JSON to the URL. Each submission:

1. validates the fields (an `email` field is required),
2. creates the contact or updates the existing one (never overwriting what is already there),
3. adds the form's tags, records the submission and emits `form.submitted` (so workflows can react).

A hidden `_hp` honeypot field and a per-visitor rate limit (10 per minute) keep bots out. Pause a form to stop accepting submissions.

## Knowledge base and chat agents

Add documents under **Knowledge**. They are searched with Postgres full-text search (any of the question's words, ranked). They feed three things: the **Try it** box, public **chat agents**, and AI reply drafts in the inbox. A chat agent is a public endpoint (`POST /api/chat/<workspaceId>/<token>` with `{ "message": "...", "email": "optional" }`) for a website widget; it uses the workspace's AI provider and monthly token cap and answers only from the knowledge base. Visitors who leave an email become contacts.

## Moving from GoHighLevel

**Settings → Import from GoHighLevel.** Export Contacts and Opportunities as CSV from GoHighLevel, upload contacts first, then opportunities. Columns are matched by name (Contact Name, First/Last Name, Email, Phone, Business Name, Tags, Opportunity Name, Pipeline, Stage, Lead Value, Status). Contacts merge by email; opportunities create the pipelines and stages they mention and skip ones that already exist, so repeating an import is safe. GoHighLevel's own workflows, funnels and calendars have no export; rebuild automations from the workflow templates.

## Inviting people

**Settings → Invite people.** The invitee gets a link that works for 7 days (emailed if `ORBYT_SMTP_URL` is set; the link is always shown to you). They sign up or sign in with the invited email address and click **Join**. Inviting again replaces the old link.
