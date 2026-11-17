import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "correct horse battery staple";
const WEB = "http://localhost:3200";
const rand = () => Math.random().toString(36).slice(2, 8);
const unique = () => `e2e-${Date.now()}-${rand()}@example.test`;

async function signUp(page: Page, name: string, email = unique()) {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
  return {
    email,
    workspaceId: /\/app\/([0-9a-f-]{36})\//.exec(page.url())![1]!,
  };
}

test("invitations: send a link, the invitee signs up with it and joins the workspace", async ({
  page,
  browser,
}) => {
  const owner = await signUp(page, "Owner");
  const invitee = unique();

  await page.getByRole("link", { name: "Settings" }).click();
  await page.locator("#inv-email").fill(invitee);
  await page.locator("#inv-role").selectOption("member");
  await page.getByRole("button", { name: "Send invitation" }).click();
  const link = await page.getByTestId("invite-link").innerText();
  expect(link).toContain("/accept-invite?token=");
  // The pending invitation is listed (and could be revoked).
  await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();

  // The invitee opens the link in their own browser.
  const ctx = await browser.newContext({ baseURL: WEB });
  const guest = await ctx.newPage();
  await guest.goto(link);
  await expect(guest.getByText("You were invited as member.")).toBeVisible();
  await expect(guest.getByText(invitee).first()).toBeVisible();

  // No account yet: sign up (the ?next= keeps them on the invitation afterwards).
  await guest.getByRole("link", { name: "Create an account" }).click();
  await guest.getByLabel("Name").fill("Guest");
  await guest.getByLabel("Email").fill(invitee);
  await guest.getByLabel("Password").fill(PASSWORD);
  await guest.getByRole("button", { name: "Create account" }).click();
  await guest.getByRole("button", { name: "Join Default" }).click();
  await expect(guest).toHaveURL(
    new RegExp(`/app/${owner.workspaceId}/contacts`),
  );
  await expect(guest.getByRole("heading", { name: "Contacts" })).toBeVisible();

  // The link works once.
  await guest.goto(link);
  await expect(guest.getByRole("alert").first()).toContainText(
    "not valid any more",
  );

  // The owner now sees them on the team.
  await page.reload();
  await expect(page.getByText(invitee).first()).toBeVisible();
  await ctx.close();
});

test("an invitation for another email address cannot be used by the wrong account", async ({
  page,
  browser,
}) => {
  await signUp(page, "Owner");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.locator("#inv-email").fill(unique());
  await page.getByRole("button", { name: "Send invitation" }).click();
  const link = await page.getByTestId("invite-link").innerText();

  const ctx = await browser.newContext({ baseURL: WEB });
  const other = await ctx.newPage();
  await signUp(other, "Someone else");
  await other.goto(link);
  await expect(other.getByText("this invitation is for")).toBeVisible();
  await expect(other.getByRole("button", { name: /^Join/ })).toHaveCount(0);
  await ctx.close();
});

test("forms: create one, submit it from 'another website', see the lead and the contact", async ({
  page,
}) => {
  await signUp(page, "Forms owner");
  await page.getByRole("link", { name: "Forms" }).click();
  await page.locator("#form-title").fill("Contact us");
  await page.locator("#form-tags").fill("lead, website");
  await page.getByRole("button", { name: "Create form" }).click();

  const embed = await page.getByTestId("embed-html").innerText();
  expect(embed).toContain(`<form method="post" action="${WEB}/api/forms/`);
  const url = /action="([^"]+)"/.exec(embed)![1]!;

  // A visitor submits through the public endpoint (no session needed).
  const submit = await page.request.post(url, {
    data: { email: "visitor@example.com", name: "Vera", message: "Hello!" },
  });
  expect(submit.ok()).toBe(true);
  expect(await submit.json()).toMatchObject({ ok: true });

  // A plain HTML form post works too and answers with a page.
  const html = await page.request.post(url, {
    form: { email: "html-visitor@example.com", message: "Hi from a <form>" },
    headers: { accept: "text/html" },
  });
  expect(html.ok()).toBe(true);
  expect(await html.text()).toContain("Thank you");

  await page.reload();
  await page.getByRole("button", { name: "Contact us" }).click();
  await expect(page.getByText("2 submission(s)")).toBeVisible();
  await expect(
    page.getByText("html-visitor@example.com").first(),
  ).toBeVisible();

  await page.getByRole("link", { name: "Contacts" }).click();
  await expect(
    page.getByRole("link", { name: "visitor@example.com", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("website").first()).toBeVisible();
});

test("knowledge base and chat agents", async ({ page }) => {
  const { workspaceId } = await signUp(page, "Kb owner");
  await page.getByRole("link", { name: "Knowledge" }).click();
  await expect(
    page.getByRole("heading", { name: "Knowledge & chat" }),
  ).toBeVisible();

  await page.locator("#kb-title").fill("Opening hours");
  await page.locator("#kb-body").fill("We are open 9 to 5 on weekdays.");
  await page.getByRole("button", { name: "Add document" }).click();
  await expect(page.getByText(/^\d+ characters$/)).toBeVisible();

  await page.locator("#ag-name").fill("Support");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByText("/api/chat/").first()).toBeVisible();

  // Asking needs an AI provider; without one the app says so instead of failing silently.
  await page.getByLabel("Question").fill("When are you open?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(
    page.getByText(/Connect an AI provider in Settings first/),
  ).toBeVisible();

  // The agent's public endpoint is reachable through the web origin.
  const agents = await page.request.get(`/api/w/${workspaceId}/chat-agents`);
  const [agent] = (await agents.json()) as { url: string }[];
  const info = await page.request.get(agent!.url);
  expect(await info.json()).toMatchObject({ name: "Support" });
});

test("import from GoHighLevel: contacts, then opportunities", async ({
  page,
}) => {
  await signUp(page, "Importer");
  await page.getByRole("link", { name: "Settings" }).click();

  await page.locator("#ghl-contacts").setInputFiles({
    name: "ghl-contacts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Contact Id,First Name,Last Name,Business Name,Phone,Email,Tags\n" +
        '1,Ada,Lovelace,Analytical Engines,+44 20,ada@example.com,"vip, london"\n' +
        "2,Grace,Hopper,,,grace@example.com,navy\n",
    ),
  });
  await expect(page.getByTestId("import-result")).toContainText("2 created");

  await page.locator("#ghl-opps").setInputFiles({
    name: "ghl-opps.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Opportunity Name,Contact Name,email,pipeline,stage,Lead Value,status\n" +
        'Website redesign,Ada Lovelace,ada@example.com,Sales,Proposal,"$5,000.00",open\n',
    ),
  });
  await expect(page.getByTestId("import-result")).toContainText(
    "Imported opportunities",
  );

  await page.getByRole("link", { name: "Contacts" }).click();
  await expect(
    page.getByRole("link", { name: "ada@example.com" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Deals" }).click();
  await expect(page.getByText("Website redesign")).toBeVisible();
});

test("workflow templates: start from one and land in the builder", async ({
  page,
}) => {
  await signUp(page, "Templates");
  await page.getByRole("link", { name: "Workflows" }).click();
  await page.getByRole("button", { name: "New workflow" }).click();
  await expect(page.getByText("Or start from a template")).toBeVisible();
  // The first template is "Welcome new contacts".
  await page.getByRole("button", { name: "Use this template" }).first().click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Workflow name")).toHaveValue(
    "Welcome new contacts",
  );
  // The trigger and its two steps are on the canvas.
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
});

test("webhook workflows: the URL is shown, and it only listens once activated", async ({
  page,
}) => {
  const { workspaceId } = await signUp(page, "Hooks");
  await page.getByRole("link", { name: "Workflows" }).click();
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Name", { exact: true }).fill("From outside");
  await page.locator("#wf-trigger").selectOption("webhook");
  await page.getByRole("button", { name: "Create and open editor" }).click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);

  const shown = page.getByText(/POST .*\/api\/hooks\//);
  await expect(shown).toBeVisible();
  const url = /POST (\S+)/.exec(await shown.innerText())![1]!;
  expect(url).toContain(`/api/hooks/${workspaceId}/workflows/`);

  // A draft workflow does not listen yet.
  const early = await page.request.post(url, {
    data: { email: "x@example.com" },
  });
  expect(early.status()).toBe(404);
});
