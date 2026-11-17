import { expect, test, type Page } from "@playwright/test";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";

// Needs the GreenMail test server: docker compose --profile test up -d mail
const SMTP = Number(process.env.MAIL_SMTP_PORT ?? 3025);
const IMAP = Number(process.env.MAIL_IMAP_PORT ?? 3143);
const rand = () => Math.random().toString(36).slice(2, 8);

async function inbox(address: string): Promise<ParsedMail[]> {
  const c = new ImapFlow({
    host: "127.0.0.1",
    port: IMAP,
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

async function signUp(page: Page) {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Mia");
  await page
    .getByLabel("Email")
    .fill(`e2e-${Date.now()}-${rand()}@example.test`);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
}

test("connect a mailbox, run a sequence, receive and answer a reply", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sender = `e2e-sender-${rand()}@orbyt-test.local`;
  const lead = `e2e-lead-${rand()}@example.test`;
  await signUp(page);

  // 1. Contact
  await page.getByRole("button", { name: "Add contact" }).click();
  await page.getByLabel("Email").fill(lead);
  await page.getByLabel("Name", { exact: true }).fill("Lee Lead");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("link", { name: lead })).toBeVisible();

  // 2. Mailbox (the form tests the SMTP and IMAP logins before saving)
  await page.getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("button", { name: "Connect mailbox" }).click();
  await page.getByLabel("Email address").fill(sender);
  await page.locator("#smtp-host").fill("127.0.0.1");
  await page.locator("#smtp-port").fill(String(SMTP));
  await page.locator("#smtp-pass").fill("x");
  await page.locator("#imap-host").fill("127.0.0.1");
  await page.locator("#imap-port").fill(String(IMAP));
  await page.locator("#imap-pass").fill("x");
  await page.locator('input[name="imapSecure"]').uncheck();
  await page.getByRole("button", { name: "Test and save" }).click();
  await expect(page.getByText(sender)).toBeVisible();

  // 3. Deliverability checker renders results for a domain
  await page.getByLabel("Domain").fill("example.invalid");
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByLabel("Results for example.invalid")).toContainText(
    "SPF",
  );

  // 4. Sequence: open window all day, every day, so the test does not depend on the clock
  await page.getByRole("link", { name: "Sequences" }).click();
  await page.getByRole("button", { name: "New sequence" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Intro");
  await page.getByLabel("Timezone").fill("UTC");
  await page.getByLabel("Send from hour").fill("0");
  await page.getByLabel("Until hour").fill("24");
  await page.getByLabel("Sat").check();
  await page.getByLabel("Sun").check();
  await page.getByLabel("Subject").first().fill("Hello {{first_name}}");
  await page.getByLabel("Email 1").fill("Hi {{first_name}}, can we talk?");
  await page
    .getByLabel(/Footer with your postal address/)
    .fill("Acme Inc, 1 Main St, Springfield");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Intro", { exact: true })).toBeVisible();

  // Activating needs the compliance footer; it is set, so this works.
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText("active", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Enroll", exact: true }).click();
  await page.getByLabel(/Contact emails/).fill(lead);
  await page.getByRole("button", { name: "Enroll contacts" }).click();
  await expect(page.getByText(/Enrolled 1/)).toBeVisible();

  // 5. The live scheduler sends it; the lead's mailbox receives personalised mail with a footer.
  await expect
    .poll(async () => (await inbox(lead)).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const [mail] = await inbox(lead);
  expect(mail!.subject).toBe("Hello Lee");
  expect(mail!.text).toContain("Hi Lee, can we talk?");
  expect(mail!.text).toContain("Acme Inc, 1 Main St, Springfield");
  expect(mail!.text).toContain("/api/u/");

  await page.getByRole("button", { name: "Stats" }).click();
  await expect(page.getByLabel("Sequence stats")).toContainText("Sent");

  // 6. The lead answers; the sync loop files it in the Inbox and cancels the sequence.
  await nodemailer
    .createTransport({ host: "127.0.0.1", port: SMTP, secure: false })
    .sendMail({
      from: lead,
      to: sender,
      subject: "Re: Hello Lee",
      text: "Yes, Thursday works for me.",
      inReplyTo: mail!.messageId,
      references: mail!.messageId,
    });
  await page.getByRole("link", { name: "Inbox" }).click();
  const row = page.getByRole("button", { name: new RegExp(lead) });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("Thursday works for me", { timeout: 20_000 });
  await row.click();
  await expect(
    page.getByRole("article").filter({ hasText: "Thursday works for me" }),
  ).toBeVisible();

  // 7. Answer from the Inbox; it goes out threaded.
  await page.getByLabel("Reply").fill("Great, see you Thursday at 10.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("Reply sent")).toBeVisible();
  await expect
    .poll(async () => (await inbox(lead)).length, { timeout: 30_000 })
    .toBe(2);
  const answer = (await inbox(lead)).find(
    (m) => m.subject === "Re: Hello Lee",
  )!;
  expect(answer.text).toContain("see you Thursday at 10");
  expect(answer.inReplyTo).toBeTruthy();

  // 8. The reply stopped the sequence: stats show it.
  await page.getByRole("link", { name: "Sequences" }).click();
  await page.getByRole("button", { name: "Stats" }).click();
  await expect(page.getByLabel("Sequence stats")).toContainText("1 replied", {
    timeout: 20_000,
  });
});
