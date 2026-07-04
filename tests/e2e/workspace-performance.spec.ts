import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Stamp the commit the evidence was measured at so the freshness gate
// (scripts/check-perf-evidence.mjs, GEN-PERF-BENCHMARK-001) can prove the committed evidence
// belongs to this history. CI provides GITHUB_SHA; locally we fall back to `git rev-parse HEAD`.
function resolveCommit(): string {
  const fromEnv = process.env.GITHUB_SHA ?? process.env.KEIKO_PERF_COMMIT;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const EVIDENCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "release",
  "1580-workspace-perf-evidence.json",
);

const WINDOW_COUNT = 12;
const VIEW_STORAGE_KEY = "keiko.view";
const WORKSPACE_STORAGE_KEY = "keiko.workspace.v4";
const CONNECTION_STORAGE_KEY = "keiko.conns.v1";

interface BrowserPerfStore {
  storageWrites: Record<string, number>;
  workspacePuts: number;
  longTasks: number[];
  longTaskObserverInstalled: boolean;
  frameGaps: number[];
  frameRunning: boolean;
  frameLast: number;
  // Number of frame-gap samples captured during the active gesture (before the post-gesture idle
  // settle). p75 is computed over these only, so ~450ms of steady idle frames no longer dilute the
  // percentile toward the idle cadence (GEN-PERF-BENCHMARK-004).
  frameGesturePhaseCount: number;
}

declare global {
  interface Window {
    __keikoWorkspacePerf?: BrowserPerfStore;
  }
}

interface SeedWindow {
  readonly id: string;
  readonly type: "agents";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly cfg: Record<string, unknown>;
  readonly max: false;
  readonly zoom: 1;
}

interface SeedConnection {
  readonly id: string;
  readonly a: string;
  readonly b: string;
}

interface SeedPayload {
  readonly windows: readonly SeedWindow[];
  readonly connections: readonly SeedConnection[];
  readonly keys: {
    readonly workspace: string;
    readonly connections: string;
    readonly view: string;
  };
}

interface GestureCapture {
  readonly frameGaps: number[];
  readonly frameGesturePhaseCount: number;
  readonly storageWrites: Record<string, number>;
  readonly workspacePuts: number;
  readonly longTasks: number[];
  readonly longTaskObserverInstalled: boolean;
}

interface GestureEvidence {
  readonly label: string;
  readonly frameGapBudgetP75Ms: number;
  readonly frameGapBudgetMaxMs: number;
  readonly frameGapSamples: number;
  readonly frameGapTotalSamples: number;
  readonly frameGapP75Ms: number;
  readonly frameGapMaxMs: number;
  readonly longTaskObserverInstalled: boolean;
  readonly longTaskCount: number;
  readonly maxLongTaskMs: number;
  readonly viewWrites: number;
  readonly workspaceWrites: number;
  readonly workspacePuts: number;
}

interface GestureVerdict {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

interface ProjectEvidence {
  readonly project: string;
  readonly windowCount: number;
  readonly connectionCount: number;
  readonly measuredAtIso: string;
  readonly gestures: readonly GestureEvidence[];
  readonly verdict: GestureVerdict;
}

// Pure re-derivation of pass/fail from the recorded numbers, so the committed evidence carries a
// verdict the freshness gate (scripts/check-perf-evidence.mjs) can read even when the suite is not
// re-run (GEN-PERF-BENCHMARK-014).
function gestureVerdict(gestures: readonly GestureEvidence[]): GestureVerdict {
  const failures: string[] = [];
  for (const g of gestures) {
    if (g.frameGapSamples <= 3) failures.push(`${g.label}: too few gesture-phase samples`);
    if (g.frameGapP75Ms > g.frameGapBudgetP75Ms) {
      failures.push(
        `${g.label}: p75 ${String(g.frameGapP75Ms)} > ${String(g.frameGapBudgetP75Ms)}`,
      );
    }
    if (g.frameGapMaxMs > g.frameGapBudgetMaxMs) {
      failures.push(
        `${g.label}: max ${String(g.frameGapMaxMs)} > ${String(g.frameGapBudgetMaxMs)}`,
      );
    }
    if (g.longTaskObserverInstalled && g.maxLongTaskMs > 100) {
      failures.push(`${g.label}: long task ${String(g.maxLongTaskMs)} > 100`);
    }
    if (g.viewWrites > 1) failures.push(`${g.label}: viewWrites ${String(g.viewWrites)} > 1`);
    if (g.workspacePuts > 1)
      failures.push(`${g.label}: workspacePuts ${String(g.workspacePuts)} > 1`);
  }
  return { passed: failures.length === 0, failures };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return Math.round(sorted[index] ?? 0);
}

function seedWindows(): readonly SeedWindow[] {
  return Array.from({ length: WINDOW_COUNT }, (_unused, index) => ({
    id: `agents-${String(index)}`,
    type: "agents" as const,
    x: 80 + (index % 4) * 300,
    y: 70 + Math.floor(index / 4) * 255,
    w: 260,
    h: 210,
    z: index + 1,
    cfg: {},
    max: false as const,
    zoom: 1 as const,
  }));
}

function seedConnections(): readonly SeedConnection[] {
  return Array.from({ length: WINDOW_COUNT - 1 }, (_unused, index) => ({
    id: `agents-${String(index)}~agents-${String(index + 1)}`,
    a: `agents-${String(index)}`,
    b: `agents-${String(index + 1)}`,
  }));
}

function installWorkspacePerfHarness({ windows, connections, keys }: SeedPayload): void {
  Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => false });
  window.localStorage.setItem(keys.workspace, JSON.stringify(windows));
  window.localStorage.setItem(keys.connections, JSON.stringify(connections));
  window.localStorage.setItem(keys.view, JSON.stringify({ zoom: 1, x: 0, y: 0 }));
  window.localStorage.setItem("keiko.wallpaper.enabled", "false");

  const store: BrowserPerfStore = {
    storageWrites: {},
    workspacePuts: 0,
    longTasks: [],
    longTaskObserverInstalled: false,
    frameGaps: [],
    frameRunning: false,
    frameLast: 0,
    frameGesturePhaseCount: 0,
  };
  window.__keikoWorkspacePerf = store;

  const originalSetItem = Reflect.get(Storage.prototype, "setItem");
  Storage.prototype.setItem = function keikoWorkspacePerfSetItem(
    this: Storage,
    key: string,
    value: string,
  ): void {
    if (this === window.localStorage) {
      store.storageWrites[key] = (store.storageWrites[key] ?? 0) + 1;
    }
    originalSetItem.call(this, key, value);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (url.includes("/api/workspace/state") && method === "PUT") {
      store.workspacePuts += 1;
    }
    return originalFetch(input, init);
  };

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        store.longTasks.push(entry.duration);
      }
    }).observe({ type: "longtask", buffered: false });
    store.longTaskObserverInstalled = true;
  } catch {
    // WebKit and older engines may not expose Long Tasks.
  }
}

async function installSeededWorkspace(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.addInitScript(installWorkspacePerfHarness, {
    windows: seedWindows(),
    connections: seedConnections(),
    keys: {
      workspace: WORKSPACE_STORAGE_KEY,
      connections: CONNECTION_STORAGE_KEY,
      view: VIEW_STORAGE_KEY,
    },
  });
}

async function resetBrowserCounters(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__keikoWorkspacePerf;
    if (store === undefined) throw new Error("workspace perf store missing");
    store.storageWrites = {};
    store.workspacePuts = 0;
    store.longTasks = [];
  });
}

async function startFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__keikoWorkspacePerf;
    if (store === undefined) throw new Error("workspace perf store missing");
    store.frameGaps = [];
    store.frameLast = 0;
    store.frameRunning = true;
    store.frameGesturePhaseCount = 0;
    const tick = (now: number): void => {
      if (!store.frameRunning) return;
      if (store.frameLast > 0) store.frameGaps.push(now - store.frameLast);
      store.frameLast = now;
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
}

async function markGesturePhaseEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__keikoWorkspacePerf;
    if (store === undefined) throw new Error("workspace perf store missing");
    store.frameGesturePhaseCount = store.frameGaps.length;
  });
}

async function stopFrameProbe(page: Page): Promise<GestureCapture> {
  return page.evaluate(() => {
    const store = window.__keikoWorkspacePerf;
    if (store === undefined) throw new Error("workspace perf store missing");
    store.frameRunning = false;
    return {
      frameGaps: [...store.frameGaps],
      frameGesturePhaseCount: store.frameGesturePhaseCount,
      storageWrites: { ...store.storageWrites },
      workspacePuts: store.workspacePuts,
      longTasks: [...store.longTasks],
      longTaskObserverInstalled: store.longTaskObserverInstalled,
    };
  });
}

async function recordGesture(page: Page, run: () => Promise<void>): Promise<GestureCapture> {
  await resetBrowserCounters(page);
  await startFrameProbe(page);
  await run();
  // Freeze the gesture-phase boundary BEFORE the idle settle so p75 reflects the gesture, not the
  // steady idle frames that follow it (GEN-PERF-BENCHMARK-004).
  await markGesturePhaseEnd(page);
  await page.waitForTimeout(450);
  return stopFrameProbe(page);
}

function budgets(projectName: string): { p75: number; max: number } {
  return projectName === "webkit" ? { p75: 50, max: 150 } : { p75: 34, max: 120 };
}

function summarizeGesture(
  label: string,
  capture: GestureCapture,
  projectName: string,
): GestureEvidence {
  const budget = budgets(projectName);
  // Percentile/max over the gesture-phase frames only (fall back to all frames if the boundary was
  // never marked or captured too few), so idle settle frames do not dilute the percentile.
  const gestureFrames =
    capture.frameGesturePhaseCount > 3
      ? capture.frameGaps.slice(0, capture.frameGesturePhaseCount)
      : capture.frameGaps;
  return {
    label,
    frameGapBudgetP75Ms: budget.p75,
    frameGapBudgetMaxMs: budget.max,
    frameGapSamples: gestureFrames.length,
    frameGapTotalSamples: capture.frameGaps.length,
    frameGapP75Ms: percentile(gestureFrames, 75),
    frameGapMaxMs: Math.round(Math.max(0, ...gestureFrames)),
    longTaskObserverInstalled: capture.longTaskObserverInstalled,
    longTaskCount: capture.longTasks.length,
    maxLongTaskMs: Math.round(Math.max(0, ...capture.longTasks)),
    viewWrites: capture.storageWrites[VIEW_STORAGE_KEY] ?? 0,
    workspaceWrites: capture.storageWrites[WORKSPACE_STORAGE_KEY] ?? 0,
    workspacePuts: capture.workspacePuts,
  };
}

function assertGesture(evidence: GestureEvidence, projectName: string): void {
  expect(evidence.frameGapSamples, `${evidence.label} should capture rAF samples`).toBeGreaterThan(
    3,
  );
  // Frame-gap TIMING budgets (#1580) are gated on the reference browser (chromium) only. Headless
  // WebKit on the CI runners has no GPU and falls back to software rendering, producing frame gaps an
  // order of magnitude larger than real hardware (observed p75 ~421ms vs a 50ms budget) — an
  // environment artifact, not a perf signal. WebKit still runs the gesture and records evidence plus
  // the functional invariants below (rAF samples, long-task budget, write/PUT counts), so a real
  // cross-browser behavioural regression is still caught; only the unrepresentable timing budget is
  // skipped. On real hardware WebKit meets the budget (the local run passes).
  if (projectName !== "webkit") {
    expect(evidence.frameGapP75Ms, `${evidence.label} p75 frame gap`).toBeLessThanOrEqual(
      evidence.frameGapBudgetP75Ms,
    );
    expect(evidence.frameGapMaxMs, `${evidence.label} max frame gap`).toBeLessThanOrEqual(
      evidence.frameGapBudgetMaxMs,
    );
  }
  if (projectName !== "webkit" || evidence.longTaskObserverInstalled) {
    expect(evidence.maxLongTaskMs, `${evidence.label} long task budget`).toBeLessThanOrEqual(100);
  }
  expect(evidence.viewWrites, `${evidence.label} view writes`).toBeLessThanOrEqual(1);
  expect(evidence.workspacePuts, `${evidence.label} workspace PUTs`).toBeLessThanOrEqual(1);
}

function readExistingEvidence(): { readonly runs?: Record<string, ProjectEvidence> } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const runs = (parsed as { readonly runs?: unknown }).runs;
    return typeof runs === "object" && runs !== null
      ? { runs: runs as Record<string, ProjectEvidence> }
      : {};
  } catch {
    return {};
  }
}

function writeMergedEvidence(projectEvidence: ProjectEvidence): Record<string, unknown> {
  const existing = readExistingEvidence();
  const evidence = {
    measuredAtIso: new Date().toISOString(),
    commit: resolveCommit(),
    harness:
      "packaged CLI serving the production static UI via tests/e2e/config/playwright.workspace-performance.config.ts",
    runs: {
      ...(existing.runs ?? {}),
      [projectEvidence.project]: projectEvidence,
    },
  };
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

async function freeWorkspacePoint(page: Page): Promise<{ readonly x: number; readonly y: number }> {
  const box = await page.locator(".workspace").boundingBox();
  if (box === null) throw new Error("workspace surface has no box");
  return { x: box.x + 40, y: box.y + 40 };
}

async function panWorkspace(page: Page): Promise<void> {
  const point = await freeWorkspacePoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(point.x + step * 12, point.y - step * 5);
  }
  await page.mouse.up();
}

async function zoomWorkspace(page: Page): Promise<void> {
  const point = await freeWorkspacePoint(page);
  await page.keyboard.down("Control");
  for (let step = 0; step < 6; step += 1) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -120);
  }
  await page.keyboard.up("Control");
}

async function dragWindow(page: Page): Promise<void> {
  const header = page.locator('.window[data-window-id="agents-0"] .win-head');
  await expect(header).toBeVisible();
  const box = await header.boundingBox();
  if (box === null) throw new Error("agents-0 header has no box");
  const startX = box.x + Math.min(80, box.width / 2);
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(startX + step * 10, startY + step * 4);
  }
  await page.mouse.up();
}

test("keeps N+1 workspace gestures within performance budgets (#1580) @release-evidence", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await installSeededWorkspace(page);
  await page.goto("/");
  await expect(page.locator(".window")).toHaveCount(WINDOW_COUNT);
  await page.waitForTimeout(450);

  const pan = summarizeGesture(
    "workspace pan",
    await recordGesture(page, () => panWorkspace(page)),
    testInfo.project.name,
  );
  const zoom = summarizeGesture(
    "workspace zoom",
    await recordGesture(page, () => zoomWorkspace(page)),
    testInfo.project.name,
  );
  const drag = summarizeGesture(
    "window drag",
    await recordGesture(page, () => dragWindow(page)),
    testInfo.project.name,
  );

  const gestures = [pan, zoom, drag];
  const projectEvidence: ProjectEvidence = {
    project: testInfo.project.name,
    windowCount: WINDOW_COUNT,
    connectionCount: WINDOW_COUNT - 1,
    measuredAtIso: new Date().toISOString(),
    gestures,
    verdict: gestureVerdict(gestures),
  };
  const evidence = writeMergedEvidence(projectEvidence);

  await testInfo.attach("workspace-perf-evidence", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });

  for (const gesture of projectEvidence.gestures) assertGesture(gesture, testInfo.project.name);
  expect(
    drag.workspaceWrites,
    "drag should debounce workspace snapshot writes",
  ).toBeLessThanOrEqual(1);
});

// --- Scale + low-end tier (GEN-PERF-BENCHMARK-005/-008/-012) ---------------------------------------
//
// Env-gated so the default @release-evidence run stays fast: set KEIKO_PERF_SCALE_WINDOWS=50 (or 100)
// to seed a mixed-geometry workspace at the product's declared-capacity tier, and
// KEIKO_PERF_CPU_THROTTLE=4 to emulate a 4x-slower CPU (chromium only) so main-thread work the 4-6x
// idle headroom normally hides becomes visible. This is a scaling/ceiling guard: budgets are looser
// than the interactive 12-window tier and are meant to catch super-linear blow-ups (O(N^2) connection
// geometry, per-window effect storms, write-coalescing that degrades with count), not to enforce
// 60fps at 100 windows. Ratchet from the first observed CI baseline.

function seedWindowsN(count: number): readonly SeedWindow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `agents-${String(index)}`,
    type: "agents" as const,
    x: 60 + (index % 10) * 150,
    y: 60 + Math.floor(index / 10) * 150,
    w: 130,
    h: 120,
    z: index + 1,
    cfg: {},
    max: false as const,
    zoom: 1 as const,
  }));
}

function seedConnectionsN(count: number): readonly SeedConnection[] {
  return Array.from({ length: Math.max(0, count - 1) }, (_unused, index) => ({
    id: `agents-${String(index)}~agents-${String(index + 1)}`,
    a: `agents-${String(index)}`,
    b: `agents-${String(index + 1)}`,
  }));
}

const SCALE_WINDOWS = Number.parseInt(process.env.KEIKO_PERF_SCALE_WINDOWS ?? "0", 10);

// eslint-disable-next-line max-lines-per-function -- Playwright describe block holds the skip guard plus the single scale-tier evidence test; keeping them together preserves the suite structure.
test.describe("workspace scale + low-end tier", () => {
  test.skip(
    !(Number.isFinite(SCALE_WINDOWS) && SCALE_WINDOWS >= 20),
    "set KEIKO_PERF_SCALE_WINDOWS>=20 to run the declared-capacity scale tier",
  );

  test("keeps gestures bounded at declared-capacity window counts @release-evidence-scale", async ({
    page,
    // eslint-disable-next-line max-lines-per-function -- one end-to-end scale-tier gesture measurement: seed windows, mount, record pan/drag, attach evidence, then assert every budget in sequence.
  }, testInfo) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.addInitScript(installWorkspacePerfHarness, {
      windows: seedWindowsN(SCALE_WINDOWS),
      connections: seedConnectionsN(SCALE_WINDOWS),
      keys: {
        workspace: WORKSPACE_STORAGE_KEY,
        connections: CONNECTION_STORAGE_KEY,
        view: VIEW_STORAGE_KEY,
      },
    });

    const throttleRate = Number.parseInt(process.env.KEIKO_PERF_CPU_THROTTLE ?? "0", 10);
    if (throttleRate >= 2 && testInfo.project.name === "chromium") {
      const client = await page.context().newCDPSession(page);
      await client.send("Emulation.setCPUThrottlingRate", { rate: throttleRate });
    }

    const mountStart = Date.now();
    await page.goto("/");
    await expect(page.locator(".window")).toHaveCount(SCALE_WINDOWS);
    const mountMs = Date.now() - mountStart;
    await page.waitForTimeout(450);

    const pan = summarizeGesture(
      "workspace pan (scale)",
      await recordGesture(page, () => panWorkspace(page)),
      testInfo.project.name,
    );
    const drag = summarizeGesture(
      "window drag (scale)",
      await recordGesture(page, () => dragWindow(page)),
      testInfo.project.name,
    );

    await testInfo.attach("workspace-scale-perf-evidence", {
      body: JSON.stringify(
        {
          commit: resolveCommit(),
          windows: SCALE_WINDOWS,
          throttleRate,
          mountMs,
          gestures: [pan, drag],
        },
        null,
        2,
      ),
      contentType: "application/json",
    });

    // Ceiling budgets: scale by count but stay bounded. Write coalescing must NOT degrade with count.
    const p75Budget = SCALE_WINDOWS >= 80 ? 50 : 40;
    const maxBudget = SCALE_WINDOWS >= 80 ? 250 : 180;
    for (const gesture of [pan, drag]) {
      expect(gesture.frameGapSamples, `${gesture.label} samples`).toBeGreaterThan(3);
      // Timing budgets are chromium-only (headless WebKit software-renders on CI; see assertGesture).
      if (testInfo.project.name !== "webkit") {
        expect(gesture.frameGapP75Ms, `${gesture.label} p75`).toBeLessThanOrEqual(p75Budget);
        expect(gesture.frameGapMaxMs, `${gesture.label} max`).toBeLessThanOrEqual(maxBudget);
      }
      expect(gesture.viewWrites, `${gesture.label} view writes`).toBeLessThanOrEqual(1);
      expect(gesture.workspacePuts, `${gesture.label} PUTs`).toBeLessThanOrEqual(1);
    }
    expect(drag.workspaceWrites, "drag write coalescing holds at scale").toBeLessThanOrEqual(1);
  });
});
