import type { AddressInfo } from "node:net";
import { eq, invitations } from "@orbyt/db";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./test-utils";

let t: TestApp;
type User = Awaited<ReturnType<TestApp["signUp"]>>;
let alice: User; // workspace admin
let bob: User; // will be invited
let carol: User; // someone else
let dave: User; // plain member of alice's workspace
const mails: string[] = [];
let smtp: SMTPServer;

beforeAll(async () => {
  t = await createTestApp();
  alice = await t.signUp("Alice");
  bob = await t.signUp("Bob");
  carol = await t.signUp("Carol");
  dave = await t.signUp("Dave");
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS", "AUTH"],
    onData(stream, _session, cb) {
      let raw = "";
      stream.on("data", (c) => (raw += c));
      stream.on("end", () => {
        mails.push(raw);
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  process.env.ORBYT_SMTP_URL = `smtp://127.0.0.1:${(smtp.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  delete process.env.ORBYT_SMTP_URL;
  await new Promise((r) => smtp.close(() => r(null)));
  await t.cleanup();
});

const as = (u: User) => ({
  get: (p: string) => t.request("GET", p, { cookie: u.cookie }),
  post: (p: string, payload?: unknown) =>
    t.request("POST", p, { cookie: u.cookie, payload: payload ?? {} }),
  del: (p: string) => t.request("DELETE", p, { cookie: u.cookie }),
});
const tokenOf = (acceptUrl: string) =>
  new URL(acceptUrl).searchParams.get("token")!;
const invite = (email: string, role = "member") =>
  as(alice).post(`${alice.base}/invitations`, { email, role });

describe("invitations", () => {
  it("only workspace admins can invite", async () => {
    await as(alice).post(`${alice.base}/members`, {
      email: dave.email,
      role: "member",
    });
    expect(
      (
        await as(dave).post(`${alice.base}/invitations`, {
          email: "x@example.test",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await as(carol).post(`${alice.base}/invitations`, {
          email: "x@example.test",
        })
      ).statusCode,
    ).toBe(404); // not even a member: the workspace is invisible
  });

  it("invite, email the link, accept with the matching account, and become a member", async () => {
    const res = await invite(bob.email, "admin");
    expect(res.statusCode, res.body).toBe(201);
    const inv = res.json() as {
      id: string;
      acceptUrl: string;
      emailed: boolean;
    };
    expect(inv.emailed).toBe(true);
    const texts = await Promise.all(
      mails.map(async (m) => (await simpleParser(m)).text ?? ""),
    );
    expect(texts.some((x) => x.includes(inv.acceptUrl))).toBe(true);
    const token = tokenOf(inv.acceptUrl);

    // The page can look up what the link is for, without signing in.
    const info = await t.request("GET", `/api/invitations/${token}`);
    expect(info.json()).toMatchObject({ email: bob.email, role: "admin" });
    // The token is not stored in clear text.
    const stored = await t.dbs.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, inv.id));
    expect(JSON.stringify(stored)).not.toContain(token);

    // Pending list never exposes the token.
    const pending = (
      await as(alice).get(`${alice.base}/invitations`)
    ).json() as {
      email: string;
    }[];
    expect(pending.map((p) => p.email)).toContain(bob.email);
    expect(JSON.stringify(pending)).not.toContain(token);

    // Wrong account, and no account at all.
    expect(
      (await as(carol).post("/api/invitations/accept", { token })).statusCode,
    ).toBe(403);
    expect(
      (
        await t.request("POST", "/api/invitations/accept", {
          payload: { token },
        })
      ).statusCode,
    ).toBe(401);

    const accepted = await as(bob).post("/api/invitations/accept", { token });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toEqual({ workspaceId: alice.workspaceId });
    const workspaces = (await as(bob).get("/api/me/workspaces")).json() as {
      id: string;
    }[];
    expect(workspaces.map((w) => w.id)).toContain(alice.workspaceId);
    const members = (await as(alice).get(`${alice.base}/members`)).json() as {
      email: string;
      role: string;
    }[];
    expect(members.find((m) => m.email === bob.email)?.role).toBe("admin");

    // One use only.
    expect(
      (await as(bob).post("/api/invitations/accept", { token })).statusCode,
    ).toBe(404);
    expect(
      (await t.request("GET", `/api/invitations/${token}`)).statusCode,
    ).toBe(404);
    // And inviting someone who is already in conflicts.
    expect((await invite(bob.email)).statusCode).toBe(409);
  });

  it("inviting again replaces the old link; revoking and expiry kill it", async () => {
    const email = `new-${Date.now()}@example.test`;
    const first = (await invite(email)).json() as { acceptUrl: string };
    const second = (await invite(email)).json() as {
      id: string;
      acceptUrl: string;
    };
    expect(
      (await t.request("GET", `/api/invitations/${tokenOf(first.acceptUrl)}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await t.request("GET", `/api/invitations/${tokenOf(second.acceptUrl)}`))
        .statusCode,
    ).toBe(200);

    expect(
      (await as(alice).del(`${alice.base}/invitations/${second.id}`))
        .statusCode,
    ).toBe(204);
    expect(
      (await t.request("GET", `/api/invitations/${tokenOf(second.acceptUrl)}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await as(alice).del(`${alice.base}/invitations/${second.id}`))
        .statusCode,
    ).toBe(404);

    const third = (await invite(email)).json() as {
      id: string;
      acceptUrl: string;
    };
    await t.dbs.db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, third.id));
    expect(
      (await t.request("GET", `/api/invitations/${tokenOf(third.acceptUrl)}`))
        .statusCode,
    ).toBe(404);
  });

  it("garbage tokens are a plain 404", async () => {
    expect((await t.request("GET", "/api/invitations/nope")).statusCode).toBe(
      404,
    );
  });
});
