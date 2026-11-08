import assert from "node:assert/strict";
import { expect } from "@playwright/test";

function supportedLocale(locale) {
  assert.ok(locale === "en" || locale === "de", "Unsupported limit-run UI language");
  return locale;
}

async function foregroundWindow(page) {
  const windows = page.locator('section.window[data-top="true"]');
  assert.equal(await windows.count(), 1, "One foreground window must own the language change");
  return windows.getAttribute("data-window-id");
}

async function restoreForeground(page, id) {
  if (id === null) return;
  const escaped = await page.evaluate((value) => globalThis.CSS.escape(value), id);
  const previous = page.locator(`section.window[data-window-id=${escaped}]`);
  if ((await previous.count()) === 1) await previous.click({ position: { x: 12, y: 12 } });
}

function guardLanguageChange(ctx, restoring) {
  if (!restoring) ctx.signal.throwIfAborted();
}

async function cleanupSettings(page, settings, existed, previous) {
  try {
    if (!existed && (await settings.count()) === 1) {
      await settings
        .getByRole("button", {
          name: /^(Close Settings window|Einstellungen-Fenster schließen)$/u,
          exact: true,
        })
        .click();
    }
  } finally {
    await restoreForeground(page, previous);
  }
}

async function applyLanguage(ctx, locale, restoring) {
  guardLanguageChange(ctx, restoring);
  const { page } = ctx;
  const html = page.locator("html");
  const current = supportedLocale(await html.getAttribute("lang"));
  if (current === locale) {
    ctx.locale = locale;
    return;
  }
  const previous = await foregroundWindow(page);
  const settings = page.locator("section.window").filter({ has: page.locator(".set") });
  const existed = (await settings.count()) !== 0;
  try {
    await page
      .getByRole("button", { name: /^(Settings|Einstellungen)$/u, exact: true })
      .first()
      .click();
    await expect(settings).toHaveCount(1);
    await settings.getByRole("button", { name: /^(General|Allgemein)$/u, exact: true }).click();
    guardLanguageChange(ctx, restoring);
    await settings.locator('[role="combobox"][aria-describedby="settings-language-help"]').click();
    guardLanguageChange(ctx, restoring);
    await page
      .getByRole("option", { name: locale === "en" ? "English" : "Deutsch", exact: true })
      .click();
    await expect(html).toHaveAttribute("lang", locale);
    ctx.locale = locale;
  } finally {
    await cleanupSettings(page, settings, existed, previous);
  }
}

/** Change the ordinary Settings control; never rewrite browser storage or reload a running turn. */
export async function changeLimitUiLanguage(ctx, locale) {
  supportedLocale(locale);
  await applyLanguage(ctx, locale, false);
}

/** Existing upload/turn owners use English controls; restore UI ownership even after cancellation. */
export async function withEnglishLimitUi(ctx, run) {
  ctx.signal.throwIfAborted();
  const original = supportedLocale(await ctx.page.locator("html").getAttribute("lang"));
  const previous = await foregroundWindow(ctx.page);
  try {
    await changeLimitUiLanguage(ctx, "en");
    return await run();
  } finally {
    try {
      // This cleanup changes only the local Settings control; it never resumes cancelled work.
      await applyLanguage(ctx, original, true);
    } finally {
      await restoreForeground(ctx.page, previous);
    }
  }
}
