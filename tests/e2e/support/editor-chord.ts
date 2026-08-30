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
 * Presses the editor's select-all chord and waits for the page to settle, so a caller can follow
 * it with `insertText` and REPLACE the buffer rather than append to it.
 */
export async function selectAllInEditor(page: Page): Promise<void> {
  await pressChord(page, await editorModifier(page));
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
 * The replacement postcondition, as a pure function so it can be tested against fixtures instead of
 * only against a live editor. Returns the reasons the rendered buffer is NOT a clean replacement of
 * `staleLines` by `text`; an empty array means it is.
 *
 * Three things must hold, and the first two were missing (PR #3355 review, P2). The old check asked
 * only "does no expected line appear more often than expected, and does the first one appear at
 * all", which accepted both corruptions it claimed to catch:
 *
 *   expected ["new"]  actual ["old", "new"]  -> "new" appears once, "new" is present  => PASSED
 *   expected ["new"]  actual [""]            -> `"new".startsWith("")` is true        => PASSED
 *
 * so a select-all that reached nothing could leave stale content, and one that wiped the buffer
 * without inserting could leave it empty, and neither failed here.
 */
export function replacementViolations(
  expected: readonly string[],
  actual: readonly string[],
  staleLines: readonly string[],
): readonly string[] {
  const violations: string[] = [];
  const rendered = JSON.stringify(actual);
  const meaningful = expected.filter((line) => line !== "");
  if (meaningful.length === 0) {
    const leftovers = actual.filter((line) => line !== "");
    if (leftovers.length > 0) violations.push(`expected an empty buffer, got ${rendered}`);
    return violations;
  }
  // 1. No line may appear MORE often than it was inserted. Counted against the expected
  //    multiplicity, not against 1: a fixture may legitimately repeat a line ("same\nsame" renders
  //    two), and demanding at most one would fail a correct replacement.
  for (const line of new Set(meaningful)) {
    const allowed = expected.filter((candidate) => candidate === line).length;
    const seen = actual.filter((candidate) => candidate === line).length;
    if (seen > allowed) {
      violations.push(`"${line}" appears ${String(seen)}x, at most ${String(allowed)}x expected`);
    }
  }
  // 2. No line that was in the buffer BEFORE may survive unless the new text also contains it. This
  //    is the stale-content half, and it needs the pre-replacement snapshot: without it there is no
  //    way to tell "old buffer" from a line the caller legitimately inserted. Preferred over
  //    asserting an empty buffer right after Backspace, which would add a round-trip inside the
  //    gesture and race Monaco's ghost text.
  for (const line of new Set(staleLines.filter((candidate) => candidate !== ""))) {
    if (expected.includes(line)) continue;
    if (actual.includes(line)) violations.push(`stale line "${line}" survived the replacement`);
  }
  // 3. The buffer must actually carry the new text. `startsWith` in BOTH directions tolerates
  //    Monaco replacing a rendered line with an inline completion (ghost text), which is why this
  //    is not an equality check — but an empty rendered line is not a truncation of anything, and
  //    accepting it is what let a wiped-and-not-reinserted buffer pass.
  const anchor = meaningful[0] ?? "";
  const carried = actual.some(
    (line) => line !== "" && (line.startsWith(anchor) || anchor.startsWith(line)),
  );
  if (!carried) violations.push(`expected the buffer to contain "${anchor}", got ${rendered}`);
  return violations;
}

async function renderedLines(editorWindow: Locator): Promise<readonly string[]> {
  return (await editorWindow.locator(".view-line").allInnerTexts()).map(normalizeEditorLine);
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
  // Snapshot BEFORE the gesture: this is what makes "stale content survived" decidable at all.
  const staleLines = await renderedLines(editorWindow);
  await selectAllInEditor(page);
  // Delete the selection with a REAL key event before inserting. `insertText` does not send key
  // events — it hands the text to the engine's input pipeline — and whether that replaces an
  // existing selection is engine-dependent: Chromium replaces, Firefox inserts at the caret and
  // leaves the selected text in place, which is what doubled the buffer. Backspace on a selection
  // is unambiguous in both.
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(text);
  const expectedLines = normalizedEditorLines(text);
  await expect(async () => {
    const violations = replacementViolations(
      expectedLines,
      await renderedLines(editorWindow),
      staleLines,
    );
    expect(violations, violations.join("; ")).toEqual([]);
  }).toPass({ timeout: 10_000 });
}
