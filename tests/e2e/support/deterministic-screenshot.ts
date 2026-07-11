import { createHash } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function captureDeterministically(
  page: Page,
  path: string,
  name: string,
): Promise<void> {
  const options = { animations: "disabled", caret: "hide" } as const;
  const screenshot = await page.screenshot({ ...options, path });
  const repeat = await page.screenshot(options);
  expect(sha256(repeat), `${name} deterministic screenshot`).toBe(sha256(screenshot));
}

export async function settleNativeValidation(control: Locator): Promise<void> {
  await expect(control).toBeFocused();
  expect(
    await control.evaluate(
      (element: HTMLInputElement) => !element.validity.valid && element.matches(":user-invalid"),
    ),
  ).toBe(true);
  await control.blur();
  await expect(control).not.toBeFocused();
}
