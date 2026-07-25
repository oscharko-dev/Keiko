import { expect, test } from "@playwright/test";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";

test("governed-assist authority is server-capped rather than fixture-projected @smoke", async ({
  page,
}) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page, {
    deploymentCeiling: "governed-assist",
  });
  await fixture.open();

  // #2644 moved the modes into Settings → Security. The ceiling stays visible at the options it
  // bounds, before the request is made, not only as an after-the-fact clamp notice.
  await fixture.requestMode(/Full access/u);
  await expect(fixture.autonomySettings.locator('[data-capped="true"]')).toHaveCount(2);
  await expect(fixture.autonomySettings.getByRole("status")).toContainText("Ask for approval");

  // The widening request is accepted by the control and refused by the server: the Workbench must
  // report the clamped effective mode, never the locally requested one.
  await page.getByRole("button", { name: "Close Settings window" }).click();
  await expect(fixture.workbench.locator("[data-mode]")).toHaveAttribute(
    "data-mode",
    "governed-assist",
  );
  await expect(fixture.workbench.locator("[data-mode]")).toContainText("Ask for approval");
  fixture.assertValidRequests();
});
