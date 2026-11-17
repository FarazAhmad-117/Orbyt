import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "correct horse battery staple";
const unique = () =>
  `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function signUp(page: Page, name: string) {
  const email = `${unique()}@example.test`;
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
  return email;
}

test("anonymous visitors are sent to sign in", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("sign up, sign out, wrong password rejected, sign back in", async ({
  page,
}) => {
  const email = await signUp(page, "Eve");
  await expect(page).toHaveURL(/\/app\/[0-9a-f-]{36}\/contacts/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
});

test("contacts: create, search, detail with note/task/timeline, import/export, delete", async ({
  page,
}) => {
  await signUp(page, "Carl");

  await page.getByRole("button", { name: "Add contact" }).click();
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Tags (comma separated)").fill("vip, lead");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("link", { name: "ada@example.com" }),
  ).toBeVisible();
  await expect(page.getByText("vip")).toBeVisible();

  // CSV import (upsert + new row), then search.
  await page.getByLabel("Import CSV").setInputFiles({
    name: "contacts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "email,name\nada@example.com,Ada L.\ngrace@example.com,Grace Hopper\n",
    ),
  });
  await expect(
    page.getByText("Imported: 1 new, 1 updated, 0 errors"),
  ).toBeVisible();
  await page.getByLabel("Search contacts").fill("grace");
  await expect(
    page.getByRole("link", { name: "grace@example.com" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "ada@example.com" })).toHaveCount(
    0,
  );
  await page.getByLabel("Search contacts").fill("");

  // Export returns a CSV with both contacts (uses the session cookie).
  const exp = await page.request.get(
    (await page
      .getByRole("link", { name: "Export CSV" })
      .getAttribute("href")) as string,
  );
  expect(exp.headers()["content-type"]).toContain("text/csv");
  const csv = await exp.text();
  expect(csv).toContain("grace@example.com");
  expect(csv).toContain("ada@example.com");

  // Detail page.
  await page.getByRole("link", { name: "ada@example.com" }).click();
  await page.getByLabel("New note").fill("Met at the conference");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Met at the conference")).toBeVisible();
  await page.getByLabel("New task").fill("Send proposal");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Send proposal")).toBeVisible();
  await expect(page.getByText("note.added")).toBeVisible();
  await expect(page.getByText("contact.created").first()).toBeVisible();

  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
  await expect(page.getByRole("link", { name: "ada@example.com" })).toHaveCount(
    0,
  );
});

test("deals: default pipeline, add, move across stages, mark won", async ({
  page,
}) => {
  await signUp(page, "Dana");
  await page.getByRole("link", { name: "Deals" }).click();
  await page
    .getByRole("button", { name: "Create a default sales pipeline" })
    .click();
  await expect(page.getByTestId("stage-Lead")).toBeVisible();

  await page.getByLabel("Deal title").fill("Website redesign");
  await page.getByLabel("Deal value").fill("1500");
  await page.getByRole("button", { name: "Add deal" }).click();
  await expect(
    page.getByTestId("stage-Lead").getByText("Website redesign"),
  ).toBeVisible();
  await expect(
    page.getByTestId("stage-Lead").getByText("$1,500.00"),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Move Website redesign forward" })
    .click();
  await expect(
    page.getByTestId("stage-Qualified").getByText("Website redesign"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Won", exact: true }).click();
  await expect(
    page.getByTestId("stage-Qualified").getByText("won"),
  ).toBeVisible();
});

test("tasks: add and complete", async ({ page }) => {
  await signUp(page, "Tess");
  await page.getByRole("link", { name: "Tasks" }).click();
  await page.getByLabel("New task").fill("Book demo");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Book demo")).toBeVisible();
  await page.getByLabel("Complete Book demo").check();
  await expect(page.getByText("Book demo")).toHaveCount(0);
});

test("settings: an API key works through the web proxy and stops working once revoked", async ({
  page,
}) => {
  await signUp(page, "Kim");
  const workspaceId = /\/app\/([0-9a-f-]{36})\//.exec(page.url())![1];
  await page.getByRole("link", { name: "Settings" }).click();

  await page.getByLabel("API key name").fill("e2e key");
  await page.getByRole("button", { name: "Create key" }).click();
  const key = await page.getByTestId("secret").innerText();
  expect(key).toMatch(/^orbyt_/);

  const url = `/api/w/${workspaceId}/contacts`;
  const headers = { authorization: `Bearer ${key}` };
  // A fresh request context has no cookies: only the key authenticates it.
  const ok = await page
    .context()
    .browser()!
    .newContext({ baseURL: "http://localhost:3200" });
  expect((await ok.request.get(url, { headers })).status()).toBe(200);
  expect((await ok.request.get(url)).status()).toBe(401);

  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("e2e key")).toHaveCount(0);
  expect((await ok.request.get(url, { headers })).status()).toBe(401);
  await ok.close();
});

test("two users never see each other's data", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await signUp(a, "Alice");
  await signUp(b, "Bob");
  await a.getByRole("button", { name: "Add contact" }).click();
  await a.getByLabel("Email").fill("only-alice@example.com");
  await a.getByRole("button", { name: "Save" }).click();
  await expect(
    a.getByRole("link", { name: "only-alice@example.com" }),
  ).toBeVisible();

  await b.reload();
  await expect(b.getByText("No contacts yet.")).toBeVisible();

  // Bob opening Alice's workspace URL gets nothing.
  const aliceWorkspace = /\/app\/([0-9a-f-]{36})\//.exec(a.url())![1];
  const res = await b.request.get(`/api/w/${aliceWorkspace}/contacts`);
  expect(res.status()).toBe(404);
});

test("agency mode: create a client workspace and switch between workspaces", async ({
  page,
}) => {
  await signUp(page, "Agnes");
  await page.getByRole("button", { name: "Add contact" }).click();
  await page.getByLabel("Email").fill("in-default@example.com");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("link", { name: "in-default@example.com" }),
  ).toBeVisible();

  page.once("dialog", (d) => void d.accept("Client Acme"));
  await page.getByRole("button", { name: "New workspace" }).click();
  await expect(page.getByLabel("Workspace")).toContainText("Client Acme");
  // The new workspace starts empty: data is per workspace.
  await expect(page.getByText("No contacts yet.")).toBeVisible();

  // Team management lives in Settings; the owner is listed as an admin.
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("admin", { exact: true })).toBeVisible();

  // Switching back shows the original contact.
  await page.getByLabel("Workspace").selectOption({ label: "Default" });
  await page.getByRole("link", { name: "Contacts" }).click();
  await expect(
    page.getByRole("link", { name: "in-default@example.com" }),
  ).toBeVisible();
});
