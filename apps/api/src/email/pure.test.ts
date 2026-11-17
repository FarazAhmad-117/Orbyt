import { simpleParser } from "mailparser";
import { beforeAll, describe, expect, it } from "vitest";
import { checkDomain, type DnsService } from "./deliverability.controller";
import { buildEmail, mergeVars, renderTemplate, textToHtml } from "./render";
import { decryptJson, encryptJson, signToken, verifyToken } from "./secrets";
import { classify } from "./sync.service";
import {
  inWindow,
  isValidTimezone,
  nextWindowStart,
  type SendWindow,
} from "./window";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-12345";
});

describe("secrets", () => {
  it("round-trips JSON and never stores plaintext", () => {
    const enc = encryptJson({ smtpPass: "hunter2" });
    expect(enc).toMatch(/^v1\./);
    expect(enc).not.toContain("hunter2");
    expect(decryptJson(enc)).toEqual({ smtpPass: "hunter2" });
    expect(encryptJson({ a: 1 })).not.toBe(encryptJson({ a: 1 })); // fresh IV every time
  });

  it("rejects tampered or foreign ciphertext", () => {
    const [v, iv, tag, data] = encryptJson({ a: 1 }).split(".");
    const flipped = Buffer.from(data!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(() =>
      decryptJson([v, iv, tag, flipped.toString("base64url")].join(".")),
    ).toThrow();
    expect(() => decryptJson("v2.x.y.z")).toThrow(/Unsupported/);
    expect(() => decryptJson("garbage")).toThrow();
  });

  it("signs tokens and rejects any modification", () => {
    const token = signToken({ k: "u", w: "ws", em: "a@b.co" });
    expect(verifyToken(token)).toEqual({ k: "u", w: "ws", em: "a@b.co" });
    const [body, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ k: "u", w: "OTHER", em: "a@b.co" }),
    ).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyToken(`${body}.AAAA`)).toBeNull();
    expect(verifyToken("nope")).toBeNull();
  });
});

describe("rendering", () => {
  it("fills merge tags with fallbacks and never leaks a raw tag", () => {
    const vars = mergeVars(
      {
        email: "ada@x.co",
        name: "Ada Lovelace",
        phone: null,
        customFields: { plan: "pro" },
      },
      "Analytical Engines",
    );
    expect(
      renderTemplate(
        "Hi {{first_name}} {{ last_name }} at {{company}} ({{plan}})",
        vars,
      ),
    ).toBe("Hi Ada Lovelace at Analytical Engines (pro)");
    expect(renderTemplate("Hi {{ phone | there }}!", vars)).toBe("Hi there!");
    expect(renderTemplate("Hi {{missing}}!", vars)).toBe("Hi !");
    expect(
      mergeVars({ email: "x@y.z", name: null, phone: null, customFields: {} })
        .first_name,
    ).toBe("");
  });

  it("escapes HTML and linkifies URLs", () => {
    const html = textToHtml(
      "<script>alert(1)</script> see https://example.com/a?b=1&c=2\nbye",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">');
    expect(html).toContain("<br>");
  });

  it("always appends the footer and unsubscribe link; tracking only when asked", () => {
    const plain = buildEmail({
      subject: "Hello",
      body: "Body https://example.com/x",
      footer: "Acme, 1 Main St, Springfield",
      unsubscribeUrl: "https://app.test/api/u/TOKEN",
    });
    expect(plain.text).toContain("Acme, 1 Main St, Springfield");
    expect(plain.text).toContain("Unsubscribe: https://app.test/api/u/TOKEN");
    expect(plain.html).toContain("https://app.test/api/u/TOKEN");
    expect(plain.html).not.toContain("<img");

    const tracked = buildEmail({
      subject: "Hello",
      body: "Body https://example.com/x",
      footer: null,
      unsubscribeUrl: "https://app.test/api/u/TOKEN",
      rewriteLink: (u) => `https://app.test/api/t/c/${encodeURIComponent(u)}`,
      openPixelUrl: "https://app.test/api/t/o/TOK",
    });
    expect(tracked.html).toContain(
      'href="https://app.test/api/t/c/https%3A%2F%2Fexample.com%2Fx"',
    );
    expect(tracked.html).toContain('<img src="https://app.test/api/t/o/TOK"');
    // The unsubscribe link itself is never wrapped for tracking.
    expect(tracked.html).not.toContain("/api/t/c/https%3A%2F%2Fapp.test");
  });
});

describe("sending window", () => {
  const w: SendWindow = {
    timezone: "UTC",
    startHour: 9,
    endHour: 17,
    days: [1, 2, 3, 4, 5],
  };
  const at = (iso: string) => new Date(iso);

  it("is true only on allowed days between start (inclusive) and end (exclusive)", () => {
    expect(inWindow(at("2030-01-07T09:00:00Z"), w)).toBe(true); // Monday 09:00
    expect(inWindow(at("2030-01-07T16:59:00Z"), w)).toBe(true);
    expect(inWindow(at("2030-01-07T17:00:00Z"), w)).toBe(false);
    expect(inWindow(at("2030-01-07T08:59:00Z"), w)).toBe(false);
    expect(inWindow(at("2030-01-05T10:00:00Z"), w)).toBe(false); // Saturday
  });

  it("uses the sequence's timezone", () => {
    const ny: SendWindow = { ...w, timezone: "America/New_York" }; // UTC-5 in January
    expect(inWindow(at("2030-01-07T14:00:00Z"), ny)).toBe(true); // 09:00 local
    expect(inWindow(at("2030-01-07T13:00:00Z"), ny)).toBe(false); // 08:00 local
  });

  it("finds the next opening, skipping the weekend", () => {
    expect(nextWindowStart(at("2030-01-05T10:00:00Z"), w).toISOString()).toBe(
      "2030-01-07T09:00:00.000Z",
    );
    expect(nextWindowStart(at("2030-01-07T18:00:00Z"), w).toISOString()).toBe(
      "2030-01-08T09:00:00.000Z",
    );
    expect(nextWindowStart(at("2030-01-07T10:00:00Z"), w).toISOString()).toBe(
      "2030-01-07T10:00:00.000Z",
    );
  });

  it("validates IANA timezones", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
  });
});

async function parse(raw: string) {
  return simpleParser(Buffer.from(raw.replace(/\n/g, "\r\n")));
}

describe("inbound classification", () => {
  it("recognises a hard bounce (DSN) and extracts the recipient", async () => {
    const p = await parse(
      [
        "From: Mail Delivery System <mailer-daemon@mx.example.com>",
        "To: sender@orbyt.test",
        "Subject: Undelivered Mail Returned to Sender",
        "Message-ID: <dsn1@mx.example.com>",
        "",
        "Final-Recipient: rfc822; gone@example.org",
        "Action: failed",
        "Status: 5.1.1",
        "Diagnostic-Code: smtp; 550 5.1.1 user unknown",
      ].join("\n"),
    );
    const r = classify(p, "mailer-daemon@mx.example.com");
    expect(r.kind).toBe("bounce");
    expect(r.bounce).toMatchObject({
      recipient: "gone@example.org",
      hard: true,
    });
  });

  it("treats a 4.x.x status as a soft bounce", async () => {
    const p = await parse(
      [
        "From: postmaster@mx.example.com",
        "To: sender@orbyt.test",
        "Subject: Delivery Status Notification (Delay)",
        "",
        "Final-Recipient: rfc822; full@example.org",
        "Status: 4.2.2",
        "mailbox full, try again later",
      ].join("\n"),
    );
    expect(classify(p, "postmaster@mx.example.com").bounce).toMatchObject({
      recipient: "full@example.org",
      hard: false,
    });
  });

  it("flags auto-responders so they do not stop a sequence", async () => {
    const byHeader = await parse(
      [
        "From: lead@example.org",
        "To: sender@orbyt.test",
        "Subject: Re: Hi",
        "Auto-Submitted: auto-replied",
        "",
        "I am away",
      ].join("\n"),
    );
    expect(classify(byHeader, "lead@example.org").kind).toBe("auto_reply");
    const bySubject = await parse(
      [
        "From: lead@example.org",
        "To: sender@orbyt.test",
        "Subject: Out of Office: Hi",
        "",
        "Back Monday",
      ].join("\n"),
    );
    expect(classify(bySubject, "lead@example.org").kind).toBe("auto_reply");
  });

  it("treats everything else as a real reply", async () => {
    const p = await parse(
      [
        "From: lead@example.org",
        "To: sender@orbyt.test",
        "Subject: Re: Hi",
        "Auto-Submitted: no",
        "",
        "Sounds good, let's talk.",
      ].join("\n"),
    );
    expect(classify(p, "lead@example.org").kind).toBe("reply");
  });
});

class FakeDns {
  constructor(private records: Record<string, string[]>) {}
  txt = async (n: string) => this.records[`txt:${n}`] ?? [];
  mx = async (n: string) => this.records[`mx:${n}`] ?? [];
  a = async (n: string) => this.records[`a:${n}`] ?? [];
}
const byName = (checks: { name: string; status: string }[], name: string) =>
  checks.find((c) => c.name.startsWith(name))!.status;

describe("deliverability checks", () => {
  it("passes a well-configured domain", async () => {
    const dns = new FakeDns({
      "txt:ok.test": ["v=spf1 include:_spf.google.com -all"],
      "txt:_dmarc.ok.test": ["v=DMARC1; p=reject; rua=mailto:d@ok.test"],
      "txt:google._domainkey.ok.test": ["v=DKIM1; k=rsa; p=MIGf..."],
      "mx:ok.test": ["aspmx.l.google.com"],
    }) as unknown as DnsService;
    const checks = await checkDomain(dns, "ok.test", "google");
    expect(checks.map((c) => c.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
  });

  it("flags missing, duplicate, weak and monitoring-only records", async () => {
    const none = await checkDomain(
      new FakeDns({}) as unknown as DnsService,
      "bad.test",
    );
    expect(byName(none, "SPF")).toBe("fail");
    expect(byName(none, "DMARC")).toBe("fail");
    expect(byName(none, "DKIM")).toBe("info");
    expect(byName(none, "MX")).toBe("warn");

    const weak = await checkDomain(
      new FakeDns({
        "txt:weak.test": ["v=spf1 +all", "v=spf1 -all"],
        "txt:_dmarc.weak.test": ["v=DMARC1; p=none"],
        "a:weak.test.dbl.spamhaus.org": ["127.0.1.2"],
      }) as unknown as DnsService,
      "weak.test",
    );
    expect(byName(weak, "SPF")).toBe("fail"); // two records
    expect(byName(weak, "DMARC")).toBe("warn"); // p=none
    expect(byName(weak, "Blocklist")).toBe("fail");

    const open = await checkDomain(
      new FakeDns({
        "txt:open.test": ["v=spf1 +all"],
      }) as unknown as DnsService,
      "open.test",
    );
    expect(byName(open, "SPF")).toBe("warn");
  });

  it("does not claim a blocklist result when the resolver is refused", async () => {
    const checks = await checkDomain(
      new FakeDns({
        "a:x.test.dbl.spamhaus.org": ["127.255.255.254"],
      }) as unknown as DnsService,
      "x.test",
    );
    expect(byName(checks, "Blocklist")).toBe("info");
  });
});
