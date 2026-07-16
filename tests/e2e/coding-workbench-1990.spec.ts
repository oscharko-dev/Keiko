import { expect, test } from "@playwright/test";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";

test("opens a live Coding Workbench and starts a server-bound run @smoke", async ({ page }) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page);
  await fixture.open();

  await expect(page.getByText("task-2257 · issue/2257-live-runtime · healthy")).toBeVisible();
  await expect(page.getByText(/Server effective mode:/u)).toContainText("Ask for approval");
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
