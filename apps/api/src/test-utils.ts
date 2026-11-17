import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  eq,
  inArray,
  organizationMembers,
  organizations,
  users,
  uuidv7,
} from "@orbyt/db";
import { AppModule } from "./app.module";
import { DbService } from "./db.service";
import { EventsService } from "./events.service";
import { configureApp, createAdapter } from "./http";

process.env.DATABASE_URL ??= "postgres://orbyt:orbyt@127.0.0.1:5432/orbyt";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-12345";
process.env.BETTER_AUTH_URL = "http://localhost:3001";
process.env.ORBYT_ALLOW_PRIVATE_URLS = "true"; // tests receive webhooks on 127.0.0.1
// Background loops are off in tests: they call scheduler.tick() / sync.syncAll() explicitly.
process.env.ORBYT_SCHEDULER = "off";
process.env.ORBYT_SYNC = "off";
process.env.ORBYT_WORKFLOWS = "off";
process.env.ORBYT_NO_JITTER = "true";
process.env.PUBLIC_URL = "http://localhost:3001";

export const origin = "http://localhost:3001";
export const password = "correct horse battery staple";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export async function createTestApp() {
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app =
    mod.createNestApplication<NestFastifyApplication>(createAdapter());
  configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const dbs = app.get(DbService);
  const events = app.get(EventsService);
  const emails: string[] = [];

  const request = (
    method: Method,
    url: string,
    opts: {
      cookie?: string;
      bearer?: string;
      payload?: unknown;
      type?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        origin,
        ...opts.headers,
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        ...(opts.payload !== undefined
          ? { "content-type": opts.type ?? "application/json" }
          : {}),
      },
      payload: opts.payload as string | object | undefined,
    });

  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    [res.headers["set-cookie"]]
      .flat()
      .filter(Boolean)
      .map((c) => String(c).split(";")[0])
      .join("; ");

  /** Sign up a fresh user (which provisions an org + "Default" workspace). */
  async function signUp(name: string) {
    const email = `${uuidv7()}@example.test`;
    emails.push(email);
    const res = await request("POST", "/api/auth/sign-up/email", {
      payload: { name, email, password },
    });
    if (res.statusCode !== 200) throw new Error(`sign-up failed: ${res.body}`);
    const cookie = cookieOf(res);
    const list = (
      await request("GET", "/api/me/workspaces", { cookie })
    ).json() as {
      id: string;
    }[];
    return {
      email,
      cookie,
      workspaceId: list[0]!.id,
      base: `/api/w/${list[0]!.id}`,
    };
  }

  async function cleanup() {
    await events.idle();
    if (emails.length) {
      const rows = await dbs.db
        .select({ orgId: organizationMembers.organizationId })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(inArray(users.email, emails));
      const orgIds = rows.map((r) => r.orgId);
      if (orgIds.length)
        await dbs.db
          .delete(organizations)
          .where(inArray(organizations.id, orgIds));
      await dbs.db.delete(users).where(inArray(users.email, emails));
    }
    await app.close();
  }

  return { app, dbs, events, request, cookieOf, signUp, cleanup };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
