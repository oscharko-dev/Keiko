import { expect, test, type CDPSession, type Page, type Response } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePaddedFixtureFiles } from "./support/editorWorkspace.js";
import { clickWindowChromeButton } from "./support/window-chrome.js";
import { editorModifier, focusMonacoInput } from "./support/editor-chord.js";

// Number of cold-start samples: kept at 3 for the manual/release-evidence smoke, raised (>=10) in the
// scheduled/CI perf job via KEIKO_PERF_RUNS so p50/p95 are stable rather than the max of 3 noisy
// samples (GEN-PERF-BENCHMARK-013).
function resolveMeasuredRuns(): number {
  const raw = process.env.KEIKO_PERF_RUNS;
  if (raw === undefined) return 3;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
}

const D12_REVISION =
  process.env.KEIKO_PERF_D12_REVISION ??
  (process.env.KEIKO_PERF_D12_COMMON === "1" ? "baseline" : undefined);
if (D12_REVISION !== undefined && D12_REVISION !== "baseline" && D12_REVISION !== "candidate") {
  throw new Error("KEIKO_PERF_D12_REVISION must be baseline or candidate");
}
const D12_COMPARISON = D12_REVISION !== undefined;
const SHA_256 = /^[0-9a-f]{64}$/u;
const requireFromSpec = createRequire(import.meta.url);
// D12 measures both checkout apps through this spec's Playwright harness, not the checkout cwd.
const PLAYWRIGHT_TEST_VERSION = packageVersionFromSpec("@playwright/test");

function packageVersionFromSpec(packageName: string): string {
  const packageJson = requireFromSpec(`${packageName}/package.json`) as unknown;
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("version" in packageJson) ||
    typeof packageJson.version !== "string"
  ) {
    throw new Error(`${packageName} package.json must expose a version string`);
  }
  return packageJson.version;
}

function resolveD12Digest(name: string): string | undefined {
  if (D12_REVISION === undefined) return undefined;
  const value = process.env[name];
  if (value === undefined || !SHA_256.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest for a D12 run`);
  }
  return value;
}

const D12_SOURCE_TREE_SHA_256 = resolveD12Digest("KEIKO_PERF_SOURCE_TREE_SHA256");
const D12_MEASUREMENT_HARNESS_SHA_256 = resolveD12Digest("KEIKO_PERF_MEASUREMENT_HARNESS_SHA256");

// Stamp the commit the evidence was measured at for the freshness gate (GEN-PERF-BENCHMARK-001).
function resolveCommit(): string {
  const fromEnv =
    D12_REVISION === undefined
      ? (process.env.GITHUB_SHA ?? process.env.KEIKO_PERF_COMMIT)
      : process.env.KEIKO_PERF_COMMIT;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function commandVersion(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: "utf8" }).trim();
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveD12RunProvenance(page: Page): D12RunProvenance | null {
  if (D12_REVISION === undefined) return null;
  const browser = page.context().browser();
  if (browser === null) throw new Error("D12 browser provenance is unavailable");
  const cpu = cpus();
  return {
    architecture: arch(),
    chromiumVersion: browser.version(),
    hardware: {
      cpuModel: cpu[0]?.model ?? "unknown",
      logicalCores: cpu.length,
      memoryBytes: totalmem(),
    },
    lockfileSha256: fileSha256(join(process.cwd(), "package-lock.json")),
    nodeVersion: process.version.replace(/^v/u, ""),
    npmVersion: commandVersion("npm", ["--version"]),
    osRelease: release(),
    platform: platform(),
    playwrightVersion: PLAYWRIGHT_TEST_VERSION,
    zlibVersion: process.versions.zlib,
  };
}

/**
 * Keiko Editor browser-measured release evidence (Issue #1209; ADR-0042 D3.6 §B4/B5/B6/B11).
 *
 * ADR-0042 D3.6 assigns #1207 to "measure and enforce" the deterministic budgets and #1209 to "record
 * release evidence" for the budgets that require a real browser and the editor running against the
 * real app path. This `@release-evidence` spec opens the Workspace editor card against the packaged
 * UI/server path and records, into `docs/release/1209-perf-evidence.json`:
 *
 *   B4   first-card-open cold-start (open -> interactive), p50/p95 across repeats
 *   B5   per-keystroke main-thread work (longest long task during a typing burst)
 *   B6   editor interaction-to-next-paint proxy (Event Timing durations, p75/max)
 *   B11  worker/model heap growth across open/close cycles and residual after close
 *   +    the runtime worker-load capture proving the governed editor instantiates only the editor
 *        worker — the TS/JSON/CSS/HTML language workers are not shipped by the governed v1 factory
 *
 * This spec is not part of the required `@smoke` set; it is the reusable release-evidence harness,
 * run via `npm run test:e2e:editor-perf`.
 */

const RELATIVE_PATH = "packages/keiko-cli/src/run.ts";
const HELPER_PATH = "packages/keiko-cli/src/helper.ts";
const RUN_TEXT = `import { helper } from "./helper.js";

export const e2eFixture = helper();
`;
const HELPER_TEXT = `export function helper(): boolean {
  return true;
}
`;
const EVIDENCE_PATH =
  process.env.KEIKO_PERF_EVIDENCE_PATH === undefined
    ? join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "docs",
        "release",
        "1209-perf-evidence.json",
      )
    : resolve(process.env.KEIKO_PERF_EVIDENCE_PATH);
const tempProjects: string[] = [];
const IDLE_DEBUG_INTERVAL_MS = 1_100;

interface TypingMetrics {
  readonly longTasks: number[];
  readonly events: number[];
  readonly interactionDurations: number[];
  readonly keystrokeMainThreadWork: number[];
  observerInstalled?: boolean;
  landed?: boolean;
  activeElement?: string;
}

interface JsonResponse {
  readonly body: unknown;
  readonly etag: string | null;
  readonly status: number;
}

interface IdleDebugSession {
  readonly activationRevision: number;
  readonly sessionId: string;
  readonly workspaceId: string;
}

interface IdleDebugSessionSnapshot {
  readonly outputAcceptedBytes: number;
  readonly status: "paused" | "running";
}

interface IdleDebugMetrics {
  readonly longTasks: readonly number[];
  readonly longTaskObserverInstalled: boolean;
  readonly matchedInputEventCounts: readonly number[];
  readonly processingSamples: readonly number[];
  readonly session: IdleDebugSessionSnapshot;
  readonly traceCaptured: boolean;
}

interface D12BaselineMeasuredWork {
  readonly captured: boolean;
  readonly expectedSampleCount: number;
  readonly longTaskCount: number;
  readonly matchedInputEventCounts: readonly number[];
  readonly maxLongTaskMs: number;
  readonly processingSamples: readonly number[];
  readonly totalMatchedInputEvents: number;
  readonly traceCaptured: boolean;
}

let d12BaselineMeasuredWork: D12BaselineMeasuredWork | null = null;

interface D12RunProvenance {
  readonly architecture: string;
  readonly chromiumVersion: string;
  readonly hardware: {
    readonly cpuModel: string;
    readonly logicalCores: number;
    readonly memoryBytes: number;
  };
  readonly lockfileSha256: string;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly osRelease: string;
  readonly platform: string;
  readonly playwrightVersion: string;
  readonly zlibVersion: string;
}

let d12RunProvenance: D12RunProvenance | null = null;

interface TraceEvent {
  readonly args: unknown;
  readonly dur: number;
  readonly name: string;
  readonly phase: string;
}

interface IdleDebugEvidence {
  readonly attempted: boolean;
  readonly budgetMax: number;
  readonly captured: boolean;
  readonly expectedSampleCount: number;
  readonly idleIntervalMs: number;
  readonly longTaskCount: number;
  readonly matchedInputEventCounts: readonly number[];
  readonly maxLongTaskMs: number;
  readonly outputAcceptedBytes: number | null;
  readonly p95: number;
  readonly processingSamples: readonly number[];
  readonly sessionStatus: "paused" | "running" | null;
  readonly totalMatchedInputEvents: number;
  readonly traceCaptured: boolean;
}

const TYPING_CHUNKS = Array.from("export const greeting = 'keiko editor performance evidence';");

const UNMEASURED_IDLE_DEBUG_EVIDENCE: IdleDebugEvidence = {
  attempted: false,
  budgetMax: 50,
  captured: false,
  expectedSampleCount: TYPING_CHUNKS.length,
  idleIntervalMs: IDLE_DEBUG_INTERVAL_MS,
  longTaskCount: 0,
  matchedInputEventCounts: [],
  maxLongTaskMs: 0,
  outputAcceptedBytes: null,
  p95: 0,
  processingSamples: [],
  sessionStatus: null,
  totalMatchedInputEvents: 0,
  traceCaptured: false,
};

interface MemoryMetrics {
  supported: boolean;
  baselineBytes: number | null;
  peakBytes: number | null;
  residualBytes: number | null;
  cycles: number;
}

interface NavigationOperationMetrics {
  readonly samples: readonly number[];
  readonly resultCounts: readonly number[];
}

interface NavigationMetrics {
  readonly definition: NavigationOperationMetrics;
  readonly references: NavigationOperationMetrics;
}

// Realistic multi-file TS program (audit defect #2): a genuine cross-file type dependency chain plus
// a fan-in aggregate, so the project-aware diagnostics pass this harness measures actually builds and
// semantically checks a non-trivial program instead of two three-line files. `FIXTURE_MODULE_DIR`
// sits under the fixture's tsconfig `include` glob, so every generated file becomes a program root
// file the TypeScript service must read and check, whether or not run.ts/helper.ts import it.
const FIXTURE_MODULE_DIR = "packages/keiko-cli/src/fixtures";
const CHAIN_MODULE_COUNT = 24;

function moduleBaseName(index: number): string {
  return `module${String(index).padStart(2, "0")}`;
}

function firstChainModuleContent(): string {
  return `export interface FixtureRecord {
  readonly id: string;
  readonly value: number;
}

export function makeFixtureRecord(id: string, value: number): FixtureRecord {
  return { id, value };
}
`;
}

function chainModuleContent(index: number): string {
  const previous = moduleBaseName(index - 1);
  return `import type { FixtureRecord } from "./${previous}.js";
import { makeFixtureRecord } from "./${previous}.js";

export function transform${String(index).padStart(2, "0")}(input: FixtureRecord): FixtureRecord {
  return makeFixtureRecord(input.id, input.value + 1);
}
`;
}

function aggregateImportLine(index: number): string {
  const name = moduleBaseName(index);
  return index === 0
    ? `import { makeFixtureRecord } from "./${name}.js";`
    : `import { transform${String(index).padStart(2, "0")} } from "./${name}.js";`;
}

function aggregateModuleContent(count: number): string {
  const imports = Array.from({ length: count }, (_, index) => aggregateImportLine(index)).join(
    "\n",
  );
  const calls = Array.from(
    { length: count - 1 },
    (_, offset) => `transform${String(offset + 1).padStart(2, "0")}`,
  );
  return `${imports}

// Fan-in aggregate: exercises every chained module in one semantic pass (breadth, not just depth).
export const fixtureTransforms = [${calls.join(", ")}] as const;
export const fixtureSeed = makeFixtureRecord("seed", 0);
`;
}

/** Write a CHAIN_MODULE_COUNT-deep real import chain plus a fan-in aggregate under the project root. */
function writeFixtureModuleChain(root: string): void {
  const dir = join(root, FIXTURE_MODULE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${moduleBaseName(0)}.ts`), firstChainModuleContent(), "utf8");
  for (let index = 1; index < CHAIN_MODULE_COUNT; index += 1) {
    writeFileSync(join(dir, `${moduleBaseName(index)}.ts`), chainModuleContent(index), "utf8");
  }
  writeFileSync(join(dir, "aggregate.ts"), aggregateModuleContent(CHAIN_MODULE_COUNT), "utf8");
}

function createProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-perf-"));
  tempProjects.push(root);
  mkdirSync(join(root, "packages", "keiko-cli", "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Keiko perf fixture\n", "utf8");
  // Debug activation is deliberately guarded by a human script-trust grant. The performance
  // fixture is a real workspace, so provide the minimal regular manifest that this grant binds.
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "keiko-editor-performance-fixture", private: true }),
    "utf8",
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
      },
      include: ["packages/**/*.ts"],
    }),
    "utf8",
  );
  writeFileSync(join(root, RELATIVE_PATH), RUN_TEXT, "utf8");
  writeFileSync(join(root, HELPER_PATH), HELPER_TEXT, "utf8");
  writeFixtureModuleChain(root);
  return root;
}

// Adversarial near-cap workspace (audit defect #2): total padding bytes exceed
// LanguageServiceLimits.maxWorkspaceReadBytes (4_000_000; packages/keiko-contracts/src/
// language-service.ts DEFAULT_LANGUAGE_SERVICE_LIMITS) while every individual padding file stays
// under maxWorkspaceReadFileBytes (1_000_000), so only the AGGREGATE workspace-read budget trips —
// proving the project-aware diagnostics pass degrades gracefully (truncates) instead of reading the
// whole tree unbounded or failing outright.
const ADVERSARIAL_PADDING_FILE_COUNT = 5;
const ADVERSARIAL_PADDING_FILE_BYTES = 900_000;
const WORKSPACE_READ_BYTES_BUDGET = 4_000_000;

function createAdversarialWorkspaceFixture(): string {
  const root = createProjectFixture();
  writePaddedFixtureFiles(
    root,
    "packages/keiko-cli/src/padding",
    ADVERSARIAL_PADDING_FILE_COUNT,
    ADVERSARIAL_PADDING_FILE_BYTES,
  );
  return root;
}

interface WorkspaceCapDegradationEvidence {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly statusCode: number | null;
  readonly errorCode: string | null;
  readonly paddingFileCount: number;
  readonly paddingBytesPerFile: number;
  readonly workspaceReadBytesBudget: number;
}

const UNMEASURED_WORKSPACE_CAP_DEGRADATION: WorkspaceCapDegradationEvidence = {
  attempted: false,
  ok: false,
  truncated: false,
  durationMs: 0,
  statusCode: null,
  errorCode: null,
  paddingFileCount: ADVERSARIAL_PADDING_FILE_COUNT,
  paddingBytesPerFile: ADVERSARIAL_PADDING_FILE_BYTES,
  workspaceReadBytesBudget: WORKSPACE_READ_BYTES_BUDGET,
};

/**
 * Probe diagnostics for the primary fixture file against the ADVERSARIAL near-cap workspace: proves
 * the project-aware TS service degrades gracefully (`result.truncated === true`, a healthy HTTP
 * response) once the workspace-read budget is exhausted, rather than hanging or erroring out.
 */
async function measureWorkspaceCapDegradation(
  page: Page,
  root: string,
): Promise<WorkspaceCapDegradationEvidence> {
  const probe = await page.evaluate(
    async ({ fixtureRoot, text }) => {
      const started = performance.now();
      const response = await fetch("/api/editor/language", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify({
          operation: "diagnostics",
          root: fixtureRoot,
          document: { path: "packages/keiko-cli/src/run.ts", languageId: "typescript", text },
        }),
      });
      const durationMs = Math.round(performance.now() - started);
      const envelope = (await response.json().catch(() => null)) as {
        readonly result?: { readonly truncated?: boolean };
        readonly error?: { readonly code?: unknown };
      } | null;
      const errorCode = typeof envelope?.error?.code === "string" ? envelope.error.code : null;
      if (!response.ok) {
        return {
          ok: response.status === 413 && errorCode === "DOCUMENT_TOO_LARGE",
          truncated: response.status === 413 && errorCode === "DOCUMENT_TOO_LARGE",
          durationMs,
          statusCode: response.status,
          errorCode,
        };
      }
      return {
        ok: true,
        truncated: envelope?.result?.truncated === true,
        durationMs,
        statusCode: response.status,
        errorCode,
      };
    },
    { fixtureRoot: root, text: RUN_TEXT },
  );
  return { ...UNMEASURED_WORKSPACE_CAP_DEGRADATION, attempted: true, ...probe };
}

async function seedFilesWindow(page: Page, projectPath: string): Promise<void> {
  await page.addInitScript((root) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "perf-files",
          type: "files",
          x: 64,
          y: 64,
          w: 620,
          h: 640,
          z: 10,
          cfg: { root },
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  }, projectPath);
}

async function openTreePath(
  filesWindow: ReturnType<Page["getByRole"]>,
  path: string,
): Promise<void> {
  const row = filesWindow.locator(`[role="treeitem"].tr-row[data-path="${path}"]`);
  await expect(row).toBeVisible();
  await row.click();
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return Math.round(sorted[index] ?? 0);
}

/** Navigate the (already-seeded) file tree to `run.ts` ready for "Open in editor". */
async function navigateToFixtureFile(page: Page): Promise<ReturnType<Page["getByRole"]>> {
  const filesWindow = page.getByRole("region", { name: /^Files/u });
  await expect(filesWindow).toBeVisible();
  await openTreePath(filesWindow, "packages");
  await openTreePath(filesWindow, "packages/keiko-cli");
  await openTreePath(filesWindow, "packages/keiko-cli/src");
  await openTreePath(filesWindow, RELATIVE_PATH);
  return filesWindow;
}

/**
 * Open the editor card and close the Files window (matching the release smoke flow), so the editor is
 * the only foreground window and Monaco clicks are not intercepted by the Files preview pane.
 */
async function openEditorCard(page: Page): Promise<ReturnType<Page["getByRole"]>> {
  const filesWindow = await navigateToFixtureFile(page);
  await filesWindow.getByRole("button", { name: "Open in editor" }).click();
  const editorWindow = page.getByRole("region", { name: /Editor.*run\.ts/u });
  await expect(editorWindow.locator(".monaco-editor")).toBeVisible();
  await clickWindowChromeButton(filesWindow, "Close Files window");
  await expect(filesWindow).toBeHidden();
  return editorWindow;
}

/**
 * B4: first-card-open cold start = time from clicking "Open in editor" until the Monaco editor is
 * mounted and showing the file content (interactive-ready), across repeated fresh navigations after
 * one warmup. The editor's `.view-line` rendering the file content is the interactive-ready signal.
 */
async function measureColdStarts(page: Page, warmups: number, runs: number): Promise<number[]> {
  const samples: number[] = [];
  for (let run = 0; run < warmups + runs; run += 1) {
    await page.goto("/");
    const filesWindow = await navigateToFixtureFile(page);
    const start = Date.now();
    await filesWindow.getByRole("button", { name: "Open in editor" }).click();
    const editorWindow = page.getByRole("region", { name: /Editor.*run\.ts/u });
    await expect(editorWindow.locator(".monaco-editor")).toBeVisible();
    await expect(
      editorWindow.locator(".view-line").filter({ hasText: "e2eFixture" }),
    ).toBeVisible();
    if (run >= warmups) {
      samples.push(Date.now() - start);
    }
    await clickWindowChromeButton(filesWindow, "Close Files window");
    await expect(filesWindow).toBeHidden();
    await clickWindowChromeButton(editorWindow, "Close Editor window");
    await expect(editorWindow).toBeHidden();
  }
  return samples;
}

/** Install long-task + Event Timing observers in the page (best-effort; unsupported types no-op). */
async function installPerfObservers(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const store: TypingMetrics = {
      longTasks: [],
      events: [],
      interactionDurations: [],
      keystrokeMainThreadWork: [],
    };
    (window as unknown as { __keikoPerf: TypingMetrics }).__keikoPerf = store;
    let observerInstalled = false;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          store.longTasks.push(entry.duration);
        }
      }).observe({ type: "longtask", buffered: false });
      observerInstalled = true;
    } catch {
      /* longtask unsupported */
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          store.events.push(entry.duration);
        }
      }).observe({
        type: "event",
        buffered: false,
        durationThreshold: 16,
      } as PerformanceObserverInit);
      observerInstalled = true;
    } catch {
      /* event timing unsupported */
    }
    store.observerInstalled = observerInstalled;
    return observerInstalled;
  });
}

async function awaitNextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

const FINAL_TYPING_TEXT = TYPING_CHUNKS.join("");

/**
 * Match the `/api/editor/language` response for the diagnostics recompute the burst's LAST keystroke
 * triggers, identified by the request's `document.text` equalling the burst's final buffer content.
 * Matching on the exact final text (not merely `operation === "diagnostics"`) is deliberate: the
 * diagnostics bridge debounces re-analysis (`DEFAULT_DIAGNOSTICS_DEBOUNCE_MS`, 400ms;
 * diagnostics-bridge.ts) and cancels/reschedules on every content change, so on a slow runner an
 * earlier, now-stale request from mid-burst could still resolve after this wait is registered — this
 * predicate ignores it and only resolves on the response for the buffer actually under test.
 */
function isFinalDiagnosticsResponse(response: Response): boolean {
  if (!response.url().includes("/api/editor/language")) return false;
  const raw = response.request().postData();
  if (raw === null) return false;
  try {
    const body = JSON.parse(raw) as {
      readonly operation?: unknown;
      readonly document?: { readonly text?: unknown };
    };
    return body.operation === "diagnostics" && body.document?.text === FINAL_TYPING_TEXT;
  } catch {
    return false;
  }
}

function waitForFinalDiagnosticsRecompute(page: Page): Promise<Response> {
  return page.waitForResponse(isFinalDiagnosticsResponse, { timeout: 5_000 });
}

async function insertMeasuredChunks(page: Page): Promise<void> {
  for (const chunk of TYPING_CHUNKS) {
    const longTaskStart = await page.evaluate(
      () =>
        (window as unknown as { __keikoPerf?: TypingMetrics }).__keikoPerf?.longTasks.length ?? 0,
    );
    const start = Date.now();
    await page.keyboard.insertText(chunk);
    await awaitNextPaint(page);
    const duration = Date.now() - start;
    await page.evaluate(
      ({ value, startIndex }) => {
        const store = (window as unknown as { __keikoPerf?: TypingMetrics }).__keikoPerf;
        if (store === undefined) return;
        const newLongTasks = store.longTasks.slice(startIndex);
        store.keystrokeMainThreadWork.push(Math.round(Math.max(0, ...newLongTasks)));
        (
          window as unknown as { __keikoPerf?: TypingMetrics }
        ).__keikoPerf?.interactionDurations.push(value);
      },
      { value: duration, startIndex: longTaskStart },
    );
  }
}

async function replaceEditorText(
  page: Page,
  editorWindow: ReturnType<Page["getByRole"]>,
): Promise<boolean> {
  // F6: a plain `.click()` on `.monaco-editor` can leave Firefox's fallback `textarea.inputarea`
  // unfocused (support/editor-chord.ts `focusMonacoInput`'s doc comment), so the select-all below
  // reaches nothing and the measured typing appends into whatever old content remains instead of
  // a clean buffer. `focusMonacoInput` focuses whichever real input surface this engine created.
  await focusMonacoInput(editorWindow);
  const observerInstalled = await installPerfObservers(page);
  const modifier = await editorModifier(page);
  await page.keyboard.press(`${modifier}+KeyA`);
  const diagnosticsRecomputed = waitForFinalDiagnosticsRecompute(page).then(
    () => true,
    () => false,
  );
  await insertMeasuredChunks(page);
  // B5 must capture the debounced diagnostics recompute (the project-aware TS service call + marker
  // apply on the main thread), not just the synchronous keydown handling. A fixed 250ms sleep (less
  // than the 400ms debounce) read metrics BEFORE that cost ever ran; waiting for the real response
  // instead makes this budget capable of observing a violation at all.
  await diagnosticsRecomputed;
  return observerInstalled;
}

async function hasTypedTextLanded(editorWindow: ReturnType<Page["getByRole"]>): Promise<boolean> {
  return editorWindow
    .locator(".view-line")
    .filter({ hasText: "greeting" })
    .first()
    .isVisible({ timeout: 5_000 });
}

async function measureLanguageOperation(
  page: Page,
  root: string,
  operation: "definition" | "references",
): Promise<{ readonly durationMs: number; readonly resultCount: number }> {
  return page.evaluate(
    async ({ fixtureRoot, languageOperation, text }) => {
      const started = performance.now();
      const response = await fetch("/api/editor/language", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify({
          operation: languageOperation,
          root: fixtureRoot,
          document: {
            path: "packages/keiko-cli/src/run.ts",
            languageId: "typescript",
            text,
          },
          position: { line: 2, character: 26 },
        }),
      });
      const durationMs = Math.round(performance.now() - started);
      if (!response.ok) {
        throw new Error(`language ${languageOperation} failed with ${String(response.status)}`);
      }
      const envelope = (await response.json()) as {
        readonly result?: { readonly locations?: readonly unknown[] };
      };
      return { durationMs, resultCount: envelope.result?.locations?.length ?? 0 };
    },
    { fixtureRoot: root, languageOperation: operation, text: RUN_TEXT },
  );
}

async function measureNavigationRoundTrips(
  page: Page,
  root: string,
  runs: number,
): Promise<NavigationMetrics> {
  const definitionSamples: number[] = [];
  const definitionCounts: number[] = [];
  const referenceSamples: number[] = [];
  const referenceCounts: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const definition = await measureLanguageOperation(page, root, "definition");
    definitionSamples.push(definition.durationMs);
    definitionCounts.push(definition.resultCount);
    const references = await measureLanguageOperation(page, root, "references");
    referenceSamples.push(references.durationMs);
    referenceCounts.push(references.resultCount);
  }
  return {
    definition: { samples: definitionSamples, resultCounts: definitionCounts },
    references: { samples: referenceSamples, resultCounts: referenceCounts },
  };
}

function unmeasuredNavigationRoundTrips(): NavigationMetrics {
  return {
    definition: { samples: [], resultCounts: [] },
    references: { samples: [], resultCounts: [] },
  };
}

async function readTypingMetrics(page: Page): Promise<TypingMetrics | undefined> {
  return page.evaluate(() => (window as unknown as { __keikoPerf?: TypingMetrics }).__keikoPerf);
}

async function readActiveElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80) : "none";
  });
}

function completeTypingMetrics(input: {
  readonly metrics: TypingMetrics | undefined;
  readonly observerInstalled: boolean;
  readonly landed: boolean;
  readonly activeElement: string;
}): TypingMetrics {
  const metrics = input.metrics;
  if (metrics === undefined) {
    return {
      longTasks: [],
      events: [],
      interactionDurations: [],
      keystrokeMainThreadWork: [],
      observerInstalled: input.observerInstalled,
      landed: input.landed,
      activeElement: input.activeElement,
    };
  }
  return {
    longTasks: metrics.longTasks,
    events: metrics.events,
    interactionDurations: metrics.interactionDurations,
    keystrokeMainThreadWork: metrics.keystrokeMainThreadWork,
    observerInstalled: metrics.observerInstalled ?? input.observerInstalled,
    landed: input.landed,
    activeElement: input.activeElement,
  };
}

/**
 * B5/B6: focus Monaco using the same click + keyboard path as the release smoke, replace the buffer
 * with a realistic burst, and read observed long tasks plus interaction-to-next-paint durations.
 */
async function measureTyping(
  page: Page,
  editorWindow: ReturnType<Page["getByRole"]>,
): Promise<TypingMetrics> {
  let landed = false;
  let observerInstalled = false;
  try {
    observerInstalled = await replaceEditorText(page, editorWindow);
    landed = await hasTypedTextLanded(editorWindow);
  } catch {
    /* focus/typing quirk: fall through with whatever the observers captured */
  }
  const metrics = await readTypingMetrics(page);
  const activeElement = await readActiveElement(page);
  return completeTypingMetrics({ metrics, observerInstalled, landed, activeElement });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function requestJson(
  page: Page,
  url: string,
  request?: {
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method?: "DELETE" | "GET" | "POST";
  },
): Promise<JsonResponse> {
  return page.evaluate(
    async (input) => {
      const response = await fetch(input.url, {
        credentials: "same-origin",
        ...(input.request?.method === undefined ? {} : { method: input.request.method }),
        ...(input.request?.headers === undefined ? {} : { headers: input.request.headers }),
        ...(input.request?.body === undefined ? {} : { body: JSON.stringify(input.request.body) }),
      });
      const rawBody = await response.text();
      let body: unknown = null;
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        /* Route errors are body-free for this performance harness. */
      }
      return {
        body,
        etag: response.headers.get("etag"),
        status: response.status,
      };
    },
    { url, request },
  );
}

function debugSettings(response: JsonResponse): {
  readonly activationRevision: number;
  readonly state: string;
  readonly workspaceId: string;
} {
  expect(response.status, "debug settings response").toBe(200);
  expect(response.etag, "debug settings revision ETag").not.toBeNull();
  const snapshot = isRecord(response.body) ? response.body : undefined;
  const debugging =
    snapshot !== undefined && isRecord(snapshot.debugging) ? snapshot.debugging : undefined;
  const workspaceId = snapshot === undefined ? undefined : stringValue(snapshot.debugWorkspaceId);
  const activationRevision =
    debugging === undefined ? undefined : nonnegativeInteger(debugging.revision);
  const state = debugging === undefined ? undefined : stringValue(debugging.state);
  expect(workspaceId, "server-projected debug workspace identity").toBeDefined();
  expect(activationRevision, "debug activation revision").toBeDefined();
  expect(state, "debug activation state").toBeDefined();
  return {
    activationRevision: activationRevision ?? -1,
    state: state ?? "unknown",
    workspaceId: workspaceId ?? "",
  };
}

async function enableDebugging(page: Page, root: string): Promise<void> {
  const before = await requestJson(page, `/api/editor/settings?root=${encodeURIComponent(root)}`);
  expect(before.etag, "debug activation ETag").not.toBeNull();
  const snapshot = isRecord(before.body) ? before.body : undefined;
  const revision =
    snapshot === undefined ? undefined : nonnegativeInteger(snapshot.workspaceRevision);
  expect(before.status, "settings before debug activation").toBe(200);
  expect(revision, "workspace settings revision").toBeDefined();
  const activated = await requestJson(page, "/api/editor/settings/debug/activate", {
    body: { root, expectedRevision: revision ?? -1 },
    headers: {
      "content-type": "application/json",
      "idempotency-key": "editor-performance-idle-debug",
      "if-match": before.etag ?? "",
      "x-keiko-csrf": "1",
    },
    method: "POST",
  });
  expect(activated.status, "debug activation").toBe(200);
}

async function registerPerformanceProject(page: Page, root: string): Promise<void> {
  const project = await page.request.post("/api/projects", {
    data: { name: "Editor performance debug evidence", path: root },
    headers: { "x-keiko-csrf": "1" },
  });
  expect(project.ok(), await project.text()).toBe(true);
  const trust = await page.request.post("/api/editor/verification/trust", {
    data: { projectId: root },
    headers: { "x-keiko-csrf": "1" },
  });
  expect(trust.status(), await trust.text()).toBe(200);
}

async function openDebugEnabledEditor(page: Page): Promise<ReturnType<Page["getByRole"]>> {
  // The idle-performance path starts its canonical debug session directly through the server route
  // below. It does not open the Debug panel, so waiting for that panel's bootstrap/SSE bridge would
  // be an unbounded wait for requests that this path deliberately does not create.
  return await openEditorCard(page);
}

function requiredSessionRecord(value: unknown): Readonly<Record<string, unknown>> {
  expect(isRecord(value), "debug session projection record").toBe(true);
  return isRecord(value) ? value : {};
}

function activeIdleStatus(record: Readonly<Record<string, unknown>>): "paused" | "running" {
  const status = stringValue(record.status);
  expect(status === "paused" || status === "running", "idle debug session state").toBe(true);
  return status === "paused" ? "paused" : "running";
}

function sessionOutputBytes(record: Readonly<Record<string, unknown>>): number {
  const output = isRecord(record.output) ? record.output : undefined;
  const outputAcceptedBytes =
    output === undefined ? undefined : nonnegativeInteger(output.acceptedBytes);
  expect(outputAcceptedBytes, "debug output byte count").toBeDefined();
  return outputAcceptedBytes ?? -1;
}

function sessionFrom(value: unknown): IdleDebugSessionSnapshot & { readonly sessionId: string } {
  const record = requiredSessionRecord(value);
  const sessionId = stringValue(record.sessionId);
  expect(sessionId, "started debug session identity").toBeDefined();
  return {
    outputAcceptedBytes: sessionOutputBytes(record),
    sessionId: sessionId ?? "",
    status: activeIdleStatus(record),
  };
}

async function startIdleDebugSession(page: Page, root: string): Promise<IdleDebugSession> {
  await registerPerformanceProject(page, root);
  await enableDebugging(page, root);
  await page.goto("/");
  await openDebugEnabledEditor(page);
  const settings = debugSettings(
    await requestJson(page, `/api/editor/settings?root=${encodeURIComponent(root)}`),
  );
  expect(settings.state, "enabled debug capability").toBe("available");
  const started = await requestJson(page, "/api/editor/debug/sessions", {
    body: {
      activationRevision: settings.activationRevision,
      schemaVersion: "1",
      target: { fileId: RELATIVE_PATH, kind: "file" },
      workspaceId: settings.workspaceId,
    },
    headers: { "content-type": "application/json", "x-keiko-csrf": "1" },
    method: "POST",
  });
  expect(started.status, "idle debug session start").toBe(201);
  const session = sessionFrom(started.body);
  return {
    activationRevision: settings.activationRevision,
    sessionId: session.sessionId,
    workspaceId: settings.workspaceId,
  };
}

async function readIdleDebugSession(
  page: Page,
  session: IdleDebugSession,
): Promise<IdleDebugSessionSnapshot> {
  const response = await requestJson(
    page,
    `/api/editor/debug/sessions/${encodeURIComponent(session.sessionId)}`,
  );
  expect(response.status, "idle debug session projection").toBe(200);
  const projection = sessionFrom(response.body);
  return { outputAcceptedBytes: projection.outputAcceptedBytes, status: projection.status };
}

async function stopIdleDebugSession(page: Page, session: IdleDebugSession): Promise<void> {
  const response = await requestJson(
    page,
    `/api/editor/debug/sessions/${encodeURIComponent(session.sessionId)}`,
    {
      body: {},
      headers: { "content-type": "application/json", "x-keiko-csrf": "1" },
      method: "DELETE",
    },
  );
  expect(response.status, "idle debug session stop").toBe(200);
}

async function installIdleDebugLongTaskObserver(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const state = {
      installedAtMs: performance.now(),
      longTasks: [] as number[],
      observerInstalled: false,
    };
    (window as unknown as { __keikoIdleDebugPerf: typeof state }).__keikoIdleDebugPerf = state;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: false });
      state.observerInstalled = true;
    } catch {
      /* Chromium release evidence requires Long Task observation; report the missing capability. */
    }
    return state.observerInstalled;
  });
}

async function waitForIdleDebugObservationWindow(page: Page): Promise<void> {
  await page.waitForFunction((minimumDurationMs) => {
    const state = (
      window as unknown as {
        __keikoIdleDebugPerf?: { readonly installedAtMs?: number | undefined };
      }
    ).__keikoIdleDebugPerf;
    return (
      state?.installedAtMs !== undefined &&
      performance.now() - state.installedAtMs >= minimumDurationMs
    );
  }, IDLE_DEBUG_INTERVAL_MS);
}

function traceEvent(value: unknown): TraceEvent | undefined {
  if (!isRecord(value)) return undefined;
  const name = stringValue(value.name);
  const phase = stringValue(value.ph);
  const dur = typeof value.dur === "number" && Number.isFinite(value.dur) ? value.dur : undefined;
  return name === undefined || phase === undefined || dur === undefined
    ? undefined
    : { args: value.args, dur, name, phase };
}

function traceEventsFrom(value: unknown): readonly TraceEvent[] {
  if (!isRecord(value) || !Array.isArray(value.value)) return [];
  return value.value.map(traceEvent).filter((event): event is TraceEvent => event !== undefined);
}

function traceDispatchType(event: TraceEvent): string | undefined {
  if (!isRecord(event.args)) return undefined;
  const data = event.args.data;
  return isRecord(data) ? stringValue(data.type) : undefined;
}

interface InputProcessingMeasurement {
  readonly durationMs: number;
  readonly matchedEventCount: number;
}

function inputDispatchMeasurements(events: readonly TraceEvent[]): InputProcessingMeasurement[] {
  // Monaco handles some keys (notably Space) directly in keydown without emitting beforeinput or
  // input. Group the complete keyboard dispatch from keydown through keyup so every real keystroke
  // has one non-vacuous sample and all synchronous editor work is included.
  const inputDispatchTypes = new Set([
    "keydown",
    "keypress",
    "beforeinput",
    "textInput",
    "input",
    "keyup",
  ]);
  const measurements: InputProcessingMeasurement[] = [];
  let microseconds = 0;
  let matchedEventCount = 0;
  const flush = (): void => {
    if (matchedEventCount === 0) return;
    measurements.push({
      durationMs: Math.round((microseconds / 1_000) * 1_000) / 1_000,
      matchedEventCount,
    });
    microseconds = 0;
    matchedEventCount = 0;
  };
  for (const event of events) {
    if (event.name !== "EventDispatch" || event.phase !== "X") continue;
    const type = traceDispatchType(event);
    if (type === "keydown") flush();
    if (type === undefined || !inputDispatchTypes.has(type)) continue;
    microseconds += event.dur;
    matchedEventCount += 1;
    if (type === "keyup") flush();
  }
  flush();
  return measurements;
}

async function captureInputProcessingSamples(
  page: Page,
  chunks: readonly string[],
  prepareMeasurementWindow?: () => Promise<void>,
): Promise<readonly InputProcessingMeasurement[]> {
  const client = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  const complete = new Promise<void>((resolve) => {
    client.once("Tracing.tracingComplete", () => {
      resolve();
    });
  });
  client.on("Tracing.dataCollected", (value: unknown) => events.push(...traceEventsFrom(value)));
  await client.send("Tracing.start", {
    categories: "devtools.timeline",
    transferMode: "ReportEvents",
  });
  try {
    // Start CDP tracing before the Long Task observer used by the idle-debug probe. Tracing startup
    // is harness instrumentation, not editor work, and must stay outside the B5 measurement window.
    await prepareMeasurementWindow?.();
    await awaitNextPaint(page);
    for (const chunk of chunks) {
      await page.keyboard.type(chunk);
      await awaitNextPaint(page);
    }
    await client.send("Tracing.end");
    await Promise.race([
      complete,
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("EDITOR_PERF_TRACE_COMPLETION_TIMEOUT"));
        }, 15_000);
        timeout.unref();
      }),
    ]);
    const measurements = inputDispatchMeasurements(events);
    if (measurements.length !== chunks.length) {
      throw new Error("EDITOR_PERF_INPUT_DISPATCH_NOT_CAPTURED");
    }
    if (measurements.some((measurement) => measurement.durationMs <= 0)) {
      throw new Error("EDITOR_PERF_INPUT_DISPATCH_DURATION_NOT_POSITIVE");
    }
    return measurements;
  } finally {
    await client.detach();
  }
}

async function measureD12BaselineWork(
  page: Page,
  editorWindow: ReturnType<Page["getByRole"]>,
): Promise<D12BaselineMeasuredWork> {
  // F6: see replaceEditorText above — focusMonacoInput, not a plain click, is what reliably
  // reaches Firefox's fallback input surface before the select-all chord.
  await focusMonacoInput(editorWindow);
  const modifier = await editorModifier(page);
  await page.keyboard.press(`${modifier}+KeyA`);
  expect(await installPerfObservers(page)).toBe(true);
  const measurements = await captureInputProcessingSamples(page, TYPING_CHUNKS);
  expect(measurements).toHaveLength(TYPING_CHUNKS.length);
  expect(measurements.every((measurement) => measurement.durationMs > 0)).toBe(true);
  const longTasks = await page.evaluate(
    () => (window as unknown as { __keikoPerf?: TypingMetrics }).__keikoPerf?.longTasks ?? [],
  );
  const matchedInputEventCounts = measurements.map((measurement) => measurement.matchedEventCount);
  return {
    captured: true,
    expectedSampleCount: TYPING_CHUNKS.length,
    longTaskCount: longTasks.length,
    matchedInputEventCounts,
    maxLongTaskMs: Math.round(Math.max(0, ...longTasks)),
    processingSamples: measurements.map((measurement) => measurement.durationMs),
    totalMatchedInputEvents: matchedInputEventCounts.reduce((total, count) => total + count, 0),
    traceCaptured: true,
  };
}

async function idleDebugLongTasks(page: Page): Promise<readonly number[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __keikoIdleDebugPerf?: { readonly longTasks: readonly number[] } })
        .__keikoIdleDebugPerf?.longTasks ?? [],
  );
}

async function measureIdleDebugTyping(
  page: Page,
  editorWindow: ReturnType<Page["getByRole"]>,
  session: IdleDebugSession,
): Promise<IdleDebugMetrics> {
  // F6: see replaceEditorText above — focusMonacoInput, not a plain click, is what reliably
  // reaches Firefox's fallback input surface before the select-all chord. The role-based check
  // below is additional: it also pins the accessible name Monaco's input surface exposes.
  await focusMonacoInput(editorWindow);
  await expect(editorWindow.getByRole("textbox", { name: /Editor:/u })).toBeFocused();
  const modifier = await editorModifier(page);
  await page.keyboard.press(`${modifier}+KeyA`);
  const diagnosticsRecomputed = waitForFinalDiagnosticsRecompute(page).catch(() => undefined);
  let observerInstalled = false;
  const measurements = await captureInputProcessingSamples(page, TYPING_CHUNKS, async () => {
    observerInstalled = await installIdleDebugLongTaskObserver(page);
    await waitForIdleDebugObservationWindow(page);
  });
  const matchedInputEventCounts = measurements.map((measurement) => measurement.matchedEventCount);
  const processingSamples = measurements.map((measurement) => measurement.durationMs);
  await diagnosticsRecomputed;
  const [longTasks, liveSession] = await Promise.all([
    idleDebugLongTasks(page),
    readIdleDebugSession(page, session),
  ]);
  return {
    longTasks,
    longTaskObserverInstalled: observerInstalled,
    matchedInputEventCounts,
    processingSamples,
    session: liveSession,
    // Each sample returns only after CDP emits Tracing.tracingComplete; the bounded capture helper
    // throws on a missing completion instead of reporting a partial measurement as evidence.
    traceCaptured: true,
  };
}

/** B11: per-cycle baseline (no editor) -> peak (editor open) -> residual (editor closed) heap. */
async function collectedHeapBytes(client: CDPSession): Promise<number> {
  await client.send("HeapProfiler.collectGarbage");
  return (await client.send("Runtime.getHeapUsage")).usedSize;
}

async function measureMemory(page: Page, cycles: number): Promise<MemoryMetrics> {
  const supported = await page.evaluate(
    () => typeof (performance as unknown as { memory?: unknown }).memory !== "undefined",
  );
  if (!supported) {
    return {
      supported: false,
      baselineBytes: null,
      peakBytes: null,
      residualBytes: null,
      cycles: 0,
    };
  }
  const client = await page.context().newCDPSession(page);
  let baseline = 0;
  let peak = 0;
  let residual = 0;
  try {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      await page.goto("/");
      await expect(page.getByRole("region", { name: /^Files/u })).toBeVisible();
      baseline = Math.max(baseline, await collectedHeapBytes(client));
      const card = await openEditorCard(page);
      peak = Math.max(peak, await collectedHeapBytes(client));
      await card.getByRole("button", { name: "Close Editor window" }).click();
      await expect(card).toBeHidden();
      residual = Math.max(residual, await collectedHeapBytes(client));
    }
  } finally {
    await client.detach();
  }
  return {
    supported: true,
    baselineBytes: baseline,
    peakBytes: peak,
    residualBytes: residual,
    cycles,
  };
}

type MonacoWorkerLabel = "editor" | "ts" | "json" | "css" | "html";

interface WorkerRequest {
  readonly url: string;
  readonly resourceType: string;
  readonly workerLabel?: MonacoWorkerLabel | "unknown";
  readonly captureReason: string;
}

function hasAll(source: string, needles: readonly string[]): boolean {
  return needles.every((needle) => source.includes(needle));
}

function classifyMonacoWorkerChunk(source: string): MonacoWorkerLabel | null {
  if (source.includes("@monaco-editor/react") || source.includes("MonacoEnvironment")) {
    return null;
  }
  if (source.includes("ScriptElementKind")) {
    return "ts";
  }
  if (source.includes("doTagComplete")) {
    return "html";
  }
  if (source.includes("getMatchingSchemas")) {
    return "json";
  }
  if (hasAll(source, ["DiffComputer", "computeLinks"])) {
    return "editor";
  }
  if (source.includes("getSelectionRanges") && source.includes("getFoldingRanges")) {
    return "css";
  }
  return null;
}

function shouldInspectJavaScriptResponse(url: string, contentType: string): boolean {
  try {
    const path = new URL(url).pathname;
    return (
      path.endsWith(".js") &&
      (path.includes("/_next/static/chunks/") || /monaco|worker|editor/iu.test(path))
    );
  } catch {
    return contentType.includes("javascript");
  }
}

function recordWorkerRequest(workerRequests: WorkerRequest[], candidate: WorkerRequest): void {
  const existingIndex = workerRequests.findIndex(
    (entry) => entry.url === candidate.url && entry.workerLabel === candidate.workerLabel,
  );
  if (existingIndex < 0) {
    workerRequests.push(candidate);
  }
}

interface WorkerCapture {
  readonly workerRequests: WorkerRequest[];
  readonly settleWorkerCaptures: () => Promise<void>;
}

const WORKER_RESPONSE_BODY_TIMEOUT_MS = 5_000;

async function readWorkerResponseBody(response: Response): Promise<Buffer | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      response.body(),
      new Promise<null>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, WORKER_RESPONSE_BODY_TIMEOUT_MS, null);
        timer.unref();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function captureWorkerResponse(
  response: Response,
  workerRequests: WorkerRequest[],
): Promise<void> {
  const url = response.url();
  const body = await readWorkerResponseBody(response);
  if (body === null) return;
  const workerLabel = classifyMonacoWorkerChunk(body.toString("utf8"));
  if (workerLabel !== null) {
    recordWorkerRequest(workerRequests, {
      url,
      resourceType: response.request().resourceType(),
      workerLabel,
      captureReason: "classified-response",
    });
  }
}

function installWorkerCapture(page: Page): WorkerCapture {
  const workerRequests: WorkerRequest[] = [];
  const inspectedJavaScriptResponses = new Set<string>();
  const pendingWorkerCaptures: Promise<void>[] = [];
  page.on("request", (request) => {
    const type = request.resourceType();
    const url = request.url();
    if (type === "worker" || /worker/iu.test(url)) {
      recordWorkerRequest(workerRequests, {
        url,
        resourceType: type,
        workerLabel: "unknown",
        captureReason: "request-resource-or-url",
      });
    }
  });
  page.on("response", (response) => {
    const contentType = response.headers()["content-type"] ?? "";
    const url = response.url();
    if (
      shouldInspectJavaScriptResponse(url, contentType) &&
      !inspectedJavaScriptResponses.has(url)
    ) {
      inspectedJavaScriptResponses.add(url);
      pendingWorkerCaptures.push(captureWorkerResponse(response, workerRequests));
    }
  });
  return {
    workerRequests,
    settleWorkerCaptures: async (): Promise<void> => {
      await Promise.allSettled(pendingWorkerCaptures.splice(0));
    },
  };
}

function isTsWorkerRequest(request: WorkerRequest): boolean {
  return request.workerLabel === "ts" || /ts\.worker|typescript.*worker/iu.test(request.url);
}

function isLanguageWorkerRequest(request: WorkerRequest): boolean {
  return (
    request.workerLabel === "ts" ||
    request.workerLabel === "json" ||
    request.workerLabel === "css" ||
    request.workerLabel === "html" ||
    /(?:ts|typescript|json|css|html).*worker|worker.*(?:ts|typescript|json|css|html)/iu.test(
      request.url,
    )
  );
}

function buildWorkerLoadCapture(workerRequests: readonly WorkerRequest[]): Record<string, unknown> {
  const editorWorkerLoaded = workerRequests.some(
    (r) => r.workerLabel === "editor" || /editor.*worker|worker.*editor/iu.test(r.url),
  );
  return {
    totalWorkerRequests: workerRequests.length,
    editorWorkerLoaded,
    tsLanguageWorkerLoaded: workerRequests.some(isTsWorkerRequest),
    languageWorkerLoaded: workerRequests.some(isLanguageWorkerRequest),
    requests: workerRequests.slice(0, 40),
  };
}

function buildB5Evidence(typing: TypingMetrics): Record<string, unknown> {
  const samples = typing.keystrokeMainThreadWork;
  return {
    budgetMax: 50,
    captured: typing.landed === true && typing.observerInstalled === true && samples.length > 0,
    samples,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    activeElement: typing.activeElement ?? "unknown",
    longTaskCount: typing.longTasks.length,
    maxLongTaskMs: Math.round(Math.max(0, ...typing.longTasks)),
  };
}

function buildIdleDebugB5Evidence(metrics: IdleDebugMetrics): IdleDebugEvidence {
  const expectedSampleCount = TYPING_CHUNKS.length;
  const hasNonVacuousSamples =
    metrics.processingSamples.length === expectedSampleCount &&
    metrics.processingSamples.every((sample) => sample > 0) &&
    metrics.matchedInputEventCounts.length === expectedSampleCount &&
    metrics.matchedInputEventCounts.every((count) => count > 0);
  return {
    attempted: true,
    budgetMax: 50,
    captured:
      metrics.traceCaptured &&
      metrics.longTaskObserverInstalled &&
      hasNonVacuousSamples &&
      metrics.session.outputAcceptedBytes === 0,
    expectedSampleCount,
    idleIntervalMs: IDLE_DEBUG_INTERVAL_MS,
    longTaskCount: metrics.longTasks.length,
    matchedInputEventCounts: metrics.matchedInputEventCounts,
    maxLongTaskMs: Math.round(Math.max(0, ...metrics.longTasks)),
    outputAcceptedBytes: metrics.session.outputAcceptedBytes,
    p95: percentile(metrics.processingSamples, 95),
    processingSamples: metrics.processingSamples,
    sessionStatus: metrics.session.status,
    totalMatchedInputEvents: metrics.matchedInputEventCounts.reduce(
      (total, count) => total + count,
      0,
    ),
    traceCaptured: metrics.traceCaptured,
  };
}

function buildB6Evidence(typing: TypingMetrics): Record<string, unknown> {
  const interactionDurations =
    typing.events.length > 0 ? typing.events : typing.interactionDurations;
  return {
    budgetP75: 200,
    captured: typing.landed === true && interactionDurations.length > 0,
    source: typing.events.length > 0 ? "event-timing" : "raf-insert-proxy",
    eventCount: typing.events.length,
    interactionCount: interactionDurations.length,
    samples: interactionDurations,
    p75: percentile(interactionDurations, 75),
    max: Math.round(Math.max(0, ...interactionDurations)),
  };
}

function buildNavigationOperationEvidence(
  metrics: NavigationOperationMetrics,
): Record<string, unknown> {
  return {
    samples: metrics.samples,
    resultCounts: metrics.resultCounts,
    p50: percentile(metrics.samples, 50),
    p95: percentile(metrics.samples, 95),
  };
}

function buildD12ProvenanceEvidence(): Record<string, unknown> {
  if (D12_REVISION === undefined) return {};
  if (
    D12_SOURCE_TREE_SHA_256 === undefined ||
    D12_MEASUREMENT_HARNESS_SHA_256 === undefined ||
    d12RunProvenance === null
  ) {
    throw new Error("D12 provenance was not initialized before writing browser evidence");
  }
  return {
    sourceTreeSha256: D12_SOURCE_TREE_SHA_256,
    measurementHarnessSha256: D12_MEASUREMENT_HARNESS_SHA_256,
    provenance: d12RunProvenance,
  };
}

function buildD12KeystrokeEvidence(typing: TypingMetrics): Record<string, unknown> {
  const samples = typing.keystrokeMainThreadWork;
  return {
    budgetMax: 50,
    captured: typing.landed === true && typing.observerInstalled === true && samples.length > 0,
    longTaskCount: typing.longTasks.length,
    maxLongTaskMs: Math.round(Math.max(0, ...typing.longTasks)),
    samples,
  };
}

function buildD12InteractionEvidence(typing: TypingMetrics): Record<string, unknown> {
  const samples = typing.events.length > 0 ? typing.events : typing.interactionDurations;
  return {
    budgetP75: 200,
    captured: typing.landed === true && samples.length > 0,
    samples,
  };
}

function buildD12WorkerEvidence(workerRequests: readonly WorkerRequest[]): Record<string, unknown> {
  return {
    editorWorkerLoaded: workerRequests.some(
      (request) =>
        request.workerLabel === "editor" || /editor.*worker|worker.*editor/iu.test(request.url),
    ),
    languageWorkerLoaded: workerRequests.some(isLanguageWorkerRequest),
    totalWorkerRequests: workerRequests.length,
    tsLanguageWorkerLoaded: workerRequests.some(isTsWorkerRequest),
  };
}

function buildD12CandidateWork(idleDebug: IdleDebugEvidence): Record<string, unknown> {
  return {
    attempted: idleDebug.attempted,
    budgetMax: idleDebug.budgetMax,
    captured: idleDebug.captured,
    expectedSampleCount: idleDebug.expectedSampleCount,
    idleIntervalMs: idleDebug.idleIntervalMs,
    longTaskCount: idleDebug.longTaskCount,
    matchedInputEventCounts: idleDebug.matchedInputEventCounts,
    maxLongTaskMs: idleDebug.maxLongTaskMs,
    outputAcceptedBytes: idleDebug.outputAcceptedBytes,
    processingSamples: idleDebug.processingSamples,
    sessionStatus: idleDebug.sessionStatus,
    totalMatchedInputEvents: idleDebug.totalMatchedInputEvents,
    traceCaptured: idleDebug.traceCaptured,
  };
}

function buildD12Evidence(
  coldStartsMs: readonly number[],
  typing: TypingMetrics,
  memory: MemoryMetrics,
  workerRequests: readonly WorkerRequest[],
  idleDebug: IdleDebugEvidence,
): Record<string, unknown> {
  if (D12_REVISION === undefined) throw new Error("D12 revision is missing");
  if (D12_REVISION === "baseline" && d12BaselineMeasuredWork === null) {
    throw new Error("D12 baseline measured-work evidence is missing");
  }
  return {
    schemaVersion: "1",
    kind: "common",
    revision: D12_REVISION,
    ...buildD12ProvenanceEvidence(),
    commit: resolveCommit(),
    measuredAtIso: new Date().toISOString(),
    b4ColdStartMs: { budgetP50: 1500, budgetP95: 2500, samples: coldStartsMs },
    b5KeystrokeMs: buildD12KeystrokeEvidence(typing),
    ...(D12_REVISION === "baseline"
      ? { d12BaselineMeasuredWork }
      : { b5IdleDebugSession: buildD12CandidateWork(idleDebug) }),
    b6InteractionMs: buildD12InteractionEvidence(typing),
    b11Memory: memory,
    workerLoadCapture: buildD12WorkerEvidence(workerRequests),
  };
}

function buildEvidence(
  coldStartsMs: number[],
  typing: TypingMetrics,
  memory: MemoryMetrics,
  navigation: NavigationMetrics,
  workerRequests: readonly WorkerRequest[],
  workspaceCapDegradation: WorkspaceCapDegradationEvidence,
  idleDebug: IdleDebugEvidence,
): Record<string, unknown> {
  if (D12_REVISION !== undefined) {
    return buildD12Evidence(coldStartsMs, typing, memory, workerRequests, idleDebug);
  }
  return {
    ...buildD12ProvenanceEvidence(),
    measuredAtIso: new Date().toISOString(),
    commit: resolveCommit(),
    harness:
      "packaged CLI serving the production static UI via tests/e2e/config/playwright.editor-performance.config.ts",
    b4ColdStartMs: {
      budgetP50: 1500,
      budgetP95: 2500,
      samples: coldStartsMs,
      p50: percentile(coldStartsMs, 50),
      p95: percentile(coldStartsMs, 95),
    },
    b5KeystrokeMs: buildB5Evidence(typing),
    b5IdleDebugSession: idleDebug,
    b6InteractionMs: buildB6Evidence(typing),
    navigationRoundTripMs: {
      definition: buildNavigationOperationEvidence(navigation.definition),
      references: buildNavigationOperationEvidence(navigation.references),
    },
    b11Memory: memory,
    workerLoadCapture: buildWorkerLoadCapture(workerRequests),
    workspaceReadCapDegradation: workspaceCapDegradation,
    ...(d12BaselineMeasuredWork === null ? {} : { d12BaselineMeasuredWork }),
  };
}

test.afterEach(() => {
  for (const root of tempProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function writeEvidence(
  coldStartsMs: number[],
  typing: TypingMetrics,
  memory: MemoryMetrics,
  navigation: NavigationMetrics,
  capture: WorkerCapture,
  workspaceCapDegradation: WorkspaceCapDegradationEvidence,
  idleDebug: IdleDebugEvidence,
): Promise<void> {
  await capture.settleWorkerCaptures();
  writeFileSync(
    EVIDENCE_PATH,
    `${JSON.stringify(
      buildEvidence(
        coldStartsMs,
        typing,
        memory,
        navigation,
        capture.workerRequests,
        workspaceCapDegradation,
        idleDebug,
      ),
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function measureMemoryBestEffort(page: Page): Promise<MemoryMetrics> {
  try {
    return await measureMemory(page, 2);
  } catch {
    return {
      supported: false,
      baselineBytes: null,
      peakBytes: null,
      residualBytes: null,
      cycles: 0,
    };
  }
}

interface EvidenceMeasurements {
  readonly coldStartsMs: number[];
  readonly typing: TypingMetrics;
  readonly memory: MemoryMetrics;
  readonly navigation: NavigationMetrics;
}

async function writeCurrentEvidence(
  measurements: EvidenceMeasurements,
  capture: WorkerCapture,
): Promise<void> {
  if (D12_COMPARISON) return;
  await writeEvidence(
    measurements.coldStartsMs,
    measurements.typing,
    measurements.memory,
    measurements.navigation,
    capture,
    UNMEASURED_WORKSPACE_CAP_DEGRADATION,
    UNMEASURED_IDLE_DEBUG_EVIDENCE,
  );
}

async function collectEvidenceMeasurements(
  page: Page,
  capture: WorkerCapture,
  projectPath: string,
): Promise<EvidenceMeasurements> {
  const measuredRuns = resolveMeasuredRuns();
  await page.goto("/");
  const navigation = D12_COMPARISON
    ? unmeasuredNavigationRoundTrips()
    : await measureNavigationRoundTrips(page, projectPath, measuredRuns);
  const coldStartsMs = await measureColdStarts(page, 1, measuredRuns);
  let typing: TypingMetrics = {
    longTasks: [],
    events: [],
    interactionDurations: [],
    keystrokeMainThreadWork: [],
    landed: false,
  };
  let memory = await measureMemoryBestEffort(page);
  await writeCurrentEvidence({ coldStartsMs, typing, memory, navigation }, capture);

  await page.goto("/");
  const editorWindow = await openEditorCard(page);
  typing = await measureTyping(page, editorWindow);
  await writeCurrentEvidence({ coldStartsMs, typing, memory, navigation }, capture);

  memory = await measureMemoryBestEffort(page);
  await writeCurrentEvidence({ coldStartsMs, typing, memory, navigation }, capture);
  return { coldStartsMs, typing, memory, navigation };
}

// Documented B11 ceilings (docs/keiko-editor/1207-performance-budgets.md): peak heap growth across
// open/close cycles and residual growth after close.
const B11_PEAK_GROWTH_BUDGET_BYTES = 128 * 1024 * 1024;
const B11_RESIDUAL_GROWTH_BUDGET_BYTES = 16 * 1024 * 1024;

// eslint-disable-next-line max-lines-per-function -- single release-evidence gate asserting every B4/B5/B6/B11 budget and worker-load guard together; splitting would scatter the coupled expectations.
function assertEvidenceBudgets(
  evidence: {
    b4ColdStartMs: { budgetP50: number; budgetP95: number; p50: number; p95: number };
    b5KeystrokeMs: { budgetMax: number; captured: boolean; maxLongTaskMs: number; p95: number };
    b5IdleDebugSession: IdleDebugEvidence;
    b6InteractionMs: { budgetP75: number; captured: boolean; p75: number };
    navigationRoundTripMs: {
      definition: { p50: number; p95: number; resultCounts: readonly number[] };
      references: { p50: number; p95: number; resultCounts: readonly number[] };
    };
    b11Memory: {
      supported: boolean;
      baselineBytes: number | null;
      peakBytes: number | null;
      residualBytes: number | null;
    };
    workerLoadCapture: {
      totalWorkerRequests: number;
      editorWorkerLoaded: boolean;
      languageWorkerLoaded: boolean;
    };
    workspaceReadCapDegradation: { attempted: boolean; ok: boolean; truncated: boolean };
  },
  measuredRuns: number,
  workerRequests: readonly WorkerRequest[],
  navigationExpected = true,
): void {
  expect(evidence.b4ColdStartMs.p50).toBeLessThanOrEqual(evidence.b4ColdStartMs.budgetP50);
  expect(evidence.b4ColdStartMs.p95).toBeLessThanOrEqual(evidence.b4ColdStartMs.budgetP95);
  expect(evidence.b5KeystrokeMs.captured).toBe(true);
  expect(evidence.b5KeystrokeMs.p95).toBeLessThan(evidence.b5KeystrokeMs.budgetMax);
  expect(evidence.b5KeystrokeMs.maxLongTaskMs).toBeLessThanOrEqual(
    evidence.b5KeystrokeMs.budgetMax,
  );
  expect(evidence.b5IdleDebugSession.attempted).toBe(true);
  expect(evidence.b5IdleDebugSession.captured).toBe(true);
  expect(evidence.b5IdleDebugSession.traceCaptured).toBe(true);
  expect(evidence.b5IdleDebugSession.expectedSampleCount).toBe(TYPING_CHUNKS.length);
  expect(evidence.b5IdleDebugSession.processingSamples).toHaveLength(TYPING_CHUNKS.length);
  expect(evidence.b5IdleDebugSession.processingSamples.every((sample) => sample > 0)).toBe(true);
  expect(evidence.b5IdleDebugSession.matchedInputEventCounts).toHaveLength(TYPING_CHUNKS.length);
  expect(evidence.b5IdleDebugSession.matchedInputEventCounts.every((count) => count > 0)).toBe(
    true,
  );
  expect(evidence.b5IdleDebugSession.totalMatchedInputEvents).toBeGreaterThanOrEqual(
    TYPING_CHUNKS.length,
  );
  expect(
    evidence.b5IdleDebugSession.processingSamples.every(
      (sample) => sample < evidence.b5IdleDebugSession.budgetMax,
    ),
  ).toBe(true);
  expect(evidence.b5IdleDebugSession.p95).toBeLessThan(evidence.b5IdleDebugSession.budgetMax);
  expect(evidence.b5IdleDebugSession.longTaskCount).toBe(0);
  expect(evidence.b5IdleDebugSession.maxLongTaskMs).toBe(0);
  expect(evidence.b5IdleDebugSession.outputAcceptedBytes).toBe(0);
  expect(
    evidence.b5IdleDebugSession.sessionStatus === "paused" ||
      evidence.b5IdleDebugSession.sessionStatus === "running",
  ).toBe(true);
  expect(evidence.b6InteractionMs.captured).toBe(true);
  expect(evidence.b6InteractionMs.p75).toBeLessThanOrEqual(evidence.b6InteractionMs.budgetP75);
  if (navigationExpected) {
    expect(evidence.navigationRoundTripMs.definition.p50).toBeGreaterThanOrEqual(0);
    expect(evidence.navigationRoundTripMs.definition.p95).toBeGreaterThanOrEqual(
      evidence.navigationRoundTripMs.definition.p50,
    );
    expect(evidence.navigationRoundTripMs.definition.resultCounts.every((count) => count > 0)).toBe(
      true,
    );
    expect(evidence.navigationRoundTripMs.references.p50).toBeGreaterThanOrEqual(0);
    expect(evidence.navigationRoundTripMs.references.p95).toBeGreaterThanOrEqual(
      evidence.navigationRoundTripMs.references.p50,
    );
    expect(evidence.navigationRoundTripMs.references.resultCounts.every((count) => count > 0)).toBe(
      true,
    );
  }
  expect(evidence.workerLoadCapture.totalWorkerRequests).toBeGreaterThan(0);
  expect(evidence.workerLoadCapture.editorWorkerLoaded).toBe(true);
  expect(evidence.workerLoadCapture.languageWorkerLoaded).toBe(false);
  expect(workerRequests.some(isTsWorkerRequest)).toBe(false);
  expect(workerRequests.some(isLanguageWorkerRequest)).toBe(false);
  expect(evidence.b4ColdStartMs.p50 > 0).toBe(true);
  // Adversarial near-cap workspace (audit defect #2): the probe must have actually run and returned a
  // healthy response, and the workspace-read budget must have genuinely tripped — proving graceful
  // degradation (truncation), not a crash, a hang, or a fixture that never approached the cap.
  expect(evidence.workspaceReadCapDegradation.attempted).toBe(true);
  expect(evidence.workspaceReadCapDegradation.ok).toBe(true);
  expect(
    evidence.workspaceReadCapDegradation.truncated,
    "adversarial near-cap workspace must trigger graceful workspace-read-budget truncation",
  ).toBe(true);
  expect(measuredRuns).toBe(resolveMeasuredRuns());
  // B11 memory: assert the recorded ceilings so the budget is actionable rather than merely recorded
  // (GEN-PERF-BENCHMARK-003). When the browser exposes a heap probe, peak/residual growth over the
  // baseline must stay within the documented budgets; a genuine worker/model leak that exceeds heap
  // quantization now fails the gate instead of being silently recorded.
  if (
    evidence.b11Memory.supported &&
    evidence.b11Memory.baselineBytes !== null &&
    evidence.b11Memory.peakBytes !== null &&
    evidence.b11Memory.residualBytes !== null
  ) {
    expect(
      evidence.b11Memory.peakBytes - evidence.b11Memory.baselineBytes,
      "B11 peak heap growth budget",
    ).toBeLessThanOrEqual(B11_PEAK_GROWTH_BUDGET_BYTES);
    expect(
      evidence.b11Memory.residualBytes - evidence.b11Memory.baselineBytes,
      "B11 residual heap growth budget",
    ).toBeLessThanOrEqual(B11_RESIDUAL_GROWTH_BUDGET_BYTES);
  }
}

interface ReleaseEvidence {
  b4ColdStartMs: { budgetP50: number; budgetP95: number; p50: number; p95: number };
  b5KeystrokeMs: { budgetMax: number; captured: boolean; maxLongTaskMs: number; p95: number };
  b5IdleDebugSession: IdleDebugEvidence;
  b6InteractionMs: { budgetP75: number; captured: boolean; p75: number };
  navigationRoundTripMs: {
    definition: { p50: number; p95: number; resultCounts: readonly number[] };
    references: { p50: number; p95: number; resultCounts: readonly number[] };
  };
  b11Memory: {
    supported: boolean;
    baselineBytes: number | null;
    peakBytes: number | null;
    residualBytes: number | null;
  };
  workerLoadCapture: {
    totalWorkerRequests: number;
    editorWorkerLoaded: boolean;
    languageWorkerLoaded: boolean;
  };
  workspaceReadCapDegradation: { attempted: boolean; ok: boolean; truncated: boolean };
  d12BaselineMeasuredWork?: D12BaselineMeasuredWork;
}

interface D12RawEvidence {
  readonly b11Memory: MemoryMetrics;
  readonly b4ColdStartMs: {
    readonly budgetP50: number;
    readonly budgetP95: number;
    readonly samples: readonly number[];
  };
  readonly b5IdleDebugSession?: Omit<IdleDebugEvidence, "p95">;
  readonly b5KeystrokeMs: {
    readonly budgetMax: number;
    readonly captured: boolean;
    readonly samples: readonly number[];
  };
  readonly b6InteractionMs: {
    readonly budgetP75: number;
    readonly captured: boolean;
    readonly samples: readonly number[];
  };
  readonly d12BaselineMeasuredWork?: D12BaselineMeasuredWork;
}

function requireD12BaselineEvidence(evidence: D12RawEvidence): D12BaselineMeasuredWork {
  const baseline = evidence.d12BaselineMeasuredWork;
  if (baseline === undefined) throw new Error("D12 baseline measured-work evidence is missing");
  return baseline;
}

function assertD12RawBudgets(evidence: D12RawEvidence, measuredRuns: number): void {
  expect(percentile(evidence.b4ColdStartMs.samples, 50)).toBeLessThanOrEqual(
    evidence.b4ColdStartMs.budgetP50,
  );
  expect(percentile(evidence.b4ColdStartMs.samples, 95)).toBeLessThanOrEqual(
    evidence.b4ColdStartMs.budgetP95,
  );
  expect(evidence.b5KeystrokeMs.captured).toBe(true);
  expect(percentile(evidence.b5KeystrokeMs.samples, 95)).toBeLessThan(
    evidence.b5KeystrokeMs.budgetMax,
  );
  expect(evidence.b6InteractionMs.captured).toBe(true);
  expect(percentile(evidence.b6InteractionMs.samples, 75)).toBeLessThanOrEqual(
    evidence.b6InteractionMs.budgetP75,
  );
  expect(measuredRuns).toBe(resolveMeasuredRuns());
}

function assertD12CommonEvidence(evidence: D12RawEvidence, measuredRuns: number): void {
  assertD12RawBudgets(evidence, measuredRuns);
  const baseline = requireD12BaselineEvidence(evidence);
  expect(baseline.captured).toBe(true);
  expect(baseline.traceCaptured).toBe(true);
  expect(baseline.expectedSampleCount).toBe(TYPING_CHUNKS.length);
  expect(baseline.processingSamples).toHaveLength(TYPING_CHUNKS.length);
  expect(baseline.matchedInputEventCounts).toHaveLength(TYPING_CHUNKS.length);
  expect(baseline.totalMatchedInputEvents).toBeGreaterThanOrEqual(TYPING_CHUNKS.length);
  expect(baseline.longTaskCount).toBe(0);
  expect(baseline.maxLongTaskMs).toBe(0);
  if (
    evidence.b11Memory.supported &&
    evidence.b11Memory.baselineBytes !== null &&
    evidence.b11Memory.peakBytes !== null &&
    evidence.b11Memory.residualBytes !== null
  ) {
    expect(evidence.b11Memory.peakBytes - evidence.b11Memory.baselineBytes).toBeLessThanOrEqual(
      B11_PEAK_GROWTH_BUDGET_BYTES,
    );
    expect(evidence.b11Memory.residualBytes - evidence.b11Memory.baselineBytes).toBeLessThanOrEqual(
      B11_RESIDUAL_GROWTH_BUDGET_BYTES,
    );
  }
}

function assertD12CandidateEvidence(evidence: D12RawEvidence, measuredRuns: number): void {
  assertD12RawBudgets(evidence, measuredRuns);
  const candidate = evidence.b5IdleDebugSession;
  if (candidate === undefined) throw new Error("D12 candidate idle-debug evidence is missing");
  expect(candidate.attempted).toBe(true);
  expect(candidate.captured).toBe(true);
  expect(candidate.traceCaptured).toBe(true);
  expect(candidate.processingSamples).toHaveLength(TYPING_CHUNKS.length);
  expect(candidate.processingSamples.every((sample) => sample > 0)).toBe(true);
  expect(percentile(candidate.processingSamples, 95)).toBeLessThan(candidate.budgetMax);
  expect(candidate.longTaskCount).toBe(0);
  expect(candidate.maxLongTaskMs).toBe(0);
  expect(candidate.outputAcceptedBytes).toBe(0);
}

async function measureD12CandidateIdleDebug(
  page: Page,
  projectPath: string,
): Promise<IdleDebugEvidence> {
  const idleSession = await startIdleDebugSession(page, projectPath);
  try {
    const editorWindow = page.getByRole("region", { name: /Editor.*run\.ts/u });
    return buildIdleDebugB5Evidence(await measureIdleDebugTyping(page, editorWindow, idleSession));
  } finally {
    await stopIdleDebugSession(page, idleSession);
  }
}

function assertFinalEvidence(
  evidence: ReleaseEvidence | D12RawEvidence,
  measuredRuns: number,
  workerRequests: readonly WorkerRequest[],
): void {
  if (D12_REVISION === "baseline") {
    assertD12CommonEvidence(evidence as D12RawEvidence, measuredRuns);
    return;
  }
  if (D12_REVISION === "candidate") {
    assertD12CandidateEvidence(evidence as D12RawEvidence, measuredRuns);
    return;
  }
  assertEvidenceBudgets(evidence as ReleaseEvidence, measuredRuns, workerRequests, true);
}

test("records Keiko Editor browser release evidence (B4/B5/B6/B11) @release-evidence", async ({
  page,
}, testInfo) => {
  // Each editor open exercises the packaged UI and server path; the iteration count is kept modest
  // so this remains a release-evidence smoke, not a benchmark suite.
  test.setTimeout(600_000);
  d12RunProvenance = resolveD12RunProvenance(page);
  d12BaselineMeasuredWork = null;
  const projectPath = createProjectFixture();
  // The global workspace selector is the root authority for Files and Editor. Register the
  // disposable fixture through the same project route before measuring so the harness opens the
  // fixture's run.ts rather than a same-named file below the process launch directory.
  await registerPerformanceProject(page, projectPath);
  await seedFilesWindow(page, projectPath);
  const capture = installWorkerCapture(page);
  const measurements = await collectEvidenceMeasurements(page, capture, projectPath);
  const { coldStartsMs, typing, memory, navigation } = measurements;
  if (D12_REVISION === "baseline") {
    await page.goto("/");
    d12BaselineMeasuredWork = await measureD12BaselineWork(page, await openEditorCard(page));
  }
  let idleDebug = UNMEASURED_IDLE_DEBUG_EVIDENCE;
  if (D12_REVISION === "candidate") {
    idleDebug = await measureD12CandidateIdleDebug(page, projectPath);
  }

  // Adversarial near-cap workspace probe (audit defect #2): a single, cheap measurement (no repeated
  // warmups/runs) against a workspace whose total source bytes exceed maxWorkspaceReadBytes, proving
  // graceful degradation without materially extending this release-evidence smoke's runtime.
  const adversarialRoot = createAdversarialWorkspaceFixture();
  const workspaceCapDegradation = await measureWorkspaceCapDegradation(page, adversarialRoot);
  await writeEvidence(
    coldStartsMs,
    typing,
    memory,
    navigation,
    capture,
    workspaceCapDegradation,
    idleDebug,
  );

  const evidence = buildEvidence(
    coldStartsMs,
    typing,
    memory,
    navigation,
    capture.workerRequests,
    workspaceCapDegradation,
    idleDebug,
  ) as unknown as ReleaseEvidence | D12RawEvidence;

  await testInfo.attach("editor-perf-evidence", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });

  assertFinalEvidence(evidence, coldStartsMs.length, capture.workerRequests);
});
