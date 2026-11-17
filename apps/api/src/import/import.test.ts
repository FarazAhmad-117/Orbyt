import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../test-utils";
import { TEMPLATES, templateProblems } from "../workflows/templates";
import {
  ghlContactToRow,
  ghlContactsToCsv,
  ghlStatus,
  parseMoneyCents,
  readGhlCsv,
} from "./ghl";

describe("GoHighLevel column mapping", () => {
  it("reads headers case- and punctuation-insensitively", () => {
    const [r] = readGhlCsv(
      '﻿"Contact Id","First Name","Last Name","Business Name","Phone","Email","Tags"\n' +
        '"c1","Ada","Lovelace","Analytical Engines","+44 20 7946 0000","ada@example.com","vip, london;press"\n',
    );
    expect(ghlContactToRow(r!)).toEqual({
      email: "ada@example.com",
      name: "Ada Lovelace",
      phone: "+44 20 7946 0000",
      company: "Analytical Engines",
      tags: "vip;london;press",
      source: "gohighlevel",
    });
    const [alt] = readGhlCsv(
      "Contact Name,E-mail Address,Company Name\nGrace,g@x.test,Navy\n",
    );
    expect(ghlContactToRow(alt!)).toMatchObject({
      name: "Grace",
      company: "Navy",
    });
  });

  it("parses money and statuses", () => {
    expect(parseMoneyCents("$1,234.50")).toBe(123450);
    expect(parseMoneyCents("1000")).toBe(100000);
    expect(parseMoneyCents("")).toBe(0);
    expect(parseMoneyCents("n/a")).toBe(0);
    expect(ghlStatus("Won")).toBe("won");
    expect(ghlStatus("abandoned")).toBe("lost");
    expect(ghlStatus("Lost")).toBe("lost");
    expect(ghlStatus("open")).toBe("open");
    expect(ghlStatus("")).toBe("open");
  });

  it("refuses an export without emails and malformed CSV", () => {
    expect(() => ghlContactsToCsv("Name,Phone\nA,1\n")).toThrow(/email/i);
    expect(() => ghlContactsToCsv("")).toThrow();
    expect(() => readGhlCsv('Email\n"unterminated')).toThrow(/Invalid CSV/);
  });
});

describe("workflow templates", () => {
  it("every template passes the same validation as a user's workflow", () => {
    for (const tpl of TEMPLATES)
      expect([tpl.key, templateProblems(tpl)]).toEqual([tpl.key, []]);
    expect(new Set(TEMPLATES.map((x) => x.key)).size).toBe(TEMPLATES.length);
  });
});

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

const csv = (u: User, path: string, body: string) =>
  t.request("POST", `${u.base}${path}`, {
    cookie: u.cookie,
    payload: body,
    type: "text/csv",
  });
const get = (u: User, path: string) =>
  t.request("GET", `${u.base}${path}`, { cookie: u.cookie });
const post = (u: User, path: string, payload: unknown = {}) =>
  t.request("POST", `${u.base}${path}`, { cookie: u.cookie, payload });

describe("importing from GoHighLevel", () => {
  const contactsCsv =
    "Contact Id,First Name,Last Name,Business Name,Phone,Email,Tags\n" +
    '1,Ada,Lovelace,Analytical Engines,+44 20,ada@example.com,"vip, london"\n' +
    "2,Grace,Hopper,,,grace@example.com,navy\n" +
    "3,No,Email,,,,\n";

  it("imports contacts with companies and tags, merging on re-import", async () => {
    const first = await csv(alice, "/import/ghl/contacts", contactsCsv);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ created: 2, updated: 0 });
    expect(first.json().errors).toEqual([{ row: 4, message: "Invalid email" }]);

    const [ada] = (await get(alice, "/contacts?q=ada@example.com")).json()
      .items as { id: string; name: string; source: string }[];
    expect(ada).toMatchObject({ name: "Ada Lovelace", source: "gohighlevel" });
    const full = (await get(alice, `/contacts/${ada!.id}`)).json();
    expect(full.tags.map((x: { name: string }) => x.name).sort()).toEqual([
      "london",
      "vip",
    ]);
    const companies = (await get(alice, "/companies")).json().items as {
      name: string;
    }[];
    expect(companies.map((c) => c.name)).toContain("Analytical Engines");

    const again = await csv(alice, "/import/ghl/contacts", contactsCsv);
    expect(again.json()).toMatchObject({ created: 0, updated: 2 });
    expect((await get(alice, "/contacts?limit=100")).json().items).toHaveLength(
      2,
    );
  });

  const oppsCsv =
    "Opportunity Name,Contact Name,email,phone,pipeline,stage,Lead Value,status\n" +
    'Website redesign,Ada Lovelace,ada@example.com,,Sales,Proposal,"$5,000.00",open\n' +
    "Retainer,Grace Hopper,grace@example.com,,Sales,Won,2500,won\n" +
    "Old lead,New Person,new@example.com,,Sales,Proposal,100,abandoned\n" +
    "Orphan deal,,,,Partners,Intro,,open\n" +
    ",Nobody,nobody@example.com,,Sales,Proposal,1,open\n";

  it("imports opportunities into pipelines and stages, linking contacts by email", async () => {
    await csv(alice, "/import/ghl/contacts", contactsCsv);
    const res = await csv(alice, "/import/ghl/opportunities", oppsCsv);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      created: 4,
      skipped: 0,
      contactsCreated: 1, // new@example.com
    });
    expect(res.json().errors).toEqual([
      { row: 6, message: "Missing opportunity name" },
    ]);

    const pipelines = (await get(alice, "/pipelines")).json() as {
      name: string;
    }[];
    expect(pipelines.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Sales", "Partners"]),
    );

    const deals = (await get(alice, "/deals?limit=100")).json().items as {
      title: string;
      valueCents: number;
      status: string;
      contactId: string | null;
    }[];
    const byTitle = Object.fromEntries(deals.map((d) => [d.title, d]));
    expect(byTitle["Website redesign"]).toMatchObject({
      valueCents: 500000,
      status: "open",
    });
    expect(byTitle["Retainer"]).toMatchObject({
      valueCents: 250000,
      status: "won",
    });
    expect(byTitle["Old lead"]).toMatchObject({ status: "lost" });
    expect(byTitle["Orphan deal"]).toMatchObject({
      contactId: null,
      valueCents: 0,
    });
    const [ada] = (await get(alice, "/contacts?q=ada@example.com")).json()
      .items as { id: string }[];
    expect(byTitle["Website redesign"]!.contactId).toBe(ada!.id);

    // Running it again changes nothing.
    const again = await csv(alice, "/import/ghl/opportunities", oppsCsv);
    expect(again.json()).toMatchObject({
      created: 0,
      skipped: 4,
      contactsCreated: 0,
      pipelinesCreated: 0,
    });
    expect((await get(alice, "/deals?limit=100")).json().items).toHaveLength(4);
  });

  it("only accepts CSV bodies, only for workspace members, and keeps tenants apart", async () => {
    expect(
      (await post(alice, "/import/ghl/contacts", { a: 1 })).statusCode,
    ).toBe(400);
    expect(
      (await csv(alice, "/import/ghl/opportunities", "Opportunity Name\n"))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await t.request("POST", `${alice.base}/import/ghl/contacts`, {
          payload: contactsCsv,
          type: "text/csv",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await t.request("POST", `${alice.base}/import/ghl/contacts`, {
          cookie: bob.cookie,
          payload: contactsCsv,
          type: "text/csv",
        })
      ).statusCode,
    ).toBe(404);
    await csv(alice, "/import/ghl/contacts", contactsCsv);
    expect((await get(bob, "/contacts")).json().items).toHaveLength(0);
  });
});

describe("workflow templates over the API", () => {
  it("lists templates and copies one into the workspace as a draft that can be activated", async () => {
    const list = (await get(alice, "/workflow-templates")).json() as {
      key: string;
    }[];
    expect(list.map((x) => x.key)).toEqual(TEMPLATES.map((x) => x.key));
    expect(JSON.stringify(list)).not.toContain('"graph"');

    const res = await post(
      alice,
      "/workflow-templates/inbound-webhook-lead/use",
      {
        name: "My leads",
      },
    );
    expect(res.statusCode, res.body).toBe(201);
    const wf = res.json() as {
      id: string;
      name: string;
      status: string;
      webhookToken: string;
      triggerType: string;
    };
    expect(wf).toMatchObject({
      name: "My leads",
      status: "draft",
      triggerType: "webhook",
    });
    expect(wf.webhookToken).toMatch(/^[0-9a-f]{48}$/);
    expect((await post(alice, `/workflows/${wf.id}/activate`)).statusCode).toBe(
      200,
    );

    // Every template can be copied and activated as it is.
    for (const tpl of TEMPLATES) {
      const made = (
        await post(alice, `/workflow-templates/${tpl.key}/use`)
      ).json() as { id: string };
      const act = await post(alice, `/workflows/${made.id}/activate`);
      expect([tpl.key, act.statusCode]).toEqual([tpl.key, 200]);
    }
    expect((await post(alice, "/workflow-templates/nope/use")).statusCode).toBe(
      404,
    );
  });
});
