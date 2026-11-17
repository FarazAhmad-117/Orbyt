import net from "node:net";
import {
  emailEvents,
  enrollments,
  eq,
  mailboxes,
  messages,
  suppressions,
} from "@orbyt/db";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../test-utils";
import { SchedulerService } from "./scheduler.service";

const SMTP_PORT = Number(process.env.MAIL_SMTP_PORT ?? 3025);
const IMAP_PORT = Number(process.env.MAIL_IMAP_PORT ?? 3143);

let t: TestApp;
let scheduler: SchedulerService;
let alice: Awaited<ReturnType<TestApp["signUp"]>>;
let bob: Awaited<ReturnType<TestApp["signUp"]>>;
const extraServers: SMTPServer[] = [];

const rand = () => Math.random().toString(36).slice(2, 8);
const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
const as = (u: typeof alice) => ({
  get: (p: string) => t.request("GET", u.base + p, { cookie: u.cookie }),
  post: (p: string, payload?: unknown) =>
    t.request("POST", u.base + p, { cookie: u.cookie, payload: payload ?? {} }),
  patch: (p: string, payload: unknown) =>
    t.request("PATCH", u.base + p, { cookie: u.cookie, payload }),
  del: (p: string) => t.request("DELETE", u.base + p, { cookie: u.cookie }),
});

async function waitFor<T>(
  fn: () => Promise<T | false | undefined>,
  what: string,
  ms = 10_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const port = (p: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(p, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

/** Everything GreenMail has delivered to `address`. */
async function inbox(address: string): Promise<ParsedMail[]> {
  const c = new ImapFlow({
    host: "127.0.0.1",
    port: IMAP_PORT,
    secure: false,
    auth: { user: address, pass: "x" },
    logger: false,
  });
  c.on("error", () => undefined);
  await c.connect();
  const lock = await c.getMailboxLock("INBOX");
  const out: ParsedMail[] = [];
  try {
    if ((c.mailbox as { exists: number }).exists > 0)
      for await (const m of c.fetch("1:*", { source: true }))
        out.push(await simpleParser(m.source as Buffer));
  } finally {
    lock.release();
    await c.logout().catch(() => undefined);
  }
  return out;
}
const waitInbox = (address: string, n: number) =>
  waitFor(async () => {
    const m = await inbox(address).catch(() => []);
    return m.length >= n ? m : false;
  }, `${n} message(s) for ${address}`);

const smtp = nodemailer.createTransport({
  host: "127.0.0.1",
  port: SMTP_PORT,
  secure: false,
  tls: { rejectUnauthorized: false },
});

const mailboxBody = (email: string, over: object = {}) => ({
  email,
  smtp: {
    host: "127.0.0.1",
    port: SMTP_PORT,
    secure: false,
    user: email,
    password: "pw",
  },
  imap: {
    host: "127.0.0.1",
    port: IMAP_PORT,
    secure: false,
    user: email,
    password: "pw",
  },
  ...over,
});
async function makeMailbox(u: typeof alice, over: object = {}) {
  const email = `sender-${rand()}@orbyt-test.local`;
  const res = await as(u).post("/mailboxes", mailboxBody(email, over));
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; email: string };
}
async function makeContact(u: typeof alice, local = "lead", name?: string) {
  const email = `${local}-${rand()}@example.test`;
  const res = await as(u).post("/contacts", { email, name });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; email: string };
}
const STEP = {
  delayHours: 0,
  subject: "Hi {{first_name | there}}",
  body: "Hello {{first_name | friend}}, quick question.",
};
async function makeSequence(
  u: typeof alice,
  mailboxIds: string[],
  over: object = {},
  steps: object[] = [STEP],
  activate = true,
) {
  const res = await as(u).post("/sequences", {
    name: `Seq ${rand()}`,
    mailboxIds,
    windowStartHour: 0,
    windowEndHour: 24,
    sendDays: [1, 2, 3, 4, 5, 6, 7],
    footer: "Acme Inc, 1 Main St, Springfield",
    steps,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  const seq = res.json() as { id: string };
  if (activate)
    expect((await as(u).post(`/sequences/${seq.id}/activate`)).statusCode).toBe(
      200,
    );
  return seq;
}
const enroll = async (
  u: typeof alice,
  seqId: string,
  ...contactIds: string[]
) =>
  (await as(u).post(`/sequences/${seqId}/enroll`, { contactIds })).json() as {
    enrolled: number;
    skipped: { reason: string }[];
  };
const enrollmentOf = (u: typeof alice, contactId: string) =>
  t.dbs.inWorkspace(
    u,
    async (tx) =>
      (
        await tx
          .select()
          .from(enrollments)
          .where(eq(enrollments.contactId, contactId))
      )[0]!,
  );
const eventTypes = (u: typeof alice, contactId: string) =>
  t.dbs.inWorkspace(u, async (tx) =>
    (
      await tx
        .select()
        .from(emailEvents)
        .where(eq(emailEvents.contactId, contactId))
    ).map((e) => e.type),
  );
const pathOf = (url: string) => new URL(url).pathname;
// mailparser structures List-Unsubscribe; read the raw header value instead.
const rawHeader = (m: ParsedMail, name: string) =>
  m.headerLines.find((h) => h.key === name)?.line.replace(/^[^:]+:\s*/, "") ??
  "";
const unsubUrl = (m: ParsedMail) =>
  /<(.+?)>/.exec(rawHeader(m, "list-unsubscribe"))![1]!;

beforeAll(async () => {
  if (!(await port(SMTP_PORT)) || !(await port(IMAP_PORT)))
    throw new Error(
      "GreenMail is not running. Start it with: docker compose --profile test up -d mail",
    );
  t = await createTestApp();
  scheduler = t.app.get(SchedulerService);
  // Every test gets its own workspace and tick() only touches the current one, so tests cannot
  // trigger each other's pending emails (they use far-future clocks).
  const realTick = scheduler.tick.bind(scheduler);
  scheduler.tick = (now?: Date) => realTick(now, alice.workspaceId);
  bob = await t.signUp("Bob");
}, 60_000);

beforeEach(async () => {
  alice = await t.signUp("Alice");
});

afterAll(async () => {
  smtp.close();
  await Promise.all(
    extraServers.map((s) => new Promise((r) => s.close(() => r(null)))),
  );
  await t.cleanup();
});

describe("mailboxes", () => {
  it("connects, hides credentials everywhere, and is private to the workspace", async () => {
    const mb = await makeMailbox(alice);
    const list = JSON.stringify((await as(alice).get("/mailboxes")).json());
    expect(list).not.toContain("credentials");
    expect(list).not.toContain('"pw"');
    const [row] = await t.dbs.inWorkspace(alice, (tx) =>
      tx.select().from(mailboxes).where(eq(mailboxes.id, mb.id)),
    );
    expect(row!.credentialsEnc).toMatch(/^v1\./);
    expect(row!.credentialsEnc).not.toContain("pw");

    expect(
      (
        await as(alice).patch(`/mailboxes/${mb.id}`, {
          dailyLimit: 5,
          hourlyLimit: 2,
        })
      ).json(),
    ).toMatchObject({
      dailyLimit: 5,
      hourlyLimit: 2,
    });
    expect(
      (await as(alice).post(`/mailboxes/${mb.id}/test`)).json(),
    ).toMatchObject({ ok: true, smtp: null, imap: null });

    expect(
      (await as(bob).patch(`/mailboxes/${mb.id}`, { dailyLimit: 1 }))
        .statusCode,
    ).toBe(404);
    expect((await as(bob).post(`/mailboxes/${mb.id}/test`)).statusCode).toBe(
      404,
    );
    expect((await as(bob).del(`/mailboxes/${mb.id}`)).statusCode).toBe(404);
    expect((await as(bob).get("/mailboxes")).json()).toHaveLength(0);
    expect((await as(alice).del(`/mailboxes/${mb.id}`)).statusCode).toBe(204);
  });

  it("verifies the connection on create, validates input, and blocks private hosts when SSRF protection is on", async () => {
    const email = `x-${rand()}@orbyt-test.local`;
    const bad = await as(alice).post(
      "/mailboxes",
      mailboxBody(email, {
        smtp: {
          host: "127.0.0.1",
          port: 1,
          secure: false,
          user: email,
          password: "pw",
        },
      }),
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json().smtp).toBeTruthy();
    // verify:false saves anyway (servers may still be getting set up).
    const saved = await as(alice).post(
      "/mailboxes",
      mailboxBody(email, {
        verify: false,
        smtp: {
          host: "127.0.0.1",
          port: 1,
          secure: false,
          user: email,
          password: "pw",
        },
      }),
    );
    expect(saved.statusCode).toBe(201);
    expect(
      (await as(alice).post("/mailboxes", mailboxBody("not-an-email")))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await as(alice).post(
          "/mailboxes",
          mailboxBody(email, { dailyLimit: 0 }),
        )
      ).statusCode,
    ).toBe(400);

    process.env.ORBYT_ALLOW_PRIVATE_URLS = "false";
    try {
      const res = await as(alice).post(
        "/mailboxes",
        mailboxBody(`y-${rand()}@orbyt-test.local`, { verify: false }),
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/private/);
    } finally {
      process.env.ORBYT_ALLOW_PRIVATE_URLS = "true";
    }
  });
});

describe("sequence rules", () => {
  it("enforces compliance and sanity before a sequence can run", async () => {
    const mb = await makeMailbox(alice);
    const noFooter = await makeSequence(
      alice,
      [mb.id],
      { footer: null },
      [STEP],
      false,
    );
    const r1 = await as(alice).post(`/sequences/${noFooter.id}/activate`);
    expect(r1.statusCode).toBe(400);
    expect(r1.json().message).toMatch(/postal address/);

    const noBox = await makeSequence(alice, [], {}, [STEP], false);
    expect(
      (await as(alice).post(`/sequences/${noBox.id}/activate`)).statusCode,
    ).toBe(400);

    const post = (over: object, steps: object[] = [STEP]) =>
      as(alice).post("/sequences", { name: "x", footer: "f", steps, ...over });
    expect(
      (await post({ windowStartHour: 17, windowEndHour: 9 })).statusCode,
    ).toBe(400);
    expect((await post({ timezone: "Mars/Olympus" })).statusCode).toBe(400);
    expect((await post({}, [{ ...STEP, subject: "" }])).statusCode).toBe(400); // first step needs a subject
    expect((await post({ mailboxIds: [crypto.randomUUID()] })).statusCode).toBe(
      400,
    ); // unknown mailbox
    expect((await post({}, [])).statusCode).toBe(400);

    const bobBox = await makeMailbox(bob);
    expect((await post({ mailboxIds: [bobBox.id] })).statusCode).toBe(400); // another tenant's mailbox
  });
});

describe("sending", () => {
  it("sends step 1 with merge tags, footer and unsubscribe headers, then threads the follow-up", async () => {
    const mb = await makeMailbox(alice);
    const seq = await makeSequence(alice, [mb.id], {}, [
      STEP,
      { delayHours: 24, subject: "", body: "Just following up." },
    ]);
    const c = await makeContact(alice, "ada", "Ada Lovelace");
    expect((await enroll(alice, seq.id, c.id)).enrolled).toBe(1);

    expect(await scheduler.tick(hours(0.1))).toBe(1);
    const [first] = await waitInbox(c.email, 1);
    expect(first!.subject).toBe("Hi Ada");
    expect(first!.text).toContain("Hello Ada, quick question.");
    expect(first!.text).toContain("Acme Inc, 1 Main St, Springfield");
    expect(first!.from?.value[0]?.address).toBe(mb.email);
    const unsub = unsubUrl(first!);
    expect(unsub).toContain("/api/u/");
    expect(first!.text).toContain(unsub);
    expect(rawHeader(first!, "list-unsubscribe-post")).toBe(
      "List-Unsubscribe=One-Click",
    );

    const e1 = await enrollmentOf(alice, c.id);
    expect(e1).toMatchObject({
      currentStep: 1,
      status: "active",
      mailboxId: mb.id,
      attempts: 0,
    });
    expect(e1.nextSendAt!.getTime()).toBeGreaterThan(hours(23).getTime());
    expect(await eventTypes(alice, c.id)).toContain("sent");

    expect(await scheduler.tick(hours(1))).toBe(0); // follow-up is not due yet

    expect(await scheduler.tick(hours(25))).toBe(1);
    const all = await waitInbox(c.email, 2);
    const follow = all.find((m) => m.subject === "Re: Hi Ada")!;
    expect(follow.inReplyTo).toBe(first!.messageId);
    expect((await enrollmentOf(alice, c.id)).status).toBe("completed");
    expect(await scheduler.tick(hours(60))).toBe(0);
  });

  it("respects hourly limits and rotates across mailboxes", async () => {
    const a = await makeMailbox(alice, { hourlyLimit: 1, dailyLimit: 10 });
    const b = await makeMailbox(alice, { hourlyLimit: 1, dailyLimit: 10 });
    const seq = await makeSequence(alice, [a.id, b.id]);
    const people = [
      await makeContact(alice),
      await makeContact(alice),
      await makeContact(alice),
    ];
    await enroll(alice, seq.id, ...people.map((p) => p.id));

    expect(await scheduler.tick(hours(0.1))).toBe(2); // one per mailbox, the third has to wait
    const used = await t.dbs.inWorkspace(alice, (tx) =>
      tx
        .select({ m: messages.mailboxId })
        .from(messages)
        .where(eq(messages.direction, "out")),
    );
    const byBox = used.filter((u) => u.m === a.id || u.m === b.id);
    expect(new Set(byBox.map((u) => u.m))).toEqual(new Set([a.id, b.id]));

    const waiting = await Promise.all(
      people.map((p) => enrollmentOf(alice, p.id)),
    );
    const deferred = waiting.find((e) => e.currentStep === 0)!;
    expect(deferred.nextSendAt!.getTime()).toBeGreaterThan(
      hours(0.3).getTime(),
    );
    expect(await scheduler.tick(hours(0.5))).toBe(0); // still inside the 1-hour limit
    expect(await scheduler.tick(hours(1.3))).toBe(1); // the hour has rolled over
  });

  it("warm-up caps the daily volume of a new mailbox until it is switched off", async () => {
    const mb = await makeMailbox(alice, {
      dailyLimit: 30,
      hourlyLimit: 50,
      warmup: true,
    });
    expect(mb).toMatchObject({ warmupEnabled: true });
    const seq = await makeSequence(alice, [mb.id]);
    const people = [];
    for (let i = 0; i < 8; i++) people.push(await makeContact(alice));
    await enroll(alice, seq.id, ...people.map((p) => p.id));

    // Day one of the ramp allows 5 emails, however high the mailbox's own limit is.
    expect(await scheduler.tick(hours(0.1))).toBe(5);
    expect(await scheduler.tick(hours(0.2))).toBe(0);
    // Switching warm-up off lifts the cap to the real daily limit.
    expect(
      (await as(alice).patch(`/mailboxes/${mb.id}`, { warmup: false }))
        .statusCode,
    ).toBe(200);
    expect(await scheduler.tick(hours(0.5))).toBe(3);
  });

  it("a brand-new workspace has a low total sending cap when one is configured", async () => {
    process.env.ORBYT_NEW_TENANT_DAILY_LIMIT = "2";
    try {
      const a = await makeMailbox(alice, { dailyLimit: 10, hourlyLimit: 10 });
      const b = await makeMailbox(alice, { dailyLimit: 10, hourlyLimit: 10 });
      const seq = await makeSequence(alice, [a.id, b.id]);
      const people = [];
      for (let i = 0; i < 5; i++) people.push(await makeContact(alice));
      await enroll(alice, seq.id, ...people.map((p) => p.id));

      expect(await scheduler.tick(hours(0.1))).toBe(2); // across BOTH mailboxes
      expect(await scheduler.tick(hours(0.5))).toBe(0);
      // The cap is per rolling 24 hours: the next day it lets 2 more through.
      expect(await scheduler.tick(hours(25))).toBe(2);

      // Once the workspace is older than the grace period (here ~14 minutes) there is no cap.
      process.env.ORBYT_NEW_TENANT_DAYS = "0.01";
      expect(await scheduler.tick(hours(26))).toBe(1);
    } finally {
      delete process.env.ORBYT_NEW_TENANT_DAILY_LIMIT;
      delete process.env.ORBYT_NEW_TENANT_DAYS;
    }
  });

  it("only sends inside the sequence's window", async () => {
    const mb = await makeMailbox(alice);
    const seq = await makeSequence(alice, [mb.id], {
      windowStartHour: 9,
      windowEndHour: 17,
      sendDays: [1, 2, 3, 4, 5],
      timezone: "UTC",
    });
    const c = await makeContact(alice);
    await enroll(alice, seq.id, c.id);
    // 2030-01-05 is a Saturday: nothing goes out and the enrollment waits for Monday 09:00.
    expect(await scheduler.tick(new Date("2030-01-05T10:00:00Z"))).toBe(0);
    expect((await enrollmentOf(alice, c.id)).nextSendAt!.toISOString()).toBe(
      "2030-01-07T09:00:00.000Z",
    );
    expect(await scheduler.tick(new Date("2030-01-07T10:00:00Z"))).toBe(1);
  });

  it("never emails suppressed addresses, even if they were enrolled earlier", async () => {
    const mb = await makeMailbox(alice);
    const seq = await makeSequence(alice, [mb.id]);
    const c = await makeContact(alice);
    await enroll(alice, seq.id, c.id);
    expect(
      (await as(alice).post("/suppressions", { email: c.email.toUpperCase() }))
        .statusCode,
    ).toBe(201);
    expect(await scheduler.tick(hours(0.1))).toBe(0);
    expect((await enrollmentOf(alice, c.id)).status).toBe("unsubscribed");

    // A suppressed address is refused even though it already has an (now cancelled) enrollment.
    expect(await enroll(alice, seq.id, c.id)).toMatchObject({
      enrolled: 0,
      skipped: [{ reason: "suppressed" }],
    });
    const enrolledTwice = await makeContact(alice);
    await enroll(alice, seq.id, enrolledTwice.id);
    expect(
      (await enroll(alice, seq.id, enrolledTwice.id)).skipped[0],
    ).toMatchObject({ reason: "already_enrolled" });
    const again = await makeContact(alice);
    await as(alice).post("/suppressions", { email: again.email });
    expect((await enroll(alice, seq.id, again.id)).skipped[0]).toMatchObject({
      reason: "suppressed",
    });
    expect(
      (await enroll(alice, seq.id, crypto.randomUUID())).skipped[0],
    ).toMatchObject({ reason: "not_found" });
  });

  it("does not send for paused sequences or paused enrollments", async () => {
    const mb = await makeMailbox(alice);
    const seq = await makeSequence(alice, [mb.id]);
    const c = await makeContact(alice);
    await enroll(alice, seq.id, c.id);
    const e = await enrollmentOf(alice, c.id);
    await as(alice).patch(`/sequences/${seq.id}/enrollments/${e.id}`, {
      status: "paused",
    });
    expect(await scheduler.tick(hours(0.1))).toBe(0);
    await as(alice).patch(`/sequences/${seq.id}/enrollments/${e.id}`, {
      status: "active",
    });
    await as(alice).post(`/sequences/${seq.id}/pause`);
    expect(await scheduler.tick(hours(0.2))).toBe(0);
    await as(alice).post(`/sequences/${seq.id}/activate`);
    expect(await scheduler.tick(hours(0.3))).toBe(1);
  });
});

describe("delivery failures", () => {
  async function smtpServer(opts: { goodPassword?: string } = {}) {
    const server = new SMTPServer({
      authOptional: !opts.goodPassword,
      allowInsecureAuth: true,
      disabledCommands: ["STARTTLS"],
      onAuth(auth, _s, cb) {
        if (auth.password !== (opts.goodPassword ?? auth.password))
          return cb(new Error("Invalid login"));
        cb(null, { user: auth.username });
      },
      onRcptTo(address, _s, cb) {
        const reject = (code: number, text: string) =>
          cb(Object.assign(new Error(text), { responseCode: code }));
        if (address.address.startsWith("nouser"))
          return reject(550, "5.1.1 User unknown");
        if (address.address.startsWith("slow"))
          return reject(451, "4.3.0 Try again later");
        cb();
      },
      onData(stream, _s, cb) {
        stream.resume();
        stream.on("end", () => cb());
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    extraServers.push(server);
    return (server.server.address() as net.AddressInfo).port;
  }
  const mailboxVia = (u: typeof alice, smtpPort: number, password = "good") => {
    const email = `fail-${rand()}@orbyt-test.local`;
    return as(u)
      .post(
        "/mailboxes",
        mailboxBody(email, {
          smtp: {
            host: "127.0.0.1",
            port: smtpPort,
            secure: false,
            user: email,
            password,
          },
        }),
      )
      .then((r) => {
        expect(r.statusCode, r.body).toBe(201);
        return r.json() as { id: string; email: string };
      });
  };

  it("a refused recipient is a hard bounce: suppressed, never retried", async () => {
    const mb = await mailboxVia(alice, await smtpServer());
    const seq = await makeSequence(alice, [mb.id]);
    const c = await makeContact(alice, "nouser");
    await enroll(alice, seq.id, c.id);
    expect(await scheduler.tick(hours(0.1))).toBe(0);
    expect((await enrollmentOf(alice, c.id)).status).toBe("bounced");
    expect(await eventTypes(alice, c.id)).toContain("bounce_hard");
    const sup = await t.dbs.inWorkspace(alice, (tx) =>
      tx.select().from(suppressions).where(eq(suppressions.email, c.email)),
    );
    expect(sup[0]).toMatchObject({ reason: "hard_bounce" });
  });

  it("a temporary failure is retried with backoff, then given up on after 5 attempts", async () => {
    const mb = await mailboxVia(alice, await smtpServer());
    const seq = await makeSequence(alice, [mb.id]);
    const c = await makeContact(alice, "slow");
    await enroll(alice, seq.id, c.id);
    let now = hours(0.1);
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await scheduler.tick(now)).toBe(0);
      const e = await enrollmentOf(alice, c.id);
      expect(e).toMatchObject({ status: "active", attempts: attempt });
      expect(e.nextSendAt!.getTime()).toBeGreaterThan(now.getTime());
      now = new Date(e.nextSendAt!.getTime() + 1000);
    }
    await scheduler.tick(now);
    expect(await enrollmentOf(alice, c.id)).toMatchObject({
      status: "error",
      attempts: 5,
    });
    expect(await eventTypes(alice, c.id)).toContain("failed");
  });

  it("a rejected login parks the mailbox instead of burning through contacts", async () => {
    const mb = await mailboxVia(
      alice,
      await smtpServer({ goodPassword: "good" }),
    );
    await as(alice).patch(`/mailboxes/${mb.id}`, {
      smtp: { password: "changed-elsewhere" },
    });
    const seq = await makeSequence(alice, [mb.id]);
    const c = await makeContact(alice);
    await enroll(alice, seq.id, c.id);
    expect(await scheduler.tick(hours(0.1))).toBe(0);
    const box = (await as(alice).get("/mailboxes"))
      .json()
      .find((m: { id: string }) => m.id === mb.id);
    expect(box).toMatchObject({ status: "error" });
    expect(box.lastError).toMatch(/login|auth/i);
    const e = await enrollmentOf(alice, c.id);
    expect(e).toMatchObject({ status: "active", currentStep: 0 }); // not consumed
  });
});

describe("replies, bounces and auto-replies (IMAP)", () => {
  async function sentTo(mb: { id: string; email: string }, over: object = {}) {
    const seq = await makeSequence(alice, [mb.id], over, [
      STEP,
      { delayHours: 24, subject: "", body: "Follow up" },
    ]);
    const c = await makeContact(alice);
    await enroll(alice, seq.id, c.id);
    // Real "now": the send time must not be later than the replies the tests then deliver.
    expect(await scheduler.tick(new Date())).toBe(1);
    const [first] = await waitInbox(c.email, 1);
    return { seq, c, first: first! };
  }
  const syncNow = async (mb: { id: string }) => {
    const r = await as(alice).post("/inbox/sync", { mailboxId: mb.id });
    expect(r.statusCode).toBe(200);
    return r.json() as { processed: number; errors: unknown[] };
  };

  it("a real reply lands in the inbox thread and stops the sequence", async () => {
    const mb = await makeMailbox(alice);
    const { seq, c, first } = await sentTo(mb);
    await smtp.sendMail({
      from: c.email,
      to: mb.email,
      subject: "Re: Hi",
      text: "Sounds good, let's talk Tuesday.",
      inReplyTo: first.messageId,
      references: first.messageId,
    });
    const got = await waitFor(async () => {
      const r = await syncNow(mb);
      return r.processed > 0 ? r : false;
    }, "the reply to be synced");
    expect(got.errors).toHaveLength(0);

    const e = await enrollmentOf(alice, c.id);
    expect(e.status).toBe("replied");
    expect(await eventTypes(alice, c.id)).toContain("reply");
    expect(await scheduler.tick(hours(30))).toBe(0); // follow-up cancelled

    const convs = (
      await as(alice).get("/inbox/conversations?unread=true")
    ).json().items as {
      id: string;
      contactEmail: string;
      lastDirection: string;
      snippet: string;
    }[];
    const conv = convs.find((x) => x.contactEmail === c.email)!;
    expect(conv).toMatchObject({ lastDirection: "in" });
    expect(conv.snippet).toContain("Tuesday");
    const thread = (
      await as(alice).get(`/inbox/conversations/${conv.id}`)
    ).json();
    expect(
      thread.messages.map((m: { direction: string }) => m.direction),
    ).toEqual(["out", "in"]);

    // syncing again must not duplicate anything
    expect((await syncNow(mb)).processed).toBe(0);
    expect(
      (await as(alice).get(`/inbox/conversations/${conv.id}`)).json().messages,
    ).toHaveLength(2);

    const stats = (await as(alice).get(`/sequences/${seq.id}/stats`)).json();
    expect(stats.enrollments).toMatchObject({ replied: 1 });
    expect(stats.replyRate).toBe(1);

    // Isolation: Bob cannot read Alice's thread or see it in his inbox.
    expect(
      (await as(bob).get(`/inbox/conversations/${conv.id}`)).statusCode,
    ).toBe(404);
    expect(
      (await as(bob).get("/inbox/conversations")).json().items,
    ).toHaveLength(0);
    expect(
      (
        await as(bob).post(`/inbox/conversations/${conv.id}/reply`, {
          body: "hi",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("stopOnReply=false keeps the sequence going", async () => {
    const mb = await makeMailbox(alice);
    const { c, first } = await sentTo(mb, { stopOnReply: false });
    await smtp.sendMail({
      from: c.email,
      to: mb.email,
      subject: "Re: Hi",
      text: "ok",
      inReplyTo: first.messageId,
    });
    await waitFor(async () => (await syncNow(mb)).processed > 0, "the reply");
    expect((await enrollmentOf(alice, c.id)).status).toBe("active");
    expect(await eventTypes(alice, c.id)).toContain("reply");
  });

  it("out-of-office replies are recorded but do not stop the sequence", async () => {
    const mb = await makeMailbox(alice);
    const { c, first } = await sentTo(mb);
    await smtp.sendMail({
      from: c.email,
      to: mb.email,
      subject: "Automatic reply: Hi",
      text: "I am away until Monday.",
      inReplyTo: first.messageId,
      headers: { "Auto-Submitted": "auto-replied" },
    });
    await waitFor(
      async () => (await syncNow(mb)).processed > 0,
      "the auto-reply",
    );
    expect((await enrollmentOf(alice, c.id)).status).toBe("active");
    const types = await eventTypes(alice, c.id);
    expect(types).toContain("auto_reply");
    expect(types).not.toContain("reply");
  });

  it("a hard bounce report suppresses the address; a soft one only records the event", async () => {
    const mb = await makeMailbox(alice);
    const hard = await sentTo(mb);
    await smtp.sendMail({
      from: "mailer-daemon@mx.example.test",
      to: mb.email,
      subject: "Undelivered Mail Returned to Sender",
      text: `Final-Recipient: rfc822; ${hard.c.email}\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 user unknown`,
    });
    const soft = await sentTo(mb);
    await smtp.sendMail({
      from: "postmaster@mx.example.test",
      to: mb.email,
      subject: "Delivery Status Notification (Delay)",
      text: `Final-Recipient: rfc822; ${soft.c.email}\nStatus: 4.2.2\nmailbox full, try again later`,
    });
    await waitFor(async () => {
      await syncNow(mb);
      return (
        (await eventTypes(alice, hard.c.id)).includes("bounce_hard") &&
        (await eventTypes(alice, soft.c.id)).includes("bounce_soft")
      );
    }, "both bounce reports");

    expect((await enrollmentOf(alice, hard.c.id)).status).toBe("bounced");
    const sup = await t.dbs.inWorkspace(alice, (tx) =>
      tx
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, hard.c.email)),
    );
    expect(sup).toHaveLength(1);
    expect((await enrollmentOf(alice, soft.c.id)).status).toBe("active");
    // Bounce reports must not clutter the inbox as conversations.
    const subjects = (
      (await as(alice).get("/inbox/conversations?limit=100")).json().items as {
        subject: string;
      }[]
    ).map((x) => x.subject);
    expect(subjects.some((s) => /Undelivered|Delivery Status/.test(s))).toBe(
      false,
    );
  });

  it("unknown senders create their own conversation; the inbox paginates and can reply in-thread", async () => {
    const mb = await makeMailbox(alice);
    const strangers = [
      `s1-${rand()}@example.test`,
      `s2-${rand()}@example.test`,
      `s3-${rand()}@example.test`,
    ];
    for (const [i, s] of strangers.entries()) {
      await smtp.sendMail({
        from: s,
        to: mb.email,
        subject: `Question ${i + 1}`,
        text: `Hello ${i + 1}`,
      });
      await new Promise((r) => setTimeout(r, 25));
    }
    await waitFor(
      async () =>
        (await syncNow(mb)).processed > 0 &&
        (
          await as(alice).get(
            `/inbox/conversations?mailboxId=${mb.id}&limit=100`,
          )
        ).json().items.length >= 3,
      "3 conversations",
    );

    const q = `mailboxId=${mb.id}`;
    const p1 = (
      await as(alice).get(`/inbox/conversations?${q}&limit=2`)
    ).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (
      await as(alice).get(
        `/inbox/conversations?${q}&limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`,
      )
    ).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    const ids = [...p1.items, ...p2.items].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(3);
    expect(p1.items[0].contactId).toBeNull(); // not a CRM contact

    const target = [...p1.items, ...p2.items].find(
      (x: { subject: string }) => x.subject === "Question 2",
    );
    expect(
      (await as(alice).get(`/inbox/conversations?${q}&q=question%202`)).json()
        .items,
    ).toHaveLength(1);
    expect(
      (
        await as(alice).patch(`/inbox/conversations/${target.id}`, {
          read: true,
        })
      ).json().hasUnread,
    ).toBe(false);
    expect(
      (await as(alice).get(`/inbox/conversations?${q}&unread=true`)).json()
        .items,
    ).toHaveLength(2);

    const reply = await as(alice).post(
      `/inbox/conversations/${target.id}/reply`,
      { body: "Thanks for asking!" },
    );
    expect(reply.statusCode).toBe(201);
    const received = (await waitInbox(strangers[1]!, 1))[0]!;
    expect(received.subject).toBe("Re: Question 2");
    expect(received.text).toContain("Thanks for asking!");
    const thread = (
      await as(alice).get(`/inbox/conversations/${target.id}`)
    ).json();
    expect(received.inReplyTo).toBe(`<${thread.messages[0].messageId}>`);
    expect(
      thread.messages.map((m: { direction: string }) => m.direction),
    ).toEqual(["in", "out"]);
    expect(
      (
        await as(alice).patch(`/inbox/conversations/${target.id}`, {
          status: "closed",
        })
      ).json().status,
    ).toBe("closed");
    expect(
      (await as(alice).get(`/inbox/conversations?${q}&status=closed`)).json()
        .items,
    ).toHaveLength(1);
  });
});

describe("unsubscribe and tracking links", () => {
  it("one-click unsubscribe (RFC 8058) suppresses the contact and cancels everything; GET alone does nothing; forged links fail", async () => {
    const mb = await makeMailbox(alice);
    const seq = await makeSequence(alice, [mb.id], {}, [
      STEP,
      { delayHours: 24, subject: "", body: "More" },
    ]);
    const c = await makeContact(alice);
    await enroll(alice, seq.id, c.id);
    await scheduler.tick(hours(0.1));
    const [mail] = await waitInbox(c.email, 1);
    const url = pathOf(unsubUrl(mail!));

    const page = await t.request("GET", url);
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain('method="post"');
    expect((await enrollmentOf(alice, c.id)).status).toBe("active"); // a link pre-fetcher changed nothing

    expect((await t.request("GET", url.slice(0, -2) + "zz")).statusCode).toBe(
      404,
    );
    expect(
      (
        await t.request("POST", url.replace("/u/", "/u/x"), {
          payload: "List-Unsubscribe=One-Click",
          type: "application/x-www-form-urlencoded",
        })
      ).statusCode,
    ).toBe(404);

    const done = await t.request("POST", url, {
      payload: "List-Unsubscribe=One-Click",
      type: "application/x-www-form-urlencoded",
    });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain("unsubscribed");
    expect((await enrollmentOf(alice, c.id)).status).toBe("unsubscribed");
    expect(await eventTypes(alice, c.id)).toContain("unsubscribe");
    const sup = await t.dbs.inWorkspace(alice, (tx) =>
      tx.select().from(suppressions).where(eq(suppressions.email, c.email)),
    );
    expect(sup[0]).toMatchObject({ reason: "unsubscribe" });
    expect(await scheduler.tick(hours(30))).toBe(0);
    // Doing it twice is harmless.
    expect(
      (
        await t.request("POST", url, {
          payload: "List-Unsubscribe=One-Click",
          type: "application/x-www-form-urlencoded",
        })
      ).statusCode,
    ).toBe(200);
  });

  it("open and click tracking are opt-in, signed, and recorded", async () => {
    const mb = await makeMailbox(alice);
    const plain = await makeSequence(alice, [mb.id], {}, [
      { ...STEP, body: "See https://example.com/pricing" },
    ]);
    const tracked = await makeSequence(
      alice,
      [mb.id],
      { trackOpens: true, trackClicks: true },
      [{ ...STEP, body: "See https://example.com/pricing" }],
    );
    const c1 = await makeContact(alice);
    const c2 = await makeContact(alice);
    await enroll(alice, plain.id, c1.id);
    await enroll(alice, tracked.id, c2.id);
    await scheduler.tick(hours(0.1));
    const [m1] = await waitInbox(c1.email, 1);
    const [m2] = await waitInbox(c2.email, 1);

    expect(m1!.html).not.toContain("/api/t/"); // off by default
    expect(m1!.html).toContain('href="https://example.com/pricing"');

    const pixel = pathOf(
      /src="([^"]*\/api\/t\/o\/[^"]+)"/.exec(String(m2!.html))![1]!,
    );
    const link = pathOf(
      /href="([^"]*\/api\/t\/c\/[^"]+)"/.exec(String(m2!.html))![1]!,
    );
    const img = await t.request("GET", pixel);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/gif");
    const click = await t.request("GET", link);
    expect(click.statusCode).toBe(302);
    expect(click.headers.location).toBe("https://example.com/pricing");
    expect(await eventTypes(alice, c2.id)).toEqual(
      expect.arrayContaining(["open", "click"]),
    );
    const [clickEvent] = await t.dbs.inWorkspace(alice, (tx) =>
      tx.select().from(emailEvents).where(eq(emailEvents.contactId, c2.id)),
    );
    expect(clickEvent).toBeDefined();

    expect((await t.request("GET", pixel.slice(0, -2) + "zz")).statusCode).toBe(
      404,
    );
    expect(
      (await t.request("GET", link.replace("/t/c/", "/t/o/"))).statusCode,
    ).toBe(404); // token kind must match
  });
});

describe("sequence stats and deliverability endpoint", () => {
  it("reports enrollment status counts and event totals", async () => {
    const mb = await makeMailbox(alice);
    const seq = await makeSequence(alice, [mb.id]);
    const people = [await makeContact(alice), await makeContact(alice)];
    await enroll(alice, seq.id, ...people.map((p) => p.id));
    await scheduler.tick(hours(0.1));
    const stats = (await as(alice).get(`/sequences/${seq.id}/stats`)).json();
    expect(stats.enrollments).toEqual({ completed: 2 });
    expect(stats.events.sent).toEqual({ total: 2, unique: 2 });
    expect(stats.replyRate).toBe(0);
    expect((await as(bob).get(`/sequences/${seq.id}/stats`)).statusCode).toBe(
      404,
    );
    const list = (
      await as(alice).get(`/sequences/${seq.id}/enrollments?status=completed`)
    ).json();
    expect(list.items).toHaveLength(2);
    expect(list.items[0].email).toMatch(/@example\.test$/);
  });

  it("validates the domain before doing any lookups", async () => {
    expect(
      (await as(alice).get("/deliverability?domain=not a domain")).statusCode,
    ).toBe(400);
    expect(
      (await as(alice).get("/deliverability?domain=localhost")).statusCode,
    ).toBe(400);
    const ok = await as(alice).get("/deliverability?domain=example.invalid");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().checks.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(["SPF", "DMARC", "DKIM", "MX"]),
    );
  });
});
