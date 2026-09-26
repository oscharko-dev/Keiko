// Interacting with a DESKTOP WINDOW's own chrome (its close/minimise/maximise buttons).
//
// Why this exists: Keiko's desktop surface stacks overlapping windows, and a window's chrome button
// is only clickable when that window is on top. A spec that opens window A, then opens window B on
// top of it, and then clicks A's close button is asking for a click that a real user could not make
// either — they would activate A first. Chromium happened to lay the cascade out so the button
// stayed uncovered and the click landed; Firefox lays it out slightly differently (engines measure
// the available viewport differently, scrollbar reservation included) and the same click times out
// with `<section class="window" aria-label="Editor — …"> subtree intercepts pointer events`.
//
// That is a REAL difference between engines, not a Firefox bug and not a product defect — window
// stacking works exactly as designed in both. The defect was in the specs: they modelled a user
// interaction that skipped activation. This helper performs the activation the product already
// implements (`WindowFrame`'s `onFocusCapture` raises a non-top window, audit C061 / WCAG 2.4.11)
// and then clicks, so the same journey passes on any engine without weakening a single assertion.
import { expect, type Locator } from "@playwright/test";

function desktopWindowFrame(windowRegion: Locator): Locator {
  // A title such as "Problems" can label both the desktop window and a nested product region. Keep
  // the caller's semantic locator, but intersect it with the product's own window-frame contract so
  // strict mode never has to guess which of the two should receive focus.
  return windowRegion.and(
    windowRegion.page().locator('[data-window-id][aria-roledescription="window"]'),
  );
}

async function activateFrame(frame: Locator): Promise<void> {
  await expect(frame).toHaveCount(1);
  // Raise the window the way a pointer press does, through the frame's own `onPointerDown`.
  // `dispatchEvent` rather than `click` on purpose: the window we need to raise is by
  // definition the covered one, so a real click would be intercepted by whatever sits above it,
  // and a click somewhere in the window body could select a tree row or start a drag. This
  // dispatches on the frame element itself, which is exactly what the product listens to.
  //
  // Not `focus()` any more: focus that a window's own content or a test takes is no longer a
  // raise signal (WindowFrame's onFocusCapture now raises only on keyboard navigation), because a
  // still-loading window that grabbed focus used to raise itself over the window the user had
  // moved to.
  await frame.dispatchEvent("pointerdown", { button: 0, isPrimary: true });
  await frame.focus();
  await expect(frame).toHaveAttribute("data-top", "true");
}

/**
 * Brings `windowRegion` to the front and waits until the product has actually raised it.
 *
 * Focus, not a synthetic click: `WindowFrame` raises on `onFocusCapture`, and moving focus through
 * its window chrome cannot select a tree row, start a drag, or trip a connect gesture the way a
 * click somewhere in the window body might.
 */
export async function activateWindow(windowRegion: Locator): Promise<void> {
  await activateFrame(desktopWindowFrame(windowRegion));
}

/**
 * Clicks a chrome button (e.g. `Close Files window`) on `windowRegion`, activating the window
 * first. Use this instead of clicking the button directly whenever another window may have been
 * opened on top since this one was last touched.
 */
export async function clickWindowChromeButton(
  windowRegion: Locator,
  buttonName: string,
): Promise<void> {
  const frame = desktopWindowFrame(windowRegion);
  await activateFrame(frame);
  await frame.getByRole("button", { name: buttonName }).click();
}
