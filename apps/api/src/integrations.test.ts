import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./test-utils";
import { signWebhook } from "./webhooks.service";

process.env.WEBHOOK_RETRY_BASE_MS = "5";

let t: TestApp;
let alice: Awaited<ReturnType<TestApp["signUp"]>>;
let bob: Awaited<ReturnType<TestApp["signUp"]>>;

// A tiny webhook receiver on loopback.
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let failNext = 0;
let server: http.Server;
let url: string;

beforeAll(async () => {
  t = await createTestApp();
  alice = await t.signUp("Alice");
  bob = await t.signUp("Bob");
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.statusCode = failNext > 0 ? (failNext--, 500) : 200;
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});
afterAll(async () => {
  await t.cleanup();
  await new Promise((r) => server.close(r));
});

const as = (u: typeof alice) => ({
  get: (path: string) => t.request("GET", u.base + path, { cookie: u.cookie }),
  post: (path: string, payload?: unknown) =>
    t.request("POST", u.base + path, { cookie: u.cookie, payload }),
  patch: (path: string, payload: unknown) =>
    t.request("PATCH", u.base + path, { cookie: u.cookie, payload }),
  del: (path: string) =>
    t.request("DELETE", u.base + path, { cookie: u.cookie }),
});

describe("API keys", () => {
  it("authenticate API calls for exactly one workspace, can be revoked, and are never re-shown", async () => {
    const created = await as(alice).post("/api-keys", { name: "CI" });
    expect(created.statusCode).toBe(201);
    const { id, key } = created.json();
    expect(key).toMatch(/^orbyt_/);

    const list = (await as(alice).get("/api-keys")).json();
    expect(JSON.stringify(list)).not.toContain(key);
    expect(JSON.stringify(list)).not.toContain("hash");

    const ok = await t.request("GET", `${alice.base}/contacts`, {
      bearer: key,
    });
    expect(ok.statusCode).toBe(200);
    // Scoped to its own workspace only.
    expect(
      (await t.request("GET", `${bob.base}/contacts`, { bearer: key }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await t.request("GET", `${alice.base}/contacts`, {
          bearer: "orbyt_nope",
        })
      ).statusCode,
    ).toBe(401);
    // A key can create data but cannot manage keys or webhooks.
    const made = await t.request("POST", `${alice.base}/contacts`, {
      bearer: key,
      payload: { email: "viakey@example.com" },
    });
    expect(made.statusCode).toBe(201);
    expect(
      (
        await t.request("POST", `${alice.base}/api-keys`, {
          bearer: key,
          payload: { name: "x" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await t.request("GET", `${alice.base}/webhooks`, { bearer: key }))
        .statusCode,
    ).toBe(403);

    expect((await as(alice).del(`/api-keys/${id}`)).statusCode).toBe(204);
    expect(
      (await t.request("GET", `${alice.base}/contacts`, { bearer: key }))
        .statusCode,
    ).toBe(401);
  });

  it("another tenant cannot list or revoke the key", async () => {
    const { id } = (await as(alice).post("/api-keys", { name: "mine" })).json();
    expect(
      (await as(bob).get("/api-keys"))
        .json()
        .some((k: { id: string }) => k.id === id),
    ).toBe(false);
    expect((await as(bob).del(`/api-keys/${id}`)).statusCode).toBe(404);
  });
});

describe("webhooks", () => {
  it("delivers signed events for subscribed types only, retries 5xx, and honours `active`", async () => {
    const created = await as(alice).post("/webhooks", {
      url,
      events: ["contact.created"],
    });
    expect(created.statusCode).toBe(201);
    const hook = created.json();
    expect(hook.secret).toMatch(/^whsec_/);
    expect(
      JSON.stringify((await as(alice).get("/webhooks")).json()),
    ).not.toContain(hook.secret);

    received.length = 0;
    await as(alice).post("/companies", { name: "Not subscribed" }); // company.created
    await as(alice).post("/contacts", { email: "hook1@example.com" });
    await t.events.idle();
    expect(received).toHaveLength(1);
    const [hit] = received;
    expect(hit!.headers["x-orbyt-event"]).toBe("contact.created");
    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(
      String(hit!.headers["x-orbyt-signature"]),
    )!;
    expect(sig[2]).toBe(signWebhook(hook.secret, Number(sig[1]), hit!.body));
    expect(JSON.parse(hit!.body)).toMatchObject({
      type: "contact.created",
      workspaceId: alice.workspaceId,
      data: { email: "hook1@example.com" },
    });

    // A failing receiver is retried until it succeeds.
    received.length = 0;
    failNext = 1;
    await as(alice).post("/contacts", { email: "hook2@example.com" });
    await t.events.idle();
    expect(received).toHaveLength(2);

    // Inactive hooks are skipped.
    await as(alice).patch(`/webhooks/${hook.id}`, { active: false });
    received.length = 0;
    await as(alice).post("/contacts", { email: "hook3@example.com" });
    await t.events.idle();
    expect(received).toHaveLength(0);

    // Another tenant's events never reach this hook.
    await as(alice).patch(`/webhooks/${hook.id}`, { active: true });
    await as(bob).post("/contacts", { email: "bobs-hook@example.com" });
    await t.events.idle();
    expect(received).toHaveLength(0);

    expect((await as(alice).del(`/webhooks/${hook.id}`)).statusCode).toBe(204);
  });

  it("the test endpoint reports the receiver's answer", async () => {
    const hook = (
      await as(alice).post("/webhooks", { url, events: ["*"] })
    ).json();
    received.length = 0;
    const res = await as(alice).post(`/webhooks/${hook.id}/test`);
    expect(res.json()).toMatchObject({ ok: true, status: 200, attempts: 1 });
    expect(received[0]!.headers["x-orbyt-event"]).toBe("webhook.test");
    await as(alice).del(`/webhooks/${hook.id}`);
  });

  it("validates input and blocks private URLs when SSRF protection is on", async () => {
    expect(
      (await as(alice).post("/webhooks", { url: "not a url", events: ["*"] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await as(alice).post("/webhooks", { url, events: [] })).statusCode,
    ).toBe(400);
    expect(
      (await as(alice).post("/webhooks", { url, events: ["Bad Event"] }))
        .statusCode,
    ).toBe(400);
    process.env.ORBYT_ALLOW_PRIVATE_URLS = "false";
    try {
      const res = await as(alice).post("/webhooks", { url, events: ["*"] });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/private/);
    } finally {
      process.env.ORBYT_ALLOW_PRIVATE_URLS = "true";
    }
  });

  it("another tenant cannot see, change or test the hook", async () => {
    const hook = (
      await as(alice).post("/webhooks", { url, events: ["*"] })
    ).json();
    expect(
      (await as(bob).get("/webhooks"))
        .json()
        .some((h: { id: string }) => h.id === hook.id),
    ).toBe(false);
    expect(
      (await as(bob).patch(`/webhooks/${hook.id}`, { active: false }))
        .statusCode,
    ).toBe(404);
    expect((await as(bob).post(`/webhooks/${hook.id}/test`)).statusCode).toBe(
      404,
    );
    await as(alice).del(`/webhooks/${hook.id}`);
  });
});
