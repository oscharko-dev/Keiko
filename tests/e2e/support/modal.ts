import { expect, type Locator, type Page } from "@playwright/test";

export async function expectViewportModal(page: Page, dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  const backdrop = dialog.locator("..");
  await expect(backdrop).toBeVisible();
  await expect(page.locator(".stage")).toHaveAttribute("inert", "");
  await expect(page.locator(".stage")).toHaveAttribute("aria-hidden", "true");
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.parentElement?.parentElement === document.body),
    )
    .toBe(true);

  const viewport = page.viewportSize();
  const bounds = await backdrop.boundingBox();
  expect(viewport).not.toBeNull();
  expect(bounds).not.toBeNull();
  if (viewport !== null && bounds !== null) {
    expect(Math.abs(bounds.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.width - viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.height - viewport.height)).toBeLessThanOrEqual(1);
  }
}
