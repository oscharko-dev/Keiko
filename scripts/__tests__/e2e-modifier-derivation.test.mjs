// The keyboard modifier in an E2E chord must never be derived from `process.platform`.
//
// Two different questions hide behind one expression, and the Node host answers neither:
//
//   Monaco            binds from `navigator.userAgent`, which this suite's device presets FORCE to
//                     "Windows NT 10.0" on every host -> it listens for Ctrl.  Correct helper:
//                     `editorModifier(page)` from tests/e2e/support/editor-chord.ts.
//   Keiko's shortcuts bind from `navigator.platform`, which the presets do NOT override -> on a Mac
//                     it still reads "MacIntel" and listens for Meta.  Correct spelling:
//                     Playwright's own host-derived "ControlOrMeta".
//
// `process.platform === "darwin" ? "Meta" : "Control"` is byte-for-byte what "ControlOrMeta"
// resolves to, so on a PRODUCT surface it is merely an obfuscated spelling — but on a MONACO
// surface it is a live defect, and the expression itself cannot tell a reader which was meant.
// Banning it forces the author to state the question. Measured on a macOS host under this suite's
// own preset, before the fix (PR #3355):
//
//   process.platform            = "darwin"        -> the expression yields "Meta"
//   navigator.userAgent         = "... Windows NT 10.0 ..."   -> Monaco waits for Ctrl
//   navigator.platform          = "MacIntel"                  -> the product waits for Meta
//   Meta+KeyF    -> Monaco find widgets visible: 0     Control+KeyF -> 1
//   Meta+KeyA  + insertText -> buffer APPENDED         Control+KeyA + insertText -> REPLACED
//
// CI is Linux, so it resolved to "Control" and stayed green by accident while every macOS
// developer measured a different scenario than the one the evidence describes.
//
// This test lives under scripts/__tests__/ deliberately: that directory is excluded from
// D12_MEASUREMENT_TOOLCHAIN_PATHS, so the guard can be edited without forcing a full
// reference-container re-measurement of the very files it guards.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const E2E_ROOT = join(repoRoot, "tests", "e2e");

// A directory tree this small is worth walking exactly rather than approximating with a glob.
function typeScriptFilesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...typeScriptFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

// Comments carry the explanation of WHY the banned form is banned — including inside
// editor-chord.ts, which quotes it verbatim — so they must not themselves register as violations.
// Replacing each comment with an equal number of newlines keeps line numbers exact for the report.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, ""))
    .replace(/(^|[^:])\/\/[^\n]*/gu, (_match, lead) => lead);
}

// A violation is a `process.platform` read whose expression also produces a "Meta" modifier. The
// window is what makes this shape-agnostic: it catches the ternary, the reversed ternary, a
// hoisted `const MODIFIER = ...`, and a multi-line prettier reflow of any of them — while leaving
// an unrelated platform read (dapOperatorProvisioning's Bubblewrap check) alone.
const WINDOW = 200;

function violationsIn(source) {
  const code = stripComments(source);
  const violations = [];
  for (const match of code.matchAll(/process\.platform/gu)) {
    const from = match.index ?? 0;
    const window = code.slice(from, from + WINDOW);
    if (!/["']Meta["']/u.test(window)) continue;
    violations.push({ line: code.slice(0, from).split("\n").length });
  }
  return violations;
}

function scanRepository() {
  const files = typeScriptFilesUnder(E2E_ROOT);
  const findings = [];
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      // An input the guard cannot read is a finding, never a skip: silently passing over it would
      // remove the guard for exactly the file that resisted inspection.
      findings.push(`${relative(repoRoot, file)}: unreadable (${String(error)})`);
      continue;
    }
    for (const violation of violationsIn(source)) {
      findings.push(`${relative(repoRoot, file)}:${String(violation.line)}`);
    }
  }
  return { fileCount: files.length, findings };
}

describe("E2E keyboard modifiers are derived from the browser, never from the Node host", () => {
  const scan = scanRepository();

  it("scans the real suite and finds no host-derived modifier", () => {
    expect(
      scan.findings,
      "Derive the chord modifier from the surface it targets, not from process.platform:\n" +
        "  Monaco chord   -> `await editorModifier(page)` (tests/e2e/support/editor-chord.ts)\n" +
        '  Keiko shortcut -> "ControlOrMeta"\n' +
        "See tests/e2e/support/editor-chord.ts for why the two disagree under the device presets.",
    ).toEqual([]);
  });

  // Without this the suite above would keep passing if the walker silently stopped finding files.
  it("actually walked the suite", () => {
    expect(scan.fileCount).toBeGreaterThan(100);
    expect(typeScriptFilesUnder(E2E_ROOT).map((f) => relative(repoRoot, f))).toContain(
      "tests/e2e/editor-performance.spec.ts",
    );
  });

  // The three shapes that were actually in the tree before this guard, plus two the fix could
  // regress into. Each must be REJECTED, or the guard above is decoration.
  it.each([
    ["inline ternary", 'const modifier = process.platform === "darwin" ? "Meta" : "Control";'],
    ["hoisted constant", 'const MODIFIER = process.platform === "darwin" ? "Meta" : "Control";'],
    ["reversed ternary", 'const m = process.platform !== "darwin" ? "Control" : "Meta";'],
    [
      "prettier reflow",
      'const modifier =\n  process.platform === "darwin"\n    ? "Meta"\n    : "Control";',
    ],
    [
      "pressed inline",
      'await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+KeyA`);',
    ],
  ])("rejects a host-derived modifier: %s", (_label, source) => {
    expect(violationsIn(source)).not.toEqual([]);
  });

  // The counterpart: the two sanctioned spellings, and the one legitimate platform read in the
  // suite, must all pass. A guard that also rejects the correct answer teaches authors to bypass it.
  it.each([
    ["editorModifier for a Monaco chord", "const modifier = await editorModifier(page);"],
    ["ControlOrMeta for a product chord", 'await page.keyboard.press("ControlOrMeta+Shift+KeyP");'],
    ["an unrelated platform read", 'if (process.platform !== "linux") return skipReason;'],
    [
      "the banned form quoted in a comment",
      '// process.platform === "darwin" ? "Meta" : "Control"',
    ],
    [
      "the banned form inside a block comment",
      '/**\n * process.platform === "darwin" ? "Meta" : "Control"\n */',
    ],
  ])("accepts %s", (_label, source) => {
    expect(violationsIn(source)).toEqual([]);
  });

  it("reports the line number of the violation it found", () => {
    const source =
      'const a = 1;\nconst b = 2;\nconst m = process.platform === "darwin" ? "Meta" : "Control";';
    expect(violationsIn(source)).toEqual([{ line: 3 }]);
  });
});
