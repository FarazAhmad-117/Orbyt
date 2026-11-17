import { expect, test, type Page } from "@playwright/test";

const rand = () => Math.random().toString(36).slice(2, 8);

/** Connects two canvas nodes by dragging from a source handle to a target handle with real mouse moves. */
async function connect(page: Page, from: string, to: string) {
  const handle = async (nodeId: string, kind: "source" | "target") => {
    const box = await page
      .locator(
        `.react-flow__node[data-id="${nodeId}"] .react-flow__handle.${kind}`,
      )
      .first()
      .boundingBox();
    if (!box) throw new Error(`No ${kind} handle on ${nodeId}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const a = await handle(from, "source");
  const b = await handle(to, "target");
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 8 });
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

test("workflow builder: edit a step on the canvas, save, activate, run, and see the effect", async ({
  page,
}) => {
  // Sign up
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Wes");
  await page
    .getByLabel("Email")
    .fill(`e2e-${Date.now()}-${rand()}@example.test`);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
  const workspaceId = /\/app\/([0-9a-f-]{36})\//.exec(page.url())![1];
  const api = `/api/w/${workspaceId}`;

  // A contact to run against.
  const leadEmail = `lead-${rand()}@example.test`;
  const contact = await (
    await page.request.post(`${api}/contacts`, {
      data: { email: leadEmail, name: "Lena" },
    })
  ).json();

  // Create the workflow through the UI (new workflow -> editor opens).
  await page.getByRole("link", { name: "Workflows" }).click();
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Name").fill("Welcome flow");
  await page.locator("#wf-trigger").selectOption("manual");
  await page.getByRole("button", { name: "Create and open editor" }).click();
  await expect(page.getByLabel("Workflow canvas")).toBeVisible();
  await expect(page.getByLabel("Workflow name")).toHaveValue("Welcome flow");

  // Add a tag step; its settings open; type the tags. Saving without connecting it is rejected.
  await page.getByRole("button", { name: "Tag contact" }).click();
  await page
    .getByLabel("Add tags (comma separated)")
    .fill("from-workflow, vip");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("ul[role=alert]")).toContainText("not reachable");

  // Connect trigger -> tag by dragging between the handles.
  await connect(page, "trigger", "tag_1");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Workflow saved")).toBeVisible();
  await expect(page.locator("ul[role=alert]")).toHaveCount(0);

  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText("active", { exact: true })).toBeVisible();

  // Run it for the contact from the UI; the engine picks it up and completes it.
  await page.getByLabel("Contact email to run for").fill(leadEmail);
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Run started")).toBeVisible();
  await expect(
    page.getByText("completed", { exact: true }).first(),
  ).toBeVisible({ timeout: 30_000 });

  // Starting a run opens it: its steps and outputs are visible.
  await expect(page.getByLabel("Run steps")).toContainText("tag_1");

  // The effect landed on the contact.
  const tags = (
    (await (await page.request.get(`${api}/contacts/${contact.id}`)).json())
      .tags as { name: string }[]
  )
    .map((t) => t.name)
    .sort();
  expect(tags).toEqual(["from-workflow", "vip"]);

  // Invalid config is reported by the server, not swallowed.
  await page.getByRole("button", { name: "Enroll in sequence" }).click();
  await page.waitForTimeout(400); // the canvas re-fits around the new step
  await connect(page, "trigger", "enroll_sequence_2");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Validation failed")).toBeVisible();
});
