import { generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, password, type TestApp } from "../test-utils";

// A tiny OpenID Connect provider: discovery, authorize (redirects straight back), token, userinfo.
let idp: http.Server;
let idpUrl: string;
let profile = { sub: "u1", email: "", name: "Sso User", email_verified: true };
const codes = new Map<string, typeof profile>();

let t: TestApp;
let publicPem: string;
let license: string;

beforeAll(async () => {
  idp = http.createServer((req, res) => {
    const url = new URL(req.url!, idpUrl);
    const json = (body: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration")
      return json({
        issuer: idpUrl,
        authorization_endpoint: `${idpUrl}/authorize`,
        token_endpoint: `${idpUrl}/token`,
        userinfo_endpoint: `${idpUrl}/userinfo`,
        response_types_supported: ["code"],
      });
    if (url.pathname === "/authorize") {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, { ...profile });
      res.statusCode = 302;
      res.setHeader(
        "location",
        `${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}`,
      );
      return res.end();
    }
    if (url.pathname === "/token") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const code = new URLSearchParams(raw).get("code") ?? "";
        if (!codes.has(code)) {
          res.statusCode = 400;
          return json({ error: "invalid_grant" });
        }
        json({
          access_token: `at-${code}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
        });
      });
      return;
    }
    if (url.pathname === "/userinfo") {
      const code = (req.headers.authorization ?? "").replace("Bearer at-", "");
      const p = codes.get(code);
      if (!p) {
        res.statusCode = 401;
        return res.end();
      }
      return json(p);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  idpUrl = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  const keys = generateKeyPairSync("ed25519");
  publicPem = keys.publicKey.export({ type: "spki", format: "pem" }) as string;
  const json = JSON.stringify({
    sub: "SSO Corp",
    features: ["sso"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  license = `${Buffer.from(json).toString("base64url")}.${sign(null, Buffer.from(json), keys.privateKey).toString("base64url")}`;

  // Better Auth is built when the app boots, so SSO must be configured before createTestApp().
  process.env.ORBYT_SSO_DISCOVERY_URL = `${idpUrl}/.well-known/openid-configuration`;
  process.env.ORBYT_SSO_CLIENT_ID = "orbyt-test";
  process.env.ORBYT_SSO_CLIENT_SECRET = "secret";
  process.env.ORBYT_SSO_NAME = "Acme Login";
  process.env.ORBYT_LICENSE_PUBLIC_KEY = publicPem;
  process.env.ORBYT_LICENSE_KEY = license;
  t = await createTestApp();
});
afterAll(async () => {
  for (const k of [
    "ORBYT_SSO_DISCOVERY_URL",
    "ORBYT_SSO_CLIENT_ID",
    "ORBYT_SSO_CLIENT_SECRET",
    "ORBYT_SSO_NAME",
    "ORBYT_LICENSE_PUBLIC_KEY",
    "ORBYT_LICENSE_KEY",
  ])
    delete process.env[k];
  await t.cleanup();
  await new Promise((r) => idp.close(r));
});

/** Runs the browser part of the flow: start, IdP round trip, callback. Returns the callback response. */
async function ssoLogin() {
  const start = await t.request("POST", "/api/auth/sign-in/social", {
    payload: { provider: "sso", callbackURL: "/app" },
  });
  expect(start.statusCode, start.body).toBe(200);
  const { url } = start.json() as { url: string };
  const back = await fetch(url, { redirect: "manual" });
  const cb = new URL(back.headers.get("location")!);
  return t.request("GET", cb.pathname + cb.search, {
    cookie: t.cookieOf(start),
  });
}
const workspacesOf = async (cookie: string) =>
  (await t.request("GET", "/api/me/workspaces", { cookie })).json() as {
    id: string;
  }[];

describe("single sign-on (OpenID Connect)", () => {
  it("is advertised to the sign-in page", async () => {
    expect((await t.request("GET", "/api/sso/status")).json()).toEqual({
      enabled: true,
      name: "Acme Login",
    });
  });

  it("signs a new person in through the provider and gives them a workspace", async () => {
    profile = {
      sub: "idp-1",
      email: `sso-${Date.now()}@example.test`,
      name: "New Person",
      email_verified: true,
    };
    const cb = await ssoLogin();
    expect(cb.statusCode, cb.body).toBe(302);
    expect(String(cb.headers.location)).toContain("/app");
    const cookie = t.cookieOf(cb);
    expect(cookie).toContain("session");
    const spaces = await workspacesOf(cookie);
    expect(spaces).toHaveLength(1); // provisioned like a normal sign-up
    // The same person coming back reuses the account.
    const again = await ssoLogin();
    expect(await workspacesOf(t.cookieOf(again))).toEqual(spaces);
  });

  it("does not take over an existing password account that has the same email", async () => {
    // Sign-up does not verify emails, so merging the two would let whoever registered an address
    // first keep access after the real owner signs in through SSO.
    const existing = await t.signUp("Existing");
    profile = {
      sub: "idp-2",
      email: existing.email,
      name: "Existing",
      email_verified: true,
    };
    const cb = await ssoLogin();
    expect(String(cb.headers.location)).toContain("error=account_not_linked");
    expect(t.cookieOf(cb)).not.toContain("session_token");
    // The password account is untouched and still works.
    const pw = await t.request("POST", "/api/auth/sign-in/email", {
      payload: { email: existing.email, password },
    });
    expect(pw.statusCode).toBe(200);
  });

  it("stays closed without the sso license", async () => {
    delete process.env.ORBYT_LICENSE_KEY;
    expect((await t.request("GET", "/api/sso/status")).json().enabled).toBe(
      false,
    );
    const res = await t.request("POST", "/api/auth/sign-in/social", {
      payload: { provider: "sso", callbackURL: "/app" },
    });
    expect(res.statusCode).toBe(402);
    expect(
      (await t.request("GET", "/api/auth/callback/sso?code=x&state=y"))
        .statusCode,
    ).toBe(402);
    process.env.ORBYT_LICENSE_KEY = license;
  });

  it("a code the provider did not issue does not sign anyone in", async () => {
    const start = await t.request("POST", "/api/auth/sign-in/social", {
      payload: { provider: "sso", callbackURL: "/app" },
    });
    const state = new URL(
      (start.json() as { url: string }).url,
    ).searchParams.get("state");
    const cb = await t.request(
      "GET",
      `/api/auth/callback/sso?code=forged&state=${state}`,
      { cookie: t.cookieOf(start) },
    );
    expect(t.cookieOf(cb)).not.toContain("session_token");
  });
});
