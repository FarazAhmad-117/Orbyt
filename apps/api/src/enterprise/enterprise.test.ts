import {
  createHmac,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../test-utils";
import { describeRequest } from "./audit.interceptor";
import { verifyStripeSignature } from "./billing.service";
import { verifyLicense, type LicensePayload } from "./license";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
const otherKey = generateKeyPairSync("ed25519");

function makeLicense(
  payload: Partial<LicensePayload>,
  key: KeyObject = privateKey,
) {
  const json = JSON.stringify({
    sub: "Test Agency",
    features: [],
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload,
  });
  return `${Buffer.from(json).toString("base64url")}.${sign(null, Buffer.from(json), key).toString("base64url")}`;
}

describe("license keys", () => {
  const nowMs = Date.now();
  it("accepts a valid key and rejects tampering, other signers, expiry and a missing public key", () => {
    const key = makeLicense({ features: ["audit_logs"], maxWorkspaces: 5 });
    const ok = verifyLicense(key, publicPem, nowMs);
    expect(ok).toMatchObject({
      ok: true,
      payload: { features: ["audit_logs"], maxWorkspaces: 5 },
    });

    const [body, sig] = key.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "x", features: ["sso", "audit_logs"], exp: 9e9 }),
    ).toString("base64url");
    expect(verifyLicense(`${forged}.${sig}`, publicPem, nowMs).ok).toBe(false);
    expect(verifyLicense(`${body}.${sig}x`, publicPem, nowMs).ok).toBe(false);
    expect(
      verifyLicense(
        makeLicense({ features: ["sso"] }, otherKey.privateKey),
        publicPem,
        nowMs,
      ).ok,
    ).toBe(false);
    expect(
      verifyLicense(
        makeLicense({ exp: Math.floor(nowMs / 1000) - 10 }),
        publicPem,
        nowMs,
      ),
    ).toEqual({ ok: false, reason: "License expired" });
    expect(verifyLicense(key, null, nowMs).ok).toBe(false);
    expect(verifyLicense("garbage", publicPem, nowMs).ok).toBe(false);
    expect(verifyLicense("a.b.c", publicPem, nowMs).ok).toBe(false);
  });
});

describe("audit request classification", () => {
  const ws = "11111111-1111-4111-8111-111111111111";
  const id = "22222222-2222-4222-8222-222222222222";
  it("describes sensitive mutations and ignores reads and everything else", () => {
    expect(describeRequest("POST", `/api/w/${ws}/api-keys`)).toMatchObject({
      action: "api-keys.create",
    });
    expect(
      describeRequest("POST", `/api/w/${ws}/workflows/${id}/activate?x=1`),
    ).toEqual({
      action: "workflows.activate",
      target: { type: "workflows", id },
    });
    expect(
      describeRequest("DELETE", `/api/w/${ws}/mailboxes/${id}`),
    ).toMatchObject({ action: "mailboxes.delete" });
    expect(
      describeRequest("PATCH", `/api/w/${ws}/mailboxes/${id}`),
    ).toMatchObject({ action: "mailboxes.update" });
    expect(describeRequest("GET", `/api/w/${ws}/api-keys`)).toBeNull();
    expect(describeRequest("POST", `/api/w/${ws}/contacts`)).toBeNull();
    expect(describeRequest("POST", "/api/auth/sign-in/email")).toBeNull();
  });
});

describe("stripe signatures", () => {
  const payload = Buffer.from('{"id":"evt_1"}');
  const secret = "whsec_test";
  const header = (t: number, s = secret) =>
    `t=${t},v1=${createHmac("sha256", s).update(`${t}.`).update(payload).digest("hex")}`;
  it("verifies the exact bytes, rejects other secrets, edits and stale timestamps", () => {
    const now = 1_800_000_000;
    expect(verifyStripeSignature(payload, header(now), secret, now)).toBe(true);
    expect(
      verifyStripeSignature(payload, header(now, "other"), secret, now),
    ).toBe(false);
    expect(
      verifyStripeSignature(
        Buffer.from('{"id":"evt_2"}'),
        header(now),
        secret,
        now,
      ),
    ).toBe(false);
    expect(
      verifyStripeSignature(payload, header(now - 3600), secret, now),
    ).toBe(false);
    expect(verifyStripeSignature(payload, undefined, secret, now)).toBe(false);
    expect(verifyStripeSignature(payload, "t=1,v1=zz", secret, now)).toBe(
      false,
    );
  });
});

// ---- over HTTP ----

let t: TestApp;
type User = Awaited<ReturnType<TestApp["signUp"]>>;
let alice: User;
let bob: User;
const stripeCalls: { path: string; form: Record<string, string> }[] = [];
let stripe: http.Server;

beforeAll(async () => {
  t = await createTestApp();
  alice = await t.signUp("Alice");
  bob = await t.signUp("Bob");
  stripe = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      stripeCalls.push({
        path: req.url!,
        form: Object.fromEntries(new URLSearchParams(raw)),
      });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer sk_test_123") {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: "bad key" } }));
      }
      res.end(
        JSON.stringify(
          req.url === "/v1/customers"
            ? { id: "cus_test_1" }
            : { url: `https://stripe.test${req.url}` },
        ),
      );
    });
  });
  await new Promise<void>((r) => stripe.listen(0, "127.0.0.1", r));
});
afterEach(() => {
  for (const k of [
    "ORBYT_LICENSE_KEY",
    "ORBYT_LICENSE_PUBLIC_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_API_BASE",
    "STRIPE_PRICE_PRO",
    "STRIPE_PRICE_AGENCY",
  ])
    delete process.env[k];
});
afterAll(async () => {
  await new Promise((r) => stripe.close(r));
  await t.cleanup();
});

const as = (u: User) => ({
  get: (p: string) => t.request("GET", p, { cookie: u.cookie }),
  post: (p: string, payload?: unknown) =>
    t.request("POST", p, { cookie: u.cookie, payload: payload ?? {} }),
  put: (p: string, payload: unknown) =>
    t.request("PUT", p, { cookie: u.cookie, payload }),
});
const orgOf = async (u: User) =>
  ((await as(u).get("/api/orgs")).json() as { id: string }[])[0]!.id;
const useLicense = (payload: Partial<LicensePayload>) => {
  process.env.ORBYT_LICENSE_PUBLIC_KEY = publicPem;
  process.env.ORBYT_LICENSE_KEY = makeLicense(payload);
};
const useStripe = () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;
  process.env.STRIPE_PRICE_PRO = "price_pro";
  process.env.STRIPE_PRICE_AGENCY = "price_agency";
};
const box = (n: number) => ({
  email: `box${n}-${Math.random().toString(36).slice(2, 7)}@example.test`,
  smtp: { host: "127.0.0.1", port: 1, user: "u", password: "p" },
  imap: { host: "127.0.0.1", port: 1, user: "u", password: "p" },
  verify: false,
});

describe("community edition (no license, no billing)", () => {
  it("has no paid features but no limits either", async () => {
    const e = (await as(alice).get(`${alice.base}/entitlements`)).json();
    expect(e).toMatchObject({
      cloud: false,
      plan: "community",
      features: [],
      maxWorkspaces: null,
      maxMailboxes: null,
    });
    expect((await as(alice).get(`${alice.base}/audit-logs`)).statusCode).toBe(
      402,
    );
    const org = await orgOf(alice);
    expect(
      (await as(alice).put(`/api/orgs/${org}/branding`, { brandName: "X" }))
        .statusCode,
    ).toBe(402);
    for (let i = 0; i < 4; i++)
      expect(
        (await as(alice).post(`${alice.base}/mailboxes`, box(i))).statusCode,
      ).toBe(201);
    // A license signed by someone else is ignored.
    process.env.ORBYT_LICENSE_PUBLIC_KEY = publicPem;
    process.env.ORBYT_LICENSE_KEY = makeLicense(
      { features: ["audit_logs"] },
      otherKey.privateKey,
    );
    expect((await as(alice).get(`${alice.base}/audit-logs`)).statusCode).toBe(
      402,
    );
  });
});

describe("with a license key", () => {
  it("unlocks the audit log, which records who changed what but never the secrets", async () => {
    useLicense({ features: ["audit_logs"] });
    const e = (await as(alice).get(`${alice.base}/entitlements`)).json();
    expect(e.features).toEqual(["audit_logs"]);

    const made = await as(alice).post(`${alice.base}/api-keys`, {
      name: "ci key",
    });
    const { key, id } = made.json() as { key: string; id: string };
    await as(alice).get(`${alice.base}/api-keys`); // reads are not logged
    await t.request("DELETE", `${alice.base}/api-keys/${id}`, {
      cookie: alice.cookie,
    });

    const log = (
      await as(alice).get(`${alice.base}/audit-logs?limit=50`)
    ).json() as {
      items: { action: string; actorVia: string; targetId: string | null }[];
    };
    const actions = log.items.map((i) => i.action);
    expect(actions).toContain("api-keys.create");
    expect(actions).toContain("api-keys.delete");
    expect(actions.filter((a) => a === "api-keys.create")).toHaveLength(1);
    expect(log.items.find((i) => i.action === "api-keys.delete")).toMatchObject(
      { actorVia: "session", targetId: id },
    );
    expect(JSON.stringify(log)).not.toContain(key);
    expect(JSON.stringify(log)).not.toContain("ci key");

    // Filter, and other workspaces' logs are not visible to others.
    const only = (
      await as(alice).get(`${alice.base}/audit-logs?action=api-keys.delete`)
    ).json() as { items: unknown[] };
    expect(only.items).toHaveLength(1);
    expect((await as(bob).get(`${alice.base}/audit-logs`)).statusCode).toBe(
      404,
    );
  });

  it("applies the caps written into the license", async () => {
    useLicense({ features: [], maxWorkspaces: 2 });
    const org = await orgOf(bob);
    expect(
      (await as(bob).post(`/api/orgs/${org}/workspaces`, { name: "Second" }))
        .statusCode,
    ).toBe(201);
    const third = await as(bob).post(`/api/orgs/${org}/workspaces`, {
      name: "Third",
    });
    expect(third.statusCode).toBe(402);
    expect(third.body).toContain("2 workspace");
  });

  it("white-label: owners set the brand, the domain serves it publicly, others cannot", async () => {
    useLicense({ features: ["white_label"] });
    const org = await orgOf(alice);
    const domain = `app-${Math.random().toString(36).slice(2, 8)}.agency.test`;
    const set = await as(alice).put(`/api/orgs/${org}/branding`, {
      brandName: "Acme CRM",
      brandColor: "#1a73e8",
      brandLogoUrl: "https://cdn.agency.test/logo.png",
      customDomain: domain,
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(
      (await t.request("GET", `/api/branding?host=${domain}`)).json(),
    ).toEqual({
      brandName: "Acme CRM",
      brandLogoUrl: "https://cdn.agency.test/logo.png",
      brandColor: "#1a73e8",
    });
    // The host header works too (that is how the real sign-in page asks).
    expect(
      (
        await t.request("GET", "/api/branding", {
          headers: { "x-forwarded-host": `${domain}:443` },
        })
      ).json().brandName,
    ).toBe("Acme CRM");
    expect(
      (await t.request("GET", "/api/branding?host=unknown.test")).json(),
    ).toEqual({ brandName: null, brandLogoUrl: null, brandColor: null });

    expect(
      (await as(alice).put(`/api/orgs/${org}/branding`, { brandColor: "red" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await as(alice).put(`/api/orgs/${org}/branding`, {
          customDomain: "not a host",
        })
      ).statusCode,
    ).toBe(400);
    // Someone else cannot edit it, and cannot take the same domain.
    expect(
      (await as(bob).put(`/api/orgs/${org}/branding`, { brandName: "Evil" }))
        .statusCode,
    ).toBe(404);
    const bobOrg = await orgOf(bob);
    expect(
      (
        await as(bob).put(`/api/orgs/${bobOrg}/branding`, {
          customDomain: domain,
        })
      ).statusCode,
    ).toBe(409);

    // Without the entitlement the brand is no longer served.
    delete process.env.ORBYT_LICENSE_KEY;
    expect(
      (await t.request("GET", `/api/branding?host=${domain}`)).json().brandName,
    ).toBeNull();
  });
});

describe("hosted cloud: plans and Stripe", () => {
  const event = (type: string, object: Record<string, unknown>) =>
    JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } });
  const webhook = (
    body: string,
    t0 = Math.floor(Date.now() / 1000),
    secret = "whsec_test",
  ) =>
    t.request("POST", "/api/stripe/webhook", {
      payload: body,
      headers: {
        "stripe-signature": `t=${t0},v1=${createHmac("sha256", secret).update(`${t0}.${body}`).digest("hex")}`,
      },
    });

  it("free plan caps workspaces and mailboxes; paying through the webhook lifts them", async () => {
    useStripe();
    const carol = await t.signUp("Carol");
    const org = await orgOf(carol);

    const free = (await as(carol).get(`${carol.base}/entitlements`)).json();
    expect(free).toMatchObject({
      cloud: true,
      plan: "free",
      features: [],
      maxWorkspaces: 1,
      maxMailboxes: 2,
    });
    expect(
      (await as(carol).post(`/api/orgs/${org}/workspaces`, { name: "Two" }))
        .statusCode,
    ).toBe(402);
    expect(
      (await as(carol).post(`${carol.base}/mailboxes`, box(1))).statusCode,
    ).toBe(201);
    expect(
      (await as(carol).post(`${carol.base}/mailboxes`, box(2))).statusCode,
    ).toBe(201);
    expect(
      (await as(carol).post(`${carol.base}/mailboxes`, box(3))).statusCode,
    ).toBe(402);

    // Billing page data, and checkout creates the Stripe customer + session.
    expect(
      (await as(carol).get(`/api/orgs/${org}/billing`)).json(),
    ).toMatchObject({
      enabled: true,
      plan: "free",
    });
    stripeCalls.length = 0;
    const checkout = await as(carol).post(`/api/orgs/${org}/billing/checkout`, {
      plan: "agency",
    });
    expect(checkout.statusCode, checkout.body).toBe(200);
    expect(checkout.json().url).toContain("checkout/sessions");
    const session = stripeCalls.find(
      (c) => c.path === "/v1/checkout/sessions",
    )!;
    expect(session.form).toMatchObject({
      mode: "subscription",
      customer: "cus_test_1",
      "line_items[0][price]": "price_agency",
      "metadata[orgId]": org,
      "metadata[plan]": "agency",
    });
    expect(
      (await as(carol).post(`/api/orgs/${org}/billing/portal`)).json().url,
    ).toContain("billing_portal");
    expect(
      (await as(bob).post(`/api/orgs/${org}/billing/checkout`, { plan: "pro" }))
        .statusCode,
    ).toBe(404);

    // The webhook only listens to Stripe.
    const paid = event("checkout.session.completed", {
      customer: "cus_test_1",
      subscription: "sub_1",
      metadata: { orgId: org, plan: "agency" },
    });
    expect(
      (await t.request("POST", "/api/stripe/webhook", { payload: paid }))
        .statusCode,
    ).toBe(400);
    expect((await webhook(paid, undefined, "wrong")).statusCode).toBe(400);
    expect(
      (await webhook(paid, Math.floor(Date.now() / 1000) - 3600)).statusCode,
    ).toBe(400);
    expect(
      (await as(carol).get(`${carol.base}/entitlements`)).json().plan,
    ).toBe("free");

    expect((await webhook(paid)).statusCode).toBe(200);
    expect((await webhook(paid)).statusCode).toBe(200); // retries are harmless
    const agency = (await as(carol).get(`${carol.base}/entitlements`)).json();
    expect(agency).toMatchObject({ plan: "agency", maxWorkspaces: 100 });
    expect(agency.features.sort()).toEqual(["audit_logs", "white_label"]);
    expect(
      (await as(carol).post(`/api/orgs/${org}/workspaces`, { name: "Two" }))
        .statusCode,
    ).toBe(201);
    expect(
      (await as(carol).post(`${carol.base}/mailboxes`, box(3))).statusCode,
    ).toBe(201);
    expect((await as(carol).get(`${carol.base}/audit-logs`)).statusCode).toBe(
      200,
    );

    // A payment problem downgrades; cancellation ends it.
    const sub = (status: string) =>
      event("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_test_1",
        status,
        metadata: { orgId: org },
        current_period_end: 1_900_000_000,
        items: { data: [{ price: { id: "price_agency" } }] },
      });
    expect((await webhook(sub("past_due"))).statusCode).toBe(200);
    expect(
      (await as(carol).get(`${carol.base}/entitlements`)).json().plan,
    ).toBe("free");
    expect((await webhook(sub("active"))).statusCode).toBe(200);
    expect(
      (await as(carol).get(`${carol.base}/entitlements`)).json().plan,
    ).toBe("agency");
    const billing = (await as(carol).get(`/api/orgs/${org}/billing`)).json();
    expect(billing.currentPeriodEnd).toBe(
      new Date(1_900_000_000 * 1000).toISOString(),
    );
    expect(
      (
        await webhook(
          event("customer.subscription.deleted", {
            id: "sub_1",
            customer: "cus_test_1",
            status: "canceled",
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await as(carol).get(`${carol.base}/entitlements`)).json().plan,
    ).toBe("free");
  });

  it("reports Stripe errors and missing configuration instead of crashing", async () => {
    useStripe();
    const dan = await t.signUp("Dan");
    const org = await orgOf(dan);
    process.env.STRIPE_SECRET_KEY = "sk_wrong"; // the mock answers 401
    const bad = await as(dan).post(`/api/orgs/${org}/billing/checkout`, {
      plan: "pro",
    });
    expect(bad.statusCode).toBe(502);
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    delete process.env.STRIPE_PRICE_PRO;
    expect(
      (await as(dan).post(`/api/orgs/${org}/billing/checkout`, { plan: "pro" }))
        .statusCode,
    ).toBe(400);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect((await webhook("{}")).statusCode).toBe(400);
  });
});
