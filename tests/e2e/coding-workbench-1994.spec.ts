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
