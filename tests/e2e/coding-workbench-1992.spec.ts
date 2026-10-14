import { expect } from "@playwright/test";
import { test } from "./support/smoke-test.js";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";

test("live pending approval exposes bounded facts and one-time decision controls @smoke", async ({
  page,
}) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page, {
    initialState: "awaiting-approval",
  });
  await fixture.open();

  // #3907 (owner: less is more): the card names the action and states a high risk up front; the
  // bounded facts stay one click away in its details. Each closed-union fact is rendered through
  // the catalog, so the assertion pins the localized label ("Push"/"High") rather than the
  // contract slug the screen used to leak untranslated. `scopeLabel` is free server text and keeps
  // its literal.
  await expect(page.getByRole("heading", { name: "Push" })).toBeVisible();
  await expect(page.getByText("Approval required · Risk: High", { exact: true })).toBeVisible();
  await page.getByText("Details", { exact: true }).click();
  const facts = page.getByLabel("Approval facts");
  await expect(facts.getByText("Push", { exact: true })).toBeVisible();
  await expect(facts.getByText("workspace-scope", { exact: true })).toBeVisible();
  await expect(facts.getByText("High", { exact: true })).toBeVisible();
  // No untranslated closed-union slug reaches this screen (the free-text `reasonCode` fact keeps
  // its server literal), and no raw diff, credential or path ever does.
  await expect(page.getByText(/^(push|high)$/u)).toHaveCount(0);
  await expect(page.getByText(/diff --git|Bearer|access token|\/Users\//u)).toHaveCount(0);
  await expect.poll(fixture.editorSnapshotRegistrationCount).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Approve once" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "running");
  expect(fixture.approvalDecisionCount()).toBe(1);
  fixture.assertValidRequests();
});
