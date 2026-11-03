import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import {
  cleanupEditorWorkspaces,
  collectPageErrors,
  createEditorWorkspace,
  EDITOR_SELECTORS,
  openEditorWorkspace,
  openTreeFile,
  seedEditorWindow,
} from "./support/editorWorkspace.js";
import { editorModifier, focusMonacoInput } from "./support/editor-chord.js";
import {
  documentAction,
  expectFormatActionAvailability,
} from "./support/editor-document-actions.js";

const TAG = "@language-intelligence-1383";
const TS_FILE = "app.ts";
const PY_FILE = "tool.py";
const LARGE_FILE = "large.ts";
const MAX_BROWSER_DIAGNOSTICS = 512;
// Virtual milliseconds advanced to close the language client's request window. Comfortably over the
// editor's diagnostics debounce, and free: virtual time costs no wall-clock time.
const LANGUAGE_REQUEST_DRAIN_MS = 5_000;
// Belongs to no fixture file, so the ordering barrier it drives never lands in a ledger under test.
const DRAIN_SENTINEL_PATH = "__request-window-drain__";
// Headroom so the pause target is still in the page clock's future when the pause is applied.
const CLOCK_PAUSE_CUSHION_MS = 1_000;

const CAPABILITIES = {
  schemaVersion: "1",
  providers: [
    {
      id: "typescript",
      languages: ["typescript", "javascript"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "available",
    },
    {
      id: "python-lsp",
      languages: ["python"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "unavailable",
      unavailableReason: "Host Python provider is disabled by policy.",
    },
  ],
} as const;

test.afterAll(() => {
  cleanupEditorWorkspaces();
});

function largeBuffer(): string {
  return Array.from(
    { length: 10_100 },
    (_unused, index) => `const value${String(index)} = ${String(index)};`,
  ).join("\n");
}

interface LanguageRouteBody {
  readonly operation?: string;
  readonly document?: { readonly path?: string };
  readonly position?: { readonly line?: number; readonly character?: number };
}

interface LanguageOperationCall {
  readonly operation: string;
  readonly path: string;
}

function diagnostic(index: number): Record<string, unknown> {
  return {
    range: {
      start: { line: index % 20, character: 0 },
      end: { line: index % 20, character: 5 },
    },
    severity: index === 0 ? "error" : "warning",
    message: `Bounded diagnostic ${String(index)}`,
    source: "typescript",
  };
}

function languageResponse(body: LanguageRouteBody): Record<string, unknown> {
  const operation = body.operation ?? "unknown";
  if (operation === "diagnostics") {
    return {
      operation,
      result: {
        diagnostics: Array.from({ length: MAX_BROWSER_DIAGNOSTICS }, (_unused, index) =>
          diagnostic(index),
        ),
        truncated: true,
      },
    };
  }
  if (operation === "hover") {
    return {
      operation,
      result: {
        contents: "Keiko language intelligence hover ready",
        range: {
          start: { line: body.position?.line ?? 0, character: 0 },
          end: { line: body.position?.line ?? 0, character: 11 },
        },
      },
    };
  }
  if (operation === "symbols") {
    return {
      operation,
      result: {
        symbols: [
          {
            name: "greeting",
            kind: "variable",
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
          },
        ],
        truncated: false,
      },
    };
  }
  return { operation, result: { edits: [], truncated: false } };
}

async function routeLanguageIntelligence(page: Page): Promise<{
  readonly calls: readonly LanguageOperationCall[];
}> {
  const calls: LanguageOperationCall[] = [];
  await page.route("**/api/editor/language/capabilities**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(CAPABILITIES),
    });
  });
  await page.route("**/api/editor/language", async (route) => {
    const body = route.request().postDataJSON() as LanguageRouteBody;
    const operation = body.operation ?? "unknown";
    calls.push({ operation, path: body.document?.path ?? "" });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(languageResponse(body)),
    });
  });
  return { calls };
}

async function attachShot(testInfo: TestInfo, page: Page, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

// F6: a plain `.click()` on the Monaco root can leave Firefox's fallback `textarea.inputarea`
// unfocused (support/editor-chord.ts `focusMonacoInput`'s doc comment), so the select-all below
// reaches nothing and `insertText` APPENDS instead of replacing. `focusMonacoInput` focuses
// whichever real input surface this engine created instead of re-deriving a weaker click-only
// version of that logic here.
async function replaceMonacoText(page: Page, workspace: Locator, text: string): Promise<void> {
  await focusMonacoInput(workspace);
  const modifier = await editorModifier(page);
  await page.keyboard.down(modifier);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(modifier);
  // Delete the selection with a REAL key event first. `insertText` bypasses key events, and
  // whether it replaces a selection is engine-dependent: Chromium replaces, Firefox inserts at
  // the caret and leaves the selected text behind — appending instead of replacing.
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(text);
}

function statusField(workspace: Locator, id: string): Locator {
  return workspace.locator(`${EDITOR_SELECTORS.statusBar} [data-field="${id}"]`).first();
}

function statusBar(workspace: Locator): Locator {
  return workspace.locator(EDITOR_SELECTORS.statusBar).first();
}

function callsFor(
  routed: { readonly calls: readonly LanguageOperationCall[] },
  path: string,
): readonly LanguageOperationCall[] {
  return routed.calls.filter((call) => call.path === path);
}

function callCount(
  routed: { readonly calls: readonly LanguageOperationCall[] },
  path: string,
  operation?: string,
): number {
  return callsFor(routed, path).filter(
    (call) => operation === undefined || call.operation === operation,
  ).length;
}

/**
 * Close the language client's request window on the CURRENT document, so the "no call was made"
 * assertions below rule something out instead of merely being read too early.
 *
 * The editor dispatches diagnostics (and the other bridged operations) behind a debounce timer, so
 * "no call yet" is trivially true the instant after an edit. The window has to be closed before the
 * ledger is read — and it has to be closed WITHOUT leaving the document: the app cancels pending
 * language work as soon as the active document changes, so any bound built out of "open the file
 * whose provider IS available and wait for a fresh call" would swallow the very request these
 * assertions exist to forbid. (Measured: edit the TypeScript buffer, switch away inside the
 * debounce, and no diagnostics call is ever recorded for it.)
 *
 * Pausing the page clock and running it forward fires every timer that comes due in the window,
 * which is exactly the observable condition wanted: when this returns, a request this document was
 * going to make has been DISPATCHED rather than still pending. The sentinel round trip afterwards
 * is an ordering barrier — it travels the same intercepted route as any dispatched request, so once
 * its response is back, every earlier request has already been recorded. It carries a path that
 * belongs to no fixture file, so it never perturbs a `callsFor` ledger under test.
 */
async function drainLanguageRequestWindow(page: Page): Promise<void> {
  // Pause slightly AHEAD of the page's own clock: a target read a moment ago is already in the
  // past by the time the pause lands, and the clock refuses to travel backwards.
  const pauseTarget = (await page.evaluate(() => Date.now())) + CLOCK_PAUSE_CUSHION_MS;
  await page.clock.pauseAt(pauseTarget);
  await page.clock.runFor(LANGUAGE_REQUEST_DRAIN_MS);
  await page.clock.resume();
  await page.evaluate(async (sentinelPath) => {
    await fetch("/api/editor/language", {
      method: "POST",
      headers: { "content-type": "application/json", "x-keiko-csrf": "1" },
      body: JSON.stringify({ operation: "diagnostics", document: { path: sentinelPath } }),
    });
  }, DRAIN_SENTINEL_PATH);
}

const TIMELINE_METHODS = [
  "mark",
  "measure",
  "getEntries",
  "getEntriesByName",
  "getEntriesByType",
  "clearMarks",
  "clearMeasures",
] as const;

interface PlaywrightClockHandle {
  readonly builtins?: { readonly performance?: Performance };
}

/**
 * Give the fake-clock page its real performance timeline back, leaving `now()` to the clock.
 *
 * Playwright's clock swaps `performance` for a stub whose `getEntriesByName` always answers an
 * empty list. Monaco's input-latency recorder reads `getEntriesByName(...)[0].duration` once a
 * keystroke has been rendered, so under the stub every completed keystroke throws a page error
 * from the editor's own key handler or from a timer the drain below fires. That is an artifact of
 * the stub, not of the editor, and `collectPageErrors` is right to report it. The clock keeps
 * `performance.now()`; marks, measures and entries go back to the browser's own timeline, which is
 * all the recorder needs and nothing the drains observe.
 */
async function restorePerformanceTimeline(page: Page): Promise<void> {
  await page.evaluate((methods) => {
    const handle = (window as unknown as { __pwClock?: PlaywrightClockHandle }).__pwClock;
    const real = handle?.builtins?.performance;
    if (real === undefined) {
      throw new Error("The Playwright clock no longer exposes the real performance timeline.");
    }
    for (const method of methods) {
      const original = Reflect.get(real, method) as (...args: readonly unknown[]) => unknown;
      Reflect.set(window.performance, method, original.bind(real));
    }
  }, TIMELINE_METHODS);
}

async function openMatrixWorkspace(page: Page): Promise<Locator> {
  const { root } = createEditorWorkspace([
    { path: TS_FILE, content: "const greeting: string = 42;\ngreeting;\n" },
    { path: PY_FILE, content: "value = 1\n" },
    { path: LARGE_FILE, content: largeBuffer() },
  ]);
  // Register the fixture root as a project before seeding the window. Without it the editor has no
  // server-validated trust grant for this root, falls back to the preferred project, and reports
  // "The requested path was not found" — every status assertion below then fails on an editor that
  // never opened the fixture. This mirrors the registration the CI-covered editor suites already do
  // (editor-debugging-2348), and no lane runs this suite, so the drift went unnoticed.
  // Freeze-capable clock for the request-window drains below; time flows normally until a drain
  // pauses it, so nothing else in this suite changes behaviour.
  await page.clock.install();
  await page.clock.resume();
  const created = await page.request.post("/api/projects", {
    data: { name: "Issue 1383 language intelligence", path: root },
    headers: { "x-keiko-csrf": "1" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await seedEditorWindow(page, { root, openFiles: [TS_FILE], active: TS_FILE });
  await page.goto("/");
  await restorePerformanceTimeline(page);
  return openEditorWorkspace(page);
}

async function hoverOnGreeting(page: Page, workspace: Locator): Promise<void> {
  const usageLine = workspace.locator(".view-line", { hasText: "greeting;" });
  await expect(usageLine).toBeVisible();
  const box = await usageLine.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    await page.mouse.move(box.x + 24, box.y + box.height / 2);
  }
}

// A hover stays open while the pointer rests on its anchor, and a Playwright click aims at the
// centre of the part of the editor that is inside the viewport, which can fall inside that open
// widget. Monaco's hover carries a Copy button, so such a click presses it and asks the browser for
// clipboard write access the context never granted. Move the pointer away and wait for the widget
// to close before addressing the editor itself.
async function dismissHover(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.locator(".monaco-hover:visible")).toHaveCount(0);
}

async function triggerSymbols(page: Page, workspace: Locator): Promise<void> {
  await dismissHover(page);
  await workspace.locator(EDITOR_SELECTORS.monaco).first().click();
  const modifier = await editorModifier(page);
  await page.keyboard.press(`${modifier}+Shift+KeyO`);
}

// Format is a secondary document action: it lives in the "More file actions" menu and is offered
// only while formatting is available for the open file (#3685).
async function triggerFormat(workspace: Locator): Promise<void> {
  await (await documentAction(workspace, "Format")).click();
}

// With formatting unavailable or degraded the menu offers no Format action, so there is nothing to
// click. Prove that from an opened menu, then still try to format the way a user without the
// action would, through Monaco's native Format Document chord; callers assert that no formatting
// request reached the language service.
async function attemptUnavailableFormat(page: Page, workspace: Locator): Promise<void> {
  await expectFormatActionAvailability(workspace, false);
  await focusMonacoInput(workspace);
  await page.keyboard.press("Shift+Alt+KeyF");
}

async function assertAvailableStatus(workspace: Locator): Promise<void> {
  const statusBar = workspace.locator(EDITOR_SELECTORS.statusBar).first();
  await expect(statusBar).toHaveAttribute("role", "group");
  await expect(statusBar).toHaveAttribute("aria-label", "Editor status");
  await expect(statusField(workspace, "language")).toHaveText("TypeScript");
  await expect(statusField(workspace, "language")).toHaveAttribute(
    "aria-label",
    "Language: TypeScript",
  );
  await expect(statusField(workspace, "language-service")).toHaveText("typescript ready");
  await expect(statusField(workspace, "language-service")).toHaveAttribute(
    "aria-label",
    "Language provider available: typescript",
  );
  await expect(statusField(workspace, "formatting")).toHaveText("Format ready");
  await expect(statusField(workspace, "formatting")).toHaveAttribute(
    "aria-label",
    "Document formatting available",
  );
  await expectFormatActionAvailability(workspace, true);
}

async function assertDiagnosticsAndHover(page: Page, workspace: Locator): Promise<void> {
  const diagnosticsStartedAt = Date.now();
  await expect
    .poll(() => workspace.locator(".squiggly-error, .squiggly-warning").count(), {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  await expect(statusField(workspace, "problems")).toHaveText("1 ⚠ 511");
  await expect(statusField(workspace, "problems")).toHaveAttribute(
    "aria-label",
    "Problems: 1 error, 511 warnings",
  );
  await expect(workspace.getByTestId("editor-status-bar-live")).toHaveAttribute("role", "status");
  await expect(workspace.getByTestId("editor-status-bar-live")).toContainText(
    "Problems: 1 error, 511 warnings",
  );
  expect(Date.now() - diagnosticsStartedAt).toBeLessThan(60_000);

  await hoverOnGreeting(page, workspace);
  await expect(page.locator(".monaco-hover").first()).toContainText(
    "Keiko language intelligence hover ready",
    { timeout: 30_000 },
  );
}

async function assertAvailableOperations(
  page: Page,
  workspace: Locator,
  routed: { readonly calls: readonly LanguageOperationCall[] },
): Promise<void> {
  await expect.poll(() => callCount(routed, TS_FILE, "diagnostics")).toBeGreaterThan(0);
  await expect.poll(() => callCount(routed, TS_FILE, "hover")).toBeGreaterThan(0);
  await expect(statusBar(workspace)).toHaveScreenshot("issue-1383-available-provider.png", {
    maxDiffPixelRatio: 0.001,
  });

  await triggerSymbols(page, workspace);
  await expect
    .poll(() => callCount(routed, TS_FILE, "symbols"), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await triggerFormat(workspace);
  await expect.poll(() => callCount(routed, TS_FILE, "formatting")).toBeGreaterThan(0);
}

test(`available provider shows language, diagnostics, hover, symbols, and format state ${TAG}`, async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);
  const routed = await routeLanguageIntelligence(page);
  const workspace = await openMatrixWorkspace(page);

  await assertAvailableStatus(workspace);
  await assertDiagnosticsAndHover(page, workspace);
  await assertAvailableOperations(page, workspace, routed);
  await attachShot(testInfo, page, "available-provider-diagnostics-hover-status.png");
  expect(errors).toEqual([]);
});

async function assertUnavailableProvider(
  page: Page,
  workspace: Locator,
  routed: { readonly calls: readonly LanguageOperationCall[] },
): Promise<void> {
  await openTreeFile(workspace, PY_FILE);
  await expect(statusField(workspace, "language")).toHaveText("Python");
  await expect(statusField(workspace, "language")).toHaveAttribute(
    "aria-label",
    "Language: Python",
  );
  await expect(statusField(workspace, "language-service")).toHaveText("LSP unavailable");
  await expect(statusField(workspace, "language-service")).toHaveAttribute(
    "aria-label",
    "Language provider unavailable: Host Python provider is disabled by policy.",
  );
  await expect(statusField(workspace, "formatting")).toHaveText("Format unavailable");
  await attemptUnavailableFormat(page, workspace);
  await replaceMonacoText(page, workspace, "value = 2\n");
  await expect(statusField(workspace, "save")).toHaveText("Unsaved");
  await drainLanguageRequestWindow(page);
  expect(callsFor(routed, PY_FILE)).toEqual([]);
  await expect(statusBar(workspace)).toHaveScreenshot("issue-1383-unavailable-provider.png", {
    maxDiffPixelRatio: 0.001,
  });
}

async function assertDegradedProvider(
  page: Page,
  workspace: Locator,
  routed: { readonly calls: readonly LanguageOperationCall[] },
): Promise<void> {
  await openTreeFile(workspace, LARGE_FILE);
  await expect(statusField(workspace, "language")).toHaveText("TypeScript");
  await expect(statusField(workspace, "large-file")).toHaveText("Large file mode");
  await expect(statusField(workspace, "large-file")).toHaveAttribute(
    "aria-label",
    "Large file mode: completions and analysis disabled",
  );
  await expect(statusField(workspace, "completions")).toHaveText("Completions off");
  await expect(statusField(workspace, "completions")).toHaveAttribute(
    "aria-label",
    "Governed completions unavailable for this file type",
  );
  await expect(statusField(workspace, "formatting")).toHaveText("Format unavailable");
  await attemptUnavailableFormat(page, workspace);
  await triggerSymbols(page, workspace);
  await expect(workspace.locator(".squiggly-error, .squiggly-warning")).toHaveCount(0);
  await drainLanguageRequestWindow(page);
  expect(callsFor(routed, LARGE_FILE)).toEqual([]);
  await expect(statusBar(workspace)).toHaveScreenshot("issue-1383-degraded-large-file.png", {
    maxDiffPixelRatio: 0.001,
  });
}

test(`unavailable and degraded providers remain quiet, visible, and non-blocking ${TAG}`, async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);
  const routed = await routeLanguageIntelligence(page);
  const workspace = await openMatrixWorkspace(page);
  await expect.poll(() => callCount(routed, TS_FILE, "diagnostics")).toBeGreaterThan(0);

  await assertUnavailableProvider(page, workspace, routed);
  await attachShot(testInfo, page, "unavailable-provider-status.png");
  await assertDegradedProvider(page, workspace, routed);
  await attachShot(testInfo, page, "degraded-large-file-status.png");
  expect(errors).toEqual([]);
});
