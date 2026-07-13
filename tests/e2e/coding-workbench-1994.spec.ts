import { expect, test } from "@playwright/test";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";

test("stop, recovery acknowledgement, and fresh retry follow server lifecycle truth @smoke", async ({
  page,
}) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page, { initialState: "running" });
  await fixture.open();

  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "recovery-required");
  await expect(page.getByRole("button", { name: "Acknowledge recovery" })).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge recovery" }).click();
  await expect(page.getByRole("button", { name: "Retry as a fresh run" })).toBeVisible();
  await page.getByLabel("Task instructions").fill("Retry safely");
  await page.getByRole("button", { name: "Retry as a fresh run" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "running");
});

test("autonomous closeout narrow viewport has no horizontal overflow @smoke", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 860 });
  const fixture = await installLiveCodingWorkbenchRuntime(page, {
    deploymentCeiling: "autonomous-delivery",
  });
  await fixture.open();

  const fullAccess = page.getByRole("radio", { name: /Full access/u });
  await fullAccess.check();
  await expect(fullAccess).toBeChecked();
  await page.getByLabel("Task instructions").fill("Close out the autonomous run safely");
  await page.getByRole("button", { name: "Start coding run" }).click();
  await page.getByRole("button", { name: "Approve once" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "running");
  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "recovery-required");

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    ),
  ).toBe(false);
  expect(await fixture.workbench.evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(
    false,
  );
  await expect(page.getByRole("button", { name: "Acknowledge recovery" })).toBeVisible();
  fixture.assertValidRequests();
});
