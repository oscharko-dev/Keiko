// The editor modifier chord, derived from the BROWSER — never from the Node host.
//
// Monaco binds its keyboard shortcuts from the platform the PAGE reports (a "Macintosh" user
// agent selects the Cmd-based bindings; everything else gets Ctrl). Two tempting shortcuts get
// this wrong, and both are host-derived:
//
//   process.platform === "darwin" ? "Meta" : "Control"   // the Node process, not the browser
//   page.keyboard.press("ControlOrMeta+…")               // Playwright resolves it per HOST OS
//
// On a macOS host they both press Meta. That happens to match Chromium (which advertises
// Macintosh), which is why the mistake survived: every E2E lane ran Chromium only. Playwright's
// Firefox build does not advertise Macintosh, so Monaco binds Ctrl there — the Meta chord reaches
// nothing, and the failure is SILENT rather than loud: a "select all" that selects nothing makes
// the next `insertText` APPEND instead of replace. That is exactly how the release smoke's
// `replaceMonacoText` produced a four-line buffer from a two-line one on Firefox, and the test then
// failed far away with a strict-mode violation ("resolved to 2 elements") that named neither the
// chord nor the platform.
//
// Deriving the chord from `navigator.userAgent` inside the page asks the same question Monaco
// asks, so it is correct on every engine and on every host — including a Windows runner, where
// both the old and the new expression yield Control but only this one does so for the right reason.
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

/**
 * Replaces the whole editor buffer with `text` — the engine-agnostic version of the
 * click-selectAll-insert dance that several specs previously each carried their own copy of.
 * Verifies that the select-all actually took effect, so a chord that silently reaches nothing
 * fails HERE with a clear message instead of corrupting the buffer for a later assertion.
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
  // The buffer must now BE the text, not contain it twice. Monaco renders non-breaking spaces and
  // virtualises long files, so this compares the trimmed first line rather than the whole buffer.
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine.length > 0) {
    await expect(async () => {
      const lines = await editorWindow.locator(".view-line").allInnerTexts();
      const matches = lines.filter((line) => line.replace(/\u00a0/gu, " ").trim() === firstLine);
      expect(
        matches.length,
        `expected exactly one "${firstLine}" line after replacing the buffer`,
      ).toBe(1);
    }).toPass({ timeout: 10_000 });
  }
}
