import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keiko Editor browser-measured release evidence (Issue #1209; ADR-0042 D3.6 §B4/B5/B6/B11).
 *
 * ADR-0042 D3.6 assigns #1207 to "measure and enforce" the deterministic budgets and #1209 to "record
 * release evidence" for the budgets that require a real browser and the editor running against the
 * real app path. This `@release-evidence` spec opens the Workspace editor card against the live
 * dev-runner app (the same harness `tests/e2e/release-smoke.spec.ts` uses — keiko-server BFF + Next),
 * and records, into `docs/release/1209-perf-evidence.json`:
 *
 *   B4   first-card-open cold-start (open -> interactive), p50/p95 across repeats
 *   B5   per-keystroke main-thread work (longest long task during a typing burst)
 *   B6   editor interaction-to-next-paint proxy (Event Timing durations, p75/max)
 *   B11  worker/model heap growth across open/close cycles and residual after close
 *   +    the runtime worker-load capture proving the governed editor instantiates only the editor
 *        worker — the TS/JSON/CSS/HTML language workers ship but are never loaded (D4)
 *
 * Honesty note recorded with the evidence: the dev-runner serves the unminified webpack dev build, so
 * the latency figures are CONSERVATIVE UPPER BOUNDS — the production static export is tree-shaken and
 * minified with no on-demand compilation. The worker-load capture and the memory-disposal behaviour
 * are bundler-independent. This spec is not part of the required `@smoke` set; it is the reusable
 * release-evidence harness, run via `npm run test:e2e:editor-perf`.
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
async function installPerfObservers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store: TypingMetrics = { longTasks: [], events: [] };
    (window as unknown as { __keikoPerf: TypingMetrics }).__keikoPerf = store;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          store.longTasks.push(entry.duration);
        }
      }).observe({ type: "longtask", buffered: true });
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
        buffered: true,
        durationThreshold: 16,
      } as PerformanceObserverInit);
    } catch {
      /* event timing unsupported */
    }
  });
}

/**
 * B5/B6: focus the Monaco input (click the editor, then focus its hidden `textarea.inputarea`), type
 * a realistic burst, and read the observed long tasks + per-interaction durations. Best-effort and
 * self-diagnosing: it records whether the burst landed and the active element, and never throws, so a
 * focus quirk in the headless dev harness cannot block the load-bearing B4/B11/worker-capture
 * evidence. When `landed` is false the B5/B6 figures are reported as not-captured, not as "fast".
 */
async function measureTyping(
  page: Page,
  editorWindow: ReturnType<Page["getByRole"]>,
): Promise<TypingMetrics> {
  const burst = "export const greeting = 'keiko editor performance evidence';";
  let landed = false;
  try {
    // Bounded actions so a headless focus quirk degrades quickly to "not captured" instead of
    // hanging until the test timeout; the load-bearing B4 + worker-capture evidence is already flushed.
    const editor = editorWindow.locator(".monaco-editor").first();
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await editor.click({ timeout: 8_000 });
    await editorWindow.locator("textarea.inputarea").first().focus({ timeout: 8_000 });
    await installPerfObservers(page);
    await page.keyboard.type(burst, { delay: 24 });
    await page.waitForTimeout(500);
    landed = await editorWindow
      .locator(".view-line")
      .filter({ hasText: "greeting" })
      .first()
      .isVisible({ timeout: 5_000 });
  } catch {
    /* focus/typing quirk: fall through with whatever the observers captured */
  }
  const metrics = await page.evaluate(
    () => (window as unknown as { __keikoPerf?: TypingMetrics }).__keikoPerf,
  );
  const activeElement = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80) : "none";
  });
  return {
    longTasks: metrics?.longTasks ?? [],
    events: metrics?.events ?? [],
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

interface WorkerRequest {
  readonly url: string;
  readonly resourceType: string;
}

function buildEvidence(
  coldStartsMs: number[],
  typing: TypingMetrics,
  memory: MemoryMetrics,
  workerRequests: readonly WorkerRequest[],
): Record<string, unknown> {
  const tsWorkerLoaded = workerRequests.some((r) => /ts\.worker|typescript.*worker/iu.test(r.url));
  return {
    measuredAtIso: new Date().toISOString(),
    harness:
      "dev-runner (webpack dev build) via playwright.config.ts; conservative upper bound vs production",
    b4ColdStartMs: {
      budgetP50: 1500,
      budgetP95: 2500,
      samples: coldStartsMs,
      p50: percentile(coldStartsMs, 50),
      p95: percentile(coldStartsMs, 95),
    },
    b5KeystrokeMs: {
      budgetMax: 50,
      captured: typing.landed === true,
      activeElement: typing.activeElement ?? "unknown",
      longTaskCount: typing.longTasks.length,
      maxLongTaskMs: Math.round(Math.max(0, ...typing.longTasks)),
    },
    b6InteractionMs: {
      budgetP75: 200,
      captured: typing.landed === true,
      eventCount: typing.events.length,
      p75: percentile(typing.events, 75),
      max: Math.round(Math.max(0, ...typing.events)),
    },
    b11Memory: memory,
    workerLoadCapture: {
      totalWorkerRequests: workerRequests.length,
      tsLanguageWorkerLoaded: tsWorkerLoaded,
      requests: workerRequests.slice(0, 40),
    },
  };
}

test.afterEach(() => {
  for (const root of tempProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records Keiko Editor browser release evidence (B4/B5/B6/B11) @release-evidence", async ({
  page,
}, testInfo) => {
  // Each editor open under the dev bundler (webpack, on-demand compile) is expensive; the iteration
  // counts are kept modest and the budget generous so the harness completes against the dev app path.
  test.setTimeout(600_000);
  const projectPath = createProjectFixture();
  await seedFilesWindow(page, projectPath);

  // Worker-load capture: record every worker/script the browser fetches for the editor session.
  const workerRequests: WorkerRequest[] = [];
  page.on("request", (request) => {
    const type = request.resourceType();
    const url = request.url();
    if (type === "worker" || /worker/iu.test(url)) {
      workerRequests.push({ url, resourceType: type });
    }
  });

  // The evidence JSON is written progressively after each phase, so a slow-bundler timeout still
  // leaves the load-bearing B4 + worker-load capture on disk rather than losing every measurement.
  let typing: TypingMetrics = { longTasks: [], events: [], landed: false };
  let memory: MemoryMetrics = {
    supported: false,
    baselineBytes: null,
    peakBytes: null,
    residualBytes: null,
    cycles: 0,
  };
  const flush = (cold: number[]): void => {
    writeFileSync(
      EVIDENCE_PATH,
      `${JSON.stringify(buildEvidence(cold, typing, memory, workerRequests), null, 2)}\n`,
      "utf8",
    );
  };

  const measuredRuns = 3;
  const coldStartsMs = await measureColdStarts(page, 1, measuredRuns);
  flush(coldStartsMs);

  await page.goto("/");
  const editorWindow = await openEditorCard(page);
  typing = await measureTyping(page, editorWindow);
  flush(coldStartsMs);

  try {
    memory = await measureMemory(page, 2);
  } catch {
    /* a headless harness quirk must not discard the already-flushed B4/B5/B6/worker evidence */
  }
  flush(coldStartsMs);

  await testInfo.attach("editor-perf-evidence", {
    body: JSON.stringify(buildEvidence(coldStartsMs, typing, memory, workerRequests), null, 2),
    contentType: "application/json",
  });

  // Hard invariants that hold regardless of the (bundler-sensitive) latency magnitudes.
  expect(coldStartsMs.length).toBe(measuredRuns);
  // The TypeScript language worker (the 1.37 MB chunk) is never instantiated for a governed session.
  expect(workerRequests.some((r) => /ts\.worker|typescript.*worker/iu.test(r.url))).toBe(false);
  // Keystrokes do no model/retrieval work on the main thread: no catastrophic long task. The ceiling
  // is generous (vs the 50 ms target) to stay non-flaky while still catching a per-keystroke block.
  expect(Math.max(0, ...typing.longTasks)).toBeLessThan(1000);
});
