import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expect,
  test,
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

const FIXTURE_ROOT = join(process.cwd(), "tests", "e2e", "fixtures", "editor-debugging-2348");
const PROGRAM = "src/program.ts";
const THROWS = "src/throws.ts";
const EDITOR_WINDOW_ID = "issue-2348-editor";
const MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

interface DebugSessionProjection {
  readonly pauseGeneration: number;
  readonly sessionId: string;
}

interface CapturedDebugEvent {
  readonly event: string;
  readonly data: string;
}

declare global {
  interface Window {
    __keikoCapturedDebugEvents?: CapturedDebugEvent[];
  }
}

async function captureDebugEvents(page: Page): Promise<void> {
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
    window.__keikoCapturedDebugEvents = [];
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
          if (type.startsWith("editor-debug:")) {
            window.__keikoCapturedDebugEvents?.push({
              event: type,
              data:
                event instanceof MessageEvent && typeof event.data === "string" ? event.data : "",
            });
          }
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        },
        options,
      );
    };
  });
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

function fixture(path: string): string {
  return readFileSync(join(FIXTURE_ROOT, path), "utf8");
}

function workspace(): { readonly root: string } {
  return createEditorWorkspace([
    { path: "package.json", content: fixture("package.json") },
    { path: PROGRAM, content: fixture("program.ts") },
    { path: THROWS, content: fixture("throws.ts") },
  ]);
}

function debugSession(value: unknown): DebugSessionProjection {
  expect(typeof value).toBe("object");
  const record = value as { readonly pauseGeneration?: unknown; readonly sessionId?: unknown };
  expect(Number.isSafeInteger(record.pauseGeneration)).toBe(true);
  expect(typeof record.sessionId).toBe("string");
  return {
    pauseGeneration: typeof record.pauseGeneration === "number" ? record.pauseGeneration : -1,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
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

async function activateDebugging(page: Page, root: string): Promise<void> {
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
}

async function runPaletteCommand(page: Page, commandTitle: string): Promise<void> {
  await page.keyboard.press(`${MODIFIER}+Shift+KeyP`);
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
  await editor.page().keyboard.press(`${MODIFIER}+KeyF`);
  await expect(editor.page().locator(".find-widget").first()).toBeVisible();
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
  await palette.locator("input").fill(">Toggle Breakpoint");
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

async function startFromEditor(page: Page, pane: Locator): Promise<DebugSessionProjection> {
  const started = page.waitForResponse(
    (response) =>
      response.url().includes("/api/editor/debug/sessions") &&
      response.request().method() === "POST",
  );
  await pane.locator(EDITOR_SELECTORS.monaco).click();
  await page.keyboard.press("F5");
  const response = await started;
  expect(response.status(), await response.text()).toBe(201);
  return debugSession(await response.json());
}

async function stopFromDebugPanel(page: Page, panel: Locator): Promise<void> {
  const stopped = page.waitForResponse(
    (response) =>
      response.url().includes("/api/editor/debug/control") &&
      response.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Stop debugging" }).click();
  expect((await stopped).status()).toBe(200);
  await expect(panel.getByText("No active debug session.")).toBeVisible();
}

async function expectServerPaused(
  page: Page,
  session: DebugSessionProjection,
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
      paused = debugSession(value);
      return record.status;
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
): Promise<DebugSessionProjection> {
  const paused = await expectServerPaused(page, session);
  await expect(panel.getByText("Session is paused.")).toBeVisible();
  await expect(panel.getByRole("option", { name: new RegExp(frameName) })).toBeVisible();
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
  for (const label of ["Step over", "Step into", "Step out"] as const) {
    const stepped = page.waitForResponse(
      (response) =>
        response.url().includes("/api/editor/debug/control") &&
        response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: label }).click();
    expect((await stepped).status()).toBe(200);
    await expectPaused(page, panel, session, "breakpointFixture");
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
  await reloadedEditor.getByRole("button", { name: "Expand folder: src" }).click();
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

test.afterEach(() => {
  cleanupEditorWorkspaces();
});

test("#2348 drives the real DAP session from breakpoint through step, inline values, variables, watch, and stop", async ({
  page,
}) => {
  const project = workspace();
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
  await expect(panel.getByRole("option", { name: /src\/throws\.ts:8/ })).toBeVisible();
  await expect
    .poll(() => capturedExceptionEvent(page))
    .toMatchObject({
      event: {
        description: { value: "Fixture uncaught exception" },
        reason: "exception",
      },
    });
  await expect(panel.getByRole("status")).toHaveText("Exception: Fixture uncaught exception");
  await stopFromDebugPanel(page, panel);
});
