# Commercial tier: licenses, SSO, white-label, audit log, billing

> **Licensing status.** `ee/LICENSE` is a placeholder and says no code goes under `ee/` until the commercial license text is approved. So this code lives in `apps/api/src/enterprise/` (everything else in the repository is AGPL-3.0). Moving that folder to `ee/` is a mechanical change once the terms are final. A fork can remove the gating; that is the normal open-core trade-off.

## What is gated

| Feature | Without a license | With it |
|---|---|---|
| Audit log (`GET /api/w/:id/audit-logs`, Settings card) | Recorded, but not readable (HTTP 402) | Readable |
| White-label (name, logo, colour, custom domain) | Not served (HTTP 402) | Served on the custom domain's sign-in page and app shell |
| Single sign-on (OpenID Connect) | Endpoints closed (HTTP 402) | Works |

Everything else is free and unlimited when self-hosting.

## License keys (self-hosted)

Keys are Ed25519-signed JSON (`sub`, `features`, `exp`, optional `maxWorkspaces`/`maxMailboxes`) and verified **offline**; there is no phone-home.

```sh
node scripts/license.mjs keygen ./keys                 # once: private key (secret!) + public key
node scripts/license.mjs sign --key keys/license-private.pem --sub "Acme Agency" \
     --features sso,audit_logs,white_label --days 365 --max-workspaces 50
```

Give the customer the printed key (`ORBYT_LICENSE_KEY`). Builds you distribute must carry your **public** key (`ORBYT_LICENSE_PUBLIC_KEY`, or a file named by `ORBYT_LICENSE_PUBLIC_KEY_FILE`). With no public key configured no license is ever valid. Never commit the private key.

## Single sign-on

Installation-wide OpenID Connect (Okta, Entra ID, Google Workspace, Keycloak, ...). It needs a license with the `sso` feature; a Stripe plan does not unlock it. Set `ORBYT_SSO_DISCOVERY_URL` (the provider's `.well-known/openid-configuration`), `ORBYT_SSO_CLIENT_ID`, `ORBYT_SSO_CLIENT_SECRET` and optionally `ORBYT_SSO_NAME` (button label); register `<BETTER_AUTH_URL>/api/auth/callback/sso` as the redirect URI. The sign-in page then shows "Sign in with <name>". New people get an organization and workspace like a normal sign-up.

**Accounts are not merged automatically.** Sign-up does not verify email addresses, so linking an SSO login to an existing password account with the same address would let whoever registered it first keep access. Such a login is refused (`account_not_linked`); the person signs in with their password, or an admin removes the stale account.

## White-label

Settings → White-label (owners/admins of the organization): product name, logo URL, accent colour and a custom domain. Point the domain's DNS and your reverse proxy at the web container; the sign-in page and app shell then show the brand for visitors arriving on that host.

## Audit log

Sensitive changes are recorded with who (user or API key) did what to which object: API keys, webhooks, members, invitations, mailboxes (including OAuth connections), AI providers, channels, workflows, sequences, suppressions, forms, knowledge base, chat agents, custom fields and pipelines. Request bodies are **never** stored (they can contain secrets). The table is append-only for the application role.

## Plans and billing (hosted cloud)

Setting `STRIPE_SECRET_KEY` turns on cloud mode: organizations without a paid subscription are on the **free** plan (1 workspace, 2 mailboxes). **Pro** (3 workspaces, 10 mailboxes) and **agency** (100 / 200, plus the audit log and white-label) are sold through Stripe Checkout.

1. In Stripe create two recurring prices; put their ids in `STRIPE_PRICE_PRO` and `STRIPE_PRICE_AGENCY`.
2. Add a webhook endpoint `<BETTER_AUTH_URL>/api/stripe/webhook` for `checkout.session.completed` and `customer.subscription.created|updated|deleted`; put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Plan limits are enforced when creating workspaces and mailboxes (HTTP 402 with a clear message). A subscription that is not `active` or `trialing` falls back to free.

Subscription state is written only by the verified webhook. The limits live in `apps/api/src/enterprise/plans.ts`.
