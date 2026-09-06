import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  expect,
  test,
  type Browser,
  type CDPSession,
  type Locator,
  type Page,
  type Request,
  type Response as PlaywrightResponse,
} from "@playwright/test";

import {
  EDITOR_SELECTORS,
  cleanupEditorWorkspaces,
  createEditorWorkspace,
  firstPane,
  openEditorWorkspace,
  openTreeFile,
  seedEditorWindow,
} from "./support/editorWorkspace.js";
import { editorModifier } from "./support/editor-chord.js";
import {
  capturedStartedSessionIdAfter,
  capturedStartedSessionIds,
} from "./support/debugSessionStartCapture.js";
import { clickWindowChromeButton } from "./support/window-chrome.js";

const { computeD12NearestRankPercentile: percentile } = (await import(
  new URL("../../scripts/check-perf-evidence.mjs", import.meta.url).href
)) as unknown as {
  readonly computeD12NearestRankPercentile: (
    samples: readonly number[],
    percentileValue: number,
  ) => number;
};

const FIXTURE_ROOT = join(process.cwd(), "tests", "e2e", "fixtures", "editor-debugging-2348");
const PROGRAM = "src/program.ts";
const THROWS = "src/throws.ts";
const CAP_STOPPED = "src/cap-stopped.ts";
const CAP_OUTPUT = "src/cap-output.ts";
const EDITOR_WINDOW_ID = "issue-2348-editor";
const CAP_SAMPLE_COUNT = 10;
// ADR-0139 D1: shared CI runners cannot schedule reliably enough for single-shot wall-clock
// assertions. The D12 producer and the scheduled performance workflow set this flag and enforce
// the budgets; required-runner executions still record the measured values into the evidence.
// NOTE: the official producer no longer sets this — it measures at full depth and leaves the
// verdict to check-perf-evidence.mjs. The flag remains for a deliberately controlled local run.
const ENFORCE_WALL_CLOCK_BUDGETS = process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS === "1";
// Sample depth and budget verdict are separate concerns. The producer needs the full sample loop to
// compute meaningful percentiles, but it must NOT also be the judge: asserting a wall-clock budget
// inside the measurement aborts the run, so a single noisy-neighbour spike on the shared runner
// yields no evidence at all instead of evidence showing the overrun. check-perf-evidence.mjs owns
// that verdict against the committed document (`outputFlood maxLongTaskMs > budget`,
// D12_CAP_LONG_TASK_BUDGET_MS = 50), where an overrun is reported rather than swallowed.
const FULL_SAMPLE_DEPTH =
  ENFORCE_WALL_CLOCK_BUDGETS || process.env.KEIKO_D12_FULL_SAMPLE_DEPTH === "1";
// The repeated stop-latency sample loops exist to feed the wall-clock percentiles. Outside the
// controlled measurement context they only need to exercise the stop path deterministically, so
// required CI runs a small fixed count — the full ten-sample loop timed out on shared runners
// while the bounded-cap composition (bytes, markers, retained caps, variables) is unaffected.
const STOP_SAMPLE_COUNT = FULL_SAMPLE_DEPTH ? CAP_SAMPLE_COUNT : 2;
const CAP_STACK_FRAMES = 128;
const CAP_SCOPES = 32;
const CAP_VARIABLES = 200;
const CAP_GRAPH_NODES = 1_000;
const CAP_OUTPUT_BYTES = 1_048_576;
const CAP_BROWSER_BYTES = 524_288;
const CAP_BROWSER_ENTRIES = 2_000;
const CAP_RENDERED_ROWS = 200;
const CAP_RESIDUAL_HEAP_BYTES = 16 * 1_024 * 1_024;
const SHA_256 = /^[0-9a-f]{64}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const requireFromSpec = createRequire(import.meta.url);
// D12 measures both checkout apps through this spec's Playwright harness, not the checkout cwd.
const PLAYWRIGHT_TEST_VERSION = packageVersionFromSpec("@playwright/test");
const DEBUG_ACTIVATION_STATES = new Set([
  "available",
  "disabled",
  "disabledByPolicy",
  "notProvisioned",
]);
const DEBUG_ACTIVATION_REASONS = new Set([
  "AVAILABLE",
  "NOT_PROVISIONED",
  "POLICY_DENIED",
  "POLICY_UNAVAILABLE",
  "PRODUCT_UNSUPPORTED",
  "WORKSPACE_ACTIVATION_UNSET",
  "WORKSPACE_DISABLED",
]);

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

interface DebugSessionProjection {
  readonly pauseGeneration: number;
  readonly sessionId: string;
  readonly targetKind: "catalog" | "file";
}

interface CapturedDebugEvent {
  readonly event: string;
  readonly data: string;
  readonly kind?: string;
  readonly observedAt: number;
  readonly originalBytes?: number;
  readonly reason?: string;
  readonly sessionId?: string;
}

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

interface StoppedProjectionEvidence {
  readonly depth: 4;
  readonly frames: 128;
  readonly inlineDecorations: 200;
  readonly maxLongTaskMs: number;
  readonly nodes: 1_000;
  readonly p75: number;
  readonly samples: readonly number[];
  readonly scopes: 32;
  readonly variables: 200;
}

interface OutputFloodEvidence {
  readonly adapterOutputBytes: number;
  readonly limitMarkers: 1;
  readonly maxLongTaskMs: number;
  readonly renderedRows: number;
  readonly renderedRowsCeiling: 200;
  readonly residualHeapBytes: number;
  readonly retainedBytes: number;
  readonly retainedEntries: number;
  readonly stopP75: number;
  readonly stopSamples: readonly number[];
}

interface D12StopProbe {
  readonly sessionId: string;
  activatedAt?: number;
  controlCompleted: boolean;
  terminalSseObserved: boolean;
  finishing: boolean;
}

let activeSessionId: string | undefined;
let stoppedProjectionEvidence: StoppedProjectionEvidence | undefined;
let outputFloodEvidence: OutputFloodEvidence | undefined;
let capProvenance: D12RunProvenance | undefined;

declare global {
  interface Window {
    __keikoCapturedDebugEvents?: CapturedDebugEvent[];
    __keikoD12InlineValues?: string[];
    __keikoD12LongTaskObserverInstalled?: boolean;
    __keikoD12LongTasks?: number[];
    __keikoD12StoppedProjectionSamples?: number[];
    __keikoD12StopSamples?: number[];
    __keikoArmD12StoppedProjection?: () => void;
    __keikoArmD12Stop?: (sessionId: string) => void;
    __keikoD12AfterNextPaint?: (callback: () => void) => void;
    __keikoD12StopProbe?: D12StopProbe;
    __keikoObserveD12StoppedProjection?: (event: CapturedDebugEvent) => void;
    __keikoObserveD12Terminal?: (event: CapturedDebugEvent) => void;
    __keikoSummarizeDebugEvent?: (event: string, data: string) => CapturedDebugEvent;
  }
}

async function installD12PaintScheduler(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__keikoD12AfterNextPaint = (callback): void => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(callback, 0);
        });
      });
    };
  });
}

async function installStoppedProjectionLatencyCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let armed = false;
    window.__keikoD12StoppedProjectionSamples = [];
    window.__keikoArmD12StoppedProjection = (): void => {
      armed = true;
    };
    const projectionReady = (): boolean => {
      const panel = document.querySelector('section[aria-label="Debug"]');
      if (!panel?.textContent.includes("Session is paused.")) return false;
      const stack = panel.querySelector('[aria-label="Call stack"]');
      if (stack?.querySelectorAll("button").length !== 128) return false;
      const variables = panel.querySelector('[role="tree"][aria-label="Variables"]');
      if (variables?.querySelectorAll('[role="treeitem"]').length !== 32) return false;
      const controls = [...panel.querySelectorAll('fieldset[aria-label="Debug controls"] button')];
      const enabled = (label: string): boolean =>
        controls.some(
          (button) => button.textContent.trim() === label && !button.hasAttribute("disabled"),
        );
      if (!enabled("Step over") || !enabled("Stop debugging")) return false;
      return document.querySelector(".keiko-debug-inline-value") !== null;
    };
    window.__keikoObserveD12StoppedProjection = (event): void => {
      if (!armed || event.kind !== "stopped") return;
      armed = false;
      const stoppedEventObservedAt = event.observedAt;
      const waitForProjection = (): void => {
        if (!projectionReady()) return void requestAnimationFrame(waitForProjection);
        window.__keikoD12AfterNextPaint?.(() => {
          const samples = window.__keikoD12StoppedProjectionSamples;
          if (samples === undefined) throw new Error("D12_STOPPED_SAMPLES_NOT_INITIALIZED");
          samples.push(Math.round((performance.now() - stoppedEventObservedAt) * 1_000) / 1_000);
        });
      };
      requestAnimationFrame(waitForProjection);
    };
  });
}

async function installStopProbeInitializer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__keikoD12StopSamples = [];
    window.__keikoArmD12Stop = (sessionId): void => {
      window.__keikoD12StopProbe = {
        sessionId,
        controlCompleted: false,
        terminalSseObserved: false,
        finishing: false,
      };
    };
  });
}

async function installStopDomLatencyCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const terminalDomReady = (): boolean => {
      const panel = document.querySelector('section[aria-label="Debug"]');
      if (!panel?.textContent.includes("No active debug session.")) return false;
      const start = [...panel.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === "Start debugging current file",
      );
      return start !== undefined && !start.hasAttribute("disabled");
    };
    const poll = (): void => {
      const probe = window.__keikoD12StopProbe;
      if (probe === undefined) return;
      if (
        probe.activatedAt === undefined ||
        !probe.controlCompleted ||
        !probe.terminalSseObserved ||
        !terminalDomReady()
      )
        return void requestAnimationFrame(poll);
      if (probe.finishing) return;
      probe.finishing = true;
      const activatedAt = probe.activatedAt;
      window.__keikoD12AfterNextPaint?.(() => {
        const samples = window.__keikoD12StopSamples;
        if (samples === undefined) throw new Error("D12_STOP_SAMPLES_NOT_INITIALIZED");
        samples.push(Math.round((performance.now() - activatedAt) * 1_000) / 1_000);
        delete window.__keikoD12StopProbe;
      });
    };
    document.addEventListener(
      "pointerdown",
      (event) => {
        const button = event.target instanceof Element ? event.target.closest("button") : null;
        const probe = window.__keikoD12StopProbe;
        if (probe === undefined || button?.textContent.trim() !== "Stop debugging") return;
        probe.activatedAt = performance.now();
        requestAnimationFrame(poll);
      },
      true,
    );
  });
}

async function installStopTerminalCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__keikoObserveD12Terminal = (event): void => {
      const probe = window.__keikoD12StopProbe;
      if (
        probe === undefined ||
        event.sessionId !== probe.sessionId ||
        event.kind !== "session-stopped"
      )
        return;
      probe.terminalSseObserved = true;
    };
  });
}

async function installStopLatencyCapture(page: Page): Promise<void> {
  await installStopProbeInitializer(page);
  await installStopDomLatencyCapture(page);
  await installStopTerminalCapture(page);
}

async function installDebugEventSummarizer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__keikoSummarizeDebugEvent = (event, data): CapturedDebugEvent => {
      const summary: {
        event: string;
        data: string;
        kind?: string;
        observedAt: number;
        originalBytes?: number;
        reason?: string;
        sessionId?: string;
      } = { event, data, observedAt: performance.now() };
      try {
        const envelope = JSON.parse(data) as { readonly event?: Record<string, unknown> };
        const projected = envelope.event;
        if (projected === undefined) return summary;
        if (typeof projected.kind === "string") summary.kind = projected.kind;
        if (summary.kind === "output") summary.data = "";
        if (typeof projected.originalBytes === "number") {
          summary.originalBytes = projected.originalBytes;
        }
        if (typeof projected.reason === "string") summary.reason = projected.reason;
        if (typeof projected.sessionId === "string") summary.sessionId = projected.sessionId;
      } catch {
        // Existing bounded non-output events remain available to the exception assertion.
      }
      return summary;
    };
  });
}

async function installDebugEventCaptureState(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__keikoCapturedDebugEvents = [];
  });
}

async function installDebugEventListenerCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type EventSourceListenerRegistration = (
      this: EventSource,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => void;
    const prototype = EventSource.prototype as unknown as {
      addEventListener: EventSourceListenerRegistration;
    };
    const original = prototype.addEventListener;
    const capture = (type: string, event: Event): CapturedDebugEvent | undefined => {
      if (!type.startsWith("editor-debug:")) return;
      const data =
        event instanceof MessageEvent && typeof event.data === "string" ? event.data : "";
      const summary = window.__keikoSummarizeDebugEvent?.(type, data) ?? {
        event: type,
        data,
        observedAt: performance.now(),
      };
      const captured = window.__keikoCapturedDebugEvents;
      if (captured === undefined) throw new Error("D12_DEBUG_CAPTURE_NOT_INITIALIZED");
      captured.push(summary);
      return summary;
    };
    prototype.addEventListener = function addEventListener(
      this: EventSource,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void {
      original.call(
        this,
        type,
        (event: Event): void => {
          const summary = capture(type, event);
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
          if (summary !== undefined) {
            window.__keikoObserveD12StoppedProjection?.(summary);
            window.__keikoObserveD12Terminal?.(summary);
          }
        },
        options,
      );
    };
  });
}

async function installDebugEventCapture(page: Page): Promise<void> {
  await installDebugEventCaptureState(page);
  await installDebugEventListenerCapture(page);
}

async function installLongTaskCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__keikoD12LongTaskObserverInstalled = false;
    window.__keikoD12LongTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__keikoD12LongTasks?.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
      window.__keikoD12LongTaskObserverInstalled = true;
    } catch {
      // Unsupported observers leave no samples; the cap tests still use CDP interaction timing.
    }
  });
}

async function captureDebugEvents(page: Page): Promise<void> {
  await installDebugEventSummarizer(page);
  await installD12PaintScheduler(page);
  await installStoppedProjectionLatencyCapture(page);
  await installStopLatencyCapture(page);
  await installDebugEventCapture(page);
  await installLongTaskCapture(page);
}

async function capturedExceptionEvent(page: Page): Promise<unknown> {
  return await page.evaluate(() => {
    const entry = window.__keikoCapturedDebugEvents?.find((candidate) => {
      if (candidate.event !== "editor-debug:stopped") return false;
      try {
        const parsed = JSON.parse(candidate.data) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
        const event = (parsed as { readonly event?: unknown }).event;
        return (
          typeof event === "object" &&
          event !== null &&
          !Array.isArray(event) &&
          (event as { readonly reason?: unknown }).reason === "exception"
        );
      } catch {
        return false;
      }
    });
    return entry === undefined ? null : (JSON.parse(entry.data) as unknown);
  });
}

async function capturedDebugSessionEvents(page: Page): Promise<readonly CapturedDebugEvent[]> {
  return await page.evaluate(() => window.__keikoCapturedDebugEvents ?? []);
}

async function capturedStartedSessionCount(page: Page): Promise<number> {
  return capturedStartedSessionIds(await capturedDebugSessionEvents(page)).length;
}

async function capturedStartedSessionId(
  page: Page,
  observedStartCount: number,
  expectedSessionId?: string,
): Promise<string> {
  let sessionId: string | undefined;
  const readCaptured = async (): Promise<string | undefined> => {
    sessionId = capturedStartedSessionIdAfter(
      await capturedDebugSessionEvents(page),
      observedStartCount,
    );
    return sessionId;
  };
  if (expectedSessionId === undefined) {
    await expect.poll(readCaptured).not.toBeUndefined();
  } else {
    await expect.poll(readCaptured).toBe(expectedSessionId);
  }
  if (sessionId === undefined) throw new Error("DEBUG_SESSION_START_EVENT_NOT_OBSERVED");
  return sessionId;
}

function fixture(path: string): string {
  return readFileSync(join(FIXTURE_ROOT, path), "utf8");
}

function capStoppedSource(): string {
  return Array.from(
    { length: CAP_VARIABLES },
    (_, index) => `const inline1_${String(index + 1).padStart(3, "0")} = ${String(index + 1)};`,
  ).join("\n");
}

function workspace(): { readonly root: string } {
  return createEditorWorkspace([
    { path: "package.json", content: fixture("package.json") },
    { path: PROGRAM, content: fixture("program.ts") },
    { path: THROWS, content: fixture("throws.ts") },
    { path: CAP_STOPPED, content: capStoppedSource() },
    { path: CAP_OUTPUT, content: "export const outputFlood = true;\n" },
  ]);
}

function debugSession(value: unknown): DebugSessionProjection {
  expect(typeof value).toBe("object");
  const record = value as {
    readonly pauseGeneration?: unknown;
    readonly sessionId?: unknown;
    readonly targetKind?: unknown;
  };
  expect(Number.isSafeInteger(record.pauseGeneration)).toBe(true);
  expect(typeof record.sessionId).toBe("string");
  expect(["catalog", "file"]).toContain(record.targetKind);
  return {
    pauseGeneration: typeof record.pauseGeneration === "number" ? record.pauseGeneration : -1,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
    targetKind: record.targetKind === "catalog" ? "catalog" : "file",
  };
}

function savedWatchId(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("DEBUG_WATCH_SAVE_RESPONSE_INVALID");
  }
  const snapshot = (value as { readonly snapshot?: unknown }).snapshot;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new Error("DEBUG_WATCH_SAVE_SNAPSHOT_INVALID");
  }
  const watches = (snapshot as { readonly watches?: unknown }).watches;
  if (!Array.isArray(watches)) throw new Error("DEBUG_WATCH_SAVE_WATCHES_INVALID");
  const watch = watches.find(
    (candidate): candidate is { readonly watchId: string; readonly expression: string } =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      (candidate as { readonly expression?: unknown }).expression === "total" &&
      typeof (candidate as { readonly watchId?: unknown }).watchId === "string",
  );
  if (watch === undefined) throw new Error("DEBUG_WATCH_SAVE_WATCH_NOT_FOUND");
  return watch.watchId;
}

async function createProject(page: Page, root: string): Promise<void> {
  const response = await page.request.post("/api/projects", {
    data: { name: "Issue 2348 editor debugging", path: root },
    headers: { "x-keiko-csrf": "1" },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function grantWorkspaceScriptTrust(page: Page, root: string): Promise<void> {
  const response = await page.request.post("/api/editor/verification/trust", {
    data: { projectId: root },
    headers: { "x-keiko-csrf": "1" },
  });
  expect(response.status(), await response.text()).toBe(200);
}

interface DebugActivationProjection {
  readonly activationRevision: number;
  readonly workspaceId: string;
}

function activationDiagnostic(
  value: unknown,
  allowed: ReadonlySet<string>,
  fallback: string,
): string {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function validDebugActivationProjection(
  workspaceId: unknown,
  activationRevision: unknown,
  state: unknown,
): DebugActivationProjection | undefined {
  if (
    typeof workspaceId !== "string" ||
    typeof activationRevision !== "number" ||
    !Number.isSafeInteger(activationRevision) ||
    state !== "available"
  ) {
    return undefined;
  }
  return { activationRevision, workspaceId };
}

function debugActivationProjection(value: unknown): DebugActivationProjection {
  const result = value as {
    readonly snapshot?: {
      readonly debugWorkspaceId?: unknown;
      readonly debugging?: {
        readonly reasonCode?: unknown;
        readonly revision?: unknown;
        readonly state?: unknown;
      };
    };
  };
  const workspaceId = result.snapshot?.debugWorkspaceId;
  const debugging = result.snapshot?.debugging;
  const activationRevision = debugging?.revision;
  const projection = validDebugActivationProjection(
    workspaceId,
    activationRevision,
    debugging?.state,
  );
  if (projection === undefined) {
    const state = activationDiagnostic(debugging?.state, DEBUG_ACTIVATION_STATES, "INVALID_STATE");
    const reasonCode = activationDiagnostic(
      debugging?.reasonCode,
      DEBUG_ACTIVATION_REASONS,
      "INVALID_REASON",
    );
    throw new Error(`DEBUG_ACTIVATION_RESPONSE_INVALID:${state}:${reasonCode}`);
  }
  return projection;
}

async function activateDebugging(page: Page, root: string): Promise<DebugActivationProjection> {
  const settings = await page.request.get(`/api/editor/settings?root=${encodeURIComponent(root)}`);
  expect(settings.status()).toBe(200);
  const body = (await settings.json()) as { readonly workspaceRevision?: unknown };
  expect(Number.isSafeInteger(body.workspaceRevision)).toBe(true);
  const response = await page.request.post("/api/editor/settings/debug/activate", {
    data: { expectedRevision: body.workspaceRevision, root },
    headers: {
      "if-match": settings.headers().etag ?? "",
      "idempotency-key": "issue-2348-enable-debugging",
      "x-keiko-csrf": "1",
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  return debugActivationProjection(await response.json());
}

async function startCatalogDebugging(
  page: Page,
  activation: DebugActivationProjection,
): Promise<DebugSessionProjection> {
  const bootstrap = await page.request.post("/api/editor/debug/bootstrap", {
    data: { schemaVersion: "1", workspaceId: activation.workspaceId },
    headers: { "x-keiko-csrf": "1" },
  });
  expect(bootstrap.status(), await bootstrap.text()).toBe(200);
  const projection = (await bootstrap.json()) as {
    readonly workspaceId?: unknown;
    readonly activationRevision?: unknown;
  };
  if (
    typeof projection.workspaceId !== "string" ||
    !Number.isSafeInteger(projection.activationRevision)
  ) {
    throw new Error("DEBUG_BOOTSTRAP_RESPONSE_INVALID");
  }
  const response = await page.request.post("/api/editor/debug/sessions", {
    data: {
      schemaVersion: "1",
      workspaceId: projection.workspaceId,
      target: { kind: "catalog", targetId: "npm-script:debug:catalog" },
      activationRevision: projection.activationRevision,
    },
    headers: { "x-keiko-csrf": "1" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const session = debugSession(await response.json());
  activeSessionId = session.sessionId;
  return session;
}

async function runPaletteCommand(page: Page, commandTitle: string): Promise<void> {
  // "ControlOrMeta", NOT `editorModifier`: this is a PRODUCT shortcut, not a Monaco one — the
  // combobox it opens is Keiko's own quick access ("Command query" is `quickAccess.query.commands`
  // in keiko-ui's i18n catalog), and Keiko's `useKeyboardShortcuts` derives its platform from
  // `navigator.platform`, which the device presets do NOT override. Measured under this suite's
  // preset on a macOS host: `navigator.userAgent` reports "Windows NT 10.0" (so Monaco waits for
  // Ctrl) while `navigator.platform` still reports "MacIntel" (so the product waits for Meta).
  // Playwright's host-derived shorthand sends exactly the latter. `editorModifier` would send
  // Control to a product listening for Meta and the palette would never open.
  await page.keyboard.press("ControlOrMeta+Shift+KeyP");
  const combobox = page.getByRole("combobox", { name: "Command query" });
  await expect(combobox).toBeVisible();
  await combobox.fill(`>${commandTitle}`);
  const option = page.getByRole("option").filter({ hasText: commandTitle }).first();
  await expect(option).toBeVisible();
  await option.click();
}

async function selectBreakpointSourceLine(pane: Locator): Promise<void> {
  const editor = pane.locator(EDITOR_SELECTORS.monaco).first();
  await expect(editor).toBeVisible();
  await editor.click();
  // MONACO chord (`.find-widget` is Monaco's own), so the modifier comes from the browser.
  // Measured on a macOS host under this suite's preset: `Meta+KeyF` left the find widget closed
  // (0 visible), `Control+KeyF` opened it (1) — the host-derived form reached nothing here.
  const page = editor.page();
  await page.keyboard.press(`${await editorModifier(page)}+KeyF`);
  await expect(page.locator(".find-widget").first()).toBeVisible();
  await editor.page().keyboard.type("const displayed = total;");
  await editor.page().keyboard.press("Enter");
  await editor.page().keyboard.press("Escape");
}

function submittedBreakpointLines(request: Request): readonly number[] {
  const payload: unknown = request.postDataJSON();
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const breakpoints = (payload as { readonly breakpoints?: unknown }).breakpoints;
  if (!Array.isArray(breakpoints)) return [];
  return breakpoints.flatMap((breakpoint) => {
    if (typeof breakpoint !== "object" || breakpoint === null || Array.isArray(breakpoint)) {
      return [];
    }
    const line = (breakpoint as { readonly line?: unknown }).line;
    return typeof line === "number" && Number.isSafeInteger(line) ? [line] : [];
  });
}

function submittedWatchId(request: Request): string | undefined {
  const payload: unknown = request.postDataJSON();
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const watchId = (payload as { readonly watchId?: unknown }).watchId;
  return typeof watchId === "string" ? watchId : undefined;
}

async function toggleBreakpointFromEditorPalette(page: Page): Promise<void> {
  await page.keyboard.press("F1");
  const palette = page.locator(".quick-input-widget");
  await expect(palette).toBeVisible();
  await palette.locator("input").fill(">Debug: Toggle Breakpoint");
  await page.keyboard.press("Enter");
}

function debugWindow(page: Page): Locator {
  return page
    .locator(".window")
    .filter({ has: page.getByRole("heading", { name: "Debug", exact: true }) });
}

function editorWindow(page: Page): Locator {
  return page.locator(`[data-window-id="${EDITOR_WINDOW_ID}"]`);
}

type DebugSessionStartSettlement =
  | { readonly kind: "response"; readonly response: PlaywrightResponse }
  | { readonly kind: "aborted"; readonly errorText: string | undefined };

function isDebugSessionStartRequest(request: Request): boolean {
  return (
    new URL(request.url()).pathname === "/api/editor/debug/sessions" && request.method() === "POST"
  );
}

function waitForDebugSessionStart(page: Page): Promise<DebugSessionStartSettlement> {
  return new Promise((resolve) => {
    let startRequest: Request | undefined;
    const cleanup = (): void => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
    };
    const finish = (settlement: DebugSessionStartSettlement): void => {
      cleanup();
      resolve(settlement);
    };
    const onRequest = (request: Request): void => {
      if (startRequest === undefined && isDebugSessionStartRequest(request)) startRequest = request;
    };
    const onResponse = (response: PlaywrightResponse): void => {
      if (response.request() === startRequest) finish({ kind: "response", response });
    };
    const onRequestFailed = (request: Request): void => {
      if (request === startRequest) {
        finish({ kind: "aborted", errorText: request.failure()?.errorText });
      }
    };
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfailed", onRequestFailed);
  });
}

async function startedSessionId(
  page: Page,
  observedStartCount: number,
  settlement: DebugSessionStartSettlement,
): Promise<string> {
  if (settlement.kind === "aborted") {
    expect(settlement.errorText).toBe("net::ERR_ABORTED");
    return await capturedStartedSessionId(page, observedStartCount);
  }
  expect(settlement.response.status(), await settlement.response.text()).toBe(201);
  const session = debugSession(await settlement.response.json());
  return await capturedStartedSessionId(page, observedStartCount, session.sessionId);
}

async function startFromEditor(page: Page, pane: Locator): Promise<DebugSessionProjection> {
  const observedStartCount = await capturedStartedSessionCount(page);
  const started = waitForDebugSessionStart(page);
  await pane.locator(EDITOR_SELECTORS.monaco).click();
  await page.keyboard.press("F5");
  const sessionId = await startedSessionId(page, observedStartCount, await started);
  activeSessionId = sessionId;
  const projection = await page.request.get(
    `/api/editor/debug/sessions/${encodeURIComponent(sessionId)}`,
  );
  expect(projection.status(), await projection.text()).toBe(200);
  const session = debugSession(await projection.json());
  return session;
}

async function startFromDebugPanel(page: Page, panel: Locator): Promise<DebugSessionProjection> {
  const observedStartCount = await capturedStartedSessionCount(page);
  const started = waitForDebugSessionStart(page);
  await panel.getByRole("button", { name: "Start debugging current file" }).click();
  const sessionId = await startedSessionId(page, observedStartCount, await started);
  activeSessionId = sessionId;
  const projection = await page.request.get(
    `/api/editor/debug/sessions/${encodeURIComponent(sessionId)}`,
  );
  expect(projection.status(), await projection.text()).toBe(200);
  return debugSession(await projection.json());
}

async function expectServerStopped(page: Page, sessionId: string): Promise<void> {
  await expect
    .poll(async () => {
      const value = await page.evaluate(async (id) => {
        const response = await fetch(`/api/editor/debug/sessions/${encodeURIComponent(id)}`, {
          headers: { "x-keiko-csrf": "1" },
        });
        // A terminated session reports "stopped"; an evicted one is gone. Both are terminal.
        return response.ok ? ((await response.json()) as unknown) : { status: "gone" };
      }, sessionId);
      const record = value as { readonly status?: unknown };
      return String(record.status);
    })
    .toMatch(/^(?:stopped|gone)$/u);
}

async function stopFromDebugPanel(page: Page, panel: Locator): Promise<void> {
  // Wait on the concrete terminal state the stop actually produces — the server session reaching
  // "stopped" and the panel clearing — instead of racing the single control-POST response, whose
  // wall-clock budget flaked under CI load.
  const sessionId = activeSessionId;
  await panel.getByRole("button", { name: "Stop debugging" }).click();
  if (sessionId !== undefined) await expectServerStopped(page, sessionId);
  activeSessionId = undefined;
  await expect(panel.getByText("No active debug session.")).toBeVisible();
}

async function expectServerPaused(
  page: Page,
  session: DebugSessionProjection,
  minGeneration = 0,
): Promise<DebugSessionProjection> {
  let paused: DebugSessionProjection | undefined;
  await expect
    .poll(async () => {
      const value = await page.evaluate(async (sessionId) => {
        const response = await fetch(
          `/api/editor/debug/sessions/${encodeURIComponent(sessionId)}`,
          {
            headers: { "x-keiko-csrf": "1" },
          },
        );
        return response.ok
          ? ((await response.json()) as unknown)
          : { status: `http-${String(response.status)}` };
      }, session.sessionId);
      const record = value as { readonly status?: unknown };
      if (record.status !== "paused") return record.status;
      const projection = debugSession(value);
      // A session still sitting on the previous stop is not the pause being waited for. The
      // registry advances pauseGeneration once per adapter stop event, so requiring a higher
      // generation distinguishes "stepped and paused again" from "never left the last pause".
      // Reported rather than swallowed, so a timeout says which generation it was stuck on.
      if (projection.pauseGeneration < minGeneration) {
        return `paused-at-generation-${String(projection.pauseGeneration)}`;
      }
      paused = projection;
      return "paused";
    })
    .toBe("paused");
  if (paused === undefined) throw new Error("DEBUG_SESSION_PAUSE_NOT_OBSERVED");
  return paused;
}

async function expectPaused(
  page: Page,
  panel: Locator,
  session: DebugSessionProjection,
  frameName: string,
  minGeneration = 0,
): Promise<DebugSessionProjection> {
  const paused = await expectServerPaused(page, session, minGeneration);
  await expect(panel.getByText("Session is paused.")).toBeVisible();
  await expect(panel.getByRole("button", { name: new RegExp(frameName) })).toBeVisible();
  return paused;
}

function stackLoaded(page: Page): Promise<PlaywrightResponse> {
  return page.waitForResponse(
    (response) =>
      response.url().includes("/api/editor/debug/stack") && response.request().method() === "POST",
  );
}

async function inspectPausedBreakpoint(
  page: Page,
  panel: Locator,
  editor: Locator,
  session: DebugSessionProjection,
): Promise<DebugSessionProjection> {
  const paused = await expectPaused(page, panel, session, "breakpointFixture");
  await expect(editor.locator(".keiko-debug-breakpoint-hit")).toBeVisible();
  await panel.getByRole("treeitem", { name: /Local/ }).click();
  await expect(panel.getByRole("treeitem", { name: /total: 2/ })).toBeVisible();
  await expect(editor.locator(".keiko-debug-inline-value").first()).toBeVisible();
  await expect(editor).toBeVisible();
  return paused;
}

async function addAndEvaluateTotalWatch(page: Page, panel: Locator): Promise<void> {
  await panel.getByRole("button", { name: "Add watch" }).click();
  await panel.getByRole("textbox", { name: "Watch expression" }).fill("total");
  const watchSaved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/editor/debug/watches") && response.request().method() === "PUT",
  );
  await panel.getByRole("button", { name: "Save" }).click();
  const saved = await watchSaved;
  expect(saved.status()).toBe(200);
  const watchId = savedWatchId(await saved.json());
  const evaluated = page.waitForResponse(
    (response) =>
      response.url().includes("/api/editor/debug/watches/evaluate") &&
      response.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Evaluate total" }).click();
  const evaluatedResponse = await evaluated;
  expect(submittedWatchId(evaluatedResponse.request())).toBe(watchId);
  expect(evaluatedResponse.status()).toBe(200);
  await expect(panel.getByRole("list", { name: "Registered watch results" })).toContainText(
    "total: 2",
  );
}

async function stepAndStop(
  page: Page,
  panel: Locator,
  session: DebugSessionProjection,
): Promise<void> {
  // Wait on the state each step actually produces — a new pause, proven by pauseGeneration
  // advancing — instead of racing the control-POST response. That race gave the three round trips
  // no budget of their own: a slow-but-successful step under CI load consumed the whole test's
  // 120s and failed it, exactly the flake `stopFromDebugPanel` above was already fixed for.
  // Polling bare "paused" instead would be worse than the race, not better: the session is already
  // paused when the button is clicked, so it would go green even if the step never landed.
  let current = session;
  for (const label of ["Step over", "Step into", "Step out"] as const) {
    await panel.getByRole("button", { name: label }).click();
    current = await expectPaused(
      page,
      panel,
      current,
      "breakpointFixture",
      current.pauseGeneration + 1,
    );
  }
  await stopFromDebugPanel(page, panel);
}

interface PreparedExceptionDebugUi {
  readonly pane: Locator;
  readonly panel: Locator;
}

async function prepareExceptionDebugging(page: Page): Promise<PreparedExceptionDebugUi> {
  const project = workspace();
  await captureDebugEvents(page);
  await createProject(page, project.root);
  await grantWorkspaceScriptTrust(page, project.root);
  await seedEditorWindow(page, {
    active: THROWS,
    openFiles: [PROGRAM, THROWS],
    root: project.root,
    windowId: EDITOR_WINDOW_ID,
  });
  await page.goto("/");
  await openEditorWorkspace(page);
  await activateDebugging(page, project.root);
  await page.reload();
  const reloadedEditor = await openEditorWorkspace(page);
  const pane = firstPane(reloadedEditor);
  // The caret is aria-hidden since #2605 (role="tree" may own only treeitem/group), so it is
  // addressed by selector rather than by role. Expansion is also reachable via Arrow Right.
  await reloadedEditor.locator('button.tr-caret-btn[aria-label="Expand folder: src"]').click();
  await openTreeFile(reloadedEditor, THROWS);
  const panel = debugWindow(page);
  await runPaletteCommand(page, "Open Debug");
  await expect(panel.getByRole("heading", { name: "Debug", exact: true })).toBeVisible();
  const exceptionCheckbox = panel.getByRole("checkbox", { name: "uncaught" });
  await expect(exceptionCheckbox).toBeVisible();
  const exceptionSaved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/editor/debug/exception-breakpoints") &&
      response.request().method() === "PUT",
  );
  await exceptionCheckbox.click();
  expect((await exceptionSaved).status()).toBe(200);
  await expect(exceptionCheckbox).toBeChecked();
  await panel.getByRole("button", { name: "Minimize Debug window" }).click();
  return { pane, panel };
}

interface PreparedCapDebugUi {
  readonly pane: Locator;
  readonly panel: Locator;
}

async function prepareCapDebugging(page: Page, activeFile: string): Promise<PreparedCapDebugUi> {
  const project = workspace();
  await captureDebugEvents(page);
  await createProject(page, project.root);
  await grantWorkspaceScriptTrust(page, project.root);
  await seedEditorWindow(page, {
    active: activeFile,
    openFiles: [activeFile],
    root: project.root,
    windowId: EDITOR_WINDOW_ID,
  });
  await page.goto("/");
  await openEditorWorkspace(page);
  await activateDebugging(page, project.root);
  await page.reload();
  const editor = await openEditorWorkspace(page);
  const pane = firstPane(editor);
  await editor.locator('button.tr-caret-btn[aria-label="Expand folder: src"]').click();
  await openTreeFile(editor, activeFile);
  await runPaletteCommand(page, "Open Debug");
  const panel = debugWindow(page);
  await expect(panel.getByRole("heading", { name: "Debug", exact: true })).toBeVisible();
  return { pane, panel };
}

async function reopenAndStopDebug(page: Page, panel: Locator): Promise<void> {
  await runPaletteCommand(page, "Open Debug");
  await expect(panel.getByRole("heading", { name: "Debug", exact: true })).toBeVisible();
  await stopFromDebugPanel(page, panel);
}

async function awaitNextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            done();
          });
        });
      }),
  );
}

async function collectStoppedProjectionSamples(
  page: Page,
  panel: Locator,
): Promise<{
  readonly rootVariables: readonly Record<string, unknown>[];
  readonly samples: readonly number[];
  readonly session: DebugSessionProjection;
}> {
  await page.evaluate(() => {
    window.__keikoD12StoppedProjectionSamples = [];
  });
  let session: DebugSessionProjection | undefined;
  let rootVariables: readonly Record<string, unknown>[] | undefined;
  for (let index = 0; index < STOP_SAMPLE_COUNT; index += 1) {
    const finalSample = index + 1 === STOP_SAMPLE_COUNT;
    const capVariables = finalSample
      ? page.waitForResponse(async (response) => {
          if (!response.url().includes("/api/editor/debug/variables")) return false;
          const nodes = variableNodes((await response.json()) as unknown);
          if (nodes.length !== CAP_VARIABLES) return false;
          rootVariables = nodes;
          return true;
        })
      : undefined;
    await page.evaluate(() => window.__keikoArmD12StoppedProjection?.());
    session = await startFromDebugPanel(page, panel);
    if (capVariables !== undefined) await capVariables;
    await expect
      .poll(() => page.evaluate(() => window.__keikoD12StoppedProjectionSamples?.length ?? 0))
      .toBe(index + 1);
    if (index + 1 < STOP_SAMPLE_COUNT) await stopFromDebugPanel(page, panel);
  }
  if (session === undefined) throw new Error("D12_STOPPED_SESSION_NOT_CREATED");
  if (rootVariables === undefined) throw new Error("D12_ROOT_VARIABLES_NOT_CAPTURED");
  const samples = await page.evaluate(() => window.__keikoD12StoppedProjectionSamples ?? []);
  return { rootVariables, samples, session };
}

async function resetLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__keikoD12LongTasks = [];
  });
}

async function longTasks(
  page: Page,
): Promise<{ readonly installed: boolean; readonly samples: readonly number[] }> {
  return await page.evaluate(() => ({
    installed: window.__keikoD12LongTaskObserverInstalled === true,
    samples: window.__keikoD12LongTasks ?? [],
  }));
}

function variableNodes(value: unknown): readonly Record<string, unknown>[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const nodes = (value as { readonly nodes?: unknown }).nodes;
  return Array.isArray(nodes)
    ? nodes.filter(
        (node): node is Record<string, unknown> =>
          typeof node === "object" && node !== null && !Array.isArray(node),
      )
    : [];
}

function requiredVariableRef(node: Record<string, unknown> | undefined): string {
  const reference = node?.variableRef;
  if (typeof reference !== "string") throw new Error("D12_VARIABLE_REFERENCE_MISSING");
  return reference;
}

async function expandVariable(
  page: Page,
  session: DebugSessionProjection,
  variableRef: string,
): Promise<unknown> {
  const response = await page.request.post("/api/editor/debug/variables", {
    data: {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: session.pauseGeneration,
      variableRef,
    },
    headers: { "x-keiko-csrf": "1" },
  });
  expect(response.status(), await response.text()).toBe(200);
  return await response.json();
}

async function reachableGraphCount(
  page: Page,
  session: DebugSessionProjection,
  root: readonly Record<string, unknown>[],
): Promise<{ readonly depth: number; readonly nodes: number }> {
  const depthTwo = variableNodes(await expandVariable(page, session, requiredVariableRef(root[0])));
  const depthThree = variableNodes(
    await expandVariable(page, session, requiredVariableRef(depthTwo[0])),
  );
  const depthFour = variableNodes(
    await expandVariable(page, session, requiredVariableRef(depthThree[0])),
  );
  const width = variableNodes(await expandVariable(page, session, requiredVariableRef(root[1])));
  const sentinel = variableNodes(
    await expandVariable(page, session, requiredVariableRef(depthFour[0])),
  );
  expect(sentinel).toEqual([
    expect.objectContaining({ kind: "truncated", reason: "depth", truncated: true }),
  ]);
  return {
    depth: 4,
    nodes: root.length + depthTwo.length + depthThree.length + depthFour.length + width.length,
  };
}

async function collectInlineDecorations(page: Page, editor: Locator): Promise<number> {
  const values = new Set<string>();
  const monaco = editor.locator(EDITOR_SELECTORS.monaco).first();
  await monaco.click();
  // MONACO chord (`cursorTop`), so the modifier comes from the browser — see `editorModifier`.
  await page.keyboard.press(`${await editorModifier(page)}+Home`);
  for (let index = 0; index < 30; index += 1) {
    for (const value of await editor.locator(".keiko-debug-inline-value").allTextContents()) {
      values.add(value);
    }
    await page.keyboard.press("PageDown");
    await awaitNextPaint(page);
  }
  return values.size;
}

function commandVersion(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: "utf8" }).trim();
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveCapProvenance(browser: Browser | null): D12RunProvenance {
  if (browser === null) throw new Error("D12_CAP_BROWSER_PROVENANCE_UNAVAILABLE");
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

async function clearCapturedEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__keikoCapturedDebugEvents = [];
  });
}

async function capturedAdapterBytes(page: Page, sessionId: string): Promise<number> {
  return await page.evaluate(
    (expectedSessionId) =>
      (window.__keikoCapturedDebugEvents ?? [])
        .filter((event) => event.kind === "output" && event.sessionId === expectedSessionId)
        .reduce((total, event) => total + (event.originalBytes ?? 0), 0),
    sessionId,
  );
}

async function waitForAdapterBytes(
  page: Page,
  sessionId: string,
  minimumBytes: number,
): Promise<void> {
  await expect
    .poll(() => capturedAdapterBytes(page, sessionId), { intervals: [10] })
    .toBeGreaterThanOrEqual(minimumBytes);
}

async function detachHeapClient(page: Page, client: CDPSession): Promise<void> {
  try {
    await client.detach();
  } catch (error: unknown) {
    if (!page.isClosed()) throw error;
  }
}

async function stopFloodNearBoundary(page: Page, panel: Locator): Promise<number> {
  await clearCapturedEvents(page);
  const session = await startFromDebugPanel(page, panel);
  const sampleCount = await page.evaluate(() => window.__keikoD12StopSamples?.length ?? 0);
  await page.evaluate((sessionId) => window.__keikoArmD12Stop?.(sessionId), session.sessionId);
  await waitForAdapterBytes(page, session.sessionId, 896 * 1_024);
  await stopFromDebugPanel(page, panel);
  await page.evaluate(() => {
    const probe = window.__keikoD12StopProbe;
    if (probe === undefined) throw new Error("D12_STOP_PROBE_NOT_ARMED");
    probe.controlCompleted = true;
  });
  await expect
    .poll(() => page.evaluate(() => window.__keikoD12StopSamples?.length ?? 0))
    .toBe(sampleCount + 1);
  const sample = await page.evaluate(() => window.__keikoD12StopSamples?.at(-1));
  if (sample === undefined) throw new Error("D12_STOP_LATENCY_NOT_CAPTURED");
  return sample;
}

async function readHeap(client: CDPSession): Promise<number> {
  await client.send("HeapProfiler.collectGarbage");
  const usage = await client.send("Runtime.getHeapUsage");
  return usage.usedSize;
}

async function outputConsoleCounts(panel: Locator): Promise<{
  readonly retainedBytes: number;
  readonly retainedEntries: number;
  readonly rows: number;
}> {
  const text = (await panel.getByLabel("Debug output").textContent()) ?? "";
  const rows = text.length === 0 ? [] : text.split("\n");
  const retained = rows.map((row) => row.replace(/^\[(stdout|stderr|console)\] /u, ""));
  const retainedBytes = retained.reduce(
    (total, row) => total + new TextEncoder().encode(row).length,
    0,
  );
  return { retainedBytes, retainedEntries: retained.length, rows: rows.length };
}

async function outputLimitMarkers(page: Page, sessionId: string): Promise<number> {
  return await page.evaluate(
    (expectedSessionId) =>
      (window.__keikoCapturedDebugEvents ?? []).filter(
        (event) =>
          event.kind === "session-stopped" &&
          event.reason === "limit" &&
          event.sessionId === expectedSessionId,
      ).length,
    sessionId,
  );
}

async function collectStopSamples(page: Page, panel: Locator): Promise<readonly number[]> {
  await page.evaluate(() => {
    window.__keikoD12StopSamples = [];
  });
  const samples: number[] = [];
  for (let index = 0; index < STOP_SAMPLE_COUNT; index += 1) {
    samples.push(await stopFloodNearBoundary(page, panel));
  }
  return samples;
}

async function measureTerminalFlood(
  page: Page,
  panel: Locator,
): Promise<{
  readonly adapterOutputBytes: number;
  readonly counts: Awaited<ReturnType<typeof outputConsoleCounts>>;
  readonly limitMarkers: number;
}> {
  await clearCapturedEvents(page);
  const terminal = await startFromDebugPanel(page, panel);
  await waitForAdapterBytes(page, terminal.sessionId, CAP_OUTPUT_BYTES);
  await expect.poll(() => outputLimitMarkers(page, terminal.sessionId)).toBe(1);
  await expect(panel.getByText("No active debug session.")).toBeVisible();
  activeSessionId = undefined;
  await awaitNextPaint(page);
  return {
    adapterOutputBytes: await capturedAdapterBytes(page, terminal.sessionId),
    counts: await outputConsoleCounts(panel),
    limitMarkers: await outputLimitMarkers(page, terminal.sessionId),
  };
}

async function closeDebugPanel(page: Page, panel: Locator): Promise<void> {
  await clickWindowChromeButton(panel, "Close Debug window");
  await expect(panel).toBeHidden();
  await awaitNextPaint(page);
}

function expectOutputFloodEvidence(evidence: OutputFloodEvidence): void {
  expect(evidence.adapterOutputBytes).toBeGreaterThanOrEqual(CAP_OUTPUT_BYTES);
  expect(evidence.limitMarkers).toBe(1);
  expect(evidence.retainedBytes).toBeLessThanOrEqual(CAP_BROWSER_BYTES);
  expect(evidence.retainedEntries).toBeLessThanOrEqual(CAP_BROWSER_ENTRIES);
  expect(evidence.renderedRows).toBeLessThanOrEqual(CAP_RENDERED_ROWS);
  expect(evidence.stopSamples).toHaveLength(STOP_SAMPLE_COUNT);
  expect(evidence.stopSamples.every((sample) => sample > 0)).toBe(true);
  if (ENFORCE_WALL_CLOCK_BUDGETS) {
    expect(evidence.stopP75).toBeLessThanOrEqual(200);
    expect(evidence.maxLongTaskMs).toBeLessThanOrEqual(50);
  }
  expect(evidence.residualHeapBytes).toBeLessThanOrEqual(CAP_RESIDUAL_HEAP_BYTES);
}

function stoppedEvidence(
  maxLongTaskMs: number,
  p75: number,
  samples: readonly number[],
): StoppedProjectionEvidence {
  return {
    depth: 4,
    frames: 128,
    inlineDecorations: 200,
    maxLongTaskMs,
    nodes: 1_000,
    p75,
    samples,
    scopes: 32,
    variables: 200,
  };
}

async function measureOutputFloodEvidence(
  page: Page,
  panel: Locator,
  heapClient: CDPSession,
): Promise<OutputFloodEvidence> {
  // Forced CDP collection is measurement instrumentation, not product work. Establish the heap
  // baseline before opening the long-task window, then read long tasks after the complete product
  // teardown but before the second forced collection used only for residual-memory evidence.
  const baselineHeap = await readHeap(heapClient);
  await awaitNextPaint(page);
  await resetLongTasks(page);
  const stopSamples = await collectStopSamples(page, panel);
  const terminal = await measureTerminalFlood(page, panel);
  expect(terminal.limitMarkers).toBe(1);
  await closeDebugPanel(page, panel);
  const observedLongTasks = await longTasks(page);
  const residualHeapBytes = Math.max(0, (await readHeap(heapClient)) - baselineHeap);
  expect(observedLongTasks.installed).toBe(true);
  const maxLongTaskMs = Math.max(0, ...observedLongTasks.samples);
  return {
    adapterOutputBytes: terminal.adapterOutputBytes,
    limitMarkers: 1,
    maxLongTaskMs,
    renderedRows: terminal.counts.rows,
    renderedRowsCeiling: 200,
    residualHeapBytes,
    retainedBytes: terminal.counts.retainedBytes,
    retainedEntries: terminal.counts.retainedEntries,
    stopP75: percentile(stopSamples, 75),
    stopSamples,
  };
}

function requiredEvidenceDigest(name: string): string {
  const value = process.env[name];
  if (value === undefined || !SHA_256.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest for cap evidence`);
  }
  return value;
}

function evidenceCommit(): string {
  const value =
    process.env.KEIKO_PERF_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!FULL_COMMIT.test(value)) throw new Error("D12 cap evidence commit must be a full SHA");
  return value;
}

function writeCapEvidence(): void {
  const path = process.env.KEIKO_D12_CAP_EVIDENCE_PATH;
  if (path === undefined) return;
  if (
    stoppedProjectionEvidence === undefined ||
    outputFloodEvidence === undefined ||
    capProvenance === undefined
  ) {
    throw new Error("D12 cap evidence scenarios did not complete");
  }
  const artifact = {
    schemaVersion: "1",
    kind: "cap",
    revision: "candidate",
    commit: evidenceCommit(),
    measuredAtIso: new Date().toISOString(),
    sourceTreeSha256: requiredEvidenceDigest("KEIKO_PERF_SOURCE_TREE_SHA256"),
    measurementHarnessSha256: requiredEvidenceDigest("KEIKO_PERF_MEASUREMENT_HARNESS_SHA256"),
    provenance: capProvenance,
    stoppedProjection: {
      depth: stoppedProjectionEvidence.depth,
      frames: stoppedProjectionEvidence.frames,
      inlineDecorations: stoppedProjectionEvidence.inlineDecorations,
      maxLongTaskMs: stoppedProjectionEvidence.maxLongTaskMs,
      nodes: stoppedProjectionEvidence.nodes,
      samples: stoppedProjectionEvidence.samples,
      scopes: stoppedProjectionEvidence.scopes,
      variables: stoppedProjectionEvidence.variables,
    },
    outputFlood: {
      adapterOutputBytes: outputFloodEvidence.adapterOutputBytes,
      limitMarkers: outputFloodEvidence.limitMarkers,
      maxLongTaskMs: outputFloodEvidence.maxLongTaskMs,
      renderedRows: outputFloodEvidence.renderedRows,
      renderedRowsCeiling: outputFloodEvidence.renderedRowsCeiling,
      residualHeapBytes: outputFloodEvidence.residualHeapBytes,
      retainedBytes: outputFloodEvidence.retainedBytes,
      retainedEntries: outputFloodEvidence.retainedEntries,
      stopSamples: outputFloodEvidence.stopSamples,
    },
  };
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

async function attachCapEvidence(name: string, evidence: object): Promise<void> {
  await test.info().attach(name, {
    body: JSON.stringify(evidence),
    contentType: "application/json",
  });
}

async function cleanupActiveSession(page: Page): Promise<void> {
  const sessionId = activeSessionId;
  activeSessionId = undefined;
  if (sessionId === undefined) return;
  const health = await page.request.get(
    `/api/editor/debug/sessions/${encodeURIComponent(sessionId)}`,
  );
  if (health.status() === 404) return;
  expect(health.status(), await health.text()).toBe(200);
  const session = debugSession(await health.json());
  const stopped = await page.request.post("/api/editor/debug/control", {
    data: {
      schemaVersion: "1",
      sessionId,
      action: "stop",
      pauseGeneration: session.pauseGeneration,
    },
    headers: { "x-keiko-csrf": "1" },
  });
  expect(stopped.status(), await stopped.text()).toBe(200);
}

test.afterEach(async ({ page }) => {
  await cleanupActiveSession(page);
  cleanupEditorWorkspaces();
});

test.afterAll(() => {
  writeCapEvidence();
});

test("#2348 drives the real DAP session from breakpoint through step, inline values, variables, watch, and stop", async ({
  page,
}) => {
  const project = workspace();
  await captureDebugEvents(page);
  await createProject(page, project.root);
  await grantWorkspaceScriptTrust(page, project.root);
  await seedEditorWindow(page, {
    active: PROGRAM,
    openFiles: [PROGRAM, THROWS],
    root: project.root,
    windowId: EDITOR_WINDOW_ID,
  });
  await page.goto("/");
  await openEditorWorkspace(page);
  await activateDebugging(page, project.root);
  await page.reload();
  const reloadedEditor = await openEditorWorkspace(page);
  const pane = firstPane(reloadedEditor);

  const panel = debugWindow(page);
  const breakpointMutation = page.waitForRequest(
    (request) =>
      request.url().includes("/api/editor/debug/breakpoints") && request.method() === "PUT",
  );
  const breakpointSaved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/editor/debug/breakpoints") &&
      response.request().method() === "PUT",
  );
  await selectBreakpointSourceLine(pane);
  await toggleBreakpointFromEditorPalette(page);
  expect(submittedBreakpointLines(await breakpointMutation)).toEqual([4]);
  expect((await breakpointSaved).status()).toBe(200);
  await expect(editorWindow(page).locator(".keiko-debug-breakpoint")).toBeVisible();

  const stack = stackLoaded(page);
  const session = await startFromEditor(page, pane);
  await expect(panel.getByRole("heading", { name: "Debug", exact: true })).toBeVisible();
  expect((await stack).status()).toBe(200);
  const paused = await inspectPausedBreakpoint(page, panel, editorWindow(page), session);
  await addAndEvaluateTotalWatch(page, panel);
  await stepAndStop(page, panel, paused);
});

test("#2348 drives a separate uncaught exception breakpoint through the real DAP UI", async ({
  page,
}) => {
  const { pane, panel } = await prepareExceptionDebugging(page);
  const stack = stackLoaded(page);
  const session = await startFromEditor(page, pane);
  expect((await stack).status()).toBe(200);
  await expectPaused(page, panel, session, "throwsFixture");
  await expect(panel.getByRole("button", { name: /src\/throws\.ts:8/ })).toBeVisible();
  await expect
    .poll(() => capturedExceptionEvent(page))
    .toMatchObject({
      event: {
        description: { value: "Fixture uncaught exception" },
        reason: "exception",
      },
    });
  await expect(panel.getByText("Exception: Fixture uncaught exception")).toBeVisible();
  await stopFromDebugPanel(page, panel);
});

test("#2348 launches a governed catalog target through the real npm CLI artifact", async ({
  page,
}) => {
  const project = workspace();
  await createProject(page, project.root);
  await grantWorkspaceScriptTrust(page, project.root);
  const activation = await activateDebugging(page, project.root);

  const session = await startCatalogDebugging(page, activation);

  expect(session.targetKind).toBe("catalog");
});

test("#2348 waits for a slow successful session response before matching its start event", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { panel } = await prepareCapDebugging(page, CAP_STOPPED);
  await page.route(
    "**/api/editor/debug/sessions",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 20_500));
      await route.continue();
    },
    { times: 1 },
  );

  const session = await startFromDebugPanel(page, panel);

  expect(session.targetKind).toBe("file");
  await stopFromDebugPanel(page, panel);
});

test("#2348 D12 composes exact stopped-projection caps through the real BFF and UI", async ({
  browser,
  page,
}) => {
  test.setTimeout(300_000);
  capProvenance = resolveCapProvenance(browser);
  const { panel } = await prepareCapDebugging(page, CAP_STOPPED);
  await resetLongTasks(page);
  const measuredProjection = await collectStoppedProjectionSamples(page, panel);
  const session = measuredProjection.session;
  const paused = await expectServerPaused(page, session);
  const rootVariables = measuredProjection.rootVariables;
  const callStack = panel.getByRole("list", { name: "Call stack" });
  await expect(callStack.getByRole("button")).toHaveCount(CAP_STACK_FRAMES);
  const variableTree = panel.getByRole("tree", { name: "Variables" });
  await expect(variableTree.getByRole("treeitem")).toHaveCount(CAP_SCOPES);
  await variableTree.getByRole("treeitem", { name: /Cap scope 01/u }).click();
  await expect(variableTree.getByRole("treeitem", { name: /inline1_200/u })).toBeVisible();
  await panel.getByRole("button", { name: "Minimize Debug window" }).click();
  const inlineDecorations = await collectInlineDecorations(page, editorWindow(page));
  const graph = await reachableGraphCount(page, paused, rootVariables);
  const samples = measuredProjection.samples;
  const retainedSamples = samples.slice(0, STOP_SAMPLE_COUNT);
  const observedLongTasks = await longTasks(page);
  const maxLongTaskMs = Math.max(0, ...observedLongTasks.samples);
  const p75 = percentile(retainedSamples, 75);
  const observedEvidence = stoppedEvidence(maxLongTaskMs, p75, retainedSamples);
  await attachCapEvidence("d12-stopped-projection", observedEvidence);

  expect(rootVariables).toHaveLength(CAP_VARIABLES);
  expect(graph).toEqual({ depth: 4, nodes: CAP_GRAPH_NODES });
  expect(inlineDecorations).toBe(CAP_VARIABLES);
  expect(samples.length).toBeGreaterThanOrEqual(STOP_SAMPLE_COUNT);
  expect(samples.every((sample) => sample > 0)).toBe(true);
  expect(observedLongTasks.installed).toBe(true);
  if (ENFORCE_WALL_CLOCK_BUDGETS) {
    expect(p75).toBeLessThanOrEqual(200);
    expect(maxLongTaskMs).toBeLessThanOrEqual(50);
  }
  stoppedProjectionEvidence = observedEvidence;
  await reopenAndStopDebug(page, panel);
});

test("#2348 D12 composes the real output limit with bounded browser state and teardown", async ({
  browser,
  page,
}) => {
  test.setTimeout(300_000);
  capProvenance = resolveCapProvenance(browser);
  const { panel } = await prepareCapDebugging(page, CAP_OUTPUT);
  const heapClient = await page.context().newCDPSession(page);
  try {
    outputFloodEvidence = await measureOutputFloodEvidence(page, panel, heapClient);
    await attachCapEvidence("d12-output-flood", outputFloodEvidence);
    expectOutputFloodEvidence(outputFloodEvidence);
  } finally {
    await detachHeapClient(page, heapClient);
  }
});
