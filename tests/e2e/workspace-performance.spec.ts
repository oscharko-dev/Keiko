import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  readonly frameGapP75Ms: number;
  readonly frameGapMaxMs: number;
  readonly longTaskObserverInstalled: boolean;
  readonly longTaskCount: number;
  readonly maxLongTaskMs: number;
  readonly viewWrites: number;
  readonly workspaceWrites: number;
  readonly workspacePuts: number;
}

interface ProjectEvidence {
  readonly project: string;
  readonly windowCount: number;
  readonly connectionCount: number;
  readonly gestures: readonly GestureEvidence[];
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
    const tick = (now: number): void => {
      if (!store.frameRunning) return;
      if (store.frameLast > 0) store.frameGaps.push(now - store.frameLast);
      store.frameLast = now;
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
}

async function stopFrameProbe(page: Page): Promise<GestureCapture> {
  return page.evaluate(() => {
    const store = window.__keikoWorkspacePerf;
    if (store === undefined) throw new Error("workspace perf store missing");
    store.frameRunning = false;
    return {
      frameGaps: [...store.frameGaps],
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
  return {
    label,
    frameGapBudgetP75Ms: budget.p75,
    frameGapBudgetMaxMs: budget.max,
    frameGapSamples: capture.frameGaps.length,
    frameGapP75Ms: percentile(capture.frameGaps, 75),
    frameGapMaxMs: Math.round(Math.max(0, ...capture.frameGaps)),
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
  expect(evidence.frameGapP75Ms, `${evidence.label} p75 frame gap`).toBeLessThanOrEqual(
    evidence.frameGapBudgetP75Ms,
  );
  expect(evidence.frameGapMaxMs, `${evidence.label} max frame gap`).toBeLessThanOrEqual(
    evidence.frameGapBudgetMaxMs,
  );
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

  const projectEvidence: ProjectEvidence = {
    project: testInfo.project.name,
    windowCount: WINDOW_COUNT,
    connectionCount: WINDOW_COUNT - 1,
    gestures: [pan, zoom, drag],
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
