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
  // The bounded facts stay visible; each closed-union fact is rendered through the catalog, so the
  // assertion pins the localized label ("Push"/"High") rather than the contract slug the screen
  // used to leak untranslated. `scopeLabel` is free server text and keeps its literal.
  await expect(page.getByText("Push", { exact: true })).toBeVisible();
  await expect(page.getByText("workspace-scope", { exact: true })).toBeVisible();
  await expect(page.getByText("High", { exact: true })).toBeVisible();
  // No untranslated closed-union slug reaches this screen (the free-text `reasonCode` fact keeps
  // its server literal), and no raw diff, credential or path ever does.
  await expect(page.getByText(/^(push|high)$/u)).toHaveCount(0);
  await expect(page.getByText(/diff --git|Bearer|access token|\/Users\//u)).toHaveCount(0);
  await page.getByRole("button", { name: "Approve once" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "running");
});
