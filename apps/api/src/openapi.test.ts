import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./test-utils";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.cleanup());

it("serves an OpenAPI document generated from the controllers", async () => {
  const res = await t.request("GET", "/api/openapi.json");
  expect(res.statusCode).toBe(200);
  const spec = res.json();
  expect(spec.openapi).toBe("3.1.0");
  expect(spec.paths["/health"].get).toBeDefined();
  const contacts = spec.paths["/api/w/{workspaceId}/contacts"];
  expect(Object.keys(contacts).sort()).toEqual(["get", "post"]);
  expect(contacts.post.security).toEqual([
    { cookieAuth: [] },
    { bearerAuth: [] },
  ]);
  expect(
    contacts.post.requestBody.content["application/json"].schema.properties
      .email,
  ).toBeDefined();
  expect(spec.paths["/api/w/{workspaceId}/contacts/{id}"].delete).toBeDefined();
  // API keys must be session-only, so the spec must not offer bearer auth there.
  expect(spec.paths["/api/w/{workspaceId}/api-keys"].post.security).toEqual([
    { cookieAuth: [] },
  ]);
});

it("serves the docs page", async () => {
  const res = await t.request("GET", "/api/docs");
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/html");
  expect(res.body).toContain("/api/openapi.json");
});
