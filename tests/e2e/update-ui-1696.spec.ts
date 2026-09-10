import { expect, test, type Browser, type Locator, type Page, type Route } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { evidenceArtifactPath, evidenceScreenshotPath } from "./support/evidence.js";

// Issue #3405 (Epic #3403) - current browser qualification for the governed update UI. The test
// boots the packaged CLI UI and opens Updates through the real Settings/startup entry points. Its
// visual fixtures mock only /api/update/* and are explicitly labelled as such; they do not qualify
// native handoff or a production BFF update. The separate @real-bff-outage journey is required CI
// coverage and proves HTTP acceptance, actual BFF stop/restart, reconnect, and durable recovery.

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "design-system", "evidence", "3405");
const APP_ORIGIN = `http://127.0.0.1:${process.env.KEIKO_E2E_UI_PORT ?? "32201"}`;
const OUTAGE_WRAPPER = resolve(REPO_ROOT, "tests/e2e/support/update-bff-outage-3405.mjs");
const PACKAGED_CLI = resolve(REPO_ROOT, "dist/cli/index.js");
const PACKAGED_STATIC_ROOT = resolve(REPO_ROOT, "dist/ui/static");
const EVIDENCE_GENERATED_AT = new Date().toISOString();
const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);
// WCAG 2.0/2.1/2.2 A + AA is the declared evidence standard. `runAxe` returns only rules selected
// by these tags, so every returned violation is gating regardless of axe impact classification.
const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

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
  "12-portable-managed-one-click.png",
  "13-reconnecting-state-mocked.png",
  "14-remediation-pending.png",
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
  readonly evidenceSource: "deterministic-update-api-fixture";
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
  readonly transientSessionReadFailuresAfterStart?: number;
  readonly preflightFailureAtGet?: number;
}

interface UpdateRouteState {
  currentSessionStatus: JsonObject;
  currentRemediation: JsonObject;
  transientSessionReadFailuresAfterStart: number;
  sessionStarted: boolean;
}

interface A11yCapture {
  readonly file: ArtifactName;
  readonly violations: readonly AxeViolation[];
}

interface EvidenceState {
  readonly captures: CaptureRecord[];
  readonly a11yCaptures: A11yCapture[];
  readonly ledgers: UpdateRouteLedger[];
}

interface OutageHarness {
  readonly port: number;
  readonly origin: string;
  readonly root: string;
  readonly stateDir: string;
  readonly launcherCwd: string;
  readonly env: NodeJS.ProcessEnv;
}

function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address !== "object" || address === null) {
        probe.close();
        reject(new Error("Could not reserve a loopback port for the update outage harness"));
        return;
      }
      probe.close((error) => {
        if (error !== undefined) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function createOutageHarness(): Promise<OutageHarness> {
  const root = mkdtempSync(join(realpathSync(homedir()), ".keiko-e2e-update-outage-"));
  const launcherCwd = join(root, "launcher");
  const stateDir = join(root, "state");
  const configPath = join(stateDir, "keiko.e2e.config.json");
  mkdirSync(launcherCwd, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  copyFileSync(resolve(REPO_ROOT, "tests/e2e/fixtures/keiko.e2e.config.json"), configPath);
  writeFileSync(join(launcherCwd, "package.json"), '{"name":"keiko-e2e-outage-launcher"}\n', {
    encoding: "utf8",
    mode: 0o600,
  });
  const port = await freeLoopbackPort();
  return {
    port,
    origin: `http://127.0.0.1:${String(port)}`,
    root,
    stateDir,
    launcherCwd,
    env: {
      ...process.env,
      KEIKO_CLI_BIN_PATH: OUTAGE_WRAPPER,
      KEIKO_UI_STATIC_ROOT: PACKAGED_STATIC_ROOT,
      KEIKO_CONFIG_FILE: configPath,
      KEIKO_E2E_UPDATE_OUTAGE: "1",
    },
  };
}

function runOutageLifecycle(harness: OutageHarness, command: "start" | "stop" | "restart"): string {
  return execFileSync(
    process.execPath,
    [
      PACKAGED_CLI,
      command,
      "--state-dir",
      harness.stateDir,
      ...(command === "stop"
        ? []
        : ["--port", String(harness.port), "--host", "127.0.0.1", "--start-timeout", "60"]),
      ...(command === "stop" || command === "restart" ? ["--stop-timeout", "20"] : []),
    ],
    {
      cwd: harness.launcherCwd,
      env: harness.env,
      encoding: "utf8",
      timeout: 90_000,
    },
  );
}

async function updateStatus(origin: string): Promise<JsonObject> {
  const response = await fetch(`${origin}/api/update/session`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Update status returned ${String(response.status)}`);
  return (await response.json()) as JsonObject;
}

async function fetchUpdatePreflight(origin: string): Promise<JsonObject> {
  const response = await fetch(`${origin}/api/update/preflight`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Update preflight returned ${String(response.status)}`);
  return (await response.json()) as JsonObject;
}

async function originUnavailable(origin: string): Promise<boolean> {
  try {
    await fetch(`${origin}/api/health`, { cache: "no-store" });
    return false;
  } catch {
    return true;
  }
}

async function provePortReusable(port: number): Promise<void> {
  await new Promise<void>((resolveProof, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => {
      probe.close((error) => {
        if (error !== undefined) reject(error);
        else resolveProof();
      });
    });
  });
}

async function cleanupOutageHarness(harness: OutageHarness): Promise<void> {
  runOutageLifecycle(harness, "stop");
  await provePortReusable(harness.port);
  rmSync(harness.root, { recursive: true, force: true });
}

function serverLogRecords(stateDir: string): readonly JsonObject[] {
  return readFileSync(join(stateDir, "logs", "server.log"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonObject);
}

function artifactPath(name: ArtifactName): string {
  if (!ARTIFACT_NAMES.includes(name)) {
    throw new Error("Unexpected Issue #3405 update UI evidence artifact");
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

function screenshotArtifactPath(name: ArtifactName): string {
  return evidenceScreenshotPath(relative(REPO_ROOT, artifactPath(name)));
}

function cssSha256(): string {
  return sourceSha256("packages/keiko-ui/src/app/globals.css");
}

function sourceSha256(path: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(REPO_ROOT, path)))
    .digest("hex");
}

function updateSourceHashes(): JsonObject {
  const paths = [
    "packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.tsx",
    "packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.tsx",
    "packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.module.css",
    "packages/keiko-ui/src/app/components/desktop/update/update-copy.ts",
    "packages/keiko-ui/src/app/globals.css",
    "packages/keiko-ui/src/lib/api.ts",
    "packages/keiko-ui/src/lib/i18n-messages.de.ts",
    "packages/keiko-ui/src/lib/i18n-messages.en.ts",
  ];
  return Object.fromEntries(paths.map((path) => [path, sourceSha256(path)]));
}

function harnessProvenanceHashes(): JsonObject {
  // Deliberately excludes this spec and generated artifacts: adding either would make the proof
  // self-referential. These inputs define the runner, evidence output policy, and real-BFF harness.
  const paths = [
    "tests/e2e/config/playwright.issue-1696-update-ui.config.ts",
    "tests/e2e/fixtures/keiko.e2e.config.json",
    "tests/e2e/support/evidence.ts",
    "tests/e2e/support/update-bff-outage-3405.mjs",
  ];
  return Object.fromEntries(paths.map((path) => [path, sourceSha256(path)]));
}

function patchNotesFixture(): JsonObject {
  return {
    collapsed: true,
    summary: "Plain-language update summary for the governed updater.",
    bullets: [
      "Adds update readiness, state impact, and remediation guidance.",
      "Keeps patch notes and technical details available but secondary.",
    ],
    details: ["Internal package-manager output remains collapsed unless the user opens details."],
  };
}

function releaseFixture(): JsonObject {
  return {
    source: "github-release",
    tag: "v0.2.11",
    title: "Keiko 0.2.11",
    summary: "Governed update experience.",
    notes: ["Review update impact before installing."],
    url: "https://github.com/oscharko-dev/Keiko/releases/tag/v0.2.11",
    publishedAt: "2026-06-30T12:00:00.000Z",
  };
}

function stateImpactFixture(): JsonObject {
  return {
    store: "local-knowledge",
    description: "Local Knowledge vectors need reindexing after this update.",
    remediation: "local-knowledge-reindex-required",
    userActionRequired: true,
  };
}

function updateImpactFixture(): JsonObject {
  return {
    entries: [
      {
        packageVersion: "0.2.11",
        releaseTag: "v0.2.11",
        summary: "Local Knowledge needs a reindex after this update.",
        releaseNoteBullets: ["Local Knowledge search quality is refreshed after reindexing."],
        stateImpact: [stateImpactFixture()],
        userActionRequired: true,
        remediation: "local-knowledge-reindex-required",
      },
    ],
    releaseNoteBullets: ["Local Knowledge search quality is refreshed after reindexing."],
    affectedStateStores: ["local-knowledge"],
    stateImpact: [stateImpactFixture()],
    userActionRequired: true,
    remediations: ["local-knowledge-reindex-required"],
  };
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
    candidate: {
      schemaVersion: "1",
      candidateId: "candidate-0.2.11",
      targetVersion: "0.2.11",
      confirmationDigest: "a".repeat(64),
      executionToken: "b".repeat(64),
      issuedAt: "2026-06-30T12:00:00.000Z",
      expiresAt: "2026-06-30T12:10:00.000Z",
    },
    patchNotes: patchNotesFixture(),
    release: releaseFixture(),
    impact: updateImpactFixture(),
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

const SESSION_LIFECYCLE_PHASES: Readonly<Record<string, string>> = {
  preparing: "preparing",
  "restart-required": "verifying-relaunch",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

function updateSession(phase = "running", message = "Installing update."): JsonObject {
  const lifecyclePhase = SESSION_LIFECYCLE_PHASES[phase] ?? "downloading";
  return {
    schemaVersion: "1",
    sessionId: "issue-1696-update-session",
    candidateId: "candidate-0.2.11",
    candidateDigest: "c".repeat(64),
    correlationId: "update-correlation-1696",
    packageName: "@oscharko-dev/keiko",
    targetVersion: "0.2.11",
    phase,
    lifecycle: {
      phase: lifecyclePhase,
      progress: { completedBytes: 0 },
      cancellationCutoff:
        phase === "running" || phase === "preparing" ? "not-reached" : "handoff-committed",
    },
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

function portableAsset(status = "eligible"): JsonObject {
  return {
    source: "github-release-asset",
    target: "macos-arm64",
    requiredAssetName: "keiko-macos-arm64.zip",
    status,
    asset:
      status === "eligible"
        ? {
            target: "macos-arm64",
            assetName: "keiko-macos-arm64.zip",
            assetId: 120,
            releaseId: 12,
            sizeBytes: 48_000_000,
            sha256: "0".repeat(64),
            manifestAssetName: "macos-arm64-portable-manifest.json",
            manifestSha256: "1".repeat(64),
            checksumAssetName: "macos-arm64-SHA256SUMS.txt",
            checksumVerified: true,
          }
        : undefined,
  };
}

function portableReport(overrides: JsonObject = {}): JsonObject {
  return updatePreflight({
    userActionRequired: false,
    affectedStateStores: [],
    installabilitySource: "github-release-asset",
    portableAsset: portableAsset(),
    impact: undefined,
    ...overrides,
  });
}

function portableBlockedReport(): JsonObject {
  return portableReport({
    manualUpdateRequired: true,
    oneClickEligible: false,
    userActionRequired: true,
    portableAsset: portableAsset("malformed"),
    blockers: [
      {
        code: "portable-checksum-mismatch",
        message: "The release verification file does not match the downloaded update archive.",
        severity: "high",
        userActionRequired: true,
      },
    ],
  });
}

function portableSessionStatus(): JsonObject {
  return sessionStatus({
    installMode: {
      schemaVersion: "1",
      status: "supported",
      packageName: "@oscharko-dev/keiko",
      installKind: "portable-managed",
      installRoot: "/Users/private/Keiko",
      recommendedAction: "portable-managed-update",
      portable: {
        status: "managed",
        target: "macos-arm64",
        updateEligible: true,
        packageVersion: "0.2.10",
        stable: true,
        managedRootKind: "home-relative",
      },
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

function updateRouteLedger(): UpdateRouteLedger {
  return {
    preflightGets: 0,
    preflightChecks: 0,
    sessionStarts: [],
    remediationActions: [],
  };
}

function updateRouteState(fixtures: RouteFixtures): UpdateRouteState {
  return {
    currentSessionStatus: fixtures.sessionStatus ?? sessionStatus(),
    currentRemediation: fixtures.remediation ?? remediationStatus(),
    transientSessionReadFailuresAfterStart: fixtures.transientSessionReadFailuresAfterStart ?? 0,
    sessionStarted: false,
  };
}

async function installPreflightRoutes(
  page: Page,
  fixtures: RouteFixtures,
  ledger: UpdateRouteLedger,
): Promise<void> {
  await page.route("**/api/update/preflight/check", async (route) => {
    ledger.preflightChecks += 1;
    await fulfillJson(route, fixtures.report);
  });
  await page.route("**/api/update/preflight", async (route) => {
    ledger.preflightGets += 1;
    if (ledger.preflightGets === fixtures.preflightFailureAtGet) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "INTERNAL", message: "Update service unavailable" }),
      });
      return;
    }
    await fulfillJson(route, fixtures.report);
  });
}

async function handleSessionRoute(
  route: Route,
  ledger: UpdateRouteLedger,
  state: UpdateRouteState,
): Promise<void> {
  const method = route.request().method();
  if (method === "GET") {
    if (state.sessionStarted && state.transientSessionReadFailuresAfterStart > 0) {
      state.transientSessionReadFailuresAfterStart -= 1;
      await route.abort("connectionrefused");
      return;
    }
    await fulfillJson(route, state.currentSessionStatus);
    return;
  }
  if (method === "DELETE") {
    const session = updateSession("cancelled", "Update cancelled.");
    state.currentSessionStatus = sessionStatus({ lastSession: session });
    await fulfillJson(route, session);
    return;
  }
  ledger.sessionStarts.push(postedJson(route));
  state.sessionStarted = true;
  const session = updateSession("running", "Installing update.");
  state.currentSessionStatus = sessionStatus({ activeSession: session });
  await fulfillJson(route, session);
}

async function installSessionRoutes(
  page: Page,
  ledger: UpdateRouteLedger,
  state: UpdateRouteState,
): Promise<void> {
  await page.route("**/api/update/session/verify-restart", async (route) => {
    const session = updateSession("succeeded", "Update verified.");
    state.currentSessionStatus = sessionStatus({ lastSession: session });
    await fulfillJson(route, session);
  });
  await page.route("**/api/update/session", async (route) => {
    await handleSessionRoute(route, ledger, state);
  });
}

function completedRemediationStatus(): JsonObject {
  return remediationStatus({
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
}

async function installRemediationRoutes(
  page: Page,
  ledger: UpdateRouteLedger,
  state: UpdateRouteState,
): Promise<void> {
  await page.route("**/api/update/remediation/status", async (route) => {
    await fulfillJson(route, state.currentRemediation);
  });
  await page.route("**/api/update/remediation/actions", async (route) => {
    ledger.remediationActions.push(postedJson(route));
    state.currentRemediation = completedRemediationStatus();
    await fulfillJson(route, state.currentRemediation);
  });
  await page.route("**/api/update/remediation", async (route) => {
    await fulfillJson(route, state.currentRemediation);
  });
}

async function installUpdateRoutes(
  page: Page,
  fixtures: RouteFixtures,
): Promise<UpdateRouteLedger> {
  const ledger = updateRouteLedger();
  const state = updateRouteState(fixtures);
  await installPreflightRoutes(page, fixtures, ledger);
  await installSessionRoutes(page, ledger, state);
  await installRemediationRoutes(page, ledger, state);
  return ledger;
}

async function seedSettingsWindow(
  page: Page,
  mode: ModeCaptureCase,
  locale: "en" | "de" = "en",
): Promise<void> {
  await page.addInitScript(
    ({ theme, highContrast, nextLocale }) => {
      window.localStorage.setItem("keiko.theme", theme);
      window.localStorage.setItem("keiko.locale", nextLocale);
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
    },
    { ...mode, nextLocale: locale },
  );
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

async function openSettingsGeneral(
  page: Page,
  origin: string = APP_ORIGIN,
  reviewUpdatesLabel = "Review updates",
  generalTabLabel = "General",
): Promise<Locator> {
  await page.goto(origin);
  await expect(page.locator("body")).toBeVisible();
  const settings = page.locator('.window[data-window-id="issue-1696-settings"]');
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: generalTabLabel }).click();
  await expect(settings.getByRole("button", { name: reviewUpdatesLabel })).toBeVisible();
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
  reviewUpdatesLabel = "Review updates",
): Promise<Locator> {
  const reviewUpdates = settings.getByRole("button", { name: reviewUpdatesLabel });
  await reviewUpdates.focus();
  await expect(reviewUpdates).toBeFocused();
  await page.keyboard.press("Enter");
  const updateWindow = page.locator(".window").filter({
    has: page.getByRole("heading", { name: title }),
  });
  await expect(updateWindow).toBeVisible();
  return page.locator(await windowSelector(updateWindow));
}

async function expectKeyboardFocusVisible(control: Locator): Promise<void> {
  await control.focus();
  await expect(control).toBeFocused();
  await expect
    .poll(() => control.evaluate((element) => element.matches(":focus-visible")))
    .toBe(true);
}

async function expectKeyboardTraversal(page: Page, control: Locator): Promise<void> {
  await expectKeyboardFocusVisible(control);
  await page.keyboard.press("Tab");
  await expect
    .poll(() => control.evaluate((element) => document.activeElement !== element))
    .toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(control).toBeFocused();
}

async function activateWithKeyboard(page: Page, control: Locator): Promise<void> {
  await expectKeyboardFocusVisible(control);
  await page.keyboard.press("Enter");
}

async function assertReflowAt320CssPixels(page: Page, updateWindow: Locator): Promise<void> {
  expect(page.viewportSize()).toEqual({ width: 320, height: 900 });
  const content = updateWindow.locator(".upd");
  await expect(content).toBeVisible();
  await expect
    .poll(() =>
      content.evaluate((element) => {
        const container = element as HTMLElement;
        return container.scrollWidth <= container.clientWidth;
      }),
    )
    .toBe(true);
}

async function assertManualCheckActionIsUnobscuredAt320CssPixels(
  page: Page,
  settings: Locator,
  updateWindow: Locator,
): Promise<void> {
  const checkAgain = updateWindow.getByRole("button", { name: "Check again" });
  const notice = page.getByRole("alert", { name: "Keiko update notification" });
  await expect(checkAgain).toBeVisible();
  // The startup alert remains available before the foreground updater opens. Once it does, the
  // window owns the same update context and the notice must stop covering its manual-path action.
  await expect(notice).not.toBeVisible();
  await expectKeyboardFocusVisible(checkAgain);
  await checkAgain.click();
  await expect(
    updateWindow.getByText(
      "Manual install is still pending. Follow the approved manual instructions, restart Keiko, then check again.",
    ),
  ).toBeVisible();

  await settings.focus();
  await expect(updateWindow).toHaveAttribute("data-top", "false");
  await expect(notice).toBeVisible();
  await page.keyboard.press("Tab");
  await updateWindow.focus();
  await expect(updateWindow).toHaveAttribute("data-top", "true");
  await expect(notice).not.toBeVisible();
}

async function assertStartupNoticeReturnsWhenUpdaterMinimized(
  page: Page,
  updateWindow: Locator,
): Promise<void> {
  const notice = page.getByRole("alert", { name: "Keiko update notification" });
  await updateWindow.locator(".win-traffic-minimize").click();
  await expect(updateWindow).toBeHidden();
  await expect(notice).toBeVisible();
}

async function assertStartupNoticeRemainsWhenUpdaterOnlyHasAnError(
  page: Page,
  settings: Locator,
): Promise<void> {
  const notice = page.getByRole("alert", { name: "Keiko update notification" });
  await expect(notice).toBeVisible();
  const updateWindow = await openUpdateFromSettings(page, settings, /Update status unavailable/u);
  await expect(updateWindow.getByRole("alert")).toContainText("HTTP 503");
  await expect(updateWindow.locator(".upd")).not.toHaveClass(/cmpReady/u);
  await expect(notice).toBeVisible();
}

async function assertUpdateWindowCore(updateWindow: Locator): Promise<void> {
  await expect(updateWindow.getByRole("heading", { name: "Update available" })).toBeFocused();
  await expect(updateWindow.getByText("Current 0.2.10 -> target 0.2.11")).toBeVisible();
  await expect(updateWindow.getByText("Follow-up after install")).toBeVisible();
  await expect(
    updateWindow.getByText("This update will require this after the package is installed."),
  ).toBeVisible();
  await expect(
    updateWindow.getByText("Local Knowledge Reindex", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    updateWindow.getByText("Vectors need reindexing before search is fully current."),
  ).toBeVisible();
  await expect(updateWindow.getByRole("button", { name: "Install update" })).toBeEnabled();

  const patchNotes = updateWindow.locator("details").filter({ hasText: "Patch notes" });
  const technicalDetails = updateWindow
    .locator("details")
    .filter({ hasText: "Technical details and logs" });
  await expect(patchNotes).not.toHaveAttribute("open", "");
  await expect(technicalDetails).not.toHaveAttribute("open", "");
}

async function assertDetailsDisclosure(page: Page, updateWindow: Locator): Promise<void> {
  const patchNotes = updateWindow.locator("details").filter({ hasText: "Patch notes" });
  const technicalDetails = updateWindow
    .locator("details")
    .filter({ hasText: "Technical details and logs" });
  const patchNotesSummary = patchNotes.locator("summary");
  await expectKeyboardTraversal(page, patchNotesSummary);
  await activateWithKeyboard(page, patchNotesSummary);
  await expect(patchNotes).toHaveAttribute("open", "");
  await expect(updateWindow.getByText("Adds update readiness")).toBeVisible();
  await activateWithKeyboard(page, patchNotesSummary);
  await expect(patchNotes).not.toHaveAttribute("open", "");

  const technicalDetailsSummary = technicalDetails.locator("summary");
  await expectKeyboardTraversal(page, technicalDetailsSummary);
  await activateWithKeyboard(page, technicalDetailsSummary);
  await expect(technicalDetails).toHaveAttribute("open", "");
  await expect(technicalDetails.getByText("Registry")).toBeVisible();
  await expect(technicalDetails.getByText("ok")).toBeVisible();
  await expect(technicalDetails.getByText("Release metadata")).toBeVisible();
  await expect(technicalDetails.getByText("live")).toBeVisible();
  await expect(technicalDetails.getByText("Install mode")).toBeVisible();
  await expect(technicalDetails.getByText("supported")).toBeVisible();
  await expect(updateWindow.getByText("npm install -g @oscharko-dev/keiko@0.2.11")).toHaveCount(0);
  await activateWithKeyboard(page, technicalDetailsSummary);
  await expect(technicalDetails).not.toHaveAttribute("open", "");
}

async function assertManualPath(page: Page, updateWindow: Locator): Promise<void> {
  await expect(
    updateWindow.getByRole("heading", { name: "Critical update available" }),
  ).toBeVisible();
  await expect(updateWindow.getByText("Manual update path", { exact: true })).toBeVisible();
  const manualInstructions = updateWindow.locator("details").filter({
    hasText: "Manual update instructions",
  });
  await expect(manualInstructions).not.toHaveAttribute("open", "");
  const manualInstructionsSummary = manualInstructions.locator("summary");
  await expectKeyboardTraversal(page, manualInstructionsSummary);
  await activateWithKeyboard(page, manualInstructionsSummary);
  await expect(manualInstructions).toHaveAttribute("open", "");
  await expect(
    updateWindow.getByText("Run the approved package update outside Keiko"),
  ).toBeVisible();
  await expect(
    updateWindow.getByText("npm install --global --ignore-scripts @oscharko-dev/keiko@0.2.11"),
  ).toBeVisible();
  await expect(
    updateWindow.getByText("yarn global add --ignore-scripts @oscharko-dev/keiko@0.2.11"),
  ).toBeVisible();
  await expect(
    updateWindow.getByText("npm install --global --ignore-scripts @oscharko-dev/keiko@latest"),
  ).toHaveCount(0);
  const copyNpmCommand = updateWindow.getByRole("button", { name: "Copy npm command" });
  await expectKeyboardTraversal(page, copyNpmCommand);
  await activateWithKeyboard(page, copyNpmCommand);
  await expect(copyNpmCommand).toHaveAttribute("data-copied", "true");
  await expect(updateWindow.getByRole("button", { name: "Check again" })).toBeEnabled();
}

async function assertPortableOneClickReady(updateWindow: Locator): Promise<void> {
  await expect(updateWindow.getByRole("heading", { name: "Update available" })).toBeFocused();
  await expect(
    updateWindow.getByText(
      "Click Update. Keiko will download, verify, apply, relaunch, and verify the new version.",
    ),
  ).toBeVisible();
  await expect(updateWindow.getByRole("button", { name: "Update Keiko" })).toBeEnabled();
  await expect(updateWindow.getByText("Manual update path")).toHaveCount(0);
  await expect(updateWindow.getByText("npm", { exact: true })).toHaveCount(0);
}

async function assertPortableOneClickPath(updateWindow: Locator): Promise<void> {
  await assertPortableOneClickReady(updateWindow);
  await updateWindow.getByRole("button", { name: "Update Keiko" }).click();
  await expect(updateWindow.getByLabel("Update progress")).toBeVisible();
}

async function assertPortableBlockedPath(updateWindow: Locator): Promise<void> {
  await expect(updateWindow.getByRole("heading", { name: "Update available" })).toBeFocused();
  await expect(updateWindow.getByText("Update blocked for safety")).toBeVisible();
  await expect(
    updateWindow.getByText(
      "Keiko could not prove that this update file is the official release file. Your current Keiko version was not changed.",
    ),
  ).toBeVisible();
  await expect(updateWindow.getByText("Keep using Keiko normally.")).toBeVisible();
  await expect(updateWindow.getByText("Try again later after the release is fixed.")).toBeVisible();
  await expect(
    updateWindow.getByText("Do not install this downloaded update manually."),
  ).toBeVisible();
  await expect(updateWindow.getByText("Manual update instructions")).toHaveCount(0);
  await expect(updateWindow.getByText("Package-manager commands")).toHaveCount(0);
  await expect(updateWindow.getByText("npm", { exact: true })).toHaveCount(0);
  await expect(updateWindow.getByRole("link", { name: "Open manual download" })).toHaveCount(0);
  const technicalDetails = updateWindow
    .locator("details")
    .filter({ hasText: "Technical details and logs" });
  await technicalDetails.locator("summary").click();
  await expect(
    technicalDetails.getByText(
      "The release verification file does not match the downloaded update archive.",
    ),
  ).toBeVisible();
  await expect(updateWindow.getByRole("button", { name: "Check again" })).toBeEnabled();
}

async function capture(locator: Locator, name: ArtifactName): Promise<ArtifactName> {
  await locator.evaluate(() => document.fonts.ready.then(() => undefined));
  await locator.screenshot({
    path: screenshotArtifactPath(name),
    animations: "disabled",
    caret: "hide",
  });
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
  return page.evaluate(
    async ({ rootSelector, tags }) => {
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
          values: tags,
        },
      });
      return result.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? null,
        nodes: violation.nodes.map((node) => ({ target: node.target })),
      }));
    },
    { rootSelector: selector, tags: [...WCAG_AA_TAGS] },
  );
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
    evidenceSource: "deterministic-update-api-fixture",
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

const MODE_CAPTURES: readonly [ModeCaptureCase, ...ModeCaptureCase[]] = [
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

const MANUAL_MODE: ModeCaptureCase = {
  file: "10-responsive-manual-path.png",
  mode: "dark",
  theme: "dark",
  media: { colorScheme: "dark" },
  viewport: { width: 320, height: 900 },
};

const PORTABLE_MODE: ModeCaptureCase = {
  file: "12-portable-managed-one-click.png",
  mode: "dark",
  theme: "dark",
  media: { colorScheme: "dark" },
};

function noRemediation(): JsonObject {
  return remediationStatus({
    overallStatus: "not-required",
    updateCanComplete: true,
    actions: [],
    affectedFeatures: [],
  });
}

function createEvidenceState(): EvidenceState {
  return { captures: [], a11yCaptures: [], ledgers: [] };
}

async function recordProgressEvidence(
  updateWindow: Locator,
  page: Page,
  mode: ModeCaptureCase,
  evidence: EvidenceState,
): Promise<void> {
  await assertDetailsDisclosure(page, updateWindow);
  await resetUpdateScroll(updateWindow);
  const install = updateWindow.getByRole("button", { name: "Install update" });
  await expectKeyboardTraversal(page, install);
  await activateWithKeyboard(page, install);
  await expect(
    updateWindow.locator('.upd-panel[role="status"]').filter({ hasText: "Installing update" }),
  ).toBeVisible();
  await expect(updateWindow.getByLabel("Update progress")).toBeVisible();
  await capture(updateWindow, "11-progress-state.png");
  evidence.captures.push({
    ...(await captureContext(page, mode, "progress")),
    file: "11-progress-state.png",
  });
}

async function captureModeWindow(
  page: Page,
  mode: ModeCaptureCase,
  evidence: EvidenceState,
): Promise<void> {
  const settings = await openSettingsGeneral(page);
  await applyInAppHighContrast(page, mode.highContrast);
  if (mode.file === "01-update-window-dark.png") {
    await capture(settings, "09-settings-entrypoint.png");
  }
  const updateWindow = await openUpdateFromSettings(page, settings, /Update available/u);
  await assertUpdateWindowCore(updateWindow);
  await resetUpdateScroll(updateWindow);
  await capture(updateWindow, mode.file);
  evidence.captures.push(await captureContext(page, mode, "normal-update"));
  evidence.a11yCaptures.push({
    file: mode.file,
    violations: await runAxe(page, await updateContentSelector(updateWindow)),
  });
  if (mode.file === "01-update-window-dark.png") {
    await recordProgressEvidence(updateWindow, page, mode, evidence);
  }
}

async function recordModeEvidence(
  browser: Browser,
  mode: ModeCaptureCase,
  evidence: EvidenceState,
): Promise<void> {
  const { page, ledger } = await openModePage(browser, mode, {
    report: updatePreflight(),
    remediation: remediationStatus(),
  });
  evidence.ledgers.push(ledger);
  try {
    await captureModeWindow(page, mode, evidence);
  } finally {
    await closePage(page);
  }
}

async function startupCaptureRecord(page: Page): Promise<CaptureRecord> {
  return {
    file: "08-startup-notice-critical.png",
    mode: "dark",
    entrypoint: "startup",
    viewport: page.viewportSize() ?? { width: 0, height: 0 },
    dataTheme: await page.evaluate(() => document.documentElement.getAttribute("data-theme")),
    dataHc: await page.evaluate(() => document.documentElement.getAttribute("data-hc")),
    forcedColors: "none",
    reducedMotion: "no-preference",
    state: "critical-startup-notice",
    evidenceSource: "deterministic-update-api-fixture",
  };
}

async function recordStartupEvidence(browser: Browser, evidence: EvidenceState): Promise<void> {
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    await installUpdateRoutes(page, {
      report: updatePreflight({ severity: "critical" }),
      remediation: remediationStatus(),
    });
    await seedStartupOnly(page, "dark");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(APP_ORIGIN);
    const notice = page.getByRole("alert", { name: "Keiko update notification" });
    await expect(notice).toContainText("Critical update available");
    await capture(page.locator(".update-notice"), "08-startup-notice-critical.png");
    evidence.a11yCaptures.push({
      file: "08-startup-notice-critical.png",
      violations: await runAxe(page, ".update-notice"),
    });
    const reviewUpdate = notice.getByRole("button", { name: "Review update" });
    await expectKeyboardTraversal(page, reviewUpdate);
    await activateWithKeyboard(page, reviewUpdate);
    await expect(page.getByRole("heading", { name: "Critical update available" })).toBeVisible();
    evidence.captures.push(await startupCaptureRecord(page));
  } finally {
    await context.close();
  }
}

function manualRemediation(): JsonObject {
  return remediationStatus({
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
  });
}

async function recordManualEvidence(browser: Browser, evidence: EvidenceState): Promise<void> {
  const { page } = await openModePage(browser, MANUAL_MODE, {
    report: manualReport(),
    sessionStatus: manualSessionStatus(),
    remediation: manualRemediation(),
  });
  try {
    const settings = await openSettingsGeneral(page);
    await applyInAppHighContrast(page, MANUAL_MODE.highContrast);
    const updateWindow = await openUpdateFromSettings(page, settings, /Critical update available/u);
    await assertManualPath(page, updateWindow);
    await assertReflowAt320CssPixels(page, updateWindow);
    await assertManualCheckActionIsUnobscuredAt320CssPixels(page, settings, updateWindow);
    await resetUpdateScroll(updateWindow);
    await capture(updateWindow, "10-responsive-manual-path.png");
    evidence.captures.push(await captureContext(page, MANUAL_MODE, "responsive-manual-path"));
    evidence.a11yCaptures.push({
      file: "10-responsive-manual-path.png",
      violations: await runAxe(page, await updateContentSelector(updateWindow)),
    });
    await assertStartupNoticeReturnsWhenUpdaterMinimized(page, updateWindow);
  } finally {
    await closePage(page);
  }
}

test("retains the startup notice when a foreground updater contains only a load error", async ({
  browser,
}) => {
  const { page } = await openModePage(browser, MANUAL_MODE, {
    report: manualReport(),
    sessionStatus: manualSessionStatus(),
    remediation: manualRemediation(),
    preflightFailureAtGet: 2,
  });
  try {
    const settings = await openSettingsGeneral(page);
    await assertStartupNoticeRemainsWhenUpdaterOnlyHasAnError(page, settings);
  } finally {
    await closePage(page);
  }
});

test("retains the startup notice while a foreground updater is loading", async ({ browser }) => {
  const { page, ledger } = await openModePage(browser, MANUAL_MODE, {
    report: manualReport(),
    sessionStatus: manualSessionStatus(),
    remediation: manualRemediation(),
  });
  let releasePreflight: () => void = () => undefined;
  const preflightRelease = new Promise<void>((resolveRelease) => {
    releasePreflight = resolveRelease;
  });
  let preflightRequests = 0;
  await page.route("**/api/update/preflight", async (route) => {
    preflightRequests += 1;
    if (preflightRequests === 2) await preflightRelease;
    await route.fallback();
  });
  try {
    const settings = await openSettingsGeneral(page);
    const notice = page.getByRole("alert", { name: "Keiko update notification" });
    await expect(notice).toBeVisible();
    const reviewUpdates = settings.getByRole("button", { name: "Review updates" });
    await reviewUpdates.focus();
    await page.keyboard.press("Enter");

    const loadingUpdater = page.locator('.window[data-top="true"]', {
      has: page.locator(".upd-loading"),
    });
    await expect(loadingUpdater).toBeVisible();
    await expect(loadingUpdater.locator(".upd-loading")).toBeVisible();
    await expect(notice).toBeVisible();

    const updateWindow = page.locator(await windowSelector(loadingUpdater));
    releasePreflight();
    await expect(
      updateWindow.getByRole("heading", { name: "Critical update available" }),
    ).toBeVisible();
    await expect(updateWindow.locator(".upd")).toHaveClass(/cmpReady/u);
    await expect(notice).not.toBeVisible();
    expect(ledger.preflightGets).toBe(2);
  } finally {
    releasePreflight();
    await closePage(page);
  }
});

async function recordPortableEvidence(browser: Browser, evidence: EvidenceState): Promise<void> {
  const { page, ledger } = await openModePage(browser, PORTABLE_MODE, {
    report: portableReport(),
    sessionStatus: portableSessionStatus(),
    remediation: noRemediation(),
  });
  evidence.ledgers.push(ledger);
  try {
    const settings = await openSettingsGeneral(page);
    const updateWindow = await openUpdateFromSettings(page, settings, /Update available/u);
    await assertPortableOneClickReady(updateWindow);
    await resetUpdateScroll(updateWindow);
    await capture(updateWindow, PORTABLE_MODE.file);
    evidence.captures.push(await captureContext(page, PORTABLE_MODE, "portable-managed-one-click"));
    evidence.a11yCaptures.push({
      file: PORTABLE_MODE.file,
      violations: await runAxe(page, await updateContentSelector(updateWindow)),
    });
  } finally {
    await closePage(page);
  }
}

async function recordMockedReconnectEvidence(
  browser: Browser,
  evidence: EvidenceState,
): Promise<void> {
  const mode: ModeCaptureCase = {
    file: "13-reconnecting-state-mocked.png",
    mode: "dark",
    theme: "dark",
    media: { colorScheme: "dark" },
  };
  const { page, ledger } = await openModePage(browser, mode, {
    report: updatePreflight(),
    remediation: remediationStatus(),
    transientSessionReadFailuresAfterStart: 1,
  });
  evidence.ledgers.push(ledger);
  try {
    const settings = await openSettingsGeneral(page);
    const updateWindow = await openUpdateFromSettings(page, settings, /Update available/u);
    await updateWindow.getByRole("button", { name: "Install update" }).click();
    await expect(
      updateWindow.getByText(
        "Reconnecting to the local Keiko backend. The last safe update progress is still shown.",
      ),
    ).toBeVisible();
    await expect(updateWindow.getByLabel("Update progress")).toBeVisible();
    await expect(
      updateWindow
        .locator('.upd-check-feedback[role="status"][aria-live="polite"]')
        .filter({ hasText: "Reconnecting to the local Keiko backend." }),
    ).toContainText("Reconnecting to the local Keiko backend.");
    await capture(updateWindow, mode.file);
    evidence.captures.push(await captureContext(page, mode, "mocked-reconnecting"));
    evidence.a11yCaptures.push({
      file: mode.file,
      violations: await runAxe(page, await updateContentSelector(updateWindow)),
    });
  } finally {
    await closePage(page);
  }
}

async function recordRemediationEvidence(browser: Browser, evidence: EvidenceState): Promise<void> {
  const mode: ModeCaptureCase = {
    file: "14-remediation-pending.png",
    mode: "dark",
    theme: "dark",
    media: { colorScheme: "dark" },
  };
  const { page, ledger } = await openModePage(browser, mode, {
    report: updatePreflight(),
    sessionStatus: sessionStatus({ lastSession: updateSession("succeeded", "Update verified.") }),
    remediation: remediationStatus(),
  });
  evidence.ledgers.push(ledger);
  try {
    const settings = await openSettingsGeneral(page);
    const updateWindow = await openUpdateFromSettings(page, settings, /Update installed/u);
    await expect(updateWindow.getByText("Follow-up action", { exact: true })).toBeVisible();
    await expect(updateWindow.getByRole("button", { name: "Run action" })).toBeEnabled();
    await expect(updateWindow.getByRole("button", { name: "Defer" })).toBeEnabled();
    await expect(
      updateWindow.locator('[aria-labelledby="updates-remediation-title"]'),
    ).toHaveAttribute("aria-live", "polite");
    await capture(updateWindow, mode.file);
    evidence.captures.push(await captureContext(page, mode, "mocked-remediation-pending"));
    evidence.a11yCaptures.push({
      file: mode.file,
      violations: await runAxe(page, await updateContentSelector(updateWindow)),
    });
    const runAction = updateWindow.getByRole("button", { name: "Run action" });
    const defer = updateWindow.getByRole("button", { name: "Defer" });
    await expectKeyboardTraversal(page, runAction);
    await expectKeyboardTraversal(page, defer);
    await activateWithKeyboard(page, runAction);
    await expect.poll(() => ledger.remediationActions).toHaveLength(1);
  } finally {
    await closePage(page);
  }
}

async function assertKeyboardCancelAndRetry(browser: Browser): Promise<void> {
  const cancelling = await openModePage(browser, MODE_CAPTURES[0], {
    report: updatePreflight(),
    sessionStatus: sessionStatus({ activeSession: updateSession("running") }),
    remediation: noRemediation(),
  });
  try {
    const settings = await openSettingsGeneral(cancelling.page);
    const updateWindow = await openUpdateFromSettings(
      cancelling.page,
      settings,
      /Installing update/u,
    );
    const cancel = updateWindow.getByRole("button", { name: "Cancel update" });
    await expectKeyboardTraversal(cancelling.page, cancel);
    await activateWithKeyboard(cancelling.page, cancel);
    await expect(updateWindow.getByRole("button", { name: "Check again" })).toBeVisible();
  } finally {
    await closePage(cancelling.page);
  }

  const retrying = await openModePage(browser, MODE_CAPTURES[0], {
    report: updatePreflight(),
    sessionStatus: sessionStatus({ lastSession: updateSession("failed", "Update failed.") }),
    remediation: noRemediation(),
  });
  try {
    const settings = await openSettingsGeneral(retrying.page);
    const updateWindow = await openUpdateFromSettings(retrying.page, settings, /Update failed/u);
    const retry = updateWindow.getByRole("button", { name: "Retry update" });
    await expectKeyboardTraversal(retrying.page, retry);
    await activateWithKeyboard(retrying.page, retry);
    await expect.poll(() => retrying.ledger.preflightChecks).toBe(1);
  } finally {
    await closePage(retrying.page);
  }
}

test("keeps English and German update controls, focus, and live semantics in parity", async ({
  browser,
}) => {
  const english = await openModePage(browser, MODE_CAPTURES[0], {
    report: updatePreflight(),
    remediation: remediationStatus(),
  });
  try {
    const settings = await openSettingsGeneral(english.page);
    const updateWindow = await openUpdateFromSettings(english.page, settings, /Update available/u);
    await expect(updateWindow.getByRole("heading", { name: "Update available" })).toBeFocused();
    await updateWindow.getByRole("button", { name: "Install update" }).click();
    await expect(updateWindow.getByLabel("Update progress")).toBeVisible();
    await expect(updateWindow.locator('[role="status"][aria-live="polite"]')).toBeVisible();
  } finally {
    await closePage(english.page);
  }

  const german = await openModePage(browser, MODE_CAPTURES[0], {
    report: updatePreflight(),
    remediation: remediationStatus(),
  });
  try {
    await seedSettingsWindow(german.page, MODE_CAPTURES[0], "de");
    const settings = await openSettingsGeneral(
      german.page,
      APP_ORIGIN,
      "Updates prüfen",
      "Allgemein",
    );
    const updateWindow = await openUpdateFromSettings(
      german.page,
      settings,
      /Update verfügbar/u,
      "Updates prüfen",
    );
    await expect(german.page.locator("html")).toHaveAttribute("lang", "de");
    await expect(updateWindow.getByRole("heading", { name: "Update verfügbar" })).toBeFocused();
    await updateWindow.getByRole("button", { name: "Update installieren" }).click();
    await expect(updateWindow.getByLabel("Update-Fortschritt")).toBeVisible();
    await expect(updateWindow.locator('[role="status"][aria-live="polite"]')).toBeVisible();
  } finally {
    await closePage(german.page);
  }
});

function wcagA11yFindings(a11yCaptures: readonly A11yCapture[]): JsonObject[] {
  return a11yCaptures.flatMap((entry) =>
    entry.violations.map((violation) => ({
      file: entry.file,
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes,
    })),
  );
}

function writeJsonArtifact(name: ArtifactName, value: unknown): void {
  writeFileSync(
    evidenceArtifactPath(relative(REPO_ROOT, artifactPath(name))),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function routeLedgerSummary(ledgers: readonly UpdateRouteLedger[]): JsonObject {
  return {
    updatePreflightGets: ledgers.reduce((sum, ledger) => sum + ledger.preflightGets, 0),
    updatePreflightChecks: ledgers.reduce((sum, ledger) => sum + ledger.preflightChecks, 0),
    sessionStarts: ledgers.reduce((sum, ledger) => sum + ledger.sessionStarts.length, 0),
    remediationActions: ledgers.reduce((sum, ledger) => sum + ledger.remediationActions.length, 0),
  };
}

function writeFidelityProof(captures: readonly CaptureRecord[], cssHash: string): void {
  writeJsonArtifact("update-experience-fidelity-proof.json", {
    issue: 3405,
    epic: 3403,
    verdict: "PASS",
    cssSha256: cssHash,
    sourceSha256: updateSourceHashes(),
    harnessProvenanceSha256: harnessProvenanceHashes(),
    harness: "tests/e2e/config/playwright.issue-1696-update-ui.config.ts",
    route: "/",
    appPath: "packaged-cli-ui",
    generatedAt: EVIDENCE_GENERATED_AT,
    visualFixtureScope:
      "All screenshot captures use deterministic /api/update/* fixtures. They prove rendered UI behavior only, never native handoff, real package replacement, or production-BFF update success.",
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
      reconnectingVisualIsExplicitlyMocked: true,
      pendingRemediationIsCaptured: true,
      englishAndGermanFocusAndLiveParity: true,
      manualPathIsNotRenderedAsError: true,
      sevenModeThemeCoverage: MODE_CAPTURES.length,
      reflowAt320CssPixels: true,
      startupNoticeYieldsToOpenUpdateWindowAt320CssPixels: true,
      keyboardTraversalAndActivation: true,
    },
    artifacts: ARTIFACT_NAMES,
  });
}

function writeA11yProof(a11yCaptures: readonly A11yCapture[], cssHash: string): void {
  writeJsonArtifact("a11y-proof.json", {
    issue: 3405,
    epic: 3403,
    verdict: "PASS",
    tool: "axe-core 4.12.1",
    cssSha256: cssHash,
    sourceSha256: updateSourceHashes(),
    harnessProvenanceSha256: harnessProvenanceHashes(),
    wcagTags: WCAG_AA_TAGS,
    gate: "zero axe violations for WCAG 2.0/2.1/2.2 A and AA tags across update window modes, startup notice, and responsive manual path",
    captures: a11yCaptures,
    deterministicChecks: {
      titleFocus: true,
      criticalNoticeUsesAlert: true,
      progressHasNativeProgressElement: true,
      collapsedDetailsUseNativeDetails: true,
      criticalAndManualStatesAreNotColorOnly: true,
      keyboardReachableEntrypoints: true,
      englishAndGermanFocusAndLiveParity: true,
      responsiveManualPathReflowsAt320CssPixels: true,
      startupNoticeYieldsToOpenUpdateWindowAt320CssPixels: true,
    },
  });
}

function writeManifest(ledgers: readonly UpdateRouteLedger[]): void {
  writeJsonArtifact("manifest.json", {
    issue: 3405,
    epic: 3403,
    generatedAt: EVIDENCE_GENERATED_AT,
    command: "npm run test:e2e:update-ui-1696",
    requiredCiCommand: "npm run test:e2e:update-ui-1696 -- --grep @real-bff-outage",
    artifacts: ARTIFACT_NAMES,
    routeLedger: routeLedgerSummary(ledgers),
    sourceSha256: updateSourceHashes(),
    harnessProvenanceSha256: harnessProvenanceHashes(),
    notes: [
      "Packaged CLI UI renders the real Settings panel, startup notice, WindowsRegistry, and UpdateWindow.",
      "Only /api/update/* routes are mocked for screenshot and axe artifacts; the shell, registry, theme, i18n, and focus behavior are real.",
      "Update window is transient and cannot be seeded directly through keiko.workspace.v4; evidence opens it from Settings/startup.",
      "13-reconnecting-state-mocked.png is a deterministic transport-failure fixture and is not real-BFF evidence.",
      "The separately required @real-bff-outage test proves accepted HTTP start, actual BFF stop/restart, reconnect, and durable recovery-required projection. It does not claim native N-1-to-N replacement or production update success.",
    ],
  });
}

function writeEvidenceArtifacts(evidence: EvidenceState): void {
  const cssHash = cssSha256();
  writeFidelityProof(evidence.captures, cssHash);
  writeA11yProof(evidence.a11yCaptures, cssHash);
  writeManifest(evidence.ledgers);
}

test("fails the updater WCAG evidence gate for moderate and minor findings", () => {
  const findings = wcagA11yFindings([
    {
      file: "01-update-window-dark.png",
      violations: [
        { id: "color-contrast", impact: "moderate", nodes: [{ target: [".upd-primary-btn"] }] },
        { id: "landmark-one-main", impact: "minor", nodes: [{ target: [".upd"] }] },
      ],
    },
  ]);

  expect(findings).toEqual([
    {
      file: "01-update-window-dark.png",
      id: "color-contrast",
      impact: "moderate",
      nodes: [{ target: [".upd-primary-btn"] }],
    },
    {
      file: "01-update-window-dark.png",
      id: "landmark-one-main",
      impact: "minor",
      nodes: [{ target: [".upd"] }],
    },
  ]);
});

test("routes default updater JSON and PNG evidence into one untracked output root", () => {
  const previousWritePolicy = process.env.KEIKO_WRITE_TRACKED_EVIDENCE;
  try {
    delete process.env.KEIKO_WRITE_TRACKED_EVIDENCE;
    const trackedManifest = artifactPath("manifest.json");
    const trackedScreenshot = artifactPath("01-update-window-dark.png");
    const manifestBefore = readFileSync(trackedManifest);
    const screenshotBefore = readFileSync(trackedScreenshot);
    const outputs = ARTIFACT_NAMES.map((name) =>
      name.endsWith(".png")
        ? screenshotArtifactPath(name)
        : evidenceArtifactPath(relative(REPO_ROOT, artifactPath(name))),
    );
    const outputDirs = new Set(outputs.map((output) => dirname(resolve(REPO_ROOT, output))));

    expect(outputs.every((output) => !resolve(REPO_ROOT, output).startsWith(EVIDENCE_DIR))).toBe(
      true,
    );
    expect(outputDirs).toEqual(
      new Set([
        resolve(REPO_ROOT, "test-results", "e2e-evidence", "design-system", "evidence", "3405"),
      ]),
    );
    writeJsonArtifact("manifest.json", { regression: "default evidence output is untracked" });
    expect(readFileSync(trackedManifest)).toEqual(manifestBefore);
    expect(readFileSync(trackedScreenshot)).toEqual(screenshotBefore);
  } finally {
    if (previousWritePolicy === undefined) delete process.env.KEIKO_WRITE_TRACKED_EVIDENCE;
    else process.env.KEIKO_WRITE_TRACKED_EVIDENCE = previousWritePolicy;
  }
});

test("@real-bff-outage preserves accepted update progress and reconnects to durable recovery-required state", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const harness = await createOutageHarness();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    expect(runOutageLifecycle(harness, "start")).toContain("Starting Keiko UI");
    expect(readFileSync(join(harness.stateDir, "ui.log"), "utf8")).toContain(
      "KEIKO_E2E_UPDATE_OUTAGE_BFF",
    );
    const offered = await fetchUpdatePreflight(harness.origin);
    expect(offered, `real-BFF preflight:\n${JSON.stringify(offered, undefined, 2)}`).toHaveProperty(
      "candidate",
    );

    await seedSettingsWindow(page, {
      file: "01-update-window-dark.png",
      mode: "dark",
      theme: "dark",
    });
    const settings = await openSettingsGeneral(page, harness.origin);
    const updateWindow = await openUpdateFromSettings(page, settings, /Update available/u);
    await updateWindow.getByRole("button", { name: "Install update" }).click();

    await expect
      .poll(() => updateStatus(harness.origin))
      .toMatchObject({
        activeSession: {
          phase: "running",
          lifecycle: { phase: "activating", cancellationCutoff: "mutation-started" },
        },
      });
    await expect(updateWindow.getByRole("heading", { name: "Installing update" })).toBeVisible();
    await expect(updateWindow.getByLabel("Update progress")).toBeVisible();

    runOutageLifecycle(harness, "stop");
    await expect.poll(() => originUnavailable(harness.origin)).toBe(true);
    await expect(
      updateWindow.getByText(
        "Reconnecting to the local Keiko backend. The last safe update progress is still shown.",
      ),
    ).toBeVisible();
    await expect(updateWindow.getByLabel("Update progress")).toBeVisible();

    expect(runOutageLifecycle(harness, "restart")).toContain("Starting Keiko UI");
    await expect
      .poll(() => updateStatus(harness.origin))
      .toMatchObject({
        activeSession: {
          phase: "restart-required",
          lifecycle: { phase: "recovery-required", cancellationCutoff: "mutation-started" },
          restartRequired: true,
          retryable: false,
        },
      });
    await expect(updateWindow.getByRole("heading", { name: "Restart required" })).toBeVisible();
    await expect(updateWindow.getByRole("button", { name: "Verify restart" })).toBeVisible();
    await expect(updateWindow.getByText("Reconnecting to the local Keiko backend.")).toHaveCount(0);

    const records = serverLogRecords(harness.stateDir);
    expect(
      records.find(
        (record) =>
          record.op === "request" &&
          record.method === "POST" &&
          record.path === "/api/update/session",
      ),
    ).toMatchObject({
      routeTemplate: "/api/update/session",
      status: 202,
    });
    const lifecycle = records.find(
      (record) =>
        record.op === "update.session.lifecycle" &&
        record.eventKind === "transition" &&
        record.phase === "activating",
    );
    expect(lifecycle).toMatchObject({
      category: "diagnostic",
      phase: "activating",
      cancellationCutoff: "mutation-started",
    });
    expect(lifecycle?.correlationId).toEqual(expect.any(String));
    const rawLog = readFileSync(join(harness.stateDir, "logs", "server.log"), "utf8");
    expect(rawLog).not.toContain("executionToken");
    expect(rawLog).not.toContain("confirmationDigest");
  } finally {
    try {
      await closePage(page);
    } finally {
      await cleanupOutageHarness(harness);
    }
  }
});

test("covers Issue #1958 portable update window paths", async ({ browser }) => {
  const eligible = await openModePage(browser, PORTABLE_MODE, {
    report: portableReport(),
    sessionStatus: portableSessionStatus(),
    remediation: noRemediation(),
  });
  try {
    const settings = await openSettingsGeneral(eligible.page);
    const updateWindow = await openUpdateFromSettings(eligible.page, settings, /Update available/u);
    await assertPortableOneClickPath(updateWindow);
    expect(eligible.ledger.sessionStarts).toEqual([
      {
        candidateId: "candidate-0.2.11",
        confirmationDigest: "a".repeat(64),
        executionToken: "b".repeat(64),
      },
    ]);
  } finally {
    await closePage(eligible.page);
  }

  const blocked = await openModePage(browser, PORTABLE_MODE, {
    report: portableBlockedReport(),
    sessionStatus: portableSessionStatus(),
    remediation: noRemediation(),
  });
  try {
    const settings = await openSettingsGeneral(blocked.page);
    const updateWindow = await openUpdateFromSettings(blocked.page, settings, /Update available/u);
    await assertPortableBlockedPath(updateWindow);
  } finally {
    await closePage(blocked.page);
  }
});

test("records Issue #3405 governed update UI design-system evidence", async ({ browser }) => {
  test.setTimeout(600_000);
  const evidence = createEvidenceState();
  for (const mode of MODE_CAPTURES) {
    await recordModeEvidence(browser, mode, evidence);
  }
  await recordStartupEvidence(browser, evidence);
  await recordManualEvidence(browser, evidence);
  await recordPortableEvidence(browser, evidence);
  await recordMockedReconnectEvidence(browser, evidence);
  await recordRemediationEvidence(browser, evidence);
  await assertKeyboardCancelAndRetry(browser);
  expect(wcagA11yFindings(evidence.a11yCaptures)).toEqual([]);
  expect(evidence.ledgers.some((ledger) => ledger.sessionStarts.length > 0)).toBe(true);
  writeEvidenceArtifacts(evidence);
});
