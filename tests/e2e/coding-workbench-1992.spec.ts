import { expect, test } from "@playwright/test";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";

test("live pending approval exposes bounded facts and one-time decision controls @smoke", async ({
  page,
}) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page, {
    initialState: "awaiting-approval",
  });
  await fixture.open();

  await expect(page.getByRole("heading", { name: "Review the bounded action" })).toBeVisible();
  await expect(page.getByText("push", { exact: true })).toBeVisible();
  await expect(page.getByText("workspace-scope", { exact: true })).toBeVisible();
  await expect(page.getByText("high", { exact: true })).toBeVisible();
  await expect(page.getByText(/diff --git|Bearer|access token|\/Users\//u)).toHaveCount(0);
  await page.getByRole("button", { name: "Approve once" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "running");
});
