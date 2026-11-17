import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq, mailboxes } from "@orbyt/db";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemScope } from "../scope";
import { createTestApp, type TestApp } from "../test-utils";
import { MailService, SendError, type MailboxRow } from "./mail.service";
import { signToken } from "./secrets";
import { SyncService } from "./sync.service";

// ---- a mock "Google": token endpoint + an SMTP server that only accepts XOAUTH2 ----
let provider: http.Server;
let smtp: SMTPServer;
let providerUrl: string;
let smtpPort: number;
let nextEmail = "";
let nextRefreshToken: string | undefined = "rt-good";
let refreshStatus = 200;
const tokenCalls: Record<string, string>[] = [];
const smtpAuths: { user: string; token: string }[] = [];
let accessCounter = 0;

let t: TestApp;
type User = Awaited<ReturnType<TestApp["signUp"]>>;
let alice: User;
let mail: MailService;
let sync: SyncService;

beforeAll(async () => {
  provider = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(raw));
      tokenCalls.push(form);
      res.setHeader("content-type", "application/json");
      if (form.grant_type === "authorization_code") {
        const idToken = `h.${Buffer.from(JSON.stringify({ email: nextEmail })).toString("base64url")}.s`;
        return res.end(
          JSON.stringify({
            access_token: `at-${++accessCounter}`,
            refresh_token: nextRefreshToken,
            expires_in: 3600,
            id_token: idToken,
          }),
        );
      }
      // refresh_token grant
      if (refreshStatus !== 200 || form.refresh_token === "rt-revoked") {
        res.statusCode = refreshStatus !== 200 ? refreshStatus : 400;
        return res.end(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Token has been revoked",
          }),
        );
      }
      res.end(
        JSON.stringify({
          access_token: `at-${++accessCounter}`,
          expires_in: 3600,
        }),
      );
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  smtp = new SMTPServer({
    authMethods: ["XOAUTH2"],
    allowInsecureAuth: true,
    disabledCommands: ["STARTTLS"],
    onAuth(auth, _session, cb) {
      if (auth.method !== "XOAUTH2" || !auth.accessToken?.startsWith("at-"))
        return cb(new Error("Invalid credentials"));
      smtpAuths.push({ user: auth.username ?? "", token: auth.accessToken });
      cb(null, { user: auth.username });
    },
    onData(stream, _session, cb) {
      stream.resume();
      stream.on("end", () => cb());
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  smtpPort = (smtp.server.address() as AddressInfo).port;

  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gsecret";
  process.env.GOOGLE_AUTH_URL = `${providerUrl}/auth`;
  process.env.GOOGLE_TOKEN_URL = `${providerUrl}/token`;
  t = await createTestApp();
  alice = await t.signUp("Alice");
  mail = t.app.get(MailService);
  sync = t.app.get(SyncService);
});
afterAll(async () => {
  for (const k of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_AUTH_URL",
    "GOOGLE_TOKEN_URL",
  ])
    delete process.env[k];
  await t.cleanup();
  await new Promise((r) => provider.close(r));
  await new Promise((r) => smtp.close(() => r(null)));
});

const as = (u: User) => ({
  get: (p: string) => t.request("GET", u.base + p, { cookie: u.cookie }),
  post: (p: string, payload?: unknown) =>
    t.request("POST", u.base + p, { cookie: u.cookie, payload: payload ?? {} }),
  patch: (p: string, payload: unknown) =>
    t.request("PATCH", u.base + p, { cookie: u.cookie, payload }),
});
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
const rand = () => Math.random().toString(36).slice(2, 8);
const listMailboxes = async () =>
  (await as(alice).get("/mailboxes")).json() as {
    email: string;
    status: string;
    lastError: string | null;
  }[];

/** Runs "Connect Google" as the browser would; returns where the callback sent it. */
async function connect(email: string, hint?: string) {
  nextEmail = email;
  const start = await as(alice).post("/mailboxes/oauth/start", {
    provider: "google",
    loginHint: hint,
  });
  expect(start.statusCode, start.body).toBe(200);
  const cb = await t.request(
    "GET",
    `/api/oauth/callback?code=abc&state=${encodeURIComponent(stateOf(start.json().url))}`,
  );
  expect(cb.statusCode).toBe(302);
  return new URL(String(cb.headers.location));
}
const rowOf = async (email: string): Promise<MailboxRow> =>
  (
    await t.dbs.inWorkspace(systemScope(alice.workspaceId), (tx) =>
      tx.select().from(mailboxes).where(eq(mailboxes.email, email)),
    )
  )[0]!;
const sendTest = (box: MailboxRow) =>
  mail.send({
    mailbox: {
      ...box,
      smtpHost: "127.0.0.1",
      smtpPort: smtpPort,
      smtpSecure: false,
    },
    to: "someone@example.test",
    subject: "hi",
    text: "hi",
    html: "<p>hi</p>",
    messageId: `${rand()}@example.test`,
  });

describe("Google / Microsoft mailboxes (OAuth)", () => {
  it("only offers providers that are configured", async () => {
    const list = (await as(alice).get("/mailboxes/oauth/providers")).json();
    expect(list).toEqual([
      { provider: "google", configured: true },
      { provider: "microsoft", configured: false },
    ]);
    const res = await as(alice).post("/mailboxes/oauth/start", {
      provider: "microsoft",
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("MICROSOFT_CLIENT_ID");
  });

  it("builds the consent URL, connects the mailbox from the callback and never exposes tokens", async () => {
    const email = `agent-${rand()}@gmail.test`;
    const start = await as(alice).post("/mailboxes/oauth/start", {
      provider: "google",
      loginHint: email,
    });
    const url = new URL(start.json().url);
    expect(url.origin + url.pathname).toBe(`${providerUrl}/auth`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "gid",
      response_type: "code",
      login_hint: email,
      access_type: "offline",
      redirect_uri: "http://localhost:3001/api/oauth/callback",
    });
    expect(url.searchParams.get("scope")).toContain("https://mail.google.com/");

    const done = await connect(email, email);
    expect(done.pathname).toBe(`/app/${alice.workspaceId}/mailboxes`);
    expect(done.searchParams.get("connected")).toBe(email);

    const box = (await as(alice).get("/mailboxes"))
      .json()
      .find((m: { email: string }) => m.email === email);
    expect(box).toMatchObject({
      authType: "google",
      smtpHost: "smtp.gmail.com",
      imapHost: "imap.gmail.com",
      status: "active",
    });
    expect(JSON.stringify(box)).not.toMatch(/rt-good|credentials|refresh/i);
    // The refresh token is stored encrypted.
    expect((await rowOf(email)).credentialsEnc).not.toContain("rt-good");
  });

  it("sends with XOAUTH2 and reuses the access token until it nears expiry", async () => {
    const email = `agent-${rand()}@gmail.test`;
    await connect(email);
    const box = await rowOf(email);
    const refreshes = () =>
      tokenCalls.filter((c) => c.grant_type === "refresh_token").length;
    const before = refreshes();
    smtpAuths.length = 0;
    await sendTest(box);
    await sendTest(box);
    expect(smtpAuths).toHaveLength(2);
    expect(smtpAuths[0]).toMatchObject({ user: email });
    expect(smtpAuths[0]!.token).toBe(smtpAuths[1]!.token);
    expect(refreshes() - before).toBe(1);
    const refresh = tokenCalls
      .filter((c) => c.grant_type === "refresh_token")
      .at(-1)!;
    expect(refresh).toMatchObject({
      client_id: "gid",
      client_secret: "gsecret",
      refresh_token: "rt-good",
    });
  });

  it("a revoked grant parks the mailbox with a clear message; reconnecting revives it", async () => {
    const email = `agent-${rand()}@gmail.test`;
    nextRefreshToken = "rt-revoked";
    await connect(email);
    nextRefreshToken = "rt-good";
    const box = await rowOf(email);

    const err = await sendTest(box).catch((e) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err.kind).toBe("auth");
    expect(err.message).toContain("revoked");

    // Inbox sync records the problem on the mailbox instead of throwing.
    const synced = await sync.syncMailbox(alice.workspaceId, box.id);
    expect(synced.error).toContain("revoked");
    const parked = (await listMailboxes()).find((m) => m.email === email)!;
    expect(parked.status).toBe("error");
    expect(parked.lastError).toContain("revoked");

    // Connect again with a good grant: same mailbox, active again, and it sends.
    const done = await connect(email);
    expect(done.searchParams.get("connected")).toBe(email);
    expect(
      (await listMailboxes()).filter((m) => m.email === email),
    ).toHaveLength(1);
    const revived = await rowOf(email);
    expect(revived).toMatchObject({ status: "active", lastError: null });
    await sendTest(revived);
  });

  it("a provider outage is retried later, not treated as a broken login", async () => {
    const email = `agent-${rand()}@gmail.test`;
    await connect(email);
    const box = await rowOf(email); // no access token cached yet
    refreshStatus = 503;
    try {
      const err = await sendTest(box).catch((e) => e);
      expect(err).toBeInstanceOf(SendError);
      expect(err.kind).toBe("transient");
      const synced = await sync.syncMailbox(alice.workspaceId, box.id);
      expect(synced.error).toBeTruthy();
      expect(
        (await listMailboxes()).find((m) => m.email === email)!.status,
      ).toBe("active");
    } finally {
      refreshStatus = 200;
    }
  });

  it("rejects forged, expired and mismatched callbacks without creating mailboxes", async () => {
    const before = (await listMailboxes()).length;
    const go = async (state: string, extra = "&code=abc") => {
      const r = await t.request(
        "GET",
        `/api/oauth/callback?state=${encodeURIComponent(state)}${extra}`,
      );
      return new URL(String(r.headers.location));
    };
    const valid = {
      w: alice.workspaceId,
      u: null,
      p: "google",
      hint: null,
      exp: Date.now() + 60_000,
      n: "x",
    };
    const good = signToken(valid);
    const tampered = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");

    expect((await go("garbage")).searchParams.get("error")).toContain(
      "expired",
    );
    expect(
      (
        await go(signToken({ ...valid, exp: Date.now() - 1000 }))
      ).searchParams.get("error"),
    ).toContain("expired");
    expect((await go(tampered)).searchParams.get("error")).toContain("expired");

    // The user denied access at the provider.
    const denied = await go(good, "&error=access_denied");
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.pathname).toBe(`/app/${alice.workspaceId}/mailboxes`);

    // Signed in as someone other than the address the admin asked for.
    nextEmail = "other@gmail.test";
    const mismatch = await go(
      signToken({ ...valid, hint: "wanted@gmail.test" }),
    );
    expect(mismatch.searchParams.get("error")).toContain("wanted@gmail.test");

    // The provider did not hand out a refresh token.
    nextEmail = `norefresh-${rand()}@gmail.test`;
    nextRefreshToken = undefined;
    const none = await go(good);
    nextRefreshToken = "rt-good";
    expect(none.searchParams.get("error")).toContain("refresh token");

    expect((await listMailboxes()).length).toBe(before);
  });

  it("only admins can start a connection, and passwords cannot be set on OAuth mailboxes", async () => {
    const bob = await t.signUp("Bob");
    expect(
      (
        await t.request("POST", `${alice.base}/mailboxes/oauth/start`, {
          cookie: bob.cookie,
          payload: { provider: "google" },
        })
      ).statusCode,
    ).toBe(404);
    const email = `agent-${rand()}@gmail.test`;
    await connect(email);
    const box = await rowOf(email);
    const res = await as(alice).patch(`/mailboxes/${box.id}`, {
      smtp: { password: "hunter2hunter2" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Reconnect");
  });
});
