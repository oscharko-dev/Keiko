// Expected browser-smoke patch shape for the `browser-smoke` style: a minimal Playwright happy-path
// smoke test that navigates to the route and asserts one key user-visible element is visible. Placed
// under the project's end-to-end test directory. Not an exhaustive suite.
import { expect, test } from "@playwright/test";

test("home page shows the welcome heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
});
