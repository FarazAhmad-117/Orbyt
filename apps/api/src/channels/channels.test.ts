import http from "node:http";
import type { AddressInfo } from "node:net";
import { channelAccounts, eq } from "@orbyt/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../test-utils";
import { WorkflowService } from "../workflows/workflow.service";
import { normalizePhone, twilioSignature } from "./providers";

let t: TestApp;
let alice: Awaited<ReturnType<TestApp["signUp"]>>;
let bob: Awaited<ReturnType<TestApp["signUp"]>>;

// ---- Mock Twilio + Retell ----
interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
const seen: Seen[] = [];
const mock = {
  fail: null as null | { status: number; message: string },
  sid: 0,
};
let server: http.Server;

beforeAll(async () => {
  t = await createTestApp();
  bob = await t.signUp("Bob");
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url!, headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      if (mock.fail) {
        res.statusCode = mock.fail.status;
        return res.end(
          JSON.stringify({ message: mock.fail.message, code: 21211 }),
        );
      }
      if (req.url!.includes("/Messages.json"))
        return res.end(
          JSON.stringify({ sid: `SM${++mock.sid}`, status: "queued" }),
        );
      if (req.url === "/v2/create-phone-call")
        return res.end(JSON.stringify({ call_id: `call_${++mock.sid}` }));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TWILIO_API_BASE = base;
  process.env.RETELL_API_BASE = base;
});
beforeEach(async () => {
  alice = await t.signUp("Alice");
  seen.length = 0;
  mock.fail = null;
  mock.sid = 0;
});
afterAll(async () => {
  await t.cleanup();
  await new Promise((r) => server.close(r));
});

const as = (u: typeof alice) => ({
  get: (p: string) => t.request("GET", u.base + p, { cookie: u.cookie }),
  post: (p: string, payload?: unknown) =>
    t.request("POST", u.base + p, { cookie: u.cookie, payload: payload ?? {} }),
  del: (p: string) => t.request("DELETE", u.base + p, { cookie: u.cookie }),
});
const AUTH_TOKEN = "twilio-auth-token-123";
const addTwilio = async (u: typeof alice, over: object = {}) => {
  const res = await as(u).post("/channels", {
    type: "twilio_sms",
    name: `sms-${Math.random().toString(36).slice(2, 6)}`,
    address: "+1 415 555 0100",
    accountSid: "ACtest1234567890",
    authToken: AUTH_TOKEN,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; webhookUrl: string; address: string };
};
const hookPath = (a: { webhookUrl: string }) => new URL(a.webhookUrl).pathname;

/** Delivers an inbound Twilio webhook, signed the way Twilio signs it. */
async function inbound(
  a: { webhookUrl: string },
  params: Record<string, string>,
  opts: { signature?: string | null } = {},
) {
  const signature =
    opts.signature === undefined
      ? twilioSignature(AUTH_TOKEN, a.webhookUrl, params)
      : opts.signature;
  return t.request("POST", hookPath(a), {
    payload: new URLSearchParams(params).toString(),
    type: "application/x-www-form-urlencoded",
    headers: signature ? { "x-twilio-signature": signature } : {},
  });
}
const inboxOf = async (u: typeof alice) =>
  (await as(u).get("/inbox/conversations?limit=50")).json().items as {
    id: string;
    channel: string;
    contactEmail: string | null;
    subject: string;
    hasUnread: boolean;
    snippet: string;
  }[];
const threadOf = async (u: typeof alice, id: string) =>
  (await as(u).get(`/inbox/conversations/${id}`)).json();

describe("phone numbers", () => {
  it("normalises to E.164 and rejects the rest", () => {
    expect(normalizePhone("+1 (415) 555-0100")).toBe("+14155550100");
    expect(normalizePhone("whatsapp:+44 20 7946 0958")).toBe("+442079460958");
    for (const bad of [
      "4155550100",
      "+0123456789",
      "+12",
      "abc",
      "+1 415 555 01009999999999",
    ])
      expect(() => normalizePhone(bad), bad).toThrow();
  });
});

describe("channel accounts", () => {
  it("hides credentials, is private, and can only be connected by a signed-in user", async () => {
    const a = await addTwilio(alice);
    expect(a.address).toBe("+14155550100");
    expect(a.webhookUrl).toMatch(/\/api\/channels\/twilio\/[\w-]{20,}$/);
    const listed = JSON.stringify((await as(alice).get("/channels")).json());
    expect(listed).not.toContain(AUTH_TOKEN);
    expect(listed).not.toContain("config");
    const [row] = await t.dbs.inWorkspace(alice, (tx) =>
      tx.select().from(channelAccounts).where(eq(channelAccounts.id, a.id)),
    );
    expect(row!.configEnc).toMatch(/^v1\./);
    expect(row!.configEnc).not.toContain(AUTH_TOKEN);

    expect((await as(bob).get("/channels")).json()).toHaveLength(0);
    expect(
      (
        await as(bob).post(`/channels/${a.id}/send`, {
          to: "+14155550111",
          body: "hi",
        })
      ).statusCode,
    ).toBe(404);
    expect((await as(bob).del(`/channels/${a.id}`)).statusCode).toBe(404);
    const key = (await as(alice).post("/api-keys", { name: "k" })).json()
      .key as string;
    const connect = await t.request("POST", `${alice.base}/channels`, {
      bearer: key,
      payload: {
        type: "retell",
        name: "r",
        address: "+14155550101",
        apiKey: "retell-key-12345",
      },
    });
    expect(connect.statusCode).toBe(403);
  });

  it("validates input", async () => {
    const post = (over: object) =>
      as(alice).post("/channels", {
        type: "twilio_sms",
        name: "x",
        address: "+14155550100",
        accountSid: "ACtest1234567890",
        authToken: AUTH_TOKEN,
        ...over,
      });
    expect((await post({ address: "415-555-0100" })).statusCode).toBe(400);
    expect((await post({ accountSid: "nope" })).statusCode).toBe(400);
    expect((await post({ authToken: "short" })).statusCode).toBe(400);
    expect((await post({ type: "fax" })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(201);
    expect((await post({})).statusCode).toBe(409); // names are unique
  });
});

describe("sending", () => {
  it("sends an SMS through Twilio with the right credentials and files it in the inbox", async () => {
    const a = await addTwilio(alice);
    const c = (
      await as(alice).post("/contacts", {
        email: "lena@example.test",
        name: "Lena",
        phone: "+1 (415) 555-0123",
      })
    ).json();
    const res = await as(alice).post(`/channels/${a.id}/send`, {
      to: "+14155550123",
      body: "Hello Lena, your demo is booked.",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sid: "SM1", to: "+14155550123" });

    expect(seen[0]!.path).toBe(
      "/2010-04-01/Accounts/ACtest1234567890/Messages.json",
    );
    expect(seen[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from(`ACtest1234567890:${AUTH_TOKEN}`).toString("base64")}`,
    );
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body))).toEqual({
      From: "+14155550100",
      To: "+14155550123",
      Body: "Hello Lena, your demo is booked.",
    });

    const [conv] = await inboxOf(alice);
    expect(conv).toMatchObject({
      channel: "sms",
      contactEmail: "lena@example.test",
      hasUnread: false,
    });
    const thread = await threadOf(alice, conv!.id);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({
      direction: "out",
      channel: "sms",
      bodyText: "Hello Lena, your demo is booked.",
      messageId: "SM1",
    });
    // The CRM timeline shows it.
    const events = (
      (await as(alice).get(`/timeline?contactId=${c.id}&limit=50`)).json()
        .items as { type: string }[]
    ).map((e) => e.type);
    expect(events).toContain("sms.sent");
  });

  it("surfaces Twilio errors without leaking credentials, and rejects bad numbers", async () => {
    const a = await addTwilio(alice);
    mock.fail = {
      status: 400,
      message: "The 'To' number is not a valid phone number",
    };
    const bad = await as(alice).post(`/channels/${a.id}/send`, {
      to: "+14155550123",
      body: "x",
    });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().message).toMatch(/400.*not a valid phone number.*21211/);
    expect(bad.body).not.toContain(AUTH_TOKEN);
    mock.fail = null;
    expect(
      (
        await as(alice).post(`/channels/${a.id}/send`, {
          to: "415-555-0123",
          body: "x",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await as(alice).post(`/channels/${a.id}/send`, {
          to: "+14155550123",
          body: "",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await as(alice).post(`/channels/${a.id}/call`, { to: "+14155550123" }))
        .statusCode,
    ).toBe(400); // an SMS channel cannot call
  });

  it("whatsapp channels address numbers with the whatsapp: prefix", async () => {
    const a = await addTwilio(alice, {
      type: "twilio_whatsapp",
      address: "+14155238886",
    });
    expect(a.address).toBe("whatsapp:+14155238886");
    await as(alice).post(`/channels/${a.id}/send`, {
      to: "+4915112345678",
      body: "Hallo",
    });
    expect(
      Object.fromEntries(new URLSearchParams(seen[0]!.body)),
    ).toMatchObject({
      From: "whatsapp:+14155238886",
      To: "whatsapp:+4915112345678",
    });
    expect((await inboxOf(alice))[0]!.channel).toBe("whatsapp");
  });
});

describe("inbound messages", () => {
  it("accepts a correctly signed webhook, threads it to the contact, and lets the inbox reply", async () => {
    const a = await addTwilio(alice);
    const c = (
      await as(alice).post("/contacts", {
        email: "ina@example.test",
        name: "Ina",
        phone: "+14155550777",
      })
    ).json();
    const res = await inbound(a, {
      From: "+14155550777",
      To: "+14155550100",
      Body: "Is Thursday ok?",
      MessageSid: "SMin1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain("<Response>");

    const [conv] = await inboxOf(alice);
    expect(conv).toMatchObject({
      channel: "sms",
      contactEmail: "ina@example.test",
      hasUnread: true,
      snippet: "Is Thursday ok?",
    });
    expect(
      (
        (await as(alice).get(`/timeline?contactId=${c.id}&limit=50`)).json()
          .items as { type: string }[]
      ).map((e) => e.type),
    ).toContain("sms.received");

    // Replying from the unified inbox goes out over SMS to the same number.
    const reply = await as(alice).post(
      `/inbox/conversations/${conv!.id}/reply`,
      { body: "Yes, Thursday works!" },
    );
    expect(reply.statusCode).toBe(201);
    expect(
      Object.fromEntries(new URLSearchParams(seen[0]!.body)),
    ).toMatchObject({ To: "+14155550777", Body: "Yes, Thursday works!" });
    const thread = await threadOf(alice, conv!.id);
    expect(
      thread.messages.map((m: { direction: string }) => m.direction),
    ).toEqual(["in", "out"]);
    expect(await inboxOf(alice)).toHaveLength(1); // same conversation, not a new one
  });

  it("is idempotent when Twilio retries, and handles numbers that are not contacts", async () => {
    const a = await addTwilio(alice);
    const params = {
      From: "+14155550888",
      To: "+14155550100",
      Body: "Who is this?",
      MessageSid: "SMdup",
    };
    await inbound(a, params);
    await inbound(a, params);
    const [conv] = await inboxOf(alice);
    expect(conv).toMatchObject({ contactEmail: null, subject: "+14155550888" });
    expect((await threadOf(alice, conv!.id)).messages).toHaveLength(1);
  });

  it("rejects missing or wrong signatures and unknown tokens, storing nothing", async () => {
    const a = await addTwilio(alice);
    const params = {
      From: "+14155550999",
      To: "+14155550100",
      Body: "spoofed",
      MessageSid: "SMfake",
    };
    expect((await inbound(a, params, { signature: "AAAA" })).statusCode).toBe(
      403,
    );
    expect((await inbound(a, params, { signature: null })).statusCode).toBe(
      403,
    );
    const wrongToken = twilioSignature(
      "some-other-token",
      a.webhookUrl,
      params,
    );
    expect(
      (await inbound(a, params, { signature: wrongToken })).statusCode,
    ).toBe(403);
    // A valid signature for DIFFERENT parameters does not authorise these.
    const other = twilioSignature(AUTH_TOKEN, a.webhookUrl, {
      ...params,
      Body: "legit",
    });
    expect((await inbound(a, params, { signature: other })).statusCode).toBe(
      403,
    );
    expect(await inboxOf(alice)).toHaveLength(0);

    const unknown = await t.request(
      "POST",
      "/api/channels/twilio/not-a-real-token-at-all",
      {
        payload: "From=%2B14155550999&Body=x",
        type: "application/x-www-form-urlencoded",
      },
    );
    expect(unknown.statusCode).toBe(404);
    // A Retell token is not accepted on the Twilio endpoint.
    const retell = (
      await as(alice).post("/channels", {
        type: "retell",
        name: "voice",
        address: "+14155550101",
        apiKey: "retell-key-12345",
      })
    ).json();
    expect(
      (
        await t.request(
          "POST",
          `/api/channels/twilio/${new URL(retell.webhookUrl).pathname.split("/").pop()}`,
          {
            payload: "From=%2B1&Body=x",
            type: "application/x-www-form-urlencoded",
          },
        )
      ).statusCode,
    ).toBe(404);
  });

  it("STOP opts the number out of further messages; START opts back in", async () => {
    const a = await addTwilio(alice);
    await as(alice).post("/contacts", {
      email: "stan@example.test",
      phone: "+14155550666",
    });
    await as(alice).post(`/channels/${a.id}/send`, {
      to: "+14155550666",
      body: "Welcome",
    });
    await inbound(a, {
      From: "+14155550666",
      To: "+14155550100",
      Body: "stop",
      MessageSid: "SMstop",
    });
    seen.length = 0;
    const blocked = await as(alice).post(`/channels/${a.id}/send`, {
      to: "+14155550666",
      body: "Sale!",
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toMatch(/opted out/);
    expect(seen).toHaveLength(0); // Twilio was never contacted
    await inbound(a, {
      From: "+14155550666",
      To: "+14155550100",
      Body: "START",
      MessageSid: "SMstart",
    });
    expect(
      (
        await as(alice).post(`/channels/${a.id}/send`, {
          to: "+14155550666",
          body: "Welcome back",
        })
      ).statusCode,
    ).toBe(200);
  });

  it("whatsapp inbound maps whatsapp:+number to the same contact", async () => {
    const a = await addTwilio(alice, {
      type: "twilio_whatsapp",
      address: "+14155238886",
    });
    await as(alice).post("/contacts", {
      email: "wa@example.test",
      phone: "+4915112345678",
    });
    await inbound(a, {
      From: "whatsapp:+4915112345678",
      To: "whatsapp:+14155238886",
      Body: "Hallo!",
      MessageSid: "SMwa",
    });
    expect((await inboxOf(alice))[0]).toMatchObject({
      channel: "whatsapp",
      contactEmail: "wa@example.test",
    });
  });

  it("keeps channels isolated per workspace", async () => {
    const a = await addTwilio(alice);
    await inbound(a, {
      From: "+14155550321",
      To: "+14155550100",
      Body: "private",
      MessageSid: "SMiso",
    });
    expect(await inboxOf(bob)).toHaveLength(0);
    expect(await inboxOf(alice)).toHaveLength(1);
  });
});

describe("voice (Retell)", () => {
  const addRetell = async (u: typeof alice) => {
    const res = await as(u).post("/channels", {
      type: "retell",
      name: "voice",
      address: "+14155550101",
      apiKey: "retell-key-12345",
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; webhookUrl: string };
  };

  it("places an outbound call and stores the transcript and summary when the call ends", async () => {
    const a = await addRetell(alice);
    const c = (
      await as(alice).post("/contacts", {
        email: "vic@example.test",
        phone: "+14155550444",
      })
    ).json();
    const started = await as(alice).post(`/channels/${a.id}/call`, {
      to: "+14155550444",
      agentId: "agent_1",
      contactId: c.id,
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      callId: "call_1",
      to: "+14155550444",
    });
    expect(seen[0]!.headers.authorization).toBe("Bearer retell-key-12345");
    expect(JSON.parse(seen[0]!.body)).toMatchObject({
      from_number: "+14155550101",
      to_number: "+14155550444",
      override_agent_id: "agent_1",
    });

    const event = {
      event: "call_analyzed",
      call: {
        call_id: "call_1",
        direction: "outbound",
        from_number: "+14155550101",
        to_number: "+14155550444",
        transcript: "Agent: Hi Vic!\nUser: Hello.",
        call_analysis: { call_summary: "Booked a demo." },
      },
    };
    const path = new URL(a.webhookUrl).pathname;
    expect((await t.request("POST", path, { payload: event })).statusCode).toBe(
      200,
    );
    expect((await t.request("POST", path, { payload: event })).statusCode).toBe(
      200,
    ); // retried delivery

    const [conv] = await inboxOf(alice);
    expect(conv).toMatchObject({
      channel: "voice",
      contactEmail: "vic@example.test",
    });
    const thread = await threadOf(alice, conv!.id);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].bodyText).toContain("Summary: Booked a demo.");
    expect(thread.messages[0].bodyText).toContain("User: Hello.");
    const types = (
      (await as(alice).get(`/timeline?contactId=${c.id}&limit=50`)).json()
        .items as { type: string }[]
    ).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["call.started", "call.completed"]),
    );

    // call_started carries nothing to store; unknown tokens are 404.
    await t.request("POST", path, {
      payload: {
        event: "call_started",
        call: {
          call_id: "call_9",
          direction: "outbound",
          to_number: "+14155550444",
        },
      },
    });
    expect((await threadOf(alice, conv!.id)).messages).toHaveLength(1);
    expect(
      (
        await t.request("POST", "/api/channels/retell/nope-nope-nope-nope", {
          payload: event,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("surfaces Retell errors and refuses message channels", async () => {
    const a = await addRetell(alice);
    mock.fail = { status: 402, message: "No credits" };
    const res = await as(alice).post(`/channels/${a.id}/call`, {
      to: "+14155550444",
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/402.*No credits/);
    mock.fail = null;
    expect(
      (
        await as(alice).post(`/channels/${a.id}/send`, {
          to: "+14155550444",
          body: "x",
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("workflow steps", () => {
  it("send_sms and voice_call run with templated numbers and text", async () => {
    const sms = await addTwilio(alice);
    const voice = (
      await as(alice).post("/channels", {
        type: "retell",
        name: "v",
        address: "+14155550101",
        apiKey: "retell-key-12345",
      })
    ).json();
    const engine = t.app.get(WorkflowService);
    const wf = await as(alice).post("/workflows", {
      name: "notify",
      triggerType: "manual",
      graph: {
        nodes: [
          { id: "t", type: "trigger", config: {} },
          {
            id: "text",
            type: "send_sms",
            config: {
              channelId: sms.id,
              to: "{{contact.phone}}",
              body: "Hi {{contact.name}}, thanks for signing up!",
            },
          },
          {
            id: "ring",
            type: "voice_call",
            config: {
              channelId: voice.id,
              to: "{{contact.phone}}",
              agentId: "agent_x",
            },
          },
        ],
        edges: [
          { from: "t", to: "text" },
          { from: "text", to: "ring" },
        ],
      },
    });
    expect(wf.statusCode, wf.body).toBe(201);
    const c = (
      await as(alice).post("/contacts", {
        email: "flow@example.test",
        name: "Fay",
        phone: "+1 415 555 0222",
      })
    ).json();
    const run = (
      await as(alice).post(`/workflows/${wf.json().id}/run`, {
        contactId: c.id,
      })
    ).json();
    await engine.tick(new Date(Date.now() + 60_000), alice.workspaceId);

    expect(
      Object.fromEntries(new URLSearchParams(seen[0]!.body)),
    ).toMatchObject({
      To: "+14155550222",
      Body: "Hi Fay, thanks for signing up!",
    });
    expect(JSON.parse(seen[1]!.body)).toMatchObject({
      to_number: "+14155550222",
      override_agent_id: "agent_x",
    });
    const done = (await as(alice).get(`/executions/${run.id}`)).json();
    expect(done.status).toBe("completed");
    expect(
      done.steps
        .map(
          (s: { output: Record<string, string> }) => Object.keys(s.output)[0],
        )
        .sort(),
    ).toEqual(["callId", "sid"]);
  });

  it("will not reference another tenant's channel", async () => {
    const bobs = await addTwilio(bob);
    const c = (
      await as(alice).post("/contacts", {
        email: "x@example.test",
        phone: "+14155550333",
      })
    ).json();
    const wf = await as(alice).post("/workflows", {
      name: "steal",
      triggerType: "manual",
      graph: {
        nodes: [
          { id: "t", type: "trigger", config: {} },
          {
            id: "s",
            type: "send_sms",
            config: { channelId: bobs.id, to: "+14155550333", body: "x" },
          },
        ],
        edges: [{ from: "t", to: "s" }],
      },
    });
    const engine = t.app.get(WorkflowService);
    const run = (
      await as(alice).post(`/workflows/${wf.json().id}/run`, {
        contactId: c.id,
      })
    ).json();
    for (const m of [1, 3, 8])
      await engine.tick(new Date(Date.now() + m * 60_000), alice.workspaceId);
    const failed = (await as(alice).get(`/executions/${run.id}`)).json();
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/Channel not found/);
    expect(seen).toHaveLength(0);
  });
});
