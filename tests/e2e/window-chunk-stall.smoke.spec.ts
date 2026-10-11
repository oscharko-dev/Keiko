// Window chunk stall regression smoke (dev CI run 35438847738).
//
// WebKit's network process crashed while the Chat History window's chunk was loading: every request
// in flight failed without an error event, the bundler kept the lost chunk request pending, and the
// window waited on "Loading…" until the journey timed out. A chunk request that never answers is
// that incident. The window must say it did not finish loading and offer the reload that requests
// the chunk fresh, and the reloaded workspace must open the window it restored.
//
// Tagged @smoke so every engine in the required browser lanes proves the recovery.

import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { evidenceArtifactPath, evidenceScreenshotPath } from "./support/evidence.js";
import { openChatComposer } from "./support/chat-composer.js";

test("window chunk @smoke — a chunk request that never answers offers a reload that recovers the window", async ({
  page,
}) => {
  let lost = 0;
  await page.route(/ChatHistoryPanel/u, async (route) => {
    if (lost === 0) {
      // Never answered, as in the incident: the request stays pending and no error event fires.
      lost += 1;
      return;
    }
    await route.continue();
  });

  await openChatComposer(page);

  expect(lost).toBe(1);
  await expect(page.locator("[data-window-chunk]")).toHaveCount(0);
});

// Both resources were left pending in CI4011-003; a script-only stall cannot prove recovery when
// React is also waiting for the chunk stylesheet before committing an updated fallback.
test("window chunk @smoke — pending script and stylesheet offer one reload that restores the composer", async ({
  page,
}) => {
  await dualResourceRecovery(page);
});

async function dualResourceRecovery(
  page: Page,
  capture?: () => Promise<void>,
  mode?: RecoveryMode,
): Promise<void> {
  const resources: string[] = [];
  let reloads = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document") reloads += 1;
  });
  await page.route(/ChatHistoryPanel/u, async (route) => {
    if (resources.length < 2) {
      resources.push(route.request().resourceType());
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  const historyButton = page.getByRole("button", { name: "Chat History", exact: true });
  await expect(historyButton).toBeVisible();
  if (mode) {
    // Firefox can replace the browsing context on the app's COOP-protected navigation.
    await applyRecoveryMedia(page, mode);
    await page.evaluate(
      ({ theme, highContrast }) => {
        document.documentElement.dataset.theme = theme;
        if (highContrast) document.documentElement.dataset.hc = "more";
        else delete document.documentElement.dataset.hc;
      },
      { theme: mode.theme, highContrast: mode.highContrast === true },
    );
  }
  await historyButton.click();
  const history = page.getByRole("region", { name: "Chat History — selected", exact: true });
  const reload = history.getByRole("button", {
    name: "Reload Keiko",
    exact: true,
    includeHidden: true,
  });
  const report = history.getByRole("button", {
    name: "Create error report",
    exact: true,
    includeHidden: true,
  });
  await expect(reload).toHaveCount(1);
  await expect(report).toHaveCount(1);
  await expect(reload).toBeHidden();
  await expect(report).toBeHidden();
  await expect(reload).toBeVisible({ timeout: 30_000 });
  await expect(report).toBeVisible();
  await page.mouse.move(1270, 890);
  await expect(history.locator('[data-window-chunk="stalled"]')).toHaveText(
    "This window did not finish loading.",
  );
  await expect(history.getByText("Loading...", { exact: true })).toHaveCount(0);
  await reload.focus();
  // macOS WebKit uses Safari field-only Tab navigation; Option-Tab includes buttons.
  const tab =
    process.platform === "darwin" && page.context().browser()?.browserType().name() === "webkit"
      ? "Alt+Tab"
      : "Tab";
  await page.keyboard.press(tab);
  await expect(report).toBeFocused();
  await page.keyboard.press(`Shift+${tab}`);
  await expect(reload).toBeFocused();
  if (capture) await capture();
  const beforeRecovery = reloads;
  const reloaded = page.waitForEvent("load");
  await page.keyboard.press("Enter");
  await reloaded;
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toBeVisible();

  expect(resources.sort()).toEqual(["script", "stylesheet"]);
  // Count the recovery itself, excluding initial redirect and development startup navigation.
  expect(reloads - beforeRecovery).toBe(1);
  await expect(page.locator("[data-window-chunk]")).toHaveCount(0);
}

const RECOVERY_EVIDENCE = "docs/design-system/evidence/3988";
const RECOVERY_MODES = [
  { file: "01-dark.png", theme: "dark" },
  { file: "02-light.png", theme: "light" },
  { file: "03-dark-high-contrast.png", theme: "dark", highContrast: true },
  { file: "04-light-high-contrast.png", theme: "light", highContrast: true },
  { file: "05-prefers-contrast.png", theme: "dark", contrast: "more" },
  { file: "06-forced-colors.png", theme: "dark", forcedColors: "active" },
  { file: "07-reduced-motion.png", theme: "dark", reducedMotion: "reduce" },
] as const;
interface RecoveryMode {
  readonly file: string;
  readonly theme: "dark" | "light";
  readonly highContrast?: boolean;
  readonly contrast?: "more";
  readonly forcedColors?: "active";
  readonly reducedMotion?: "reduce";
}
interface RecoveryAppearance {
  readonly theme: string | undefined;
  readonly highContrast: boolean;
  readonly contrast: boolean;
  readonly forcedColors: boolean;
  readonly reducedMotion: boolean;
}
interface RecoveryCapture {
  readonly file: string;
  readonly screenshotSha256: string;
  readonly mode: RecoveryMode;
  readonly appearance: RecoveryAppearance;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly focusedControl: string;
  readonly seriousOrCriticalAxeViolations: number;
  readonly violationIds: readonly string[];
}
// Capture results are output-only: every test owns its page, inputs and assertions independently.
const recoveryCaptures: RecoveryCapture[] = [];
for (const mode of RECOVERY_MODES) {
  test(`window chunk @smoke — recovery fidelity ${mode.file}`, async ({ page }) => {
    await prepareRecoveryMode(page, mode);
    let capture: RecoveryCapture | undefined;
    await dualResourceRecovery(
      page,
      async () => {
        capture = await captureRecovery(page, mode);
      },
      mode,
    );
    if (!capture) throw new TypeError("Recovery capture did not complete");
    recoveryCaptures.push(capture);
  });
}

test.afterAll(() => {
  if (recoveryCaptures.length === 0) return;
  const proof = {
    issue: 3988,
    finding: "CI4011-003",
    verdict: recoveryCaptures.length === RECOVERY_MODES.length ? "PASS" : "INCOMPLETE",
    harness: "tests/e2e/window-chunk-stall.smoke.spec.ts",
    browser: test.info().project.name,
    node: process.version,
    sources: {
      fallback: recoverySourceHash(
        "packages/keiko-ui/src/app/components/desktop/widgets/WindowChunkFallback.tsx",
      ),
      harness: recoverySourceHash("tests/e2e/window-chunk-stall.smoke.spec.ts"),
      globalsCss: recoverySourceHash("packages/keiko-ui/src/app/globals.css"),
    },
    captures: recoveryCaptures,
    scope: "Existing loading/stalled recovery and inherited button styles; no new component family",
  };
  for (const file of ["window-chunk-recovery-fidelity-proof.json", "a11y-proof.json"]) {
    writeFileSync(
      evidenceArtifactPath(`${RECOVERY_EVIDENCE}/${file}`),
      `${JSON.stringify(proof, null, 2)}\n`,
    );
  }
});

function recoverySourceHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function prepareRecoveryMode(page: Page, mode: RecoveryMode): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await applyRecoveryMedia(page, mode);
  await page.addInitScript(
    ({ theme, highContrast }) => {
      window.localStorage.setItem("keiko.theme", theme);
      document.documentElement.dataset.theme = theme;
      if (highContrast) document.documentElement.dataset.hc = "more";
    },
    { theme: mode.theme, highContrast: mode.highContrast === true },
  );
}

async function applyRecoveryMedia(page: Page, mode: RecoveryMode): Promise<void> {
  await page.emulateMedia({
    colorScheme: mode.theme,
    contrast: mode.contrast ?? "no-preference",
    forcedColors: mode.forcedColors ?? "none",
    reducedMotion: mode.reducedMotion ?? "no-preference",
  });
}

async function captureRecovery(page: Page, mode: RecoveryMode): Promise<RecoveryCapture> {
  const history = page.getByRole("region", { name: "Chat History — selected", exact: true });
  const appearance = await recoveryAppearance(page, mode);
  const selector = 'section.window:has([data-window-chunk="stalled"])';
  const violations = await runAxe(page, selector);
  const blocking = seriousOrCritical(violations);
  expect(blocking, formatViolations(violations)).toEqual([]);
  const screenshot = evidenceScreenshotPath(`${RECOVERY_EVIDENCE}/${mode.file}`);
  await history.screenshot({ path: screenshot });
  const focusedControl = await page.evaluate(() => document.activeElement?.textContent);
  expect(focusedControl).toBe("Reload Keiko");
  return {
    file: mode.file,
    screenshotSha256: recoverySourceHash(screenshot),
    mode,
    appearance,
    viewport: { width: 1280, height: 900 },
    focusedControl: focusedControl ?? "",
    seriousOrCriticalAxeViolations: blocking.length,
    violationIds: violations.map((violation) => violation.id),
  };
}

async function recoveryAppearance(page: Page, mode: RecoveryMode): Promise<RecoveryAppearance> {
  const appearance = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    highContrast: document.documentElement.dataset.hc === "more",
    contrast: window.matchMedia("(prefers-contrast: more)").matches,
    forcedColors: window.matchMedia("(forced-colors: active)").matches,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  expect(appearance.theme).toBe(mode.theme);
  expect(appearance.highContrast).toBe(mode.highContrast === true);
  expect(appearance.contrast).toBe(mode.contrast === "more");
  expect(appearance.forcedColors).toBe(mode.forcedColors === "active");
  expect(appearance.reducedMotion).toBe(mode.reducedMotion === "reduce");
  return appearance;
}
