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
import type { FastifyRequest } from "fastify";
import { requireEnv } from "./db.service";

export const AUTH = Symbol("AUTH");

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
