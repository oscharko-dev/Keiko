import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync, type Stats } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { evidenceScreenshotPath } from "./support/evidence.js";

// Issue #2253 - browser evidence that an unapproved Codex redistribution fails closed in the
// Workbench. It captures the governed design-system matrix from the real packaged UI while all
// profile responses remain deterministic and contain no runtime/setup capability.

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "design-system", "evidence", "2253");
const WORKSPACE_KEY = "keiko.workspace.v4";
const UNAVAILABLE_COPY = "Codex subscriptions are not supported in this release.";
const UNAVAILABLE_ANNOUNCEMENT = "ChatGPT/Codex subscription profile unavailable in this release";
// WindowFrame's 2px border plus its one-pixel selection edge appear in scroll metrics but cannot
// produce a horizontal scroll range. Anything beyond this is content overflow.
const HORIZONTAL_OVERFLOW_TOLERANCE_PX = 3;

const SCREENSHOT_ARTIFACTS = [
  "01-dark-desktop.png",
  "02-light-desktop.png",
  "03-dark-high-contrast.png",
  "04-light-high-contrast.png",
  "05-prefers-contrast.png",
  "06-forced-colors.png",
  "07-reduced-motion.png",
  "08-320px-reflow.png",
  "09-desktop-304px-frame-reflow.png",
] as const;

const JSON_ARTIFACTS = [
  "coding-workbench-unavailable-fidelity-proof.json",
  "a11y-proof.json",
  "manifest.json",
] as const;

type ScreenshotArtifact = (typeof SCREENSHOT_ARTIFACTS)[number];
type JsonArtifact = (typeof JSON_ARTIFACTS)[number];
type Artifact = ScreenshotArtifact | JsonArtifact;
type JsonObject = Record<string, unknown>;
type MediaColorScheme = "dark" | "light";
type MediaContrast = "no-preference" | "more";
type MediaForcedColors = "none" | "active";
type MediaReducedMotion = "no-preference" | "reduce";

interface ModeCase {
  readonly file: ScreenshotArtifact;
  readonly mode: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly frame: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly theme: "dark" | "light";
  readonly dataHc: "more" | null;
  readonly media: {
    readonly colorScheme: MediaColorScheme;
    readonly contrast: MediaContrast;
    readonly forcedColors: MediaForcedColors;
    readonly reducedMotion: MediaReducedMotion;
  };
}

interface CaptureRecord {
  readonly file: ScreenshotArtifact;
  readonly mode: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly dataTheme: string | null;
  readonly dataHc: string | null;
  readonly forcedColors: MediaForcedColors;
  readonly reducedMotion: MediaReducedMotion;
  readonly liveAnnouncement: string;
  readonly unavailableCopy: string;
  readonly workbenchLabel: string | null;
  readonly runtimeCardLabelledBy: string | null;
  readonly seriousOrCriticalAxeViolations: number;
  readonly documentHasHorizontalOverflow: boolean;
  readonly outerWindowHasHorizontalOverflow: boolean;
  readonly windowBodyHasHorizontalOverflow: boolean;
  readonly workbenchHasHorizontalOverflow: boolean;
  readonly sourceStatusHasHorizontalOverflow: boolean;
  readonly codexCardHasHorizontalOverflow: boolean;
  readonly viewportBoundsChecks: readonly ViewportBoundsCheck[];
}

interface ViewportBoundsCheck {
  readonly label: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly withinViewport: boolean;
  readonly withinOuterFrame: boolean | null;
}

const MODES: readonly ModeCase[] = [
  desktopMode("01-dark-desktop.png", "dark desktop", "dark"),
  desktopMode("02-light-desktop.png", "light desktop", "light"),
  { ...desktopMode("03-dark-high-contrast.png", "dark high contrast", "dark"), dataHc: "more" },
  { ...desktopMode("04-light-high-contrast.png", "light high contrast", "light"), dataHc: "more" },
  {
    ...desktopMode("05-prefers-contrast.png", "prefers contrast", "dark"),
    media: { ...baselineMedia("dark"), contrast: "more" },
  },
  {
    ...desktopMode("06-forced-colors.png", "forced colors", "dark"),
    media: { ...baselineMedia("dark"), forcedColors: "active" },
  },
  {
    ...desktopMode("07-reduced-motion.png", "reduced motion", "dark"),
    media: { ...baselineMedia("dark"), reducedMotion: "reduce" },
  },
  {
    file: "08-320px-reflow.png",
    mode: "320px reflow",
    viewport: { width: 320, height: 860 },
    frame: { x: 8, y: 42, width: 304, height: 760 },
    theme: "dark",
    dataHc: null,
    media: baselineMedia("dark"),
  },
  {
    file: "09-desktop-304px-frame-reflow.png",
    mode: "desktop viewport 304px frame reflow",
    viewport: { width: 1280, height: 900 },
    frame: { x: 70, y: 58, width: 304, height: 720 },
    theme: "dark",
    dataHc: null,
    media: baselineMedia("dark"),
  },
];

function baselineMedia(colorScheme: MediaColorScheme): ModeCase["media"] {
  return {
    colorScheme,
    contrast: "no-preference",
    forcedColors: "none",
    reducedMotion: "no-preference",
  };
}

function desktopMode(file: ScreenshotArtifact, mode: string, theme: "dark" | "light"): ModeCase {
  return {
    file,
    mode,
    viewport: { width: 1280, height: 900 },
    frame: { x: 70, y: 58, width: 940, height: 720 },
    theme,
    dataHc: null,
    media: baselineMedia(theme),
  };
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat: Stats = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #2253 evidence directory is not a real directory");
  }
}

function artifactPath(name: Artifact): string {
  return resolve(EVIDENCE_DIR, name);
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
    "2253",
    name,
  );
  mkdirSync(dirname(redirected), { recursive: true });
  return redirected;
}

function writeJsonArtifact(name: JsonArtifact, value: unknown): void {
  writeFileSync(outputArtifactPath(name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cssSha256(path: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(REPO_ROOT, path)))
    .digest("hex");
}

function redistributionUnapprovedProfile(): JsonObject {
  return {
    schemaVersion: "1",
    profileId: "codex-subscription",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status: "redistribution-unapproved",
    credentialStore: "file",
    stateScope: "keiko-owned-state",
    stateRoot: "keiko-codex-runtime-state",
    usesGlobalCodexHome: false,
    runtimeBinarySources: [],
    supportsBrowserLogin: false,
    supportsDeviceCode: false,
    supportsAccessToken: false,
    deploymentPolicyDisabled: false,
    headless: false,
  };
}

function unavailableSidecarProfile(): JsonObject {
  return { status: "unavailable", reason: "missing-config" };
}

async function fulfillJson(route: Route, body: JsonObject): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function installProfileRoutes(page: Page): Promise<void> {
  await page.route("**/api/coding-sidecar/gateway/profile", async (route) => {
    await fulfillJson(route, unavailableSidecarProfile());
  });
  await page.route("**/api/coding-workbench/codex-subscription/profile", async (route) => {
    await fulfillJson(route, redistributionUnapprovedProfile());
  });
}

function codingWindow(mode: ModeCase): JsonObject {
  return {
    id: "issue-2253-coding-unavailable",
    type: "coding",
    x: mode.frame.x,
    y: mode.frame.y,
    w: mode.frame.width,
    h: mode.frame.height,
    z: 10,
    zoom: 1,
    cfg: { state: "running" },
    max: false,
  };
}

async function seedUnavailableWorkbench(page: Page, mode: ModeCase): Promise<void> {
  await page.addInitScript(
    ({ key, theme, win }) => {
      window.localStorage.setItem("keiko.theme", theme);
      window.localStorage.setItem(key, JSON.stringify([win]));
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { key: WORKSPACE_KEY, theme: mode.theme, win: codingWindow(mode) },
  );
}

async function openMode(page: Page, mode: ModeCase): Promise<void> {
  await page.setViewportSize(mode.viewport);
  await page.emulateMedia(mode.media);
  await installProfileRoutes(page);
  await seedUnavailableWorkbench(page, mode);
  await page.goto("/");
  await page.evaluate((dataHc) => {
    if (dataHc === null) document.documentElement.removeAttribute("data-hc");
    else document.documentElement.dataset.hc = dataHc;
  }, mode.dataHc);
}

function workbench(page: Page): Locator {
  return page.locator('section[aria-label="Coding Workbench"][data-state]');
}

function outerWindow(page: Page): Locator {
  return page.locator('section.window[data-window-id="issue-2253-coding-unavailable"]');
}

function windowBody(page: Page): Locator {
  return outerWindow(page).locator(".win-body");
}

function sourceStatus(page: Page): Locator {
  return page.getByRole("region", { name: "Source status" });
}

function codexCard(page: Page): Locator {
  return sourceStatus(page)
    .locator("article")
    .filter({ hasText: "ChatGPT/Codex subscription profile" });
}

function codexProfileLabel(page: Page): Locator {
  return codexCard(page).getByText("ChatGPT/Codex subscription profile", { exact: true });
}

function unavailableDetail(page: Page): Locator {
  return codexCard(page).getByText(UNAVAILABLE_COPY, { exact: true });
}

function unavailableStatus(page: Page): Locator {
  return codexCard(page).getByText("Unavailable in this release", { exact: true });
}

function unavailableAnnouncement(surface: Locator): Locator {
  return surface.locator('[role="status"]').filter({ hasText: UNAVAILABLE_ANNOUNCEMENT });
}

async function expectUnavailableSurface(page: Page): Promise<Locator> {
  const surface = workbench(page);
  await expect(surface).toBeVisible();
  await expect(sourceStatus(page)).toBeVisible();
  await expect(codexCard(page)).toBeVisible();
  await expect(unavailableDetail(page)).toBeVisible();
  await expect(unavailableStatus(page)).toBeVisible();
  const announcement = unavailableAnnouncement(surface);
  await expect(announcement).toBeAttached();
  await expect(announcement).toHaveAttribute("aria-live", "polite");
  await expect(announcement).toHaveAttribute("aria-atomic", "true");
  await expect(surface.getByText("Needs setup", { exact: true })).toHaveCount(0);
  await expect(surface.getByRole("button", { name: /login|local install/u })).toHaveCount(0);
  return surface;
}

async function captureMode(page: Page, mode: ModeCase): Promise<CaptureRecord> {
  await openMode(page, mode);
  const surface = await expectUnavailableSurface(page);
  const violations = seriousOrCritical(
    await runAxe(page, 'section[aria-label="Coding Workbench"][data-state]'),
  );
  expect(violations.length, formatViolations(violations)).toBe(0);
  const overflow = await overflowState(page, surface);
  const viewportBoundsChecks = isNarrowFrame(mode)
    ? await assertNarrowFrameViewportBounds(page, surface)
    : [];
  if (isNarrowFrame(mode)) {
    expect(overflow.documentHasHorizontalOverflow).toBe(false);
    expect(overflow.outerWindowHasHorizontalOverflow).toBe(false);
    expect(overflow.windowBodyHasHorizontalOverflow).toBe(false);
    expect(overflow.workbenchHasHorizontalOverflow).toBe(false);
    expect(overflow.sourceStatusHasHorizontalOverflow).toBe(false);
    expect(overflow.codexCardHasHorizontalOverflow).toBe(false);
  }
  const status = sourceStatus(page);
  await status.scrollIntoViewIfNeeded();
  await status.screenshot({ path: screenshotPath(mode.file) });
  return captureRecord(page, surface, mode, violations.length, overflow, viewportBoundsChecks);
}

function isNarrowFrame(mode: ModeCase): boolean {
  return mode.frame.width === 304;
}

async function assertNarrowFrameViewportBounds(
  page: Page,
  surface: Locator,
): Promise<readonly ViewportBoundsCheck[]> {
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  const outerFrame = await boundsCheck(
    outerWindow(page),
    "outer Workbench window",
    viewportWidth,
    null,
  );
  const outerFrameBounds = { left: outerFrame.left, right: outerFrame.right };
  const innerChecks = await Promise.all([
    boundsCheck(surface, "Coding Workbench", viewportWidth, outerFrameBounds),
    boundsCheck(sourceStatus(page), "Source status region", viewportWidth, outerFrameBounds),
    boundsCheck(codexCard(page), "Codex card", viewportWidth, outerFrameBounds),
    boundsCheck(codexProfileLabel(page), "Codex profile label", viewportWidth, outerFrameBounds),
    boundsCheck(unavailableDetail(page), "unavailable detail", viewportWidth, outerFrameBounds),
    boundsCheck(unavailableStatus(page), "unavailable status", viewportWidth, outerFrameBounds),
  ]);
  const checks = [outerFrame, ...innerChecks];
  expect(checks).toHaveLength(7);
  return checks;
}

async function boundsCheck(
  locator: Locator,
  label: string,
  viewportWidth: number,
  outerFrame: { readonly left: number; readonly right: number } | null,
): Promise<ViewportBoundsCheck> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${label} bounding box was not available`);
  const withinViewport = box.x >= -1 && box.x + box.width <= viewportWidth + 1;
  expect(
    withinViewport,
    `${label}: left=${String(box.x)}, right=${String(box.x + box.width)}`,
  ).toBe(true);
  let withinOuterFrame: boolean | null = null;
  if (outerFrame !== null) {
    withinOuterFrame =
      box.x >= outerFrame.left - HORIZONTAL_OVERFLOW_TOLERANCE_PX &&
      box.x + box.width <= outerFrame.right + HORIZONTAL_OVERFLOW_TOLERANCE_PX;
    expect(
      withinOuterFrame,
      `${label}: left=${String(box.x)}, right=${String(box.x + box.width)}, outerLeft=${String(outerFrame.left)}, outerRight=${String(outerFrame.right)}`,
    ).toBe(true);
  }
  return {
    label,
    left: box.x,
    right: box.x + box.width,
    top: box.y,
    bottom: box.y + box.height,
    withinViewport,
    withinOuterFrame,
  };
}

async function overflowState(
  page: Page,
  surface: Locator,
): Promise<{
  readonly documentHasHorizontalOverflow: boolean;
  readonly outerWindowHasHorizontalOverflow: boolean;
  readonly windowBodyHasHorizontalOverflow: boolean;
  readonly workbenchHasHorizontalOverflow: boolean;
  readonly sourceStatusHasHorizontalOverflow: boolean;
  readonly codexCardHasHorizontalOverflow: boolean;
}> {
  const documentHasHorizontalOverflow = await page.evaluate(
    (tolerance) => document.documentElement.scrollWidth > window.innerWidth + tolerance,
    HORIZONTAL_OVERFLOW_TOLERANCE_PX,
  );
  const workbenchHasHorizontalOverflow = await surface.evaluate(
    (node, tolerance) => node.scrollWidth > node.clientWidth + tolerance,
    HORIZONTAL_OVERFLOW_TOLERANCE_PX,
  );
  const outerWindowHasHorizontalOverflow = await outerWindow(page).evaluate(
    (node, tolerance) => node.scrollWidth > node.clientWidth + tolerance,
    HORIZONTAL_OVERFLOW_TOLERANCE_PX,
  );
  const windowBodyHasHorizontalOverflow = await windowBody(page).evaluate(
    (node, tolerance) => node.scrollWidth > node.clientWidth + tolerance,
    HORIZONTAL_OVERFLOW_TOLERANCE_PX,
  );
  const sourceStatusHasHorizontalOverflow = await sourceStatus(page).evaluate(
    (node, tolerance) => node.scrollWidth > node.clientWidth + tolerance,
    HORIZONTAL_OVERFLOW_TOLERANCE_PX,
  );
  const codexCardHasHorizontalOverflow = await codexCard(page).evaluate(
    (node, tolerance) => node.scrollWidth > node.clientWidth + tolerance,
    HORIZONTAL_OVERFLOW_TOLERANCE_PX,
  );
  return {
    documentHasHorizontalOverflow,
    outerWindowHasHorizontalOverflow,
    windowBodyHasHorizontalOverflow,
    workbenchHasHorizontalOverflow,
    sourceStatusHasHorizontalOverflow,
    codexCardHasHorizontalOverflow,
  };
}

async function captureRecord(
  page: Page,
  surface: Locator,
  mode: ModeCase,
  axeViolationCount: number,
  overflow: Awaited<ReturnType<typeof overflowState>>,
  viewportBoundsChecks: readonly ViewportBoundsCheck[],
): Promise<CaptureRecord> {
  return {
    file: mode.file,
    mode: mode.mode,
    viewport: mode.viewport,
    dataTheme: await page.locator("html").getAttribute("data-theme"),
    dataHc: await page.locator("html").getAttribute("data-hc"),
    forcedColors: mode.media.forcedColors,
    reducedMotion: mode.media.reducedMotion,
    liveAnnouncement: await unavailableAnnouncement(surface).innerText(),
    unavailableCopy: await surface.getByText(UNAVAILABLE_COPY, { exact: true }).innerText(),
    workbenchLabel: await surface.getAttribute("aria-label"),
    runtimeCardLabelledBy: await sourceStatus(page).getAttribute("aria-labelledby"),
    seriousOrCriticalAxeViolations: axeViolationCount,
    viewportBoundsChecks,
    ...overflow,
  };
}

function sourceProof(): JsonObject {
  return {
    globalsCssSha256: cssSha256("packages/keiko-ui/src/app/globals.css"),
    codingWorkbenchModuleSha256: cssSha256(
      "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchModelCards.tsx",
    ),
    codingWorkbenchStylesSha256: cssSha256(
      "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.module.css",
    ),
  };
}

function fidelityProof(captures: readonly CaptureRecord[], source: JsonObject): JsonObject {
  return {
    issue: 2253,
    verdict: "PASS",
    harness: "tests/e2e/config/playwright.issue-2253-coding-workbench.config.ts",
    route: "/",
    appPath: "dev-runner-ui",
    ...source,
    captures,
    assertions: {
      redistributionProfileHasNoRuntimeBinarySources: true,
      redistributionProfileHasNoSetupCapabilities: true,
      unavailableCopyVisibleInEveryMode: captures.length,
      politeStatusAnnouncements: captures.length,
      labelledWorkbenchAndRuntimeCard: captures.length,
      unavailableAffordancesAbsent: true,
      native304pxOuterFrameReflowAt320px: true,
      desktopViewport304pxFrameReflow: true,
      viewportBoundsChecksPer304pxFrame: 7,
      outerFrameContentBoundsChecksPer304pxFrame: 6,
      windowBodyNoHorizontalOverflow: true,
    },
  };
}

function a11yProof(captures: readonly CaptureRecord[], source: JsonObject): JsonObject {
  return {
    issue: 2253,
    verdict: "PASS",
    proofType: "browser-capture-plus-axe-core",
    gate: "Unavailable Codex subscription state remains labelled, politely announced, actionable only through supported paths, and reflows inside a 304px frame at mobile and desktop viewport widths.",
    ...source,
    captures: captures.map((capture) => ({
      file: capture.file,
      mode: capture.mode,
      liveAnnouncement: capture.liveAnnouncement,
      seriousOrCriticalAxeViolations: capture.seriousOrCriticalAxeViolations,
      documentHasHorizontalOverflow: capture.documentHasHorizontalOverflow,
      outerWindowHasHorizontalOverflow: capture.outerWindowHasHorizontalOverflow,
      windowBodyHasHorizontalOverflow: capture.windowBodyHasHorizontalOverflow,
      workbenchHasHorizontalOverflow: capture.workbenchHasHorizontalOverflow,
      sourceStatusHasHorizontalOverflow: capture.sourceStatusHasHorizontalOverflow,
      codexCardHasHorizontalOverflow: capture.codexCardHasHorizontalOverflow,
      viewportBoundsChecks: capture.viewportBoundsChecks,
    })),
  };
}

function manifest(captures: readonly CaptureRecord[]): JsonObject {
  return {
    issue: "#2253",
    generatedAt: new Date().toISOString(),
    command: "KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:coding-workbench-2253",
    playwrightCommand:
      "playwright test --config tests/e2e/config/playwright.issue-2253-coding-workbench.config.ts --project=chromium",
    artifacts: [...SCREENSHOT_ARTIFACTS, ...JSON_ARTIFACTS],
    captureCount: captures.length,
    redaction: {
      profileFixture:
        "contains only deterministic status/capability metadata; no credentials, paths, endpoints, or runtime output",
      screenshots: "capture the labelled Source status region and unavailable Codex card",
      proofs: "contain assertions, accessibility counts, hashes, and visible product copy only",
    },
  };
}

function writeArtifacts(captures: readonly CaptureRecord[]): void {
  const source = sourceProof();
  writeJsonArtifact(
    "coding-workbench-unavailable-fidelity-proof.json",
    fidelityProof(captures, source),
  );
  writeJsonArtifact("a11y-proof.json", a11yProof(captures, source));
  writeJsonArtifact("manifest.json", manifest(captures));
}

test("Issue #2253 unavailable Codex subscription fidelity and accessibility evidence", async ({
  browser,
}) => {
  ensureEvidenceDir();
  const captures: CaptureRecord[] = [];
  for (const mode of MODES) {
    const page = await browser.newPage();
    try {
      captures.push(await captureMode(page, mode));
    } finally {
      await page.close();
    }
  }
  expect(captures).toHaveLength(SCREENSHOT_ARTIFACTS.length);
  writeArtifacts(captures);
});
