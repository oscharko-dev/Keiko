import { expect, test, type Locator, type Page } from "@playwright/test";
import { validateCodingWorkbenchCodexSubscriptionProfile } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-codex-auth";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync, type Stats } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import {
  installLiveCodingWorkbenchRuntime,
  type LiveRuntimeFixture,
} from "./support/coding-workbench-live-runtime.js";
import { evidenceScreenshotPath } from "./support/evidence.js";

// Issue #2253 - browser evidence that an unapproved Codex redistribution fails closed in the
// Workbench. It captures the governed design-system matrix from the real packaged UI while all
// profile responses remain deterministic and contain no runtime/setup capability.

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "design-system", "evidence", "2253");
const WORKSPACE_KEY = "keiko.workspace.v4";
const CONFIRMED_SOURCE = "Keiko Gateway";
const UNAVAILABLE_ANNOUNCEMENT = "Subscription authentication not selected.";
// What the status sentence appends when the runtime cannot start a run (#3873 review).
const RUNTIME_UNAVAILABLE_ANNOUNCEMENT = "Runtime unavailable.";
const READINESS_SUMMARY = "Readiness details";
// The Information popover keeps its secondary facts, the model source among them, in this disclosure.
const INFORMATION_DETAILS = "Details";
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
  readonly profileStatus: "redistribution-unapproved";
  readonly confirmedSource: string;
  readonly codexSourceAffordances: number;
  readonly workbenchLabel: string | null;
  readonly seriousOrCriticalAxeViolations: number;
  readonly documentHasHorizontalOverflow: boolean;
  readonly outerWindowHasHorizontalOverflow: boolean;
  readonly windowBodyHasHorizontalOverflow: boolean;
  readonly workbenchHasHorizontalOverflow: boolean;
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

async function openMode(
  page: Page,
  mode: ModeCase,
  runtime: { readonly runtimeAvailable?: boolean } = {},
): Promise<LiveRuntimeFixture> {
  await page.setViewportSize(mode.viewport);
  await page.emulateMedia(mode.media);
  const fixture = await installLiveCodingWorkbenchRuntime(page, {
    authStatus: "redistribution-unapproved",
    ...runtime,
  });
  await seedUnavailableWorkbench(page, mode);
  await page.goto("/");
  await page.evaluate((dataHc) => {
    if (dataHc === null) document.documentElement.removeAttribute("data-hc");
    else document.documentElement.dataset.hc = dataHc;
  }, mode.dataHc);
  return fixture;
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

function informationDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Coding Workbench information" });
}

// #3494 moved the server-confirmed model source off the Workbench surface into the Information
// popover, and #3561 keeps it in the popover's Details disclosure. This matrix still holds the same
// fact, so it reads it where it now is: the read opens the popover, expands Details, hands the
// source to `read`, and closes the popover again (also when `read` fails). Every capture of the
// matrix therefore shows the Workbench as a reader first meets it, and at narrow widths no open
// popover covers the composer.
async function readConfirmedSource<T>(
  fixture: LiveRuntimeFixture,
  page: Page,
  read: (source: Locator) => Promise<T>,
): Promise<T> {
  await fixture.openInformation();
  try {
    const dialog = informationDialog(page);
    await dialog.getByText(INFORMATION_DETAILS, { exact: true }).click();
    return await read(dialog.getByText(CONFIRMED_SOURCE, { exact: true }));
  } finally {
    await fixture.closeInformation();
  }
}

// #3873 (ADR-0163 D9): the readiness facts moved from the run status announcement into its
// collapsed readiness details. That is a relocation of the pin that held `UNAVAILABLE_ANNOUNCEMENT`
// inside the polite, atomic `role="status"`, never a relaxation of it (#3873 review):
//  - the status sentence stays that live region, and it also carries, as visible text, every fact
//    that says a part of the Workbench is missing or failing; the unavailable-runtime test below
//    makes the old pin's polite, atomic, in-the-region assertions on exactly such a fact;
//  - every other fact is read from the disclosure, and `expectReadinessDisclosure` proves it is in
//    the accessibility tree when expanded and not exposed while collapsed, so a fact left in a
//    collapsed `<details>` cannot pass for an announced one.
function runStatusAnnouncement(surface: Locator): Locator {
  return surface.locator('[data-testid="coding-runtime-announcement"]');
}

function readinessFacts(surface: Locator): Locator {
  return surface.locator('[data-testid="coding-runtime-readiness"]');
}

function readinessDisclosure(surface: Locator): Locator {
  return surface.locator('details:has([data-testid="coding-runtime-readiness"])');
}

async function expectReadinessDisclosure(surface: Locator): Promise<void> {
  const disclosure = readinessDisclosure(surface);
  const facts = readinessFacts(surface);
  await expect(disclosure).toBeVisible();
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(facts).toBeHidden();
  expect(await disclosure.ariaSnapshot()).not.toContain(UNAVAILABLE_ANNOUNCEMENT);
  await disclosure.getByText(READINESS_SUMMARY, { exact: true }).click();
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(facts).toBeVisible();
  await expect(facts).toContainText(UNAVAILABLE_ANNOUNCEMENT);
  expect(await disclosure.ariaSnapshot()).toContain(UNAVAILABLE_ANNOUNCEMENT);
  // Collapsed again: every capture of this matrix shows the Workbench as a reader first meets it.
  await disclosure.getByText(READINESS_SUMMARY, { exact: true }).click();
  await expect(disclosure).not.toHaveAttribute("open", "");
}

async function expectUnapprovedProfile(page: Page): Promise<void> {
  const candidate: unknown = await page.evaluate(async () => {
    const response = await fetch("/api/coding-workbench/codex-subscription/profile");
    if (!response.ok) throw new Error("Codex profile fixture request failed");
    const body: unknown = await response.json();
    return body;
  });
  const validation = validateCodingWorkbenchCodexSubscriptionProfile(candidate);
  expect(validation.ok).toBe(true);
  if (!validation.ok) throw new Error("Codex profile fixture failed contract validation");
  expect(validation.value).toMatchObject({
    status: "redistribution-unapproved",
    runtimeBinarySources: [],
    supportsBrowserLogin: false,
    supportsDeviceCode: false,
    supportsAccessToken: false,
  });
}

async function expectUnavailableSurface(page: Page, fixture: LiveRuntimeFixture): Promise<Locator> {
  const surface = workbench(page);
  await expect(surface).toBeVisible();
  await readConfirmedSource(fixture, page, (source) => expect(source).toBeVisible());
  const announcement = runStatusAnnouncement(surface);
  await expect(announcement).toBeAttached();
  await expect(announcement).toHaveAttribute("role", "status");
  await expect(announcement).toHaveAttribute("aria-live", "polite");
  await expect(announcement).toHaveAttribute("aria-atomic", "true");
  await expectReadinessDisclosure(surface);
  await expect(surface.getByRole("radiogroup", { name: "Runtime model source" })).toHaveCount(0);
  await expect(surface.getByText("ChatGPT/Codex subscription", { exact: true })).toHaveCount(0);
  await expect(surface.getByText("Needs setup", { exact: true })).toHaveCount(0);
  await expect(surface.getByRole("button", { name: /login|local install/u })).toHaveCount(0);
  return surface;
}

async function captureMode(page: Page, mode: ModeCase): Promise<CaptureRecord> {
  const fixture = await openMode(page, mode);
  await expectUnapprovedProfile(page);
  const surface = await expectUnavailableSurface(page, fixture);
  const violations = seriousOrCritical(
    await runAxe(page, 'section[aria-label="Coding Workbench"][data-state]'),
  );
  expect(violations.length, formatViolations(violations)).toBe(0);
  const overflow = await overflowState(page, surface);
  const viewportBoundsChecks = isNarrowFrame(mode)
    ? await assertNarrowFrameViewportBounds(page, surface, fixture)
    : [];
  if (isNarrowFrame(mode)) {
    expect(overflow.documentHasHorizontalOverflow).toBe(false);
    expect(overflow.outerWindowHasHorizontalOverflow).toBe(false);
    expect(overflow.windowBodyHasHorizontalOverflow).toBe(false);
    expect(overflow.workbenchHasHorizontalOverflow).toBe(false);
  }
  await surface.scrollIntoViewIfNeeded();
  await surface.screenshot({ path: screenshotPath(mode.file) });
  return captureRecord(surface, fixture, mode, violations.length, overflow, viewportBoundsChecks);
}

function isNarrowFrame(mode: ModeCase): boolean {
  return mode.frame.width === 304;
}

async function assertNarrowFrameViewportBounds(
  page: Page,
  surface: Locator,
  fixture: LiveRuntimeFixture,
): Promise<readonly ViewportBoundsCheck[]> {
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  const outerFrame = await boundsCheck(
    outerWindow(page),
    "outer Workbench window",
    viewportWidth,
    null,
  );
  const outerFrameBounds = { left: outerFrame.left, right: outerFrame.right };
  const workbenchCheck = await boundsCheck(
    surface,
    "Coding Workbench",
    viewportWidth,
    outerFrameBounds,
  );
  // The source is the value cell of the popover's fact grid, a block stretched to the popover's
  // edge, so the bounds of its TEXT are what must stay inside the frame. This pins that the
  // confirmed source stays readable in a 304px frame; it does not claim the popover fits there: at
  // a 1280px viewport the popover (22rem, sized by the viewport) is wider than the 304px frame
  // and the frame clips it, a layout limitation of the popover itself that this matrix does not
  // measure.
  const sourceCheck = await readConfirmedSource(fixture, page, (source) =>
    boundsCheck(source, "confirmed source context", viewportWidth, outerFrameBounds, "text"),
  );
  const checks = [outerFrame, workbenchCheck, sourceCheck];
  expect(checks).toHaveLength(3);
  return checks;
}

interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// The element's own box, or — for an element whose box is stretched beyond its content by the
// layout around it — the box of the text it holds.
async function measuredBounds(locator: Locator, region: "box" | "text"): Promise<Bounds | null> {
  if (region === "box") return locator.boundingBox();
  return locator.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const { x, y, width, height } = range.getBoundingClientRect();
    return { x, y, width, height };
  });
}

async function boundsCheck(
  locator: Locator,
  label: string,
  viewportWidth: number,
  outerFrame: { readonly left: number; readonly right: number } | null,
  region: "box" | "text" = "box",
): Promise<ViewportBoundsCheck> {
  await expect(locator).toBeVisible();
  const box = await measuredBounds(locator, region);
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
  return {
    documentHasHorizontalOverflow,
    outerWindowHasHorizontalOverflow,
    windowBodyHasHorizontalOverflow,
    workbenchHasHorizontalOverflow,
  };
}

async function captureRecord(
  surface: Locator,
  fixture: LiveRuntimeFixture,
  mode: ModeCase,
  axeViolationCount: number,
  overflow: Awaited<ReturnType<typeof overflowState>>,
  viewportBoundsChecks: readonly ViewportBoundsCheck[],
): Promise<CaptureRecord> {
  const page = surface.page();
  return {
    file: mode.file,
    mode: mode.mode,
    viewport: mode.viewport,
    dataTheme: await page.locator("html").getAttribute("data-theme"),
    dataHc: await page.locator("html").getAttribute("data-hc"),
    forcedColors: mode.media.forcedColors,
    reducedMotion: mode.media.reducedMotion,
    liveAnnouncement: await runStatusAnnouncement(surface).innerText(),
    profileStatus: "redistribution-unapproved",
    confirmedSource: await readConfirmedSource(fixture, page, (source) => source.innerText()),
    codexSourceAffordances: await surface
      .getByText("ChatGPT/Codex subscription", { exact: true })
      .count(),
    workbenchLabel: await surface.getAttribute("aria-label"),
    seriousOrCriticalAxeViolations: axeViolationCount,
    viewportBoundsChecks,
    ...overflow,
  };
}

function sourceProof(): JsonObject {
  return {
    globalsCssSha256: cssSha256("packages/keiko-ui/src/app/globals.css"),
    codingWorkbenchModuleSha256: cssSha256(
      "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.tsx",
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
      confirmedGatewayContextVisibleInEveryMode: captures.length,
      politeStatusAnnouncements: captures.length,
      labelledWorkbench: captures.length,
      codexSourceAffordancesAbsent: true,
      native304pxOuterFrameReflowAt320px: true,
      desktopViewport304pxFrameReflow: true,
      viewportBoundsChecksPer304pxFrame: 3,
      outerFrameContentBoundsChecksPer304pxFrame: 2,
      windowBodyNoHorizontalOverflow: true,
    },
  };
}

function a11yProof(captures: readonly CaptureRecord[], source: JsonObject): JsonObject {
  return {
    issue: 2253,
    verdict: "PASS",
    proofType: "browser-capture-plus-axe-core",
    gate: "An unapproved Codex redistribution remains absent from the reachable Workbench while the server-confirmed Gateway context stays labelled, politely announced, and bounded inside a 304px frame.",
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
      viewportBoundsChecks: capture.viewportBoundsChecks,
    })),
  };
}

function manifest(captures: readonly CaptureRecord[]): JsonObject {
  return {
    issue: 2253,
    generatedAt: new Date().toISOString(),
    command: "KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:coding-workbench-2253",
    playwrightCommand:
      "playwright test --config tests/e2e/config/playwright.issue-2253-coding-workbench.config.ts --project=chromium",
    artifacts: [...SCREENSHOT_ARTIFACTS, ...JSON_ARTIFACTS],
    captureCount: captures.length,
    // Seven-boolean redactionBoundary shape, matching the sibling 1990/2060 manifests (KEIKO-0959).
    // Deterministic assertions, accessibility counts, hashes, and visible product copy only —
    // never a customer repo file, secret, private path, raw diff, model prompt/output, or token.
    redactionBoundary: {
      customerRepositoryFilesIncluded: false,
      secretsIncluded: false,
      privatePathsIncluded: false,
      rawDiffsIncluded: false,
      rawModelPromptsIncluded: false,
      rawModelOutputsIncluded: false,
      tokensIncluded: false,
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

// This spec runs in the nightly lane (`npm run test:e2e:coding-workbench-2253`, e2e-extended.yml),
// so a red run there is a signal, not a merge blocker; none of its tests is `@smoke`. The per-PR
// pins for the same invariants are the unit tests that own them (CodingWorkbenchRunStatus.test.tsx
// and CodingWorkbenchWindow.test.tsx). `@smoke` would also put the next two tests into the required
// Firefox and WebKit smoke lanes, and their closed-<details> accessibility-tree proofs are certified
// on Chromium only.
//
// #3873 review: the old pin held an unavailable fact inside the polite, atomic `role="status"`, and
// moving the readiness facts into collapsed details left it announced to no one. The facts that say
// a part of the Workbench is missing or failing are the status sentence's own visible text again,
// so the same polite/atomic assertions are made here on a runtime that cannot start a run, and the
// facts that are fine stay out of the sentence.
test("Issue #2253 an unavailable runtime is announced by the polite, atomic status sentence", async ({
  page,
}) => {
  const [mode] = MODES;
  if (mode === undefined) throw new Error("the Issue #2253 matrix has no desktop mode");
  await openMode(page, mode, { runtimeAvailable: false });
  const surface = workbench(page);
  await expect(surface).toBeVisible();
  const announcement = runStatusAnnouncement(surface);
  await expect(announcement).toHaveAttribute("role", "status");
  await expect(announcement).toHaveAttribute("aria-live", "polite");
  await expect(announcement).toHaveAttribute("aria-atomic", "true");
  await expect(announcement).toBeVisible();
  await expect(announcement).toContainText(RUNTIME_UNAVAILABLE_ANNOUNCEMENT);
  await expect(announcement).not.toContainText("Model source ready.");
  expect(await announcement.ariaSnapshot()).toContain(RUNTIME_UNAVAILABLE_ANNOUNCEMENT);
});

// The disclosure that now holds the readiness facts is proven from the accessibility tree, in a test
// of its own: its result must not depend on the evidence matrix below, whose captures read the
// confirmed source context from the Workbench surface.
test("Issue #2253 the readiness facts are in the accessibility tree once their disclosure is expanded", async ({
  page,
}) => {
  const [mode] = MODES;
  if (mode === undefined) throw new Error("the Issue #2253 matrix has no desktop mode");
  await openMode(page, mode);
  const surface = workbench(page);
  await expect(surface).toBeVisible();
  await expectReadinessDisclosure(surface);
});

test("Issue #2253 unapproved Codex redistribution stays absent from the Workbench", async ({
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
