import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./test-utils";

let t: TestApp;
let alice: Awaited<ReturnType<TestApp["signUp"]>>;
let bob: Awaited<ReturnType<TestApp["signUp"]>>;

beforeAll(async () => {
  t = await createTestApp();
  alice = await t.signUp("Alice");
  bob = await t.signUp("Bob");
});
afterAll(() => t.cleanup());

const as = (u: typeof alice) => ({
  get: (path: string) => t.request("GET", u.base + path, { cookie: u.cookie }),
  post: (path: string, payload?: unknown) =>
    t.request("POST", u.base + path, { cookie: u.cookie, payload }),
  patch: (path: string, payload: unknown) =>
    t.request("PATCH", u.base + path, { cookie: u.cookie, payload }),
  del: (path: string) =>
    t.request("DELETE", u.base + path, { cookie: u.cookie }),
});

type Stage = { id: string; name: string; position: number };

describe("pipelines and stages", () => {
  it("creates with ordered stages, inserts and reorders stages, keeps positions compact", async () => {
    const a = as(alice);
    const created = await a.post("/pipelines", {
      name: "Sales",
      stages: ["New", "Won"],
    });
    expect(created.statusCode).toBe(201);
    const p = created.json();
    expect(p.stages.map((s: Stage) => s.name)).toEqual(["New", "Won"]);

    const added = await a.post(`/pipelines/${p.id}/stages`, {
      name: "Qualified",
      position: 1,
    });
    expect(added.statusCode).toBe(201);
    const list = (await a.get("/pipelines")).json();
    const mine = list.find((x: { id: string }) => x.id === p.id);
    expect(mine.stages.map((s: Stage) => [s.name, s.position])).toEqual([
      ["New", 0],
      ["Qualified", 1],
      ["Won", 2],
    ]);

    const won = mine.stages[2];
    await a.patch(`/stages/${won.id}`, { position: 0 });
    const after = (await a.get("/pipelines"))
      .json()
      .find((x: { id: string }) => x.id === p.id);
    expect(after.stages.map((s: Stage) => s.name)).toEqual([
      "Won",
      "New",
      "Qualified",
    ]);

    expect(
      (await a.patch(`/pipelines/${p.id}`, { name: "Sales 2" })).json().name,
    ).toBe("Sales 2");
    expect(
      (await a.post("/pipelines", { name: "Empty", stages: [] })).statusCode,
    ).toBe(400);
  });
});

describe("deals", () => {
  it("lifecycle: default stage, move, win, filters, and conflict on stage/pipeline delete", async () => {
    const a = as(alice);
    const p = (
      await a.post("/pipelines", {
        name: "Deals",
        stages: ["Lead", "Proposal", "Closed"],
      })
    ).json();
    const [lead, proposal] = p.stages as Stage[];
    const contact = (
      await a.post("/contacts", { email: "buyer@example.com" })
    ).json();

    const created = await a.post("/deals", {
      pipelineId: p.id,
      title: "Big one",
      valueCents: 500000,
      contactId: contact.id,
    });
    expect(created.statusCode).toBe(201);
    const deal = created.json();
    expect(deal.stageId).toBe(lead!.id); // defaults to the first stage
    expect(deal.status).toBe("open");

    const moved = await a.post(`/deals/${deal.id}/move`, {
      stageId: proposal!.id,
    });
    expect(moved.json().stageId).toBe(proposal!.id);

    // A stage from a different pipeline is rejected.
    const other = (
      await a.post("/pipelines", { name: "Other", stages: ["X"] })
    ).json();
    expect(
      (await a.post(`/deals/${deal.id}/move`, { stageId: other.stages[0].id }))
        .statusCode,
    ).toBe(400);

    const won = await a.patch(`/deals/${deal.id}`, { status: "won" });
    expect(won.json().status).toBe("won");
    expect(won.json().closedAt).not.toBeNull();
    expect(
      (await a.get(`/deals?pipelineId=${p.id}&status=open`)).json().items,
    ).toHaveLength(0);
    expect(
      (await a.get(`/deals?pipelineId=${p.id}&status=won`)).json().items,
    ).toHaveLength(1);
    expect(
      (await a.patch(`/deals/${deal.id}`, { status: "open" })).json().closedAt,
    ).toBeNull();

    // Events land on the contact's timeline.
    await t.events.idle();
    const timeline = (await a.get(`/timeline?contactId=${contact.id}`)).json()
      .items;
    expect(timeline.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(["deal.created", "deal.moved", "deal.won"]),
    );

    // A stage that still holds deals cannot be deleted; a pipeline with deals needs ?force=true.
    expect((await a.del(`/stages/${proposal!.id}`)).statusCode).toBe(409);
    expect((await a.del(`/pipelines/${p.id}`)).statusCode).toBe(409);
    expect((await a.del(`/pipelines/${p.id}?force=true`)).statusCode).toBe(204);
    expect((await a.get(`/deals/${deal.id}`)).statusCode).toBe(404);
  });

  it("validates input and rejects other tenants' references", async () => {
    const a = as(alice);
    const p = (await a.post("/pipelines", { name: "V", stages: ["S"] })).json();
    expect(
      (await a.post("/deals", { pipelineId: p.id, title: "", valueCents: -1 }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await a.post("/deals", {
          pipelineId: p.id,
          title: "x",
          currency: "usd",
        })
      ).statusCode,
    ).toBe(400);
    const bobContact = (
      await as(bob).post("/contacts", { email: "bobs@example.com" })
    ).json();
    expect(
      (
        await a.post("/deals", {
          pipelineId: p.id,
          title: "x",
          contactId: bobContact.id,
        })
      ).statusCode,
    ).toBe(400);
    const bobPipeline = (
      await as(bob).post("/pipelines", { name: "B", stages: ["S"] })
    ).json();
    expect(
      (await a.post("/deals", { pipelineId: bobPipeline.id, title: "x" }))
        .statusCode,
    ).toBe(400);
  });

  it("does not leak deals across workspaces", async () => {
    const p = (
      await as(alice).post("/pipelines", { name: "Private", stages: ["S"] })
    ).json();
    const d = (
      await as(alice).post("/deals", { pipelineId: p.id, title: "Secret" })
    ).json();
    expect((await as(bob).get(`/deals/${d.id}`)).statusCode).toBe(404);
    expect(
      (await as(bob).patch(`/deals/${d.id}`, { title: "x" })).statusCode,
    ).toBe(404);
    expect(
      (await as(bob).post(`/deals/${d.id}/move`, { stageId: p.stages[0].id }))
        .statusCode,
    ).toBe(404);
    expect(
      (await as(bob).get("/deals"))
        .json()
        .items.some((x: { id: string }) => x.id === d.id),
    ).toBe(false);
  });
});

describe("tasks, notes, timeline", () => {
  it("tasks: create, filter by done, complete, delete; assignee must be a member", async () => {
    const a = as(alice);
    const c = (
      await a.post("/contacts", { email: "tasks@example.com" })
    ).json();
    const task = (
      await a.post("/tasks", {
        title: "Call back",
        contactId: c.id,
        dueAt: "2030-01-01T10:00:00Z",
      })
    ).json();
    expect(task.assigneeId).not.toBeNull(); // defaults to the creator
    expect(
      (await a.get(`/tasks?contactId=${c.id}&done=false`)).json().items,
    ).toHaveLength(1);

    const done = await a.patch(`/tasks/${task.id}`, { done: true });
    expect(done.json().doneAt).not.toBeNull();
    expect(
      (await a.get(`/tasks?contactId=${c.id}&done=false`)).json().items,
    ).toHaveLength(0);
    expect(
      (await a.get(`/tasks?contactId=${c.id}&done=true`)).json().items,
    ).toHaveLength(1);

    expect(
      (await a.post("/tasks", { title: "x", dueAt: "tomorrow" })).statusCode,
    ).toBe(400);
    const bobId = (await t.dbs.db.query.users.findFirst({
      where: (u, { eq }) => eq(u.email, bob.email),
    }))!.id;
    expect(
      (await a.post("/tasks", { title: "x", assigneeId: bobId })).statusCode,
    ).toBe(400);

    const bobContact = (
      await as(bob).post("/contacts", { email: "bobtask@example.com" })
    ).json();
    expect(
      (await a.post("/tasks", { title: "x", contactId: bobContact.id }))
        .statusCode,
    ).toBe(400);
    expect((await a.del(`/tasks/${task.id}`)).statusCode).toBe(204);
    expect((await a.del(`/tasks/${task.id}`)).statusCode).toBe(404);
  });

  it("notes need a target and show up on the contact timeline", async () => {
    const a = as(alice);
    const c = (
      await a.post("/contacts", { email: "notes@example.com" })
    ).json();
    expect((await a.post("/notes", { body: "orphan" })).statusCode).toBe(400);
    const note = await a.post("/notes", {
      body: "Met at the conference",
      contactId: c.id,
    });
    expect(note.statusCode).toBe(201);
    expect((await a.get(`/notes?contactId=${c.id}`)).json().items).toHaveLength(
      1,
    );
    await t.events.idle();
    const types = (await a.get(`/timeline?contactId=${c.id}`))
      .json()
      .items.map((e: { type: string }) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["contact.created", "note.added"]),
    );
    // Bob cannot attach a note to Alice's contact.
    expect(
      (await as(bob).post("/notes", { body: "x", contactId: c.id })).statusCode,
    ).toBe(400);
    expect((await a.del(`/notes/${note.json().id}`)).statusCode).toBe(204);
  });
});
