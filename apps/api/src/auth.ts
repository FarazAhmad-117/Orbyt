import {
  accounts,
  provisionTenant,
  sessions,
  users,
  uuidv7,
  verifications,
  type Db,
} from "@orbyt/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import type { FastifyRequest } from "fastify";
import { requireEnv } from "./db.service";

export const AUTH = Symbol("AUTH");

/**
 * Single sign-on through any OpenID Connect provider (Okta, Entra ID, Google Workspace, Keycloak...),
 * configured for the whole installation: ORBYT_SSO_DISCOVERY_URL, ORBYT_SSO_CLIENT_ID,
 * ORBYT_SSO_CLIENT_SECRET (and optionally ORBYT_SSO_NAME for the button label). The endpoints only
 * answer when a license with the "sso" feature is present (see AuthController).
 */
export const ssoConfigured = () =>
  !!process.env.ORBYT_SSO_DISCOVERY_URL && !!process.env.ORBYT_SSO_CLIENT_ID;

export function createAuth(db: Db) {
  const secret = requireEnv("BETTER_AUTH_SECRET");
  if (secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");

  return betterAuth({
    secret,
    baseURL:
      process.env.BETTER_AUTH_URL ??
      `http://localhost:${process.env.PORT ?? 3001}`,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
      },
    }),
    emailAndPassword: { enabled: true },
    plugins: ssoConfigured()
      ? [
          genericOAuth({
            config: [
              {
                providerId: "sso",
                name: process.env.ORBYT_SSO_NAME || "SSO",
                discoveryUrl: process.env.ORBYT_SSO_DISCOVERY_URL!,
                clientId: process.env.ORBYT_SSO_CLIENT_ID!,
                clientSecret: process.env.ORBYT_SSO_CLIENT_SECRET,
                scopes: ["openid", "email", "profile"],
                // The OIDC `sub` claim of the userinfo response is the stable identity of the person.
                accountSubject: ({ profile }) => String(profile.sub ?? ""),
              },
            ],
          }),
        ]
      : [],
    // No automatic account linking: sign-up does not verify emails, so an SSO login must never be
    // merged into a password account someone else created with the same address (pre-hijacking).
    advanced: { database: { generateId: () => uuidv7() } },
    telemetry: { enabled: false }, // self-hosted: never phone home
    databaseHooks: {
      user: {
        create: {
          // shortcut: if this throws, the user exists without a tenant and a retry fails with
          // "user exists". Make provisioning lazy/idempotent when sign-up flows grow.
          after: async (user) => {
            await provisionTenant(db, {
              userId: user.id,
              organizationName: `${user.name}'s organization`,
              workspaceName: "Default",
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Fastify request headers -> Web Headers (what better-auth expects). */
export function toHeaders(req: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined)
      headers.append(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}
