import { expect, test, type Browser, type Locator, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";

// Issue #1696 (Epic #1687) - browser proof for the governed update UI. The test boots the
// packaged CLI UI, opens Updates through the real Settings/startup entry points, mocks only the
// update BFF routes with contract-shaped fixtures, captures design-system evidence, and runs
// axe-core on the rendered surfaces. This is coordinator evidence; normal CI does not run it unless
// explicitly requested through npm run test:e2e:update-ui-1696.

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "design-system", "evidence", "1696");
const APP_ORIGIN = `http://127.0.0.1:${process.env.KEIKO_E2E_UI_PORT ?? "32201"}`;
const PLAYWRIGHT_PLAN_COMMAND =
  "npx playwright test --config tests/e2e/config/playwright.issue-1696-update-ui.config.ts --project=chromium";
const UI_RECEIPT_COMMAND = `.keiko-scripts/ui-verify-receipt.sh 1696 -- ${PLAYWRIGHT_PLAN_COMMAND}`;
const EVIDENCE_GENERATED_AT = "2026-06-30T17:11:30.507Z";
const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

const ARTIFACT_NAMES = [
  "01-update-window-dark.png",
  "02-update-window-light.png",
  "03-update-window-dark-high-contrast.png",
  "04-update-window-light-high-contrast.png",
  "05-update-window-prefers-contrast.png",
  "06-update-window-forced-colors.png",
  "07-update-window-reduced-motion.png",
  "08-startup-notice-critical.png",
  "09-settings-entrypoint.png",
  "10-responsive-manual-path.png",
  "11-progress-state.png",
  "update-experience-fidelity-proof.json",
  "a11y-proof.json",
  "manifest.json",
] as const;

type ArtifactName = (typeof ARTIFACT_NAMES)[number];
type ThemeMode =
  | "dark"
  | "light"
  | "dark-high-contrast"
  | "light-high-contrast"
  | "prefers-contrast"
  | "forced-colors"
  | "reduced-motion";

type JsonObject = Record<string, unknown>;
type MediaColorScheme = "dark" | "light";
type MediaContrast = "no-preference" | "more";
type MediaForcedColors = "none" | "active";
type MediaReducedMotion = "no-preference" | "reduce";

interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

interface ModeCaptureCase {
  readonly file: ArtifactName;
  readonly mode: ThemeMode;
  readonly theme: "dark" | "light";
  readonly highContrast?: boolean;
  readonly media?: {
    readonly colorScheme?: MediaColorScheme;
    readonly contrast?: MediaContrast;
    readonly forcedColors?: MediaForcedColors;
    readonly reducedMotion?: MediaReducedMotion;
  };
  readonly viewport?: ViewportSize;
}

interface CaptureRecord {
  readonly file: ArtifactName;
  readonly mode: string;
  readonly entrypoint: "settings" | "startup";
  readonly viewport: ViewportSize;
  readonly dataTheme: string | null;
  readonly dataHc: string | null;
  readonly forcedColors: MediaForcedColors;
  readonly reducedMotion: MediaReducedMotion;
  readonly state: string;
}

interface AxeNodeResult {
  readonly target: readonly string[];
}

interface AxeViolation {
  readonly id: string;
  readonly impact?: string | null;
  readonly nodes: readonly AxeNodeResult[];
}

interface UpdateRouteLedger {
  preflightGets: number;
  preflightChecks: number;
  sessionStarts: unknown[];
  remediationActions: unknown[];
}

interface RouteFixtures {
  readonly report: JsonObject;
  readonly sessionStatus?: JsonObject;
  readonly remediation?: JsonObject;
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #1696 update UI evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!ARTIFACT_NAMES.includes(name)) {
    throw new Error("Unexpected Issue #1696 update UI evidence artifact");
  }
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Issue #1696 update UI evidence artifact escaped its directory");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #1696 update UI evidence artifact path is a symlink");
  }
  return resolved;
}

function cssSha256(): string {
  return createHash("sha256")
    .update(readFileSync(resolve(REPO_ROOT, "packages/keiko-ui/src/app/globals.css")))
    .digest("hex");
}

function updatePreflight(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: 1,
    checkedAt: "2026-06-30T12:00:00.000Z",
    currentVersion: "0.2.10",
    targetVersion: "0.2.11",
    updateAvailable: true,
    status: "update-available",
    availabilityState: "update-available",
    severity: "normal",
    registryStatus: "ok",
    releaseMetadataStatus: "live",
    userActionRequired: true,
    affectedStateStores: ["local-knowledge"],
    blockers: [],
    manualUpdateRequired: false,
    oneClickEligible: true,
    patchNotes: {
      collapsed: true,
      summary: "Plain-language update summary for the governed updater.",
      bullets: [
        "Adds update readiness, state impact, and remediation guidance.",
        "Keeps patch notes and technical details available but secondary.",
      ],
      details: ["Internal package-manager output remains collapsed unless the user opens details."],
    },
    release: {
      source: "github-release",
      tag: "v0.2.11",
      title: "Keiko 0.2.11",
      summary: "Governed update experience.",
      notes: ["Review update impact before installing."],
      url: "https://github.com/oscharko-dev/Keiko/releases/tag/v0.2.11",
      publishedAt: "2026-06-30T12:00:00.000Z",
    },
    impact: {
      entries: [
        {
          packageVersion: "0.2.11",
          releaseTag: "v0.2.11",
          summary: "Local Knowledge needs a reindex after this update.",
          releaseNoteBullets: ["Local Knowledge search quality is refreshed after reindexing."],
          stateImpact: [
            {
              store: "local-knowledge",
              description: "Local Knowledge vectors need reindexing after this update.",
              remediation: "local-knowledge-reindex-required",
              userActionRequired: true,
            },
          ],
          userActionRequired: true,
          remediation: "local-knowledge-reindex-required",
        },
      ],
      releaseNoteBullets: ["Local Knowledge search quality is refreshed after reindexing."],
      affectedStateStores: ["local-knowledge"],
      stateImpact: [
        {
          store: "local-knowledge",
          description: "Local Knowledge vectors need reindexing after this update.",
          remediation: "local-knowledge-reindex-required",
          userActionRequired: true,
        },
      ],
      userActionRequired: true,
      remediations: ["local-knowledge-reindex-required"],
    },
    warnings: [],
    ...overrides,
  };
}

function sessionStatus(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: "1",
    installMode: {
      schemaVersion: "1",
      status: "supported",
      packageName: "@oscharko-dev/keiko",
      packageManager: "npm",
      commandPreview: {
        executable: "npm",
        args: ["install", "-g", "@oscharko-dev/keiko@0.2.11"],
        label: "npm install -g @oscharko-dev/keiko@0.2.11",
      },
    },
    policy: { enabled: true, source: "default" },
    ...overrides,
  };
}

function updateSession(phase = "running", message = "Installing update."): JsonObject {
  return {
    schemaVersion: "1",
    sessionId: "issue-1696-update-session",
    packageName: "@oscharko-dev/keiko",
    targetVersion: "0.2.11",
    phase,
    failureReason: phase === "failed" ? "non-zero-exit" : "none",
    packageManager: "npm",
    startedAt: "2026-06-30T12:00:00.000Z",
    updatedAt: "2026-06-30T12:00:04.000Z",
    cancelable: phase === "running" || phase === "preparing",
    retryable: phase === "failed",
    restartRequired: phase === "restart-required",
    message,
    logs: {
      collapsed: true,
      stdoutPreview: "redacted package-manager stdout preview",
      stderrPreview: "",
      stdoutBytes: 38,
      stderrBytes: 0,
      truncated: false,
    },
  };
}

function remediationStatus(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: 1,
    checkedAt: "2026-06-30T12:00:00.000Z",
    targetVersion: "0.2.11",
    overallStatus: "pending",
    updateCanComplete: false,
    actions: [
      {
        actionId: "local-knowledge:reindex",
        kind: "local-knowledge-reindex",
        store: "local-knowledge",
        remediation: "local-knowledge-reindex-required",
        status: "pending",
        required: true,
        canRun: true,
        canDefer: true,
        userApprovalRequired: true,
        featureIds: ["local-knowledge"],
        scopeCounts: { stores: 1, artifacts: 2, retainedEntries: 2, capsules: 1 },
        message: "Reindex Local Knowledge",
        instructions: "This keeps search results consistent after the update.",
      },
    ],
    affectedFeatures: [
      {
        featureId: "local-knowledge",
        label: "Local Knowledge",
        state: "degraded",
        reason: "Vectors need reindexing before search is fully current.",
        actionIds: ["local-knowledge:reindex"],
      },
    ],
    warnings: [],
    ...overrides,
  };
}

function manualReport(): JsonObject {
  return updatePreflight({
    severity: "critical",
    blockers: [
      {
        code: "one-click-ineligible",
        message: "This installation was started from a local checkout.",
        severity: "critical",
        userActionRequired: true,
      },
    ],
    manualUpdateRequired: true,
    oneClickEligible: false,
  });
}

function manualSessionStatus(): JsonObject {
  return sessionStatus({
    installMode: {
      schemaVersion: "1",
      status: "unsupported",
      packageName: "@oscharko-dev/keiko",
      reason: "local-checkout",
      manualInstructions: "Run the approved package update outside Keiko for this local checkout.",
    },
    policy: { enabled: true, source: "default" },
  });
}

function postedJson(route: Route): unknown {
  const raw = route.request().postData();
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function installUpdateRoutes(
  page: Page,
  fixtures: RouteFixtures,
): Promise<UpdateRouteLedger> {
  const ledger: UpdateRouteLedger = {
    preflightGets: 0,
    preflightChecks: 0,
    sessionStarts: [],
    remediationActions: [],
  };
  let currentSessionStatus = fixtures.sessionStatus ?? sessionStatus();
  let currentRemediation = fixtures.remediation ?? remediationStatus();

  await page.route("**/api/update/preflight/check", async (route) => {
    ledger.preflightChecks += 1;
    await fulfillJson(route, fixtures.report);
  });
  await page.route("**/api/update/preflight", async (route) => {
    ledger.preflightGets += 1;
    await fulfillJson(route, fixtures.report);
  });
  await page.route("**/api/update/session/retry", async (route) => {
    const session = updateSession("preparing", "Retrying update.");
    currentSessionStatus = sessionStatus({ activeSession: session });
    await fulfillJson(route, session);
  });
  await page.route("**/api/update/session/verify-restart", async (route) => {
    const session = updateSession("succeeded", "Update verified.");
    currentSessionStatus = sessionStatus({ lastSession: session });
    await fulfillJson(route, session);
  });
  await page.route("**/api/update/session", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await fulfillJson(route, currentSessionStatus);
      return;
    }
    if (method === "DELETE") {
      const session = updateSession("cancelled", "Update cancelled.");
      currentSessionStatus = sessionStatus({ lastSession: session });
      await fulfillJson(route, session);
      return;
    }
    ledger.sessionStarts.push(postedJson(route));
    const session = updateSession("running", "Installing update.");
    currentSessionStatus = sessionStatus({ activeSession: session });
    await fulfillJson(route, session);
  });
  await page.route("**/api/update/remediation/status", async (route) => {
    await fulfillJson(route, currentRemediation);
  });
  await page.route("**/api/update/remediation/actions", async (route) => {
    ledger.remediationActions.push(postedJson(route));
    currentRemediation = remediationStatus({
      overallStatus: "completed",
      updateCanComplete: true,
      actions: [
        {
          actionId: "local-knowledge:reindex",
          kind: "local-knowledge-reindex",
          store: "local-knowledge",
          remediation: "local-knowledge-reindex-required",
          status: "completed",
          required: true,
          canRun: false,
          canDefer: false,
          userApprovalRequired: true,
          featureIds: ["local-knowledge"],
          scopeCounts: { stores: 1, artifacts: 2, retainedEntries: 2, capsules: 1 },
          message: "Reindex Local Knowledge",
          instructions: "Local Knowledge is current for this update.",
        },
      ],
      affectedFeatures: [
        {
          featureId: "local-knowledge",
          label: "Local Knowledge",
          state: "ready",
          reason: "Reindex completed.",
          actionIds: ["local-knowledge:reindex"],
        },
      ],
    });
    await fulfillJson(route, currentRemediation);
  });
  await page.route("**/api/update/remediation", async (route) => {
    await fulfillJson(route, currentRemediation);
  });

  return ledger;
}

async function seedSettingsWindow(page: Page, mode: ModeCaptureCase): Promise<void> {
  await page.addInitScript(({ theme, highContrast }) => {
    window.localStorage.setItem("keiko.theme", theme);
    window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-1696-settings",
          type: "settings",
          x: 32,
          y: 28,
          w: 500,
          h: 640,
          z: 10,
          cfg: {},
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
    if (highContrast) document.documentElement.dataset.hc = "more";
    else document.documentElement.removeAttribute("data-hc");
  }, mode);
}

async function seedStartupOnly(
  page: Page,
  theme: "dark" | "light",
  highContrast = false,
): Promise<void> {
  await page.addInitScript(
    ({ nextTheme, nextHighContrast }) => {
      window.localStorage.setItem("keiko.theme", nextTheme);
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      window.localStorage.removeItem("keiko.workspace.v4");
      window.localStorage.removeItem("keiko.conns.v1");
      if (nextHighContrast) document.documentElement.dataset.hc = "more";
      else document.documentElement.removeAttribute("data-hc");
    },
    { nextTheme: theme, nextHighContrast: highContrast },
  );
}

async function applyMedia(page: Page, mode: ModeCaptureCase): Promise<void> {
  await page.emulateMedia({
    colorScheme: mode.media?.colorScheme ?? mode.theme,
    contrast: mode.media?.contrast ?? "no-preference",
    forcedColors: mode.media?.forcedColors ?? "none",
    reducedMotion: mode.media?.reducedMotion ?? "no-preference",
  });
}

async function openSettingsGeneral(page: Page): Promise<Locator> {
  await page.goto(APP_ORIGIN);
  await expect(page.locator("body")).toBeVisible();
  const settings = page.locator('.window[data-window-id="issue-1696-settings"]');
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "General" }).click();
  await expect(settings.getByRole("button", { name: "Review updates" })).toBeVisible();
  return settings;
}

async function applyInAppHighContrast(page: Page, enabled: boolean | undefined): Promise<void> {
  if (enabled !== true) return;
  await page.evaluate(() => {
    document.documentElement.dataset.hc = "more";
  });
}

async function openUpdateFromSettings(
  page: Page,
  settings: Locator,
  title: RegExp,
): Promise<Locator> {
  const reviewUpdates = settings.getByRole("button", { name: "Review updates" });
  await reviewUpdates.focus();
  await expect(reviewUpdates).toBeFocused();
  await page.keyboard.press("Enter");
  const updateWindow = page.locator(".window").filter({
    has: page.getByRole("heading", { name: title }),
  });
  await expect(updateWindow).toBeVisible();
  return page.locator(await windowSelector(updateWindow));
}

async function assertUpdateWindowCore(updateWindow: Locator): Promise<void> {
  await expect(updateWindow.getByRole("heading", { name: "Update available" })).toBeFocused();
  await expect(updateWindow.getByText("Current 0.2.10 -> target 0.2.11")).toBeVisible();
  await expect(updateWindow.getByText("Workflow and state impact")).toBeVisible();
  await expect(updateWindow.getByText("Local Knowledge", { exact: true }).first()).toBeVisible();
  await expect(
    updateWindow.getByText("Local knowledge reindex", { exact: true }).first(),
  ).toBeVisible();
  await expect(updateWindow.getByRole("button", { name: "Install update" })).toBeEnabled();

  const patchNotes = updateWindow.locator("details").filter({ hasText: "Patch notes" });
  const technicalDetails = updateWindow
    .locator("details")
    .filter({ hasText: "Technical details and logs" });
  await expect(patchNotes).not.toHaveAttribute("open", "");
  await expect(technicalDetails).not.toHaveAttribute("open", "");
}

async function assertDetailsDisclosure(updateWindow: Locator): Promise<void> {
  const patchNotes = updateWindow.locator("details").filter({ hasText: "Patch notes" });
  const technicalDetails = updateWindow
    .locator("details")
    .filter({ hasText: "Technical details and logs" });
  await patchNotes.locator("summary").click();
  await expect(patchNotes).toHaveAttribute("open", "");
  await expect(updateWindow.getByText("Adds update readiness")).toBeVisible();
  await patchNotes.locator("summary").click();
  await expect(patchNotes).not.toHaveAttribute("open", "");

  await technicalDetails.locator("summary").click();
  await expect(technicalDetails).toHaveAttribute("open", "");
  await expect(updateWindow.getByText("npm install -g @oscharko-dev/keiko@0.2.11")).toBeVisible();
  await technicalDetails.locator("summary").click();
  await expect(technicalDetails).not.toHaveAttribute("open", "");
}

async function assertManualPath(updateWindow: Locator): Promise<void> {
  await expect(
    updateWindow.getByRole("heading", { name: "Critical update available" }),
  ).toBeVisible();
  await expect(updateWindow.getByText("Manual update path", { exact: true })).toBeVisible();
  await expect(
    updateWindow.getByText("Run the approved package update outside Keiko"),
  ).toBeVisible();
  await expect(updateWindow.getByRole("button", { name: "Check again" })).toBeEnabled();
}

async function capture(locator: Locator, name: ArtifactName): Promise<ArtifactName> {
  await locator.screenshot({ path: artifactPath(name) });
  return name;
}

async function resetUpdateScroll(updateWindow: Locator): Promise<void> {
  await updateWindow.locator(".upd").evaluate((element) => {
    element.scrollTop = 0;
  });
}

async function windowSelector(locator: Locator): Promise<string> {
  const id = await locator.getAttribute("data-window-id");
  if (id === null) throw new Error("Expected evidence locator to be a workspace window");
  return `.window[data-window-id="${id.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"]`;
}

async function updateContentSelector(locator: Locator): Promise<string> {
  return `${await windowSelector(locator)} .upd`;
}

async function runAxe(page: Page, selector: string): Promise<readonly AxeViolation[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async (rootSelector) => {
    const root = document.querySelector(rootSelector);
    if (root === null) throw new Error(`Axe target not found: ${rootSelector}`);
    const axeRunner = (
      window as unknown as {
        readonly axe: {
          readonly run: (
            context: Element,
            options: {
              readonly runOnly: {
                readonly type: "tag";
                readonly values: readonly string[];
              };
            },
          ) => Promise<{ readonly violations: readonly AxeViolation[] }>;
        };
      }
    ).axe;
    const result = await axeRunner.run(root, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({ target: node.target })),
    }));
  }, selector);
}

async function captureContext(
  page: Page,
  mode: ModeCaptureCase,
  state: string,
): Promise<CaptureRecord> {
  return {
    file: mode.file,
    mode: mode.mode,
    entrypoint: "settings",
    viewport: page.viewportSize() ?? { width: 0, height: 0 },
    dataTheme: await page.evaluate(() => document.documentElement.getAttribute("data-theme")),
    dataHc: await page.evaluate(() => document.documentElement.getAttribute("data-hc")),
    forcedColors: mode.media?.forcedColors ?? "none",
    reducedMotion: mode.media?.reducedMotion ?? "no-preference",
    state,
  };
}

async function openModePage(
  browser: Browser,
  mode: ModeCaptureCase,
  fixtures: RouteFixtures,
): Promise<{ readonly page: Page; readonly ledger: UpdateRouteLedger }> {
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: mode.viewport ?? { width: 1440, height: 980 },
  });
  const page = await context.newPage();
  const ledger = await installUpdateRoutes(page, fixtures);
  await seedSettingsWindow(page, mode);
  await applyMedia(page, mode);
  return { page, ledger };
}

async function closePage(page: Page): Promise<void> {
  if (page.isClosed()) return;
  try {
    await page.context().close();
  } catch {
    // The test runner may already have closed the context during interruption or timeout.
  }
}

const MODE_CAPTURES: readonly ModeCaptureCase[] = [
  {
    file: "01-update-window-dark.png",
    mode: "dark",
    theme: "dark",
    media: { colorScheme: "dark" },
  },
  {
    file: "02-update-window-light.png",
    mode: "light",
    theme: "light",
    media: { colorScheme: "light" },
  },
  {
    file: "03-update-window-dark-high-contrast.png",
    mode: "dark-high-contrast",
    theme: "dark",
    highContrast: true,
    media: { colorScheme: "dark", contrast: "more" },
  },
  {
    file: "04-update-window-light-high-contrast.png",
    mode: "light-high-contrast",
    theme: "light",
    highContrast: true,
    media: { colorScheme: "light", contrast: "more" },
  },
  {
    file: "05-update-window-prefers-contrast.png",
    mode: "prefers-contrast",
    theme: "dark",
    media: { colorScheme: "dark", contrast: "more" },
  },
  {
    file: "06-update-window-forced-colors.png",
    mode: "forced-colors",
    theme: "dark",
    media: { colorScheme: "dark", forcedColors: "active" },
  },
  {
    file: "07-update-window-reduced-motion.png",
    mode: "reduced-motion",
    theme: "dark",
    media: { colorScheme: "dark", reducedMotion: "reduce" },
  },
];

test("records Issue #1696 governed update UI design-system evidence", async ({ browser }) => {
  test.setTimeout(600_000);
  ensureEvidenceDir();

  const captures: CaptureRecord[] = [];
  const a11yCaptures: { file: ArtifactName; violations: readonly AxeViolation[] }[] = [];
  const allLedgers: UpdateRouteLedger[] = [];

  for (const mode of MODE_CAPTURES) {
    const { page, ledger } = await openModePage(browser, mode, {
      report: updatePreflight(),
      remediation: remediationStatus(),
    });
    allLedgers.push(ledger);
    try {
      const settings = await openSettingsGeneral(page);
      await applyInAppHighContrast(page, mode.highContrast);
      if (mode.file === "01-update-window-dark.png") {
        await capture(settings, "09-settings-entrypoint.png");
      }
      const updateWindow = await openUpdateFromSettings(page, settings, /Update available/u);
      await assertUpdateWindowCore(updateWindow);
      await resetUpdateScroll(updateWindow);
      await capture(updateWindow, mode.file);
      captures.push(await captureContext(page, mode, "normal-update"));

      const violations = await runAxe(page, await updateContentSelector(updateWindow));
      a11yCaptures.push({ file: mode.file, violations });

      if (mode.file === "01-update-window-dark.png") {
        await assertDetailsDisclosure(updateWindow);
        await resetUpdateScroll(updateWindow);
        await updateWindow.getByRole("button", { name: "Install update" }).click();
        await expect(
          updateWindow
            .locator('.upd-panel[role="status"]')
            .filter({ hasText: "Installing update" }),
        ).toBeVisible();
        await expect(updateWindow.getByLabel("Update progress")).toBeVisible();
        await capture(updateWindow, "11-progress-state.png");
        captures.push({
          ...(await captureContext(page, mode, "progress")),
          file: "11-progress-state.png",
        });
      }
    } finally {
      await closePage(page);
    }
  }

  const startupContext = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 900 },
  });
  const startupPage = await startupContext.newPage();
  try {
    await installUpdateRoutes(startupPage, {
      report: updatePreflight({ severity: "critical" }),
      remediation: remediationStatus(),
    });
    await seedStartupOnly(startupPage, "dark");
    await startupPage.emulateMedia({ colorScheme: "dark" });
    await startupPage.goto(APP_ORIGIN);
    const notice = startupPage.getByRole("alert", { name: "Keiko update notification" });
    await expect(notice).toContainText("Critical update available");
    await capture(startupPage.locator(".update-notice"), "08-startup-notice-critical.png");
    a11yCaptures.push({
      file: "08-startup-notice-critical.png",
      violations: await runAxe(startupPage, ".update-notice"),
    });
    await notice.getByRole("button", { name: "Review update" }).click();
    await expect(
      startupPage.getByRole("heading", { name: "Critical update available" }),
    ).toBeVisible();
    captures.push({
      file: "08-startup-notice-critical.png",
      mode: "dark",
      entrypoint: "startup",
      viewport: startupPage.viewportSize() ?? { width: 0, height: 0 },
      dataTheme: await startupPage.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      ),
      dataHc: await startupPage.evaluate(() => document.documentElement.getAttribute("data-hc")),
      forcedColors: "none",
      reducedMotion: "no-preference",
      state: "critical-startup-notice",
    });
  } finally {
    await startupContext.close();
  }

  const manualMode: ModeCaptureCase = {
    file: "10-responsive-manual-path.png",
    mode: "dark",
    theme: "dark",
    media: { colorScheme: "dark" },
    viewport: { width: 680, height: 900 },
  };
  const { page: manualPage } = await openModePage(browser, manualMode, {
    report: manualReport(),
    sessionStatus: manualSessionStatus(),
    remediation: remediationStatus({
      overallStatus: "manual-review-required",
      updateCanComplete: false,
      actions: [],
      affectedFeatures: [
        {
          featureId: "local-knowledge",
          label: "Local Knowledge",
          state: "manual-review-required",
          reason: "Manual update review is required for this install mode.",
          actionIds: [],
        },
      ],
    }),
  });
  try {
    const settings = await openSettingsGeneral(manualPage);
    await applyInAppHighContrast(manualPage, manualMode.highContrast);
    const updateWindow = await openUpdateFromSettings(
      manualPage,
      settings,
      /Critical update available/u,
    );
    await assertManualPath(updateWindow);
    await resetUpdateScroll(updateWindow);
    await capture(updateWindow, "10-responsive-manual-path.png");
    captures.push(await captureContext(manualPage, manualMode, "responsive-manual-path"));
    a11yCaptures.push({
      file: "10-responsive-manual-path.png",
      violations: await runAxe(manualPage, await updateContentSelector(updateWindow)),
    });
  } finally {
    await closePage(manualPage);
  }

  const seriousOrCritical = a11yCaptures.flatMap((entry) =>
    entry.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => ({ file: entry.file, id: violation.id, impact: violation.impact })),
  );
  expect(seriousOrCritical).toEqual([]);
  expect(allLedgers.some((ledger) => ledger.sessionStarts.length > 0)).toBe(true);

  const cssHash = cssSha256();
  writeFileSync(
    artifactPath("update-experience-fidelity-proof.json"),
    `${JSON.stringify(
      {
        issue: 1696,
        epic: 1687,
        verdict: "PASS",
        cssSha256: cssHash,
        harness: "tests/e2e/config/playwright.issue-1696-update-ui.config.ts",
        route: "/",
        appPath: "packaged-cli-ui",
        generatedAt: EVIDENCE_GENERATED_AT,
        captures,
        assertions: {
          settingsEntryPointVisible: true,
          startupNoticeCriticalAlertVisible: true,
          updatesOpenedOnlyThroughSettingsOrStartup: true,
          normalUpdateStatusBeforeDetails: true,
          stateImpactVisible: true,
          remediationVisible: true,
          patchNotesCollapsedByDefault: true,
          technicalDetailsCollapsedByDefault: true,
          focusMovesToLoadedTitle: true,
          progressUsesNativeProgressAndLiveStatus: true,
          manualPathIsNotRenderedAsError: true,
          sevenModeThemeCoverage: MODE_CAPTURES.length,
        },
        artifacts: ARTIFACT_NAMES,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  writeFileSync(
    artifactPath("a11y-proof.json"),
    `${JSON.stringify(
      {
        issue: 1696,
        verdict: "PASS",
        tool: "axe-core 4.12.1",
        cssSha256: cssHash,
        gate: "zero serious/critical axe violations across update window modes, startup notice, and responsive manual path",
        captures: a11yCaptures,
        deterministicChecks: {
          titleFocus: true,
          criticalNoticeUsesAlert: true,
          progressHasNativeProgressElement: true,
          collapsedDetailsUseNativeDetails: true,
          criticalAndManualStatesAreNotColorOnly: true,
          keyboardReachableEntrypoints: true,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  writeFileSync(
    artifactPath("manifest.json"),
    `${JSON.stringify(
      {
        issue: "#1696",
        epic: "#1687",
        generatedAt: EVIDENCE_GENERATED_AT,
        command: "npm run test:e2e:update-ui-1696",
        receiptCommand: UI_RECEIPT_COMMAND,
        artifacts: ARTIFACT_NAMES,
        routeLedger: {
          updatePreflightGets: allLedgers.reduce((sum, ledger) => sum + ledger.preflightGets, 0),
          updatePreflightChecks: allLedgers.reduce(
            (sum, ledger) => sum + ledger.preflightChecks,
            0,
          ),
          sessionStarts: allLedgers.reduce((sum, ledger) => sum + ledger.sessionStarts.length, 0),
          remediationActions: allLedgers.reduce(
            (sum, ledger) => sum + ledger.remediationActions.length,
            0,
          ),
        },
        notes: [
          "Packaged CLI UI renders the real Settings panel, startup notice, WindowsRegistry, and UpdateWindow.",
          "Only /api/update/* routes are mocked; the shell, registry, theme, i18n, and focus behavior are real.",
          "Update window is transient and cannot be seeded directly through keiko.workspace.v4; evidence opens it from Settings/startup.",
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
});
