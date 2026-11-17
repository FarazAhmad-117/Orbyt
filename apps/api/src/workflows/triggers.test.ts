import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../test-utils";
import { WorkflowService } from "./workflow.service";

let t: TestApp;
let engine: WorkflowService;
let alice: Awaited<ReturnType<TestApp["signUp"]>>;

beforeAll(async () => {
  t = await createTestApp();
  engine = t.app.get(WorkflowService);
});
beforeEach(async () => {
  alice = await t.signUp("Alice");
});
afterAll(() => t.cleanup());

const api = {
  get: (p: string) =>
    t.request("GET", alice.base + p, { cookie: alice.cookie }),
  post: (p: string, payload?: unknown) =>
    t.request("POST", alice.base + p, {
      cookie: alice.cookie,
      payload: payload ?? {},
    }),
};
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const tagGraph = (tag: string) => ({
  nodes: [
    { id: "t", type: "trigger", config: {} },
    { id: "a", type: "tag", config: { add: [tag] } },
  ],
  edges: [{ from: "t", to: "a" }],
});
const taskGraph = {
  nodes: [
    { id: "t", type: "trigger", config: {} },
    { id: "a", type: "create_task", config: { title: "tick" } },
  ],
  edges: [{ from: "t", to: "a" }],
};
const runs = async (id: string) =>
  (await api.get(`/workflows/${id}/executions`)).json().items as {
    status: string;
  }[];

describe("webhook trigger", () => {
  it("starts a run for the posted contact, and only while the workflow is active", async () => {
    const created = await api.post("/workflows", {
      name: "Inbound lead",
      triggerType: "webhook",
      graph: tagGraph("from-webhook"),
    });
    expect(created.statusCode).toBe(201);
    const wf = created.json() as { id: string; webhookToken: string };
    expect(wf.webhookToken).toMatch(/^[0-9a-f]{48}$/);
    const url = `/api/hooks/${alice.workspaceId}/workflows/${wf.webhookToken}`;
    const post = (payload: unknown) => t.request("POST", url, { payload });

    // Draft: not listening yet.
    expect((await post({ email: "lead@example.com" })).statusCode).toBe(404);
    await api.post(`/workflows/${wf.id}/activate`);

    const hit = await post({
      email: "Lead@Example.com",
      name: "Lee",
      plan: "pro",
    });
    expect(hit.statusCode, hit.body).toBe(202);
    await post({ email: "lead@example.com" }); // same person again: no duplicate contact
    await t.events.idle();
    await engine.tick(at(1), alice.workspaceId);

    const list = (await api.get("/contacts?q=lead@example.com")).json()
      .items as { id: string }[];
    expect(list).toHaveLength(1);
    const contact = (await api.get(`/contacts/${list[0]!.id}`)).json();
    expect(contact.tags.map((x: { name: string }) => x.name)).toContain(
      "from-webhook",
    );
    expect(await runs(wf.id)).toHaveLength(2);
    expect((await runs(wf.id)).every((r) => r.status === "completed")).toBe(
      true,
    );

    // Wrong token, malformed token, someone else's workspace.
    const hook = (ws: string, token: string) =>
      t.request("POST", `/api/hooks/${ws}/workflows/${token}`, { payload: {} });
    expect((await hook(alice.workspaceId, "0".repeat(48))).statusCode).toBe(
      404,
    );
    expect((await hook(alice.workspaceId, "x")).statusCode).toBe(404);
    const other = await t.signUp("Mallory");
    expect((await hook(other.workspaceId, wf.webhookToken)).statusCode).toBe(
      404,
    );

    // Paused workflows stop listening.
    await api.post(`/workflows/${wf.id}/pause`);
    expect((await post({})).statusCode).toBe(404);
  });
});

describe("schedule trigger", () => {
  it("needs an interval of at least 5 minutes", async () => {
    const base = { name: "Tick", triggerType: "schedule", graph: taskGraph };
    expect((await api.post("/workflows", base)).statusCode).toBe(400);
    expect(
      (await api.post("/workflows", { ...base, scheduleMinutes: 1 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await api.post("/workflows", { ...base, scheduleMinutes: 5 }))
        .statusCode,
    ).toBe(201);
  });

  it("runs once per interval, never twice for the same slot, and not while paused", async () => {
    const wf = (
      await api.post("/workflows", {
        name: "Every 5",
        triggerType: "schedule",
        scheduleMinutes: 5,
        graph: taskGraph,
      })
    ).json() as { id: string };
    await api.post(`/workflows/${wf.id}/activate`);

    await engine.tick(at(2), alice.workspaceId); // not due yet
    expect(await runs(wf.id)).toHaveLength(0);
    await engine.tick(at(6), alice.workspaceId);
    await engine.tick(at(6), alice.workspaceId); // same slot again: already claimed
    expect(await runs(wf.id)).toHaveLength(1);
    await engine.tick(at(8), alice.workspaceId); // next slot is at +11
    expect(await runs(wf.id)).toHaveLength(1);
    await engine.tick(at(12), alice.workspaceId);
    expect(await runs(wf.id)).toHaveLength(2);
    expect((await runs(wf.id)).every((r) => r.status === "completed")).toBe(
      true,
    );

    await api.post(`/workflows/${wf.id}/pause`);
    await engine.tick(at(60), alice.workspaceId);
    expect(await runs(wf.id)).toHaveLength(2);
  });
});
