import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { evidenceScreenshotPath } from "./support/evidence.js";

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "design-system", "evidence", "3187");
const RECOVERY_KEY = "keiko.app-boot-recovery-reload-count";

const MODES = [
  { file: "01-dark.png", theme: "dark", highContrast: false, forcedColors: "none", width: 1280 },
  { file: "02-light.png", theme: "light", highContrast: false, forcedColors: "none", width: 1280 },
  {
    file: "03-dark-high-contrast.png",
    theme: "dark",
    highContrast: true,
    forcedColors: "none",
    width: 1280,
  },
  {
    file: "04-forced-colors.png",
    theme: "dark",
    highContrast: false,
    forcedColors: "active",
    width: 1280,
  },
  {
    file: "05-responsive.png",
    theme: "light",
    highContrast: false,
    forcedColors: "none",
    width: 320,
  },
] as const;

type Mode = (typeof MODES)[number];

interface Capture {
  readonly file: string;
  readonly theme: string;
  readonly highContrast: boolean;
  readonly forcedColors: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly focusedControl: string | null;
  readonly seriousOrCriticalAxeViolations: number;
}

function sourceHash(path: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(REPO_ROOT, path)))
    .digest("hex");
}

function outputPath(file: string): string {
  const tracked = resolve(EVIDENCE_DIR, file);
  if (process.env.KEIKO_WRITE_TRACKED_EVIDENCE === "1") return tracked;
  const redirected = resolve(
    REPO_ROOT,
    "test-results",
    "e2e-evidence",
    relative(REPO_ROOT, tracked),
  );
  mkdirSync(dirname(redirected), { recursive: true });
  return redirected;
}

async function prepareRecovery(page: Page, mode: Mode): Promise<void> {
  await page.setViewportSize({ width: mode.width, height: 900 });
  await page.emulateMedia({
    colorScheme: mode.theme,
    contrast: mode.highContrast ? "more" : "no-preference",
    forcedColors: mode.forcedColors,
  });
  await page.addInitScript(
    ({ recoveryKey, theme, highContrast }) => {
      window.sessionStorage.setItem(recoveryKey, "2");
      window.localStorage.setItem("keiko.theme", theme);
      if (highContrast) document.documentElement.dataset.hc = "more";
    },
    { recoveryKey: RECOVERY_KEY, theme: mode.theme, highContrast: mode.highContrast },
  );
  await page.route("**/_next/static/**/*.js", (route) => route.abort());
}

async function expectRecovery(page: Page): Promise<void> {
  const alert = page.locator(".app:not([aria-hidden]) [role='alert']");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Keiko could not reach the local service.");
  await expect(alert.getByRole("button", { name: "Reload Keiko" })).toBeFocused();
  await expect(page.locator(".app-boot-logo")).toHaveCount(0);
}

async function capture(page: Page, mode: Mode): Promise<Capture> {
  const violations = await runAxe(page, ".app:not([aria-hidden])");
  const blocking = seriousOrCritical(violations);
  expect(blocking, formatViolations(violations)).toEqual([]);
  await page.screenshot({
    path: evidenceScreenshotPath(relative(REPO_ROOT, resolve(EVIDENCE_DIR, mode.file))),
  });
  return {
    file: mode.file,
    theme: mode.theme,
    highContrast: mode.highContrast,
    forcedColors: mode.forcedColors,
    viewport: { width: mode.width, height: 900 },
    focusedControl: await page.evaluate(() => document.activeElement?.textContent ?? null),
    seriousOrCriticalAxeViolations: blocking.length,
  };
}

function writeEvidence(captures: readonly Capture[]): void {
  const common = {
    issue: 3187,
    verdict: "PASS",
    harness: "tests/e2e/boot-recovery-3187.spec.ts",
    globalsCssSha256: sourceHash("packages/keiko-ui/src/app/globals.css"),
    layoutSha256: sourceHash("packages/keiko-ui/src/app/layout.tsx"),
    captures,
  };
  writeFileSync(
    outputPath("boot-recovery-fidelity-proof.json"),
    `${JSON.stringify(common, null, 2)}\n`,
  );
  writeFileSync(
    outputPath("a11y-proof.json"),
    `${JSON.stringify({ ...common, proofType: "browser-capture-plus-axe-core" }, null, 2)}\n`,
  );
}

test("Issue #3187 exposes an accessible boot recovery after watchdog exhaustion", async ({
  browser,
}) => {
  const captures: Capture[] = [];
  for (const mode of MODES) {
    const page = await browser.newPage();
    await prepareRecovery(page, mode);
    await page.goto("/");
    await expectRecovery(page);
    captures.push(await capture(page, mode));
    if (mode.file === "01-dark.png") {
      await page.getByRole("button", { name: "Reload Keiko" }).click();
      await expectRecovery(page);
    }
    await page.close();
  }
  writeEvidence(captures);
});
