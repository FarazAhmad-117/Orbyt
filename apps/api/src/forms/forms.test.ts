import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../test-utils";
import { WorkflowService } from "../workflows/workflow.service";

let t: TestApp;
type User = Awaited<ReturnType<TestApp["signUp"]>>;
let alice: User;
let bob: User;

beforeAll(async () => {
  t = await createTestApp();
  bob = await t.signUp("Bob");
});
beforeEach(async () => {
  alice = await t.signUp("Alice");
});
afterAll(() => t.cleanup());

const as = (u: User) => ({
  get: (p: string) => t.request("GET", u.base + p, { cookie: u.cookie }),
  post: (p: string, payload?: unknown) =>
    t.request("POST", u.base + p, { cookie: u.cookie, payload: payload ?? {} }),
  patch: (p: string, payload: unknown) =>
    t.request("PATCH", u.base + p, { cookie: u.cookie, payload }),
  del: (p: string) => t.request("DELETE", u.base + p, { cookie: u.cookie }),
});
const fields = [
  { name: "email", label: "Email", type: "email", required: true },
  { name: "name", label: "Your name", type: "text", required: false },
  { name: "phone", label: "Phone", type: "tel", required: false },
  {
    name: "message",
    label: "How can we help?",
    type: "textarea",
    required: true,
  },
];
interface FormOut {
  id: string;
  url: string;
  publicToken: string;
  embedHtml: string;
}
async function makeForm(u: User, over: object = {}) {
  const res = await as(u).post("/forms", {
    name: "Contact us",
    fields,
    tags: ["lead"],
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as FormOut;
}
const publicPath = (u: User, f: FormOut) =>
  `/api/forms/${u.workspaceId}/${f.publicToken}`;
const submit = (u: User, f: FormOut, payload: unknown) =>
  t.request("POST", publicPath(u, f), { payload });

describe("form definitions", () => {
  it("need a required email field, valid unique names and a sane size", async () => {
    const bad = async (over: object) =>
      (await as(alice).post("/forms", { name: "x", fields, ...over }))
        .statusCode;
    expect(
      await bad({ fields: [{ name: "name", label: "N", type: "text" }] }),
    ).toBe(400);
    expect(
      await bad({
        fields: [{ name: "email", label: "E", type: "email", required: false }],
      }),
    ).toBe(400);
    expect(await bad({ fields: [...fields, { ...fields[1]! }] })).toBe(400); // duplicate name
    expect(
      await bad({
        fields: [...fields, { name: "_hp", label: "x", type: "text" }],
      }),
    ).toBe(400);
    expect(
      await bad({
        fields: [...fields, { name: "bad name", label: "x", type: "text" }],
      }),
    ).toBe(400);
    expect(await bad({ name: "" })).toBe(400);
  });

  it("are created with an unguessable public URL and a paste-in HTML snippet", async () => {
    const f = await makeForm(alice);
    expect(f.publicToken).toMatch(/^[0-9a-f]{48}$/);
    expect(f.url).toBe(`http://localhost:3001${publicPath(alice, f)}`);
    expect(f.embedHtml).toContain(`<form method="post" action="${f.url}">`);
    expect(f.embedHtml).toContain('name="email"');
    expect(f.embedHtml).toContain('name="_hp"');
    const list = (await as(alice).get("/forms")).json() as {
      id: string;
      submissions: number;
    }[];
    expect(list.find((x) => x.id === f.id)?.submissions).toBe(0);
    // Other workspaces cannot see or edit it.
    expect((await as(bob).get(`/forms`)).json()).toEqual([]);
    expect(
      (
        await t.request("GET", `${bob.base}/forms/${f.id}`, {
          cookie: bob.cookie,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("submitting a form from a website", () => {
  it("creates the contact once, merges tags, stores the submission and fires an event", async () => {
    const f = await makeForm(alice, { tags: ["lead", "website"] });
    const first = await submit(alice, f, {
      email: "Ann@Example.com",
      name: "Ann",
      phone: "+1 555 0100",
      message: "Do you ship to Canada?",
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({
      ok: true,
      message: "Thanks! We will be in touch.",
    });
    expect(first.headers["access-control-allow-origin"]).toBe("*");

    // The same person submits again: still one contact.
    await submit(alice, f, {
      email: "ann@example.com",
      message: "Second question",
    });

    const people = (await as(alice).get("/contacts?q=ann@example.com")).json()
      .items as {
      id: string;
      name: string;
      phone: string;
      source: string;
    }[];
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      name: "Ann",
      phone: "+1 555 0100",
      source: "form: Contact us",
    });
    const contact = (await as(alice).get(`/contacts/${people[0]!.id}`)).json();
    expect(contact.tags.map((x: { name: string }) => x.name).sort()).toEqual([
      "lead",
      "website",
    ]);

    const subs = (await as(alice).get(`/forms/${f.id}/submissions`)).json() as {
      items: { data: Record<string, string>; contactId: string }[];
    };
    expect(subs.items).toHaveLength(2);
    expect(subs.items[1]!.data).toMatchObject({
      message: "Do you ship to Canada?",
    });
    expect(subs.items.every((s) => s.contactId === people[0]!.id)).toBe(true);
    const list = (await as(alice).get("/forms")).json() as {
      id: string;
      submissions: number;
    }[];
    expect(list.find((x) => x.id === f.id)?.submissions).toBe(2);

    // It lands on the contact's activity timeline.
    await t.events.idle();
    const timeline = (
      await as(alice).get(`/timeline?contactId=${people[0]!.id}`)
    ).json();
    expect(JSON.stringify(timeline)).toContain("form.submitted");
  });

  it("starts workflows that listen for form.submitted", async () => {
    const wf = await as(alice).post("/workflows", {
      name: "Tag form leads",
      triggerType: "event",
      triggerEvent: "form.submitted",
      graph: {
        nodes: [
          { id: "t", type: "trigger", config: {} },
          { id: "a", type: "tag", config: { add: ["from-form"] } },
        ],
        edges: [{ from: "t", to: "a" }],
      },
    });
    await as(alice).post(
      `/workflows/${(wf.json() as { id: string }).id}/activate`,
    );
    const f = await makeForm(alice, { tags: [] });
    await submit(alice, f, { email: "wf@example.com", message: "hi" });
    await t.events.idle();
    await t.app
      .get(WorkflowService)
      .tick(new Date(Date.now() + 60_000), alice.workspaceId);
    const [c] = (await as(alice).get("/contacts?q=wf@example.com")).json()
      .items as { id: string }[];
    const tags = (await as(alice).get(`/contacts/${c!.id}`)).json().tags as {
      name: string;
    }[];
    expect(tags.map((x) => x.name)).toContain("from-form");
  });

  it("validates input and keeps bots out", async () => {
    const f = await makeForm(alice);
    const post = (payload: unknown) => submit(alice, f, payload);
    expect((await post({ email: "x@example.com" })).statusCode).toBe(400); // message missing
    expect(
      (await post({ email: "not-an-email", message: "m" })).statusCode,
    ).toBe(400);
    expect(
      (await post({ email: "x@example.com", message: "m".repeat(5001) }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post({
          email: "x@example.com",
          message: "m",
          name: "n".repeat(501),
        })
      ).statusCode,
    ).toBe(400);
    expect((await post(["not", "an", "object"])).statusCode).toBe(400);

    // Unknown fields are ignored, not stored.
    await post({
      email: "ok@example.com",
      message: "m",
      admin: "true",
      extra: "x",
    });
    const subs = (await as(alice).get(`/forms/${f.id}/submissions`)).json()
      .items as { data: Record<string, string> }[];
    expect(Object.keys(subs[0]!.data).sort()).toEqual(["email", "message"]);

    // A filled honeypot looks like success but creates nothing.
    const bot = await post({
      email: "bot@example.com",
      message: "buy now",
      _hp: "http://spam",
    });
    expect(bot.statusCode).toBe(200);
    expect(
      (await as(alice).get("/contacts?q=bot@example.com")).json().items,
    ).toHaveLength(0);
  });

  it("also works as a plain HTML form post and escapes what it echoes", async () => {
    const f = await makeForm(alice, {
      successMessage: 'Thanks <b>friend</b> & "welcome"',
    });
    const ok = await t.request("POST", publicPath(alice, f), {
      payload: "email=html%40example.com&message=hello",
      type: "application/x-www-form-urlencoded",
      headers: { accept: "text/html" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(String(ok.headers["content-type"])).toContain("text/html");
    expect(ok.body).toContain("Thank you");
    expect(ok.body).toContain(
      "&lt;b&gt;friend&lt;/b&gt; &amp; &quot;welcome&quot;",
    );
    expect(ok.body).not.toContain("<b>");

    const bad = await t.request("POST", publicPath(alice, f), {
      payload: "email=nope&message=hello",
      type: "application/x-www-form-urlencoded",
      headers: { accept: "text/html" },
    });
    expect(bad.statusCode).toBe(400);
    expect(String(bad.headers["content-type"])).toContain("text/html");
    expect(bad.body).toContain("not a valid email address");
  });

  it("serves the definition and CORS preflight to other sites, and hides paused or foreign forms", async () => {
    const f = await makeForm(alice);
    const def = await t.request("GET", publicPath(alice, f));
    expect(def.json()).toMatchObject({ name: "Contact us" });
    expect(def.json().fields).toHaveLength(4);
    expect(JSON.stringify(def.json())).not.toContain(f.publicToken);
    expect(def.headers["access-control-allow-origin"]).toBe("*");
    const pre = await t.app.inject({
      method: "OPTIONS",
      url: publicPath(alice, f),
      headers: { origin: "https://customer-site.test" },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-methods"]).toContain("POST");

    expect(
      (await t.request("GET", `/api/forms/${bob.workspaceId}/${f.publicToken}`))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await t.request(
          "GET",
          `/api/forms/${alice.workspaceId}/${"0".repeat(48)}`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await t.request("GET", `/api/forms/${alice.workspaceId}/short`))
        .statusCode,
    ).toBe(404);

    await as(alice).patch(`/forms/${f.id}`, { status: "paused" });
    expect(
      (await submit(alice, f, { email: "p@example.com", message: "m" }))
        .statusCode,
    ).toBe(404);
    await as(alice).patch(`/forms/${f.id}`, {
      status: "active",
      successMessage: "Got it",
    });
    expect(
      (await submit(alice, f, { email: "p@example.com", message: "m" })).json()
        .message,
    ).toBe("Got it");

    expect((await as(alice).del(`/forms/${f.id}`)).statusCode).toBe(204);
    expect(
      (await submit(alice, f, { email: "q@example.com", message: "m" }))
        .statusCode,
    ).toBe(404);
  });

  it("rate limits each visitor per form", async () => {
    const f = await makeForm(alice);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++)
      codes.push(
        (await submit(alice, f, { email: `r${i}@example.com`, message: "m" }))
          .statusCode,
      );
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});
