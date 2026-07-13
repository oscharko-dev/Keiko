import { expect, test } from "@playwright/test";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";

test("governed-assist authority is server-capped rather than fixture-projected @smoke", async ({
  page,
}) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page, {
    deploymentCeiling: "governed-assist",
  });
  await fixture.open();

  await page.getByRole("radio", { name: /Full access/u }).check();
  await expect(page.locator('[data-capped="true"]')).toHaveCount(2);
  await expect(page.getByText(/Server effective mode:/u)).toContainText("Ask for approval");
});
