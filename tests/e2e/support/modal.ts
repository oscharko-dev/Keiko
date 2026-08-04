import { expect, type Locator, type Page } from "@playwright/test";

export async function expectViewportModal(page: Page, dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  const directlyPortaled = await dialog.evaluate(
    (element) => element.parentElement === document.body,
  );
  const backdrop = directlyPortaled ? dialog : dialog.locator("..");
  const dialogSurface = directlyPortaled ? dialog.locator(":scope > section").first() : dialog;
  await expect(backdrop).toBeVisible();
  await expect(dialogSurface).toBeVisible();
  await expect(page.locator(".stage")).toHaveAttribute("inert", "");
  await expect(page.locator(".stage")).toHaveAttribute("aria-hidden", "true");
  await expect
    .poll(() =>
      dialog.evaluate(
        (element) =>
          element.parentElement === document.body ||
          element.parentElement?.parentElement === document.body,
      ),
    )
    .toBe(true);

  const viewport = page.viewportSize();
  const bounds = await backdrop.boundingBox();
  const dialogBounds = await dialogSurface.boundingBox();
  expect(viewport).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(dialogBounds).not.toBeNull();
  if (viewport !== null && bounds !== null && dialogBounds !== null) {
    expect(Math.abs(bounds.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.width - viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.height - viewport.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(dialogBounds.x + dialogBounds.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(Math.abs(dialogBounds.y + dialogBounds.height / 2 - viewport.height / 2)).toBeLessThan(
      2,
    );
  }
}
