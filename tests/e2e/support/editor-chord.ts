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
import { expect, type Locator, type Page } from "@playwright/test";

/** "Meta" when the BROWSER reports a Macintosh user agent, "Control" otherwise. */
export async function editorModifier(page: Page): Promise<"Meta" | "Control"> {
  const browserIsMac = await page.evaluate(() => navigator.userAgent.includes("Macintosh"));
  return browserIsMac ? "Meta" : "Control";
}

/**
 * Presses the editor's select-all chord and waits for the page to settle, so a caller can follow
 * it with `insertText` and REPLACE the buffer rather than append to it.
 */
export async function selectAllInEditor(page: Page): Promise<void> {
  await pressChord(page, await editorModifier(page));
}

async function pressChord(page: Page, modifier: "Meta" | "Control"): Promise<void> {
  await page.keyboard.down(modifier);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(modifier);
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
 * Why this matters: clicking `.monaco-editor` lands focus on the EditContext surface in Chromium,
 * so a following select-all chord works. On Firefox the same click does not reliably focus the
 * fallback textarea, the chord reaches nothing, and — because a select-all that selects nothing
 * fails SILENTLY — the next `insertText` APPENDS. That is how a two-line buffer became four lines
 * and surfaced much later as an unrelated-looking strict-mode violation.
 */
export async function focusMonacoInput(editorWindow: Locator): Promise<void> {
  const editor = editorWindow.locator(".monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.click();
  // Whichever surface this engine created. `.or()` resolves to the one that exists, so this needs
  // no platform branch and keeps working if a future Monaco brings EditContext to more engines.
  const input = editor
    .locator(".native-edit-context")
    .or(editor.locator("textarea.inputarea"))
    .first();
  await input.focus();
  await expect(input).toBeFocused();
}

// Monaco renders an empty line as a lone non-breaking-space placeholder (to keep its line
// height), never as a truly empty `.view-line`. Normalizing that back to a plain space (then
// trimming) is what lets a genuinely blank line compare equal to "" instead of to a stray nbsp.
function normalizeEditorLine(line: string): string {
  return line.replace(/\u00a0/gu, " ").trim();
}

// The expected reading of `text` in the SAME shape the per-line innerText comparison needs: one
// entry per line, in order. A document with N "\n" characters renders N+1 lines (the content
// after the final "\n" is itself a — possibly empty — line), and Monaco represents a wholly empty
// document as exactly one empty line, never zero.
function normalizedEditorLines(text: string): readonly string[] {
  return text.length === 0 ? [""] : text.split("\n").map(normalizeEditorLine);
}

/**
 * Replaces the whole editor buffer with `text` — the engine-agnostic version of the
 * click-selectAll-insert dance that several specs previously each carried their own copy of.
 * Verifies that the select-all actually took effect AND that no old content survives anywhere in
 * the buffer, so a chord that silently reaches nothing fails HERE with a clear message instead of
 * corrupting the buffer for a later assertion.
 */
export async function replaceEditorBuffer(
  page: Page,
  editorWindow: Locator,
  text: string,
): Promise<void> {
  await focusMonacoInput(editorWindow);
  await selectAllInEditor(page);
  // Delete the selection with a REAL key event before inserting. `insertText` does not send key
  // events — it hands the text to the engine's input pipeline — and whether that replaces an
  // existing selection is engine-dependent: Chromium replaces, Firefox inserts at the caret and
  // leaves the selected text in place, which is what doubled the buffer. Backspace on a selection
  // is unambiguous in both.
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(text);
  // The invariant this checks is REPLACEMENT, not equality: after a successful select-all the
  // inserted text must appear ONCE, never twice. That is the actual corruption mode — a select-all
  // that silently reached nothing leaves the old content in place and `insertText` appends, so
  // every line shows up a second time.
  //
  // It deliberately does NOT assert the rendered lines EQUAL `text`, because `.view-line` is not
  // the buffer. Monaco renders inline completions (ghost text) and auto-closed brackets into those
  // same elements, so a fixture that inserts `"…answer() {\n  ret"` legitimately reads back as
  // `["…answer() {", "return 42;", "}"]` — the ghost-text suggestion replacing the visible `ret`
  // and Monaco supplying the closing brace. An equality check calls that a corrupted buffer and
  // fails a passing product (it did, on chromium, in `editor inline ghost text renders and Tab
  // accepts it`). Reading the model instead of the DOM would allow equality, but this helper's
  // contract is the replacement, so it asserts exactly that and nothing it cannot see.
  //
  // The empty-string case is still checked — the earlier first-line-only version skipped it
  // entirely, which is how a failed select-all could pass silently.
  const expectedLines = normalizedEditorLines(text);
  await expect(async () => {
    const renderedLines = await editorWindow.locator(".view-line").allInnerTexts();
    const actualLines = renderedLines.map(normalizeEditorLine);
    if (expectedLines.every((line) => line === "")) {
      expect(
        actualLines.filter((line) => line !== ""),
        `expected the buffer to be empty, got ${JSON.stringify(actualLines)}`,
      ).toEqual([]);
      return;
    }
    // Counted against the EXPECTED multiplicity, not against 1: a fixture may legitimately repeat a
    // line (`"same\nsame"` must render two "same" lines), and demanding at most one would fail a
    // correct replacement. `<=` rather than `===` because Monaco may REPLACE a rendered line with an
    // inline completion, so a line can legitimately go missing from `.view-line` — but it can never
    // legitimately appear MORE times than it was inserted, which is exactly the append-instead-of-
    // replace corruption this guards.
    for (const line of new Set(expectedLines.filter((candidate) => candidate !== ""))) {
      const expectedCount = expectedLines.filter((candidate) => candidate === line).length;
      expect(
        actualLines.filter((actual) => actual === line).length,
        `expected "${line}" at most ${String(expectedCount)}x after replacing the buffer, got ` +
          JSON.stringify(actualLines),
      ).toBeLessThanOrEqual(expectedCount);
    }
    // At least the first inserted line must be present, so a select-all that wiped everything and
    // inserted nothing cannot pass the duplicate check vacuously.
    const anchor = expectedLines.find((line) => line !== "");
    if (anchor !== undefined) {
      expect(
        actualLines.some((actual) => actual.startsWith(anchor) || anchor.startsWith(actual)),
        `expected the buffer to contain "${anchor}", got ${JSON.stringify(actualLines)}`,
      ).toBe(true);
    }
  }).toPass({ timeout: 10_000 });
}
