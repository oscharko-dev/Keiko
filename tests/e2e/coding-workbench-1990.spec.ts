import { expect, test } from "@playwright/test";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";

test("opens a live Coding Workbench and starts a server-bound run @smoke", async ({ page }) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page);
  await fixture.open();

  await expect(page.getByText("task-2257 · issue/2257-live-runtime · healthy")).toBeVisible();
  // #2386 changed the workbench default from full access to the supervised middle mode. #2644 moved
  // the selector into Settings, so the Workbench now reports the server-confirmed effective mode in
  // its session context bar instead of owning the control.
  await expect(fixture.workbench.locator("[data-mode]")).toHaveAttribute(
    "data-mode",
    "supervised-coding",
  );
  await expect(fixture.workbench.locator("[data-mode]")).toContainText("Supervised workspace");
  await page.getByLabel("Task instructions").fill("Investigate a failing test");
  await page.getByRole("button", { name: "Start coding run" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "awaiting-approval");
});

test("live ready workbench has no serious axe violations at narrow width @smoke", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 860 });
  const fixture = await installLiveCodingWorkbenchRuntime(page);
  await fixture.open();

  expect(await fixture.workbench.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(
    true,
  );
  const violations = seriousOrCritical(
    await runAxe(page, 'section[aria-label="Coding Workbench"][data-state]'),
  );
  expect(violations.length, formatViolations(violations)).toBe(0);
});
