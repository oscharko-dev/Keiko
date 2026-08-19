import { expect, test, type Browser, type Locator, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { evidenceScreenshotPath } from "./support/evidence.js";
import { formatViolations, runAxe, seriousOrCritical, type AxeViolation } from "./support/axe.js";

// Issue #3185 — prove that a failed Health Scan refresh clears the previous
// health claim before offering keyboard-operable retry. The shell and Health
// Scan component are real; only the health-scan BFF GET is deterministic.

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "design-system", "evidence", "3185");
const APP_ORIGIN = `http://127.0.0.1:${process.env.KEIKO_E2E_UI_PORT ?? "32183"}`;
const PLAYWRIGHT_PLAN_COMMAND =
  "npx playwright test tests/e2e/health-scan-3185.spec.ts --config tests/e2e/config/playwright.config.ts --project=chromium";

const SCREENSHOT_ARTIFACTS = [
  "01-dark-success.png",
  "02-light-rate-limited.png",
  "03-dark-high-contrast-rate-limited.png",
  "04-forced-colors-rate-limited.png",
  "05-responsive-rate-limited.png",
] as const;
const JSON_ARTIFACTS = [
  "health-scan-refresh-fidelity-proof.json",
  "a11y-proof.json",
  "manifest.json",
] as const;
const ARTIFACTS = [...SCREENSHOT_ARTIFACTS, ...JSON_ARTIFACTS] as const;

type ScreenshotArtifact = (typeof SCREENSHOT_ARTIFACTS)[number];
type JsonArtifact = (typeof JSON_ARTIFACTS)[number];
type Artifact = (typeof ARTIFACTS)[number];
type RoutePhase = "initial-success" | "rate-limited" | "recovery-success";

interface HealthScanRouteLedger {
  initialSuccess: number;
  rateLimited: number;
  recoverySuccess: number;
}

interface EvidenceMode {
  readonly file: ScreenshotArtifact;
  readonly label: string;
  readonly theme: "dark" | "light";
  readonly highContrast: boolean;
  readonly media: {
    readonly colorScheme: "dark" | "light";
    readonly contrast?: "more";
    readonly forcedColors?: "active";
  };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly expectedPhase: RoutePhase;
}

interface CaptureRecord {
  readonly file: ScreenshotArtifact;
  readonly mode: string;
  readonly phase: RoutePhase;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly dataTheme: string | null;
  readonly dataHc: string | null;
  readonly forcedColors: boolean;
  readonly alertVisible: boolean;
  readonly retryKeyboardOperable: boolean;
  readonly findingsCountVisible: boolean;
  readonly seriousOrCriticalAxeViolations: readonly AxeViolation[];
}

const INITIAL_RESULT = {
  findings: [
    {
      id: "health-scan-fixture-initial",
      kind: "orphan-memory",
      memories: [{ memoryId: "mem-health-fixture-1", type: "preference", status: "accepted" }],
      reason: "Deterministic initial health-scan fixture.",
      detectedAt: 1_700_000_000_000,
    },
  ],
  recordsInspected: 42,
  truncated: false,
};

const RECOVERY_RESULT = {
  findings: [
    {
      id: "health-scan-fixture-recovery",
      kind: "dangling-review-item",
      memories: [
        { memoryId: "mem-health-fixture-2", type: "decision", status: "proposed" },
        { memoryId: "mem-health-fixture-3", type: "correction", status: "conflicted" },
      ],
      reason: "Deterministic recovery health-scan fixture.",
      detectedAt: 1_700_000_005_000,
    },
  ],
  recordsInspected: 43,
  truncated: false,
};

const RATE_LIMITED_BODY = {
  error: {
    code: "HEALTH_SCAN_RATE_LIMITED",
    message: "Health scan was run too recently; please wait before retrying.",
  },
};

const EVIDENCE_MODES: readonly EvidenceMode[] = [
  {
    file: "01-dark-success.png",
    label: "dark",
    theme: "dark",
    highContrast: false,
    media: { colorScheme: "dark" },
    viewport: { width: 1280, height: 860 },
    expectedPhase: "initial-success",
  },
  {
    file: "02-light-rate-limited.png",
    label: "light",
    theme: "light",
    highContrast: false,
    media: { colorScheme: "light" },
    viewport: { width: 1280, height: 860 },
    expectedPhase: "rate-limited",
  },
  {
    file: "03-dark-high-contrast-rate-limited.png",
    label: "dark-high-contrast",
    theme: "dark",
    highContrast: true,
    media: { colorScheme: "dark", contrast: "more" },
    viewport: { width: 1280, height: 860 },
    expectedPhase: "rate-limited",
  },
  {
    file: "04-forced-colors-rate-limited.png",
    label: "forced-colors",
    theme: "dark",
    highContrast: false,
    media: { colorScheme: "dark", forcedColors: "active" },
    viewport: { width: 1280, height: 860 },
    expectedPhase: "rate-limited",
  },
  {
    file: "05-responsive-rate-limited.png",
    label: "responsive-mobile",
    theme: "light",
    highContrast: false,
    media: { colorScheme: "light" },
    viewport: { width: 540, height: 760 },
    expectedPhase: "rate-limited",
  },
];

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #3185 evidence directory is not a real directory");
  }
}

function artifactPath(name: Artifact): string {
  const path = resolve(EVIDENCE_DIR, name);
  const relativePath = relative(EVIDENCE_DIR, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Issue #3185 evidence artifact escaped its directory");
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("Issue #3185 evidence artifact path is a symlink");
  }
  return path;
}

function screenshotPath(name: ScreenshotArtifact): string {
  return evidenceScreenshotPath(relative(REPO_ROOT, artifactPath(name)));
}

function outputArtifactPath(name: JsonArtifact): string {
  if (process.env.KEIKO_WRITE_TRACKED_EVIDENCE === "1") return artifactPath(name);
  const redirected = resolve(
    REPO_ROOT,
    "test-results",
    "e2e-evidence",
    "design-system",
    "evidence",
    "3185",
    name,
  );
  mkdirSync(dirname(redirected), { recursive: true });
  return redirected;
}

function writeJsonArtifact(name: JsonArtifact, value: unknown): void {
  writeFileSync(outputArtifactPath(name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cssSha256(): string {
  return createHash("sha256")
    .update(readFileSync(resolve(REPO_ROOT, "packages", "keiko-ui", "src", "app", "globals.css")))
    .digest("hex");
}

function createRouteLedger(): HealthScanRouteLedger {
  return { initialSuccess: 0, rateLimited: 0, recoverySuccess: 0 };
}

async function fulfillHealthScan(route: Route, phase: RoutePhase): Promise<void> {
  switch (phase) {
    case "initial-success":
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(INITIAL_RESULT),
      });
      return;
    case "rate-limited":
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify(RATE_LIMITED_BODY),
      });
      return;
    case "recovery-success":
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(RECOVERY_RESULT),
      });
  }
}

async function installHealthScanRoute(page: Page): Promise<{
  readonly ledger: HealthScanRouteLedger;
  getPhase: () => RoutePhase;
  setPhase: (next: RoutePhase) => void;
}> {
  let phase: RoutePhase = "initial-success";
  const ledger = createRouteLedger();
  await page.route("**/api/memory/health-scan", async (route) => {
    if (phase === "initial-success") ledger.initialSuccess += 1;
    if (phase === "rate-limited") ledger.rateLimited += 1;
    if (phase === "recovery-success") ledger.recoverySuccess += 1;
    await fulfillHealthScan(route, phase);
  });
  return { ledger, getPhase: () => phase, setPhase: (next) => (phase = next) };
}

async function seedTheme(page: Page, mode: EvidenceMode): Promise<void> {
  await page.addInitScript((theme) => {
    window.localStorage.setItem("keiko.theme", theme);
    window.localStorage.removeItem("keiko.conns.v1");
  }, mode.theme);
}

async function applyMode(page: Page, mode: EvidenceMode): Promise<void> {
  await page.setViewportSize(mode.viewport);
  await page.emulateMedia(mode.media);
  await page.evaluate((highContrast) => {
    if (highContrast) document.documentElement.dataset.hc = "more";
    else document.documentElement.removeAttribute("data-hc");
  }, mode.highContrast);
}

async function openHealthScan(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "MemoriaViva" }).click();
  const window = page.getByRole("region", { name: "MemoriaViva", exact: true });
  await expect(window).toBeVisible();
  await window.getByRole("button", { name: "Health scan" }).click();
  await expect(window.getByRole("heading", { name: "Health scan" })).toBeVisible();
  return window;
}

async function expectInitialSuccess(window: Locator): Promise<void> {
  await expect(window.getByText("1 findings", { exact: true })).toBeVisible();
  await expect(window.getByText("Orphan memory", { exact: true })).toBeVisible();
}

async function expectRateLimitedError(window: Locator): Promise<Locator> {
  const alert = window.getByRole("alert");
  await expect(alert).toContainText("HEALTH_SCAN_RATE_LIMITED");
  await expect(window.getByText("1 findings", { exact: true })).toHaveCount(0);
  await expect(window.getByText("Orphan memory", { exact: true })).toHaveCount(0);
  const retry = alert.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  return retry;
}

async function enterRefreshError(
  page: Page,
  route: { readonly setPhase: (next: RoutePhase) => void },
): Promise<Locator> {
  const window = await openHealthScan(page);
  await expectInitialSuccess(window);
  await window.getByRole("button", { name: "Back to MemoriaViva" }).click();
  await expect(window.getByRole("heading", { name: "MemoriaViva" })).toBeVisible();
  route.setPhase("rate-limited");
  await window.getByRole("button", { name: "Health scan" }).click();
  await expect(window.getByRole("heading", { name: "Health scan" })).toBeVisible();
  await expectRateLimitedError(window);
  return window;
}

async function captureRecord(
  page: Page,
  window: Locator,
  mode: EvidenceMode,
): Promise<CaptureRecord> {
  const alert = window.getByRole("alert");
  const retry = alert.getByRole("button", { name: "Retry" });
  await window.screenshot({
    path: screenshotPath(mode.file),
    animations: "disabled",
    caret: "hide",
  });
  const violations = await runAxe(page, '[aria-label="Memory health scan findings"]');
  return {
    file: mode.file,
    mode: mode.label,
    phase: mode.expectedPhase,
    viewport: mode.viewport,
    dataTheme: await page.evaluate(() => document.documentElement.getAttribute("data-theme")),
    dataHc: await page.evaluate(() => document.documentElement.getAttribute("data-hc")),
    forcedColors: await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
    alertVisible: await alert.isVisible(),
    retryKeyboardOperable: (await retry.isVisible()) && (await retry.isEnabled()),
    findingsCountVisible: await window
      .getByText("1 findings", { exact: true })
      .isVisible()
      .catch(() => false),
    seriousOrCriticalAxeViolations: seriousOrCritical(violations),
  };
}

async function openEvidencePage(
  browser: Browser,
  mode: EvidenceMode,
): Promise<{
  readonly page: Page;
  readonly close: () => Promise<void>;
  readonly route: Awaited<ReturnType<typeof installHealthScanRoute>>;
}> {
  const context = await browser.newContext({ bypassCSP: true, viewport: mode.viewport });
  const page = await context.newPage();
  const route = await installHealthScanRoute(page);
  await seedTheme(page, mode);
  await page.goto(APP_ORIGIN);
  await applyMode(page, mode);
  return { page, close: () => context.close(), route };
}

function writeFidelityProof(
  captures: readonly CaptureRecord[],
  ledgers: readonly HealthScanRouteLedger[],
  generatedAt: string,
  globalsCssSha256: string,
  laterSuccessReplacesError: boolean,
): void {
  writeJsonArtifact("health-scan-refresh-fidelity-proof.json", {
    issue: 3185,
    epic: 3179,
    verdict: "PASS",
    generatedAt,
    harness: "tests/e2e/config/playwright.config.ts",
    route: "/",
    appPath: "dev-runner-ui",
    globalsCssSha256,
    captures,
    assertions: {
      refreshClearsPreviousFindingsCount: true,
      rateLimitedErrorIsRecoverable: true,
      retryIsKeyboardOperable: true,
      // Derived from an OBSERVED recovery transition in this run (never hard-coded): the
      // route ledger of at least one capture context must record recoverySuccess >= 1.
      laterSuccessReplacesError,
      darkLightHighContrastForcedColorsAndResponsiveCoverage: true,
      routeHandlerIsStrictModeTolerant: true,
    },
    routeLedger: ledgers,
  });
}

function writeA11yProof(captures: readonly CaptureRecord[], globalsCssSha256: string): void {
  writeJsonArtifact("a11y-proof.json", {
    issue: 3185,
    verdict: "PASS",
    tool: "axe-core",
    globalsCssSha256,
    gate: "zero serious/critical axe violations on the Health Scan rate-limited error and Retry state",
    captures: captures.map((capture) => ({
      file: capture.file,
      mode: capture.mode,
      violations: capture.seriousOrCriticalAxeViolations,
    })),
    deterministicChecks: {
      alertCarriesPlainLanguageAndRateLimitCode: true,
      retryIsKeyboardOperable: true,
      staleFindingsCountIsAbsent: true,
    },
  });
}

function writeManifest(generatedAt: string): void {
  writeJsonArtifact("manifest.json", {
    issue: "#3185",
    epic: "#3179",
    generatedAt,
    command: `KEIKO_WRITE_TRACKED_EVIDENCE=1 ${PLAYWRIGHT_PLAN_COMMAND}`,
    playwrightCommand: PLAYWRIGHT_PLAN_COMMAND,
    artifacts: ARTIFACTS,
    notes: [
      "The desktop shell, dynamic MemoriaViva window, theme handling, focus behavior, and HealthScanFindings component are real.",
      "Only GET /api/memory/health-scan is intercepted with contract-shaped success and rate-limit fixtures.",
      "The phase-based route handler remains correct when React Strict Mode duplicates an initial request: all initial requests receive the same success fixture until the test deliberately changes phase.",
    ],
  });
}

function writeEvidence(
  captures: readonly CaptureRecord[],
  ledgers: readonly HealthScanRouteLedger[],
  laterSuccessReplacesError: boolean,
): void {
  const generatedAt = new Date().toISOString();
  const globalsCssSha256 = cssSha256();
  writeFidelityProof(captures, ledgers, generatedAt, globalsCssSha256, laterSuccessReplacesError);
  writeA11yProof(captures, globalsCssSha256);
  writeManifest(generatedAt);
}

test("Issue #3185 clears stale Health Scan truth, retries by keyboard, and recovers", async ({
  page,
}) => {
  const route = await installHealthScanRoute(page);
  await page.goto("/");
  const window = await enterRefreshError(page, route);
  const retry = await expectRateLimitedError(window);

  route.setPhase("recovery-success");
  await retry.focus();
  await retry.press("Enter");
  await expect(window.getByText("Dangling review item", { exact: true })).toBeVisible();
  await expect(window.getByText("1 findings", { exact: true })).toBeVisible();
  await expect(window.getByRole("alert")).toHaveCount(0);
  expect(route.ledger.initialSuccess).toBeGreaterThanOrEqual(1);
  expect(route.ledger.rateLimited).toBeGreaterThanOrEqual(1);
  expect(route.ledger.recoverySuccess).toBeGreaterThanOrEqual(1);
});

// Drives the Retry recovery on an already-captured rate-limited page and reports whether the
// route ledger recorded the transition — the fidelity proof derives laterSuccessReplacesError
// from THIS observation instead of hard-coding it.
async function observeRecoverySuccess(
  window: Locator,
  route: {
    readonly ledger: HealthScanRouteLedger;
    readonly setPhase: (next: RoutePhase) => void;
  },
): Promise<boolean> {
  const retry = await expectRateLimitedError(window);
  route.setPhase("recovery-success");
  await retry.focus();
  await retry.press("Enter");
  await expect(window.getByText("Dangling review item", { exact: true })).toBeVisible();
  await expect(window.getByRole("alert")).toHaveCount(0);
  return route.ledger.recoverySuccess >= 1;
}

test("records Issue #3185 Health Scan refresh design-system and axe evidence", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  ensureEvidenceDir();
  const captures: CaptureRecord[] = [];
  const ledgers: HealthScanRouteLedger[] = [];
  let recoveryObserved = false;
  for (const mode of EVIDENCE_MODES) {
    const evidence = await openEvidencePage(browser, mode);
    try {
      let window: Locator;
      if (mode.expectedPhase === "initial-success") {
        window = await openHealthScan(evidence.page);
        await expectInitialSuccess(window);
      } else {
        window = await enterRefreshError(evidence.page, evidence.route);
      }
      captures.push(await captureRecord(evidence.page, window, mode));
      if (mode.expectedPhase !== "initial-success" && !recoveryObserved) {
        recoveryObserved = await observeRecoverySuccess(window, evidence.route);
      }
      ledgers.push(evidence.route.ledger);
    } finally {
      await evidence.close();
    }
  }
  const serious = captures.flatMap((capture) => capture.seriousOrCriticalAxeViolations);
  expect(serious, formatViolations(serious)).toEqual([]);
  expect(captures).toHaveLength(EVIDENCE_MODES.length);
  expect(captures.some((capture) => capture.mode === "light")).toBe(true);
  expect(captures.some((capture) => capture.mode === "dark-high-contrast")).toBe(true);
  expect(captures.some((capture) => capture.forcedColors)).toBe(true);
  expect(captures.some((capture) => capture.mode === "responsive-mobile")).toBe(true);
  expect(ledgers.every((ledger) => ledger.initialSuccess >= 1)).toBe(true);
  // The proof may not claim a recovery it did not observe: fail evidence generation outright
  // when no capture context demonstrated the rate-limited -> recovery-success transition.
  expect(recoveryObserved).toBe(true);
  expect(ledgers.some((ledger) => ledger.recoverySuccess >= 1)).toBe(true);
  writeEvidence(captures, ledgers, recoveryObserved);
});
