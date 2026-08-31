import { expect, test, type Page } from "@playwright/test";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";

async function dropFirstWorkbenchLauncherClick(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const dropFirstClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('button[aria-label="Coding Workbench"]') === null) return;
      document.removeEventListener("click", dropFirstClick, true);
      document.documentElement.dataset.e2eDroppedWorkbenchLauncherClick = "true";
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("click", dropFirstClick, true);
  });
}

test("stop, recovery acknowledgement, and fresh retry follow server lifecycle truth @smoke", async ({
  page,
}) => {
  // Run 33404765910 observed a completed cold WebKit click with the toggle still closed. Drop that
  // first action deterministically so this journey proves the shared opener retries conditionally.
  await dropFirstWorkbenchLauncherClick(page);
  const fixture = await installLiveCodingWorkbenchRuntime(page, { initialState: "running" });
  await fixture.open();
  await expect(page.locator("html")).toHaveAttribute(
    "data-e2e-dropped-workbench-launcher-click",
    "true",
  );

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

  // #2644 moved the mode control into Settings → Security. Full access is genuinely granted here:
  // the ceiling allows it, so nothing is capped and the Workbench must run at that authority.
  await fixture.requestMode(/Full access/u);
  await expect(fixture.autonomySettings.locator('[data-capped="true"]')).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Full access/u })).toBeChecked();
  await page.getByRole("button", { name: "Close Settings window" }).click();
  await expect(fixture.workbench.locator("[data-mode]")).toHaveAttribute(
    "data-mode",
    "autonomous-delivery",
  );
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
