import "reflect-metadata";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  eq,
  inArray,
  organizationMembers,
  organizations,
  users,
  uuidv7,
} from "@orbyt/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth";
import { AppModule } from "./app.module";
import { DbService } from "./db.service";

process.env.DATABASE_URL ??= "postgres://orbyt:orbyt@127.0.0.1:5432/orbyt";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-12345";
process.env.BETTER_AUTH_URL = "http://localhost:3001";

const origin = "http://localhost:3001";
const password = "correct horse battery staple";

let app: NestFastifyApplication;
let dbs: DbService;
const emails: string[] = [];

beforeAll(async () => {
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  dbs = app.get(DbService);
});

afterAll(async () => {
  // Remove what the tests created: the orgs first (cascades memberships), then the users.
  const rows = await dbs.db
    .select({ orgId: organizationMembers.organizationId })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(inArray(users.email, emails));
  const orgIds = rows.map((r) => r.orgId);
  if (orgIds.length)
    await dbs.db.delete(organizations).where(inArray(organizations.id, orgIds));
  if (emails.length)
    await dbs.db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

const post = (url: string, payload: object) =>
  app.inject({
    method: "POST",
    url,
    headers: { origin, "content-type": "application/json" },
    payload,
  });

const cookieOf = (res: { headers: Record<string, unknown> }) =>
  [res.headers["set-cookie"]]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(";")[0])
    .join("; ");

async function signUp(name: string) {
  const email = `${uuidv7()}@example.test`;
  emails.push(email);
  const res = await post("/api/auth/sign-up/email", { name, email, password });
  expect(res.statusCode).toBe(200);
  return { email, cookie: cookieOf(res) };
}

const myWorkspaces = (cookie?: string) =>
  app.inject({
    method: "GET",
    url: "/api/me/workspaces",
    headers: cookie ? { cookie } : {},
  });

describe("auth + tenancy", () => {
  it("rejects unauthenticated access", async () => {
    expect((await myWorkspaces()).statusCode).toBe(401);
  });

  it("sign-up signs the user in and provisions a default workspace", async () => {
    const { cookie } = await signUp("Alice");
    expect(cookie).toContain("session_token");
    const res = await myWorkspaces(cookie);
    expect(res.statusCode).toBe(200);
    const list = res.json() as { id: string; name: string }[];
    expect(list.map((w) => w.name)).toEqual(["Default"]);
  });

  it("each user sees only their own workspace", async () => {
    const a = await signUp("Bob");
    const b = await signUp("Carol");
    const [wa] = (await myWorkspaces(a.cookie)).json() as { id: string }[];
    const [wb] = (await myWorkspaces(b.cookie)).json() as { id: string }[];
    expect(wa!.id).not.toEqual(wb!.id);
    expect((await myWorkspaces(a.cookie)).json()).toHaveLength(1);
    expect((await myWorkspaces(b.cookie)).json()).toHaveLength(1);
  });

  it("signs in with the right password and rejects a wrong one", async () => {
    const { email } = await signUp("Dave");
    const ok = await post("/api/auth/sign-in/email", { email, password });
    expect(ok.statusCode).toBe(200);
    expect((await myWorkspaces(cookieOf(ok))).statusCode).toBe(200);
    const bad = await post("/api/auth/sign-in/email", {
      email,
      password: "wrong password entirely",
    });
    expect(bad.statusCode).toBe(401);
  });

  it("refuses to boot with a short secret", async () => {
    const prev = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "short";
    expect(() => createAuth(dbs.db)).toThrow(/at least 32/);
    process.env.BETTER_AUTH_SECRET = prev;
  });
});
