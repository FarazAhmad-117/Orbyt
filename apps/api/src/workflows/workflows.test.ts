import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../test-utils";
import { WorkflowService } from "./workflow.service";

let t: TestApp;
let engine: WorkflowService;
let alice: Awaited<ReturnType<TestApp["signUp"]>>;
let bob: Awaited<ReturnType<TestApp["signUp"]>>;

// A webhook receiver: records requests; `failNext` makes the next N answers 500.
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let failNext = 0;
let server: http.Server;
let url: string;

beforeAll(async () => {
  t = await createTestApp();
  engine = t.app.get(WorkflowService);
  // Each test has its own workspace; tick() only runs that one (tests use far-future clocks).
  const realTick = engine.tick.bind(engine);
  engine.tick = (now?: Date) => realTick(now, alice.workspaceId);
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
beforeEach(async () => {
  alice = await t.signUp("Alice");
  received.length = 0;
  failNext = 0;
});
afterAll(async () => {
  await t.cleanup();
  await new Promise((r) => server.close(r));
});

const as = (u: typeof alice) => ({
  get: (p: string) => t.request("GET", u.base + p, { cookie: u.cookie }),
  post: (p: string, payload?: unknown) =>
    t.request("POST", u.base + p, { cookie: u.cookie, payload: payload ?? {} }),
  patch: (p: string, payload: unknown) =>
    t.request("PATCH", u.base + p, { cookie: u.cookie, payload }),
  del: (p: string) => t.request("DELETE", u.base + p, { cookie: u.cookie }),
});
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const flow = (nodes: object[], edges: object[]) => ({
  nodes: [{ id: "t", type: "trigger", config: {} }, ...nodes],
  edges,
});
async function makeWorkflow(u: typeof alice, body: object, activate = true) {
  const res = await as(u).post("/workflows", {
    name: `WF ${Math.random().toString(36).slice(2, 7)}`,
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  const wf = res.json() as { id: string };
  if (activate)
    expect((await as(u).post(`/workflows/${wf.id}/activate`)).statusCode).toBe(
      200,
    );
  return wf;
}
const makeContact = async (u: typeof alice, email: string, name?: string) =>
  (await as(u).post("/contacts", { email, name })).json() as {
    id: string;
    email: string;
  };
const settle = async () => {
  await t.events.idle();
  return engine.tick(at(1));
};
const executionsOf = async (u: typeof alice, wfId: string) =>
  (await as(u).get(`/workflows/${wfId}/executions?limit=100`)).json().items as {
    id: string;
    status: string;
    error: string | null;
    workflowVersion: number;
  }[];
const tagsOf = async (u: typeof alice, contactId: string) =>
  (
    (await as(u).get(`/contacts/${contactId}`)).json().tags as {
      name: string;
    }[]
  )
    .map((x) => x.name)
    .sort();

describe("event-triggered workflows", () => {
  it("branch on a condition, tag, and create templated follow-up tasks", async () => {
    const wf = await makeWorkflow(alice, {
      triggerType: "event",
      triggerEvent: "contact.created",
      graph: flow(
        [
          {
            id: "c",
            type: "condition",
            config: {
              left: "{{contact.email}}",
              op: "contains",
              right: "@vip.",
            },
          },
          { id: "vip", type: "tag", config: { add: ["vip"] } },
          { id: "std", type: "tag", config: { add: ["standard"] } },
          {
            id: "task",
            type: "create_task",
            config: { title: "Call {{contact.name | there}}", dueInHours: 24 },
          },
        ],
        [
          { from: "t", to: "c" },
          { from: "c", to: "vip", label: "true" },
          { from: "c", to: "std", label: "false" },
          { from: "vip", to: "task" },
        ],
      ),
    });
    const a = await makeContact(alice, "ada@vip.example.test", "Ada");
    const b = await makeContact(alice, "bo@plain.example.test");
    expect(await settle()).toBeGreaterThanOrEqual(5);

    expect(await tagsOf(alice, a.id)).toEqual(["vip"]);
    expect(await tagsOf(alice, b.id)).toEqual(["standard"]);
    const tasks = (await as(alice).get("/tasks?limit=50")).json().items as {
      title: string;
      contactId: string;
      dueAt: string;
    }[];
    expect(
      tasks.filter((x) => x.contactId === a.id).map((x) => x.title),
    ).toEqual(["Call Ada"]);
    expect(tasks.filter((x) => x.contactId === b.id)).toHaveLength(0);

    const runs = await executionsOf(alice, wf.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
    const detail = (await as(alice).get(`/executions/${runs[0]!.id}`)).json();
    expect(
      detail.steps.every((s: { status: string }) => s.status === "done"),
    ).toBe(true);
    expect(detail.context.event.type).toBe("contact.created");
  });

  it("only runs while active and only for its own trigger event", async () => {
    const wf = await makeWorkflow(
      alice,
      {
        triggerType: "event",
        triggerEvent: "contact.created",
        graph: flow(
          [{ id: "n", type: "tag", config: { add: ["seen"] } }],
          [{ from: "t", to: "n" }],
        ),
      },
      false,
    );
    const draft = await makeContact(alice, "draft@example.test");
    await settle();
    expect(await tagsOf(alice, draft.id)).toEqual([]); // draft: ignored

    await as(alice).post(`/workflows/${wf.id}/activate`);
    await as(alice).post("/companies", { name: "Other event" }); // company.created: not the trigger
    const live = await makeContact(alice, "live@example.test");
    await settle();
    expect(await tagsOf(alice, live.id)).toEqual(["seen"]);

    await as(alice).post(`/workflows/${wf.id}/pause`);
    const paused = await makeContact(alice, "paused@example.test");
    await settle();
    expect(await tagsOf(alice, paused.id)).toEqual([]);
    expect(
      (
        await as(alice).post(`/workflows/${wf.id}/run`, {
          contactId: paused.id,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("stops workflow -> event -> workflow chains after 3 hops", async () => {
    const wf = await makeWorkflow(alice, {
      triggerType: "event",
      triggerEvent: "task.created",
      graph: flow(
        [{ id: "again", type: "create_task", config: { title: "again" } }],
        [{ from: "t", to: "again" }],
      ),
    });
    await as(alice).post("/tasks", { title: "start" });
    for (let i = 0; i < 8; i++) await settle();
    expect(await executionsOf(alice, wf.id)).toHaveLength(3);
    expect((await as(alice).get("/tasks?limit=100")).json().items).toHaveLength(
      4,
    ); // the user's + one per run
  });
});

describe("manual runs, waits and cancellation", () => {
  const waitThenNote = {
    triggerType: "manual",
    graph: flow(
      [
        { id: "w", type: "wait", config: { minutes: 60 } },
        {
          id: "n",
          type: "add_note",
          config: { body: "Followed up with {{contact.email}}" },
        },
      ],
      [
        { from: "t", to: "w" },
        { from: "w", to: "n" },
      ],
    ),
  };
  const notesOf = async (contactId: string) =>
    (
      (await as(alice).get(`/notes?contactId=${contactId}`)).json().items as {
        body: string;
      }[]
    ).map((n) => n.body);

  it("a wait node holds the rest of the flow until its time", async () => {
    const wf = await makeWorkflow(alice, waitThenNote);
    const c = await makeContact(alice, "wait@example.test");
    const run = (
      await as(alice).post(`/workflows/${wf.id}/run`, { contactId: c.id })
    ).json();

    expect(await engine.tick(at(1))).toBe(1); // the wait node itself
    expect(await engine.tick(at(30))).toBe(0);
    expect(await engine.tick(at(60))).toBe(0); // 1 + 60 minutes is not reached yet
    expect(await notesOf(c.id)).toEqual([]);
    expect((await as(alice).get(`/executions/${run.id}`)).json().status).toBe(
      "running",
    );

    expect(await engine.tick(at(62))).toBe(1);
    expect(await notesOf(c.id)).toEqual(["Followed up with wait@example.test"]);
    const done = (await as(alice).get(`/executions/${run.id}`)).json();
    expect(done.status).toBe("completed");
    expect(
      done.steps.find((s: { nodeId: string }) => s.nodeId === "w").output,
    ).toEqual({ minutes: 60 });
    expect(await engine.tick(at(500))).toBe(0); // nothing is run twice
  });

  it("can be cancelled while waiting", async () => {
    const wf = await makeWorkflow(alice, waitThenNote);
    const c = await makeContact(alice, "cancel@example.test");
    const run = (
      await as(alice).post(`/workflows/${wf.id}/run`, { contactId: c.id })
    ).json();
    await engine.tick(at(1));
    const cancelled = await as(alice).post(`/executions/${run.id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
    expect(await engine.tick(at(120))).toBe(0);
    expect(await notesOf(c.id)).toEqual([]);
    const steps = (await as(alice).get(`/executions/${run.id}`)).json()
      .steps as { status: string }[];
    expect(steps.some((s) => s.status === "skipped")).toBe(true);
    expect(
      (await as(alice).post(`/executions/${run.id}/cancel`)).statusCode,
    ).toBe(400);
    expect(
      (await as(alice).post(`/executions/${crypto.randomUUID()}/cancel`))
        .statusCode,
    ).toBe(404);
  });

  it("running executions keep the graph they started with when the workflow is edited", async () => {
    const wf = await makeWorkflow(alice, waitThenNote);
    const c = await makeContact(alice, "snapshot@example.test");
    const run = (
      await as(alice).post(`/workflows/${wf.id}/run`, { contactId: c.id })
    ).json();
    await engine.tick(at(1));
    const edited = await as(alice).patch(`/workflows/${wf.id}`, {
      graph: flow(
        [{ id: "n", type: "add_note", config: { body: "NEW FLOW" } }],
        [{ from: "t", to: "n" }],
      ),
    });
    expect(edited.json().version).toBe(2);
    await engine.tick(at(62));
    expect(await notesOf(c.id)).toEqual([
      "Followed up with snapshot@example.test",
    ]); // the old flow finished
    expect(
      (await executionsOf(alice, wf.id)).find((e) => e.id === run.id)!
        .workflowVersion,
    ).toBe(1);
  });

  it("a step that needs a contact fails the run cleanly when there is none", async () => {
    const wf = await makeWorkflow(alice, {
      triggerType: "manual",
      graph: flow(
        [{ id: "n", type: "add_note", config: { body: "x" } }],
        [{ from: "t", to: "n" }],
      ),
    });
    const run = (await as(alice).post(`/workflows/${wf.id}/run`)).json();
    for (const m of [1, 3, 8]) await engine.tick(at(m));
    const failed = (await as(alice).get(`/executions/${run.id}`)).json();
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/needs a contact/);
  });
});

describe("actions", () => {
  it("http: sends the templated request with an idempotency key, retries 5xx with backoff, then succeeds", async () => {
    const wf = await makeWorkflow(alice, {
      triggerType: "manual",
      graph: flow(
        [
          {
            id: "h",
            type: "http",
            config: {
              url,
              method: "POST",
              headers: { "x-who": "{{contact.name}}" },
              body: '{"email":"{{contact.email}}","trigger":"{{event.type}}"}',
            },
          },
        ],
        [{ from: "t", to: "h" }],
      ),
    });
    const c = await makeContact(alice, "hook@example.test", "Hana");
    const run = (
      await as(alice).post(`/workflows/${wf.id}/run`, { contactId: c.id })
    ).json();
    failNext = 1;

    expect(await engine.tick(at(1))).toBe(1);
    expect(
      (await as(alice).get(`/executions/${run.id}`)).json().steps[0],
    ).toMatchObject({ status: "pending", attempts: 1 });
    expect(await engine.tick(at(1.5))).toBe(0); // backoff: not due for another minute
    expect(await engine.tick(at(3))).toBe(1);

    expect(received).toHaveLength(2);
    expect(received[1]!.headers["idempotency-key"]).toBe(`${run.id}:h`);
    expect(received[0]!.headers["idempotency-key"]).toBe(
      received[1]!.headers["idempotency-key"],
    );
    expect(received[1]!.headers["x-who"]).toBe("Hana");
    expect(JSON.parse(received[1]!.body)).toEqual({
      email: "hook@example.test",
      trigger: "manual.run",
    });
    const done = (await as(alice).get(`/executions/${run.id}`)).json();
    expect(done.status).toBe("completed");
    expect(done.steps[0].output).toMatchObject({ status: 200 });
  });

  it("http: gives up after 3 attempts, skips the rest, and the run can be replayed", async () => {
    const wf = await makeWorkflow(alice, {
      triggerType: "manual",
      graph: flow(
        [
          { id: "h", type: "http", config: { url, method: "GET" } },
          { id: "after", type: "tag", config: { add: ["notified"] } },
        ],
        [
          { from: "t", to: "h" },
          { from: "h", to: "after" },
        ],
      ),
    });
    const c = await makeContact(alice, "flaky@example.test");
    const run = (
      await as(alice).post(`/workflows/${wf.id}/run`, { contactId: c.id })
    ).json();
    failNext = 99;
    for (const m of [1, 3, 8]) await engine.tick(at(m));
    const failed = (await as(alice).get(`/executions/${run.id}`)).json();
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.error).toMatch(/h: HTTP 500/);
    expect(
      failed.steps.find((s: { nodeId: string }) => s.nodeId === "h"),
    ).toMatchObject({ status: "failed", attempts: 3 });
    expect(await tagsOf(alice, c.id)).toEqual([]);

    failNext = 0;
    const again = (await as(alice).post(`/executions/${run.id}/replay`)).json();
    expect(again.id).not.toBe(run.id);
    for (const m of [10, 12]) await engine.tick(at(m));
    expect((await as(alice).get(`/executions/${again.id}`)).json().status).toBe(
      "completed",
    );
    expect(await tagsOf(alice, c.id)).toEqual(["notified"]);
  });

  it("http: refuses private addresses when SSRF protection is on", async () => {
    const wf = await makeWorkflow(alice, {
      triggerType: "manual",
      graph: flow(
        [{ id: "h", type: "http", config: { url, method: "GET" } }],
        [{ from: "t", to: "h" }],
      ),
    });
    const run = (await as(alice).post(`/workflows/${wf.id}/run`)).json();
    process.env.ORBYT_ALLOW_PRIVATE_URLS = "false";
    try {
      for (const m of [1, 3, 8]) await engine.tick(at(m));
    } finally {
      process.env.ORBYT_ALLOW_PRIVATE_URLS = "true";
    }
    expect(received).toHaveLength(0);
    expect((await as(alice).get(`/executions/${run.id}`)).json().error).toMatch(
      /private or reserved/,
    );
  });

  it("update_contact sets built-in and custom fields (typed) from templates", async () => {
    await as(alice).post("/custom-fields", {
      key: "seats",
      label: "Seats",
      type: "number",
    });
    const wf = await makeWorkflow(alice, {
      triggerType: "manual",
      graph: flow(
        [
          {
            id: "u",
            type: "update_contact",
            config: {
              fields: {
                name: "{{contact.name}} (VIP)",
                "custom.seats": "5",
                source: "workflow",
              },
            },
          },
        ],
        [{ from: "t", to: "u" }],
      ),
    });
    const c = await makeContact(alice, "upd@example.test", "Una");
    await as(alice).post(`/workflows/${wf.id}/run`, { contactId: c.id });
    await engine.tick(at(1));
    expect((await as(alice).get(`/contacts/${c.id}`)).json()).toMatchObject({
      name: "Una (VIP)",
      source: "workflow",
      customFields: { seats: 5 },
    });
  });

  it("a failing node rolls back its own partial work", async () => {
    // The tag is added, then the unknown custom field makes the node fail: nothing must stick.
    const wf = await makeWorkflow(alice, {
      triggerType: "manual",
      graph: flow(
        [
          {
            id: "u",
            type: "update_contact",
            config: { fields: { "custom.nope": "1" } },
          },
        ],
        [{ from: "t", to: "u" }],
      ),
    });
    const c = await makeContact(alice, "rollback@example.test", "Rob");
    const run = (
      await as(alice).post(`/workflows/${wf.id}/run`, { contactId: c.id })
    ).json();
    for (const m of [1, 3, 8]) await engine.tick(at(m));
    expect((await as(alice).get(`/executions/${run.id}`)).json().error).toMatch(
      /Unknown custom field/,
    );
    expect((await as(alice).get(`/contacts/${c.id}`)).json().name).toBe("Rob");
  });

  it("enroll_sequence enrols the contact once and reports duplicates", async () => {
    const seq = (
      await as(alice).post("/sequences", {
        name: "S",
        footer: "f",
        steps: [{ delayHours: 0, subject: "Hi", body: "Hello" }],
      })
    ).json();
    const wf = await makeWorkflow(alice, {
      triggerType: "manual",
      graph: flow(
        [{ id: "e", type: "enroll_sequence", config: { sequenceId: seq.id } }],
        [{ from: "t", to: "e" }],
      ),
    });
    const c = await makeContact(alice, "enroll@example.test");
    const first = (
      await as(alice).post(`/workflows/${wf.id}/run`, { contactId: c.id })
    ).json();
    const second = (
      await as(alice).post(`/workflows/${wf.id}/run`, { contactId: c.id })
    ).json();
    await engine.tick(at(1));
    const list = (
      await as(alice).get(`/sequences/${seq.id}/enrollments`)
    ).json().items;
    expect(list).toHaveLength(1);
    const out = async (id: string) =>
      (await as(alice).get(`/executions/${id}`)).json().steps[0].output;
    expect(await out(first.id)).toMatchObject({ enrolled: 1 });
    expect(await out(second.id)).toMatchObject({
      enrolled: 0,
      skipped: ["already_enrolled"],
    });
  });
});

describe("validation and isolation", () => {
  const ok = flow(
    [{ id: "n", type: "tag", config: { add: ["x"] } }],
    [{ from: "t", to: "n" }],
  );
  const post = (u: typeof alice, over: object) =>
    as(u).post("/workflows", {
      name: "x",
      triggerType: "manual",
      graph: ok,
      ...over,
    });

  it("rejects malformed, cyclic and dangling workflows with specific problems", async () => {
    expect((await post(alice, { name: "" })).statusCode).toBe(400);
    expect((await post(alice, { triggerType: "event" })).statusCode).toBe(400); // needs triggerEvent
    expect(
      (
        await post(alice, {
          triggerType: "event",
          triggerEvent: "Not An Event",
        })
      ).statusCode,
    ).toBe(400);
    const cyc = await post(alice, {
      graph: flow(
        [
          { id: "a", type: "tag", config: { add: ["x"] } },
          { id: "b", type: "tag", config: { add: ["y"] } },
        ],
        [
          { from: "t", to: "a" },
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      ),
    });
    expect(cyc.statusCode).toBe(400);
    expect(cyc.json().problems.join()).toMatch(/loop/);
    expect(
      (
        await post(alice, {
          graph: flow([{ id: "a", type: "tag", config: {} }], []),
        })
      )
        .json()
        .problems.join(),
    ).toMatch(/not reachable/);
    expect(
      (
        await post(alice, {
          graph: flow(
            [{ id: "h", type: "http", config: { url: "nope" } }],
            [{ from: "t", to: "h" }],
          ),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(alice, {
          graph: flow(
            [
              {
                id: "e",
                type: "enroll_sequence",
                config: { sequenceId: crypto.randomUUID() },
              },
            ],
            [{ from: "t", to: "e" }],
          ),
        })
      ).statusCode,
    ).toBe(400);
  });

  it("will not reference another tenant's sequence", async () => {
    const bobSeq = (
      await as(bob).post("/sequences", {
        name: "B",
        footer: "f",
        steps: [{ delayHours: 0, subject: "s", body: "b" }],
      })
    ).json();
    const res = await post(alice, {
      graph: flow(
        [
          {
            id: "e",
            type: "enroll_sequence",
            config: { sequenceId: bobSeq.id },
          },
        ],
        [{ from: "t", to: "e" }],
      ),
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps workflows, runs and events strictly per workspace", async () => {
    const mine = await makeWorkflow(alice, {
      triggerType: "event",
      triggerEvent: "contact.created",
      graph: ok,
    });
    const bobsOwn = await makeWorkflow(bob, {
      triggerType: "event",
      triggerEvent: "contact.created",
      graph: ok,
    });
    for (const call of [
      () => as(bob).get(`/workflows/${mine.id}`),
      () => as(bob).patch(`/workflows/${mine.id}`, { name: "hijack" }),
      () => as(bob).post(`/workflows/${mine.id}/activate`),
      () => as(bob).post(`/workflows/${mine.id}/run`),
      () => as(bob).del(`/workflows/${mine.id}`),
    ])
      expect((await call()).statusCode).toBe(404);
    expect(
      (await as(bob).get("/workflows"))
        .json()
        .some((w: { id: string }) => w.id === mine.id),
    ).toBe(false);

    // Alice's event starts only Alice's workflow; Bob's workflow stays idle.
    const c = await makeContact(alice, "iso@example.test");
    await t.events.idle();
    await engine.tick(at(1));
    expect(await executionsOf(alice, mine.id)).toHaveLength(1);
    expect(await executionsOf(bob, bobsOwn.id)).toHaveLength(0);
    const run = (await executionsOf(alice, mine.id))[0]!;
    expect((await as(bob).get(`/executions/${run.id}`)).statusCode).toBe(404);
    expect(
      (await as(bob).post(`/executions/${run.id}/replay`)).statusCode,
    ).toBe(404);
    expect(await tagsOf(alice, c.id)).toEqual(["x"]);
    await as(bob).del(`/workflows/${bobsOwn.id}`);
  });
});
