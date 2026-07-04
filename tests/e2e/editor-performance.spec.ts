import { expect, test, type Page, type Response } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function createProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-perf-"));
  tempProjects.push(root);
  mkdirSync(join(root, "packages", "keiko-cli", "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Keiko perf fixture\n", "utf8");
  writeFileSync(join(root, RELATIVE_PATH), "export const e2eFixture = true;\n", "utf8");
  return root;
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
    await expect(editorWindow.locator(".view-line").first()).toContainText("e2eFixture");
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
    const store: TypingMetrics = { longTasks: [], events: [], interactionDurations: [] };
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

const TYPING_CHUNKS = ["export const greeting = ", "'keiko editor ", "performance evidence';"];

async function insertMeasuredChunks(page: Page): Promise<void> {
  for (const chunk of TYPING_CHUNKS) {
    const start = Date.now();
    await page.keyboard.insertText(chunk);
    await awaitNextPaint(page);
    const duration = Date.now() - start;
    await page.evaluate((value) => {
      (window as unknown as { __keikoPerf?: TypingMetrics }).__keikoPerf?.interactionDurations.push(
        value,
      );
    }, duration);
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
  await page.keyboard.down(modifier);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(modifier);
  await insertMeasuredChunks(page);
  await page.waitForTimeout(250);
  return observerInstalled;
}

async function hasTypedTextLanded(editorWindow: ReturnType<Page["getByRole"]>): Promise<boolean> {
  return editorWindow
    .locator(".view-line")
    .filter({ hasText: "greeting" })
    .first()
    .isVisible({ timeout: 5_000 });
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
  return {
    longTasks: metrics?.longTasks ?? [],
    events: metrics?.events ?? [],
    interactionDurations: metrics?.interactionDurations ?? [],
    observerInstalled: metrics?.observerInstalled ?? observerInstalled,
    landed,
    activeElement,
  };
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
  return {
    budgetMax: 50,
    captured: typing.landed === true && typing.observerInstalled === true,
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

function buildEvidence(
  coldStartsMs: number[],
  typing: TypingMetrics,
  memory: MemoryMetrics,
  workerRequests: readonly WorkerRequest[],
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
    b11Memory: memory,
    workerLoadCapture: buildWorkerLoadCapture(workerRequests),
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
  capture: WorkerCapture,
): Promise<void> {
  await capture.settleWorkerCaptures();
  writeFileSync(
    EVIDENCE_PATH,
    `${JSON.stringify(buildEvidence(coldStartsMs, typing, memory, capture.workerRequests), null, 2)}\n`,
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
}

async function collectEvidenceMeasurements(
  page: Page,
  capture: WorkerCapture,
): Promise<EvidenceMeasurements> {
  const measuredRuns = resolveMeasuredRuns();
  const coldStartsMs = await measureColdStarts(page, 1, measuredRuns);
  let typing: TypingMetrics = {
    longTasks: [],
    events: [],
    interactionDurations: [],
    landed: false,
  };
  let memory = await measureMemoryBestEffort(page);
  await writeEvidence(coldStartsMs, typing, memory, capture);

  await page.goto("/");
  const editorWindow = await openEditorCard(page);
  typing = await measureTyping(page, editorWindow);
  await writeEvidence(coldStartsMs, typing, memory, capture);

  memory = await measureMemoryBestEffort(page);
  await writeEvidence(coldStartsMs, typing, memory, capture);
  return { coldStartsMs, typing, memory };
}

// Documented B11 ceilings (docs/keiko-editor/1207-performance-budgets.md): peak heap growth across
// open/close cycles and residual growth after close.
const B11_PEAK_GROWTH_BUDGET_BYTES = 128 * 1024 * 1024;
const B11_RESIDUAL_GROWTH_BUDGET_BYTES = 16 * 1024 * 1024;

// eslint-disable-next-line max-lines-per-function -- single release-evidence gate asserting every B4/B5/B6/B11 budget and worker-load guard together; splitting would scatter the coupled expectations.
function assertEvidenceBudgets(
  evidence: {
    b4ColdStartMs: { budgetP50: number; budgetP95: number; p50: number; p95: number };
    b5KeystrokeMs: { budgetMax: number; captured: boolean; maxLongTaskMs: number };
    b6InteractionMs: { budgetP75: number; captured: boolean; p75: number };
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
  },
  measuredRuns: number,
  workerRequests: readonly WorkerRequest[],
): void {
  expect(evidence.b4ColdStartMs.p50).toBeLessThanOrEqual(evidence.b4ColdStartMs.budgetP50);
  expect(evidence.b4ColdStartMs.p95).toBeLessThanOrEqual(evidence.b4ColdStartMs.budgetP95);
  expect(evidence.b5KeystrokeMs.captured).toBe(true);
  expect(evidence.b5KeystrokeMs.maxLongTaskMs).toBeLessThanOrEqual(
    evidence.b5KeystrokeMs.budgetMax,
  );
  expect(evidence.b6InteractionMs.captured).toBe(true);
  expect(evidence.b6InteractionMs.p75).toBeLessThanOrEqual(evidence.b6InteractionMs.budgetP75);
  expect(evidence.workerLoadCapture.totalWorkerRequests).toBeGreaterThan(0);
  expect(evidence.workerLoadCapture.editorWorkerLoaded).toBe(true);
  expect(evidence.workerLoadCapture.languageWorkerLoaded).toBe(false);
  expect(workerRequests.some(isTsWorkerRequest)).toBe(false);
  expect(workerRequests.some(isLanguageWorkerRequest)).toBe(false);
  expect(evidence.b4ColdStartMs.p50 > 0).toBe(true);
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

test("records Keiko Editor browser release evidence (B4/B5/B6/B11) @release-evidence", async ({
  page,
}, testInfo) => {
  // Each editor open exercises the packaged UI and server path; the iteration count is kept modest
  // so this remains a release-evidence smoke, not a benchmark suite.
  test.setTimeout(600_000);
  const projectPath = createProjectFixture();
  await seedFilesWindow(page, projectPath);
  const capture = installWorkerCapture(page);
  const measurements = await collectEvidenceMeasurements(page, capture);
  const { coldStartsMs, typing, memory } = measurements;

  await testInfo.attach("editor-perf-evidence", {
    body: JSON.stringify(
      buildEvidence(coldStartsMs, typing, memory, capture.workerRequests),
      null,
      2,
    ),
    contentType: "application/json",
  });

  const evidence = buildEvidence(coldStartsMs, typing, memory, capture.workerRequests) as {
    b4ColdStartMs: { budgetP50: number; budgetP95: number; p50: number; p95: number };
    b5KeystrokeMs: { budgetMax: number; captured: boolean; maxLongTaskMs: number };
    b6InteractionMs: { budgetP75: number; captured: boolean; p75: number };
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
  };

  assertEvidenceBudgets(evidence, coldStartsMs.length, capture.workerRequests);
});
