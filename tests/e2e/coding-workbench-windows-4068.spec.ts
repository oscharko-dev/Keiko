import { expect, test, type Page } from "@playwright/test";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";
import { editorM11PairingFragment } from "./support/editor-m11-app-session.js";

// #4068: what a person meets in the Coding Workbench on Windows. The broker confines only a new
// Keiko-managed worktree, so the Workbench offers that location alone, and a start the broker
// cannot confine names what to change instead of failing inside the runtime. The composer draft
// must also survive a reload against the real draft route, which had refused the Workbench's
// actual window id.

const WORK_IN = "Work in";

async function openWorkbenchLauncher(page: Page): Promise<void> {
  const launcher = page.getByRole("button", { name: "Coding Workbench", exact: true });
  await expect(launcher).toBeVisible();
  await expect(async () => {
    if ((await launcher.getAttribute("aria-pressed")) !== "true") await launcher.click();
    await expect(launcher).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Coding Workbench", exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

test("offers only a new worktree where the runtime confines no checkout @smoke", async ({
  page,
}) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page, {
    executionLocations: ["worktree"],
  });
  await fixture.open();

  const location = fixture.workbench.getByRole("combobox", { name: WORK_IN });
  await expect(location).toContainText("New local worktree");
  await expect(location).toBeDisabled();
  fixture.assertValidRequests();
});

test("keeps both work locations where the runtime names none @smoke", async ({ page }) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page);
  await fixture.open();

  const location = fixture.workbench.getByRole("combobox", { name: WORK_IN });
  await expect(location).toBeEnabled();
  await location.click();
  const menu = page.getByRole("listbox", { name: WORK_IN });
  await expect(menu.getByRole("option", { name: "Local", exact: true })).toBeVisible();
  await expect(menu.getByRole("option", { name: "New local worktree", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  fixture.assertValidRequests();
});

for (const refusal of [
  {
    code: "CODING_RUNTIME_WORKSPACE_LOCATION_UNSUPPORTED",
    sentence: "Keiko runs a coding task only in a new worktree, not in your own checkout or folder",
  },
  {
    code: "CODING_RUNTIME_WORKSPACE_VOLUME_UNSUPPORTED",
    sentence: "An operator must set KEIKO_STATE_DIR to a folder on the Windows drive",
  },
] as const) {
  test(`names what to change when Windows refuses a start with ${refusal.code} @smoke`, async ({
    page,
  }) => {
    const fixture = await installLiveCodingWorkbenchRuntime(page, {
      executionLocations: ["worktree"],
      startRefusalCode: refusal.code,
    });
    await fixture.open();
    await page.getByLabel("Task instructions").fill("Investigate a failing test");
    await page.getByRole("button", { name: "Start coding run" }).click();

    await expect(fixture.workbench.getByText(refusal.sentence)).toBeVisible();
    await expect(fixture.workbench.getByText(refusal.sentence)).toContainText(refusal.code);
    // The refusal comes before any run exists, and the typed task is kept for the corrected start.
    await expect(fixture.workbench).toHaveAttribute("data-state", "idle");
    await expect(page.getByLabel("Task instructions")).toHaveValue("Investigate a failing test");
    fixture.assertValidRequests();
  });
}

test("restores the unsent task text after a reload through the real draft route @smoke", async ({
  page,
}) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page);
  await page.goto(`/${editorM11PairingFragment("coding-workbench-draft-4068")}`);
  await expect.poll(() => page.url()).not.toContain("keiko-app-session");
  await openWorkbenchLauncher(page);

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname.startsWith("/api/coding-workbench/drafts/"),
  );
  await page.getByLabel("Task instructions").fill("Investigate the flaky import");
  expect((await saved).status()).toBe(200);

  const restored = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.startsWith("/api/coding-workbench/drafts/"),
  );
  await page.reload();
  expect((await restored).status()).toBe(200);
  await expect(page.getByLabel("Task instructions")).toHaveValue("Investigate the flaky import");
  fixture.assertValidRequests();
});
