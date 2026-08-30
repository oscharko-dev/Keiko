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
  // WebKit can leave DOM focus on a window after a newer window has moved above it. Calling
  // focus() on that already-focused section is then a no-op, so React receives no focus event and
  // cannot raise it. Move focus through a real keyboard-reachable chrome control: this exercises
  // the same onFocusCapture path as Tab navigation without clicking covered content or starting a
  // drag gesture.
  await frame.focus();
  await frame.locator(".win-traffic button").first().focus();
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
