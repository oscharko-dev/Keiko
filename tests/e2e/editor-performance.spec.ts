import { expect, test, type Page, type Response } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writePaddedFixtureFiles } from "./support/editorWorkspace.js";

// Number of cold-start samples: kept at 3 for the manual/release-evidence smoke, raised (>=10) in the
// scheduled/CI perf job via KEIKO_PERF_RUNS so p50/p95 are stable rather than the max of 3 noisy
// samples (GEN-PERF-BENCHMARK-013).
function resolveMeasuredRuns(): number {
  const raw = process.env.KEIKO_PERF_RUNS;
  if (raw === undefined) return 3;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
}

// Stamp the commit the evidence was measured at for the freshness gate (GEN-PERF-BENCHMARK-001).
function resolveCommit(): string {
  const fromEnv = process.env.GITHUB_SHA ?? process.env.KEIKO_PERF_COMMIT;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
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
const EVIDENCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "release",
  "1209-perf-evidence.json",
);
const tempProjects: string[] = [];

interface TypingMetrics {
  readonly longTasks: number[];
  readonly events: number[];
  readonly interactionDurations: number[];
  readonly keystrokeMainThreadWork: number[];
  observerInstalled?: boolean;
  landed?: boolean;
  activeElement?: string;
}

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
  const row = filesWindow.locator(`button.tr-row[data-path="${path}"]`);
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
  await filesWindow.getByRole("button", { name: "Close Files window" }).click();
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
    await filesWindow.getByRole("button", { name: "Close Files window" }).click();
    await expect(filesWindow).toBeHidden();
    await editorWindow.getByRole("button", { name: "Close Editor window" }).click();
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

const TYPING_CHUNKS = Array.from("export const greeting = 'keiko editor performance evidence';");
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
  return page.waitForResponse(isFinalDiagnosticsResponse);
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
  const editor = editorWindow.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.click({ timeout: 8_000 });
  const observerInstalled = await installPerfObservers(page);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
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
  await Promise.race([diagnosticsRecomputed, page.waitForTimeout(5_000).then(() => false)]);
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

/** B11: per-cycle baseline (no editor) -> peak (editor open) -> residual (editor closed) heap. */
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
  const readHeap = async (): Promise<number> =>
    page.evaluate(
      () =>
        (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize,
    );
  let baseline = 0;
  let peak = 0;
  let residual = 0;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await page.goto("/");
    await expect(page.getByRole("region", { name: /^Files/u })).toBeVisible();
    baseline = Math.max(baseline, await readHeap());
    const card = await openEditorCard(page);
    peak = Math.max(peak, await readHeap());
    await card.getByRole("button", { name: "Close Editor window" }).click();
    await expect(card).toBeHidden();
    await page.waitForTimeout(400);
    residual = Math.max(residual, await readHeap());
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

function captureWorkerResponse(response: Response, workerRequests: WorkerRequest[]): Promise<void> {
  const url = response.url();
  return response
    .body()
    .then((body) => {
      const workerLabel = classifyMonacoWorkerChunk(body.toString("utf8"));
      if (workerLabel === null) {
        return;
      }
      recordWorkerRequest(workerRequests, {
        url,
        resourceType: response.request().resourceType(),
        workerLabel,
        captureReason: "classified-response",
      });
    })
    .catch(() => {
      /* response body unavailable */
    });
}

function installWorkerCapture(page: Page): WorkerCapture {
  const workerRequests: WorkerRequest[] = [];
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
    if (shouldInspectJavaScriptResponse(response.url(), contentType)) {
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

function buildB6Evidence(typing: TypingMetrics): Record<string, unknown> {
  const interactionDurations =
    typing.events.length > 0 ? typing.events : typing.interactionDurations;
  return {
    budgetP75: 200,
    captured: typing.landed === true && interactionDurations.length > 0,
    source: typing.events.length > 0 ? "event-timing" : "raf-insert-proxy",
    eventCount: typing.events.length,
    interactionCount: interactionDurations.length,
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

function buildEvidence(
  coldStartsMs: number[],
  typing: TypingMetrics,
  memory: MemoryMetrics,
  navigation: NavigationMetrics,
  workerRequests: readonly WorkerRequest[],
  workspaceCapDegradation: WorkspaceCapDegradationEvidence,
): Record<string, unknown> {
  return {
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
    b6InteractionMs: buildB6Evidence(typing),
    navigationRoundTripMs: {
      definition: buildNavigationOperationEvidence(navigation.definition),
      references: buildNavigationOperationEvidence(navigation.references),
    },
    b11Memory: memory,
    workerLoadCapture: buildWorkerLoadCapture(workerRequests),
    workspaceReadCapDegradation: workspaceCapDegradation,
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

async function collectEvidenceMeasurements(
  page: Page,
  capture: WorkerCapture,
  projectPath: string,
): Promise<EvidenceMeasurements> {
  const measuredRuns = resolveMeasuredRuns();
  await page.goto("/");
  const navigation = await measureNavigationRoundTrips(page, projectPath, measuredRuns);
  const coldStartsMs = await measureColdStarts(page, 1, measuredRuns);
  let typing: TypingMetrics = {
    longTasks: [],
    events: [],
    interactionDurations: [],
    keystrokeMainThreadWork: [],
    landed: false,
  };
  let memory = await measureMemoryBestEffort(page);
  await writeEvidence(
    coldStartsMs,
    typing,
    memory,
    navigation,
    capture,
    UNMEASURED_WORKSPACE_CAP_DEGRADATION,
  );

  await page.goto("/");
  const editorWindow = await openEditorCard(page);
  typing = await measureTyping(page, editorWindow);
  await writeEvidence(
    coldStartsMs,
    typing,
    memory,
    navigation,
    capture,
    UNMEASURED_WORKSPACE_CAP_DEGRADATION,
  );

  memory = await measureMemoryBestEffort(page);
  await writeEvidence(
    coldStartsMs,
    typing,
    memory,
    navigation,
    capture,
    UNMEASURED_WORKSPACE_CAP_DEGRADATION,
  );
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
): void {
  expect(evidence.b4ColdStartMs.p50).toBeLessThanOrEqual(evidence.b4ColdStartMs.budgetP50);
  expect(evidence.b4ColdStartMs.p95).toBeLessThanOrEqual(evidence.b4ColdStartMs.budgetP95);
  expect(evidence.b5KeystrokeMs.captured).toBe(true);
  expect(evidence.b5KeystrokeMs.p95).toBeLessThan(evidence.b5KeystrokeMs.budgetMax);
  expect(evidence.b5KeystrokeMs.maxLongTaskMs).toBeLessThanOrEqual(
    evidence.b5KeystrokeMs.budgetMax,
  );
  expect(evidence.b6InteractionMs.captured).toBe(true);
  expect(evidence.b6InteractionMs.p75).toBeLessThanOrEqual(evidence.b6InteractionMs.budgetP75);
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
}

test("records Keiko Editor browser release evidence (B4/B5/B6/B11) @release-evidence", async ({
  page,
}, testInfo) => {
  // Each editor open exercises the packaged UI and server path; the iteration count is kept modest
  // so this remains a release-evidence smoke, not a benchmark suite.
  test.setTimeout(600_000);
  const projectPath = createProjectFixture();
  await seedFilesWindow(page, projectPath);
  const capture = installWorkerCapture(page);
  const measurements = await collectEvidenceMeasurements(page, capture, projectPath);
  const { coldStartsMs, typing, memory, navigation } = measurements;

  // Adversarial near-cap workspace probe (audit defect #2): a single, cheap measurement (no repeated
  // warmups/runs) against a workspace whose total source bytes exceed maxWorkspaceReadBytes, proving
  // graceful degradation without materially extending this release-evidence smoke's runtime.
  const adversarialRoot = createAdversarialWorkspaceFixture();
  const workspaceCapDegradation = await measureWorkspaceCapDegradation(page, adversarialRoot);
  await writeEvidence(coldStartsMs, typing, memory, navigation, capture, workspaceCapDegradation);

  const evidence = buildEvidence(
    coldStartsMs,
    typing,
    memory,
    navigation,
    capture.workerRequests,
    workspaceCapDegradation,
  ) as unknown as ReleaseEvidence;

  await testInfo.attach("editor-perf-evidence", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });

  assertEvidenceBudgets(evidence, coldStartsMs.length, capture.workerRequests);
});
