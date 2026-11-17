import { activities, eq } from "@orbyt/db";
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
  post: (path: string, payload?: unknown, type?: string) =>
    t.request("POST", u.base + path, { cookie: u.cookie, payload, type }),
  patch: (path: string, payload: unknown) =>
    t.request("PATCH", u.base + path, { cookie: u.cookie, payload }),
  put: (path: string, payload: unknown) =>
    t.request("PUT", u.base + path, { cookie: u.cookie, payload }),
  del: (path: string) =>
    t.request("DELETE", u.base + path, { cookie: u.cookie }),
});

describe("contacts", () => {
  it("requires authentication", async () => {
    const res = await t.request("GET", `${alice.base}/contacts`);
    expect(res.statusCode).toBe(401);
  });

  it("create / read / update / delete, with normalisation, tags and conflict handling", async () => {
    const a = as(alice);
    const created = await a.post("/contacts", {
      email: "  Ann@Example.COM ",
      name: "Ann",
      tags: ["lead", "vip"],
    });
    expect(created.statusCode).toBe(201);
    const c = created.json();
    expect(c.email).toBe("ann@example.com");
    expect(c.tags.map((x: { name: string }) => x.name).sort()).toEqual([
      "lead",
      "vip",
    ]);

    expect(
      (await a.post("/contacts", { email: "ann@example.com" })).statusCode,
    ).toBe(409);
    expect((await a.get(`/contacts/${c.id}`)).json().name).toBe("Ann");

    const patched = await a.patch(`/contacts/${c.id}`, {
      name: "Ann B",
      phone: "+1 555",
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Ann B", phone: "+1 555" });

    expect((await a.del(`/contacts/${c.id}`)).statusCode).toBe(204);
    expect((await a.get(`/contacts/${c.id}`)).statusCode).toBe(404);
  });

  it("rejects invalid input with a list of issues", async () => {
    const res = await as(alice).post("/contacts", {
      email: "not-an-email",
      tags: [""],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.length).toBeGreaterThan(0);
    expect((await as(alice).get("/contacts/not-a-uuid")).statusCode).toBe(400);
  });

  it("paginates newest-first, searches and filters by tag", async () => {
    const a = as(alice);
    for (const n of [1, 2, 3, 4, 5])
      await a.post("/contacts", {
        email: `page${n}@example.com`,
        name: `Pager ${n}`,
        tags: n % 2 ? ["odd"] : [],
      });
    const first = (await a.get("/contacts?limit=2&q=pager")).json();
    expect(first.items.map((x: { name: string }) => x.name)).toEqual([
      "Pager 5",
      "Pager 4",
    ]);
    const second = (
      await a.get(`/contacts?limit=2&q=pager&cursor=${first.nextCursor}`)
    ).json();
    expect(second.items.map((x: { name: string }) => x.name)).toEqual([
      "Pager 3",
      "Pager 2",
    ]);
    const last = (
      await a.get(`/contacts?limit=2&q=pager&cursor=${second.nextCursor}`)
    ).json();
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();

    const odd = (await a.get("/contacts?tag=odd&limit=50")).json();
    expect(odd.items.map((x: { name: string }) => x.name).sort()).toEqual([
      "Pager 1",
      "Pager 3",
      "Pager 5",
    ]);
    // LIKE wildcards in the search term are escaped, not interpreted.
    expect((await a.get("/contacts?q=%25")).json().items).toHaveLength(0);
  });

  it("isolates workspaces: no reads, writes or lookups across tenants", async () => {
    const mine = (
      await as(alice).post("/contacts", { email: "private@example.com" })
    ).json();
    // Bob, on his own workspace URL, cannot see or touch it.
    expect((await as(bob).get(`/contacts/${mine.id}`)).statusCode).toBe(404);
    expect(
      (await as(bob).patch(`/contacts/${mine.id}`, { name: "x" })).statusCode,
    ).toBe(404);
    expect((await as(bob).del(`/contacts/${mine.id}`)).statusCode).toBe(404);
    const list = (await as(bob).get("/contacts?limit=200")).json();
    expect(list.items.some((x: { id: string }) => x.id === mine.id)).toBe(
      false,
    );
    // Bob using ALICE's workspace URL is told it does not exist (no tenant id disclosure).
    const probe = await t.request("GET", `${alice.base}/contacts`, {
      cookie: bob.cookie,
    });
    expect(probe.statusCode).toBe(404);
  });

  it("rejects references to another tenant's company", async () => {
    const bobCompany = (
      await as(bob).post("/companies", { name: "Bob Inc" })
    ).json();
    const res = await as(alice).post("/contacts", {
      email: "xref@example.com",
      companyId: bobCompany.id,
    });
    expect(res.statusCode).toBe(400);
  });

  it("records activities for contact events", async () => {
    await as(alice).post("/contacts", { email: "timeline@example.com" });
    const rows = await t.dbs.inWorkspace(alice, (tx) =>
      tx
        .select()
        .from(activities)
        .where(eq(activities.type, "contact.created")),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("custom fields", () => {
  it("validates definitions and values; null removes a value", async () => {
    const a = as(alice);
    expect(
      (
        await a.post("/custom-fields", {
          key: "Bad Key",
          label: "x",
          type: "text",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await a.post("/custom-fields", {
          key: "tier",
          label: "Tier",
          type: "select",
        })
      ).statusCode,
    ).toBe(400); // select needs options
    expect(
      (
        await a.post("/custom-fields", {
          key: "tier",
          label: "Tier",
          type: "select",
          options: ["free", "pro"],
        })
      ).statusCode,
    ).toBe(201);
    await a.post("/custom-fields", {
      key: "seats",
      label: "Seats",
      type: "number",
    });

    const ok = await a.post("/contacts", {
      email: "cf@example.com",
      customFields: { tier: "pro", seats: 5 },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().customFields).toEqual({ tier: "pro", seats: 5 });

    const bad = (v: object) =>
      a.post("/contacts", {
        email: `cf${Math.random()}@example.com`,
        customFields: v,
      });
    expect((await bad({ tier: "gold" })).statusCode).toBe(400);
    expect((await bad({ seats: "many" })).statusCode).toBe(400);
    expect((await bad({ nope: 1 })).statusCode).toBe(400);

    const cleared = await a.patch(`/contacts/${ok.json().id}`, {
      customFields: { tier: null },
    });
    expect(cleared.json().customFields).toEqual({ seats: 5 });
  });
});

describe("tags and companies", () => {
  it("manages tags (colour validation) and removes them from contacts when deleted", async () => {
    const a = as(alice);
    expect(
      (await a.post("/tags", { name: "bad", color: "red" })).statusCode,
    ).toBe(400);
    const tag = (
      await a.post("/tags", { name: "hot", color: "#ff0000" })
    ).json();
    const c = (
      await a.post("/contacts", { email: "tagged@example.com", tags: ["hot"] })
    ).json();
    expect(c.tags).toHaveLength(1);
    expect((await a.del(`/tags/${tag.id}`)).statusCode).toBe(204);
    expect((await a.get(`/contacts/${c.id}`)).json().tags).toHaveLength(0);
  });

  it("companies CRUD; deleting a company unlinks its contacts", async () => {
    const a = as(alice);
    const co = (
      await a.post("/companies", { name: "Acme", domain: "acme.test" })
    ).json();
    const c = (
      await a.post("/contacts", { email: "emp@acme.test", companyId: co.id })
    ).json();
    expect(c.companyId).toBe(co.id);
    expect(
      (await a.patch(`/companies/${co.id}`, { name: "Acme Corp" })).json().name,
    ).toBe("Acme Corp");
    expect((await a.del(`/companies/${co.id}`)).statusCode).toBe(204);
    expect((await a.get(`/contacts/${c.id}`)).json().companyId).toBeNull();
  });
});

describe("CSV import / export", () => {
  it("imports with upserts and per-row errors, then exports what was stored", async () => {
    const a = as(alice);
    await a.post("/custom-fields", {
      key: "employees",
      label: "Employees",
      type: "number",
    });
    const csv = [
      "Email,Name,Company,Tags,Employees,Mystery",
      "csv1@example.com,One,CsvCo,a;b,10,zzz",
      "csv2@example.com,Two,CsvCo,,abc,",
      "not-an-email,Bad,,,,",
      "csv1@example.com,One Updated,,c,12,",
    ].join("\n");
    const res = await a.post("/contacts/import", csv, "text/csv");
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(1); // csv1 created, then updated by the last row
    expect(body.updated).toBe(1);
    expect(body.errors.map((e: { row: number }) => e.row).sort()).toEqual([
      3, 4,
    ]);
    expect(body.ignoredColumns).toEqual(["mystery"]);

    const list = (await a.get("/contacts?q=csv1")).json();
    expect(list.items[0]).toMatchObject({
      name: "One Updated",
      customFields: { employees: 12 },
    });
    expect(
      list.items[0].tags.map((x: { name: string }) => x.name).sort(),
    ).toEqual(["a", "b", "c"]);

    const exp = await a.get("/contacts/export");
    expect(exp.statusCode).toBe(200);
    expect(exp.headers["content-type"]).toContain("text/csv");
    expect(exp.body.split("\n")[0]).toContain(
      "email,name,phone,source,company,tags",
    );
    expect(exp.body).toContain("csv1@example.com,One Updated");
    expect(exp.body).toContain("CsvCo");
  });

  it("rejects a CSV without an email column and a non-CSV body", async () => {
    const a = as(alice);
    expect(
      (await a.post("/contacts/import", "name\nx", "text/csv")).statusCode,
    ).toBe(400);
    expect((await a.post("/contacts/import", { not: "csv" })).statusCode).toBe(
      400,
    );
  });
});
