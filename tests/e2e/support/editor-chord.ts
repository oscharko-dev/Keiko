// The editor modifier chord, derived from the BROWSER — never from the Node host.
//
// Monaco binds its keyboard shortcuts from the platform the PAGE reports: a "Macintosh" user agent
// selects the Cmd-based bindings, everything else gets Ctrl. Two tempting shortcuts ask the wrong
// machine, and both are host-derived:
//
//   process.platform === "darwin" ? "Meta" : "Control"   // the Node process, not the browser
//   page.keyboard.press("ControlOrMeta+…")               // Playwright resolves it per HOST OS
//
// Measured, not assumed: under this suite's own config both engines report a Windows user agent
// (`devices["Desktop Chrome"]` and `devices["Desktop Firefox"]` each force `Windows NT 10.0`
// regardless of the host OS), so `editorModifier` resolves to "Control" for both, and its "Meta"
// branch is not exercised here at all. The bug the host-derived form actually causes is therefore
// NOT an engine difference — it is a HOST difference: on a macOS developer machine those
// expressions press Meta while the page reports Windows and Monaco is listening for Ctrl, so the
// chord reaches nothing locally while CI (Linux) stays green. Asking `navigator.userAgent` inside
// the page asks exactly the question Monaco asks, so it is right on every engine AND every host.
//
// The genuine cross-engine difference in this file is a different one, and it lives in
// `focusMonacoInput` below: the EditContext-vs-textarea input surface.
import { expect, type Locator, type Page, type Request } from "@playwright/test";
import { editorPaneWindowId } from "../../../packages/keiko-ui/src/app/components/desktop/widgets/cards/editorPaneWindowId.js";

/**
 * MONACO CHORDS ONLY. Do not use this for a Keiko product shortcut — they resolve differently, and
 * the two disagree under Playwright's device presets:
 *
 *   Monaco            reads `navigator.userAgent` (`isMacintosh = userAgent.indexOf('Macintosh')`),
 *                     which the presets FORCE to Windows on every host -> it waits for Ctrl.
 *   Keiko's shortcuts read `navigator.platform` (useKeyboardShortcuts' detectPlatform), which the
 *                     presets do NOT override -> on a Mac it still reads "MacIntel" and waits for
 *                     metaKey.
 *
 * So for a PRODUCT shortcut (command palette, workspace search, canvas copy/paste) Playwright's own
 * host-derived "ControlOrMeta" is correct, and this helper is wrong: it would send Control to a
 * product listening for Meta, failing on every real Mac in BOTH engines. Measured both ways.
 *
 * "Meta" when the BROWSER reports a Macintosh user agent, "Control" otherwise.
 */
export async function editorModifier(page: Page): Promise<"Meta" | "Control"> {
  const browserIsMac = await page.evaluate(() => navigator.userAgent.includes("Macintosh"));
  return browserIsMac ? "Meta" : "Control";
}

/**
 * Selects the complete Monaco model through the input surface this engine provides.
 *
 * Chromium's EditContext surface receives Monaco's select-all chord directly. Firefox's textarea
 * fallback lets the browser consume that chord as a native textarea selection before Monaco can
 * turn it into a model selection, so select from the model's first to last position through
 * Monaco's cursor keybindings there. Neither path mutates a DOM value or exposes a test-only hook.
 */
export async function selectAllInEditor(page: Page, editorWindow: Locator): Promise<void> {
  if (await usesGeckoTextareaInput(page, editorWindow)) {
    await selectAllThroughModelBounds(page);
    return;
  }
  await pressChord(page, await editorModifier(page));
}

async function usesGeckoTextareaInput(page: Page, editorWindow: Locator): Promise<boolean> {
  return (
    page.context().browser()?.browserType().name() === "firefox" &&
    (await editorWindow.locator(".monaco-editor textarea.inputarea").count()) > 0
  );
}

async function selectAllThroughModelBounds(page: Page): Promise<void> {
  const modifier = await editorModifier(page);
  await page.keyboard.press(`${modifier}+Home`);
  await page.keyboard.press(`${modifier}+Shift+End`);
}

async function pressChord(page: Page, modifier: "Meta" | "Control"): Promise<void> {
  await page.keyboard.down(modifier);
  try {
    await page.keyboard.press("KeyA");
  } finally {
    // A throw between down() and up() (e.g. KeyA timing out) must never leave the modifier
    // physically held down for the rest of the test run — every subsequent keypress in the same
    // browser context would then arrive chorded (PR #3355 review, IDX45).
    await page.keyboard.up(modifier);
  }
}

/**
 * Focuses Monaco's actual keyboard-input surface inside `editorWindow`, whichever one this engine
 * gave it.
 *
 * Monaco 0.56 prefers the **EditContext** API and renders `div.native-edit-context`; where
 * EditContext is unavailable it falls back to the classic `textarea.inputarea`. Chromium takes the
 * first path, Firefox the second — verified from a Firefox trace snapshot of this very editor:
 * `native-edit-context` 0 occurrences, `inputarea` 2.
 *
 * Why this matters: clicking `.monaco-editor` lands focus on the EditContext surface in Chromium.
 * Firefox instead needs its fallback textarea focused explicitly. Focus is necessary in both
 * engines; replacement then selects between Monaco's model bounds on that fallback rather than a
 * browser-native textarea select-all.
 */
export async function focusMonacoInput(editorWindow: Locator): Promise<void> {
  const editor = editorWindow.locator(".monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.click();
  const input = monacoInput(editorWindow);
  await input.focus();
  await expect(input).toBeFocused();
}

function monacoInput(editorWindow: Locator): Locator {
  const editor = editorWindow.locator(".monaco-editor").first();
  // Whichever surface this engine created. `.or()` resolves to the one that exists, so this needs
  // no platform branch and keeps working if a future Monaco brings EditContext to more engines.
  return editor.locator(".native-edit-context").or(editor.locator("textarea.inputarea")).first();
}

/**
 * Reads the complete buffer from the product's hot-exit write payload.
 *
 * Monaco virtualizes `.view-line` nodes, so rendered DOM can neither prove that off-screen stale
 * lines are gone nor preserve exact leading/trailing whitespace. The hot-exit write is produced
 * from the host's controlled buffer after Monaco's `onChange` supplies the full model value. Reading
 * that already-existing request therefore verifies the complete buffer without adding a test-only
 * product hook or exposing file content in a DOM attribute.
 */
function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function hotExitSnapshotString(
  payload: unknown,
  field: "content" | "paneId" | "relativePath" | "windowId" | "workspaceRoot",
): string | undefined {
  if (!isUnknownRecord(payload)) return undefined;
  const snapshot = payload.snapshot;
  if (!isUnknownRecord(snapshot)) return undefined;
  const value = snapshot[field];
  return typeof value === "string" ? value : undefined;
}

export function hotExitSnapshotContent(payload: unknown): string | undefined {
  return hotExitSnapshotString(payload, "content");
}

export interface ExactHotExitExpectation {
  readonly content: string;
  readonly paneId: string;
  readonly relativePath: string;
  readonly windowId: string;
  readonly workspaceRoot: string;
}

function canonicalModelText(text: string): string {
  // Monaco follows the browser profile's Windows EOL preference in these journeys. EOL encoding is
  // not a content difference; every other character, including all indentation, remains exact.
  return text.replace(/\r\n?/gu, "\n");
}

export function matchesExactHotExitSnapshot(
  payload: unknown,
  expected: ExactHotExitExpectation,
): boolean {
  const observedContent = hotExitSnapshotContent(payload);
  return (
    observedContent !== undefined &&
    canonicalModelText(observedContent) === canonicalModelText(expected.content) &&
    hotExitSnapshotString(payload, "relativePath") === expected.relativePath &&
    hotExitSnapshotString(payload, "paneId") === expected.paneId &&
    hotExitSnapshotString(payload, "windowId") === expected.windowId &&
    hotExitSnapshotString(payload, "workspaceRoot") === expected.workspaceRoot
  );
}

export function isExactHotExitWrite(request: Request, expected: ExactHotExitExpectation): boolean {
  if (request.method() !== "POST" || !request.url().endsWith("/api/editor/hot-exit/write")) {
    return false;
  }
  try {
    const payload: unknown = request.postDataJSON();
    return matchesExactHotExitSnapshot(payload, expected);
  } catch {
    return false;
  }
}

function multiRootRef(labelledBy: string | null | undefined): string | undefined {
  if (labelledBy === undefined || labelledBy === null) return undefined;
  const marker = "-tab-";
  const markerIndex = labelledBy.lastIndexOf(marker);
  return markerIndex < 0 ? undefined : labelledBy.slice(markerIndex + marker.length);
}

async function activeEditorIdentity(
  editorWindow: Locator,
): Promise<Omit<ExactHotExitExpectation, "content" | "workspaceRoot">> {
  const identity = await editorWindow
    .locator(".monaco-editor")
    .first()
    .evaluate((element) => {
      const pane = element.closest<HTMLElement>("section.ed-pane[data-pane-id]");
      const tab = pane?.querySelector<HTMLElement>(".ed-tab.active[data-tab-file]");
      const windowFrame = element.closest<HTMLElement>(".window[data-window-id]");
      const rootSession = element.closest<HTMLElement>(
        '[role="tabpanel"][aria-labelledby*="-tab-root-"]',
      );
      return {
        paneId: pane?.dataset.paneId,
        relativePath: tab?.dataset.tabFile,
        // MultiRootEditorHost exposes the opaque, body-free rootRef through the tab/panel relation.
        // Keep the raw workspace path out of the DOM while reproducing its per-root window identity.
        rootSessionLabel: rootSession?.getAttribute("aria-labelledby"),
        windowId: windowFrame?.dataset.windowId,
      };
    });
  if (
    identity.paneId === undefined ||
    identity.relativePath === undefined ||
    identity.windowId === undefined
  ) {
    throw new Error("active editor identity is unavailable");
  }
  const rootRef = multiRootRef(identity.rootSessionLabel);
  const runtimeWindowId =
    rootRef === undefined ? identity.windowId : `${identity.windowId}-${rootRef}`;
  return {
    paneId: identity.paneId,
    relativePath: identity.relativePath,
    windowId: editorPaneWindowId(runtimeWindowId, identity.paneId),
  };
}

async function pasteEditorText(editorWindow: Locator, text: string): Promise<void> {
  // Dispatch through Monaco's real paste listener. `keyboard.insertText()` models character input,
  // so Monaco auto-indents every embedded newline; a paste carries the complete literal buffer and
  // preserves its indentation without using the OS clipboard or a test-only product hook.
  await monacoInput(editorWindow).evaluate((input, pastedText) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedText);
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
        composed: true,
      }),
    );
  }, text);
}

async function performReplacementGesture(
  page: Page,
  editorWindow: Locator,
  text: string,
): Promise<void> {
  await page.keyboard.press("Backspace");
  if (await usesGeckoTextareaInput(page, editorWindow)) {
    // Firefox correctly rejects the synthetic ClipboardEvent used by the EditContext path. Drive
    // its native textarea with real key events after the Monaco model selection is deleted.
    await page.keyboard.type(text);
    return;
  }
  await pasteEditorText(editorWindow, text);
}

/**
 * Enters `text` into an editor whose model is known to be empty. Real key events drive Monaco's
 * native textarea path on Gecko; page-dispatched clipboard events are correctly untrusted there,
 * while direct protocol insertion duplicates the textarea payload in Monaco 0.56 on Firefox. No
 * select-all is needed for an empty model. The exact hot-exit write remains the product-backed
 * assertion, so a silent gesture, input transformation or stale model fails closed.
 */
export async function enterEmptyEditorBuffer(
  page: Page,
  editorWindow: Locator,
  text: string,
  workspaceRoot: string,
  expectedContent = text,
): Promise<void> {
  const identity = await activeEditorIdentity(editorWindow);
  await focusMonacoInput(editorWindow);
  const expectation = { ...identity, content: expectedContent, workspaceRoot };
  const exactBufferObserved = page.waitForRequest(
    (request) => isExactHotExitWrite(request, expectation),
    { timeout: 10_000 },
  );
  await Promise.all([exactBufferObserved, page.keyboard.type(text)]);
}

/**
 * Replaces the whole editor buffer with `text` — the shared, fail-closed version of the
 * click-selectAll-insert dance that several specs previously each carried their own copy of.
 * Verifies that the select-all actually took effect AND that no old content survives anywhere in
 * the buffer, so a command that silently reaches nothing fails HERE with a clear message instead of
 * corrupting the buffer for a later assertion.
 */
export async function replaceEditorBuffer(
  page: Page,
  editorWindow: Locator,
  text: string,
  workspaceRoot: string,
): Promise<void> {
  const identity = await activeEditorIdentity(editorWindow);
  await focusMonacoInput(editorWindow);
  await selectAllInEditor(page, editorWindow);
  // Register before the mutating part of the gesture so a fast state update cannot outrun the
  // observer. The predicate ignores stale writes carrying other content or another active file and
  // settles only when the product publishes this exact full buffer through its hot-exit path.
  const expectation = { ...identity, content: text, workspaceRoot };
  const exactBufferObserved = page.waitForRequest(
    (request) => isExactHotExitWrite(request, expectation),
    { timeout: 10_000 },
  );
  // Delete the selection with a real key event before pasting. Promise.all attaches rejection
  // handlers to both operations immediately, so neither a gesture failure nor an observer timeout
  // can leak later as an unhandled rejection.
  await Promise.all([exactBufferObserved, performReplacementGesture(page, editorWindow, text)]);
}
