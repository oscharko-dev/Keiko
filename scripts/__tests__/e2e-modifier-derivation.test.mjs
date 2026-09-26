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

// The ban above answers "is the modifier host-derived" and stops there — it says nothing about
// WHICH of the two sanctioned forms belongs at a given call site (IDX65, PR #3355 review). That gap
// is real: `editorModifier(page)` reads the BROWSER's userAgent (right for a Monaco chord, wrong for
// a product one — the device presets force Windows, so it would send Control to a product shortcut
// waiting for Meta on a Mac), and "ControlOrMeta" resolves per HOST OS (right for a product chord,
// wrong for Monaco — on a macOS host it sends Meta while the page still reports Windows and Monaco
// only binds Ctrl). Both are internally well-formed and neither trips the process.platform ban, so a
// swap between them is a silent, macOS-only-reproducible failure — the exact class already fixed
// three times this round, at multi-root-search-2526.spec.ts, workspace-search-2090.spec.ts and
// workspace-trust-2523.spec.ts (all product surfaces that had wrongly used `editorModifier`).
//
// This pairs each sanctioned form's call site against CODE-LEVEL markers — real locator strings,
// accessible names, helper calls — that name which surface the chord actually targets. Markers are
// matched on the comment-STRIPPED source deliberately: the illustrative anti-pattern examples in
// this file's and editor-chord.ts's own prose (`page.keyboard.press("ControlOrMeta+…")` as a
// documented WRONG example) would otherwise register as false "product" context around a genuine
// Monaco call site. A window (not a full function-boundary parse — this file has no TS parser
// available) around each site keeps the check cheap; because a real call site always carries at
// least one marker of its OWN domain nearby, a same-domain marker from an adjacent function bleeding
// into the window can only ADD a suppressing marker, never fabricate a violation — false negatives
// are possible (a future call site with no nearby marker at all goes unchecked), false positives on
// the current tree are not (proven by the zero-violation scan below).
const MONACO_CODE_MARKERS = [
  ".monaco-editor",
  ".monaco-hover",
  ".monaco-resizable-hover",
  ".monaco-diff-editor",
  "EDITOR_SELECTORS.monaco",
  ".find-widget",
  "focusMonacoInput(",
  "selectAllInEditor(",
  "replaceEditorBuffer(",
  "cursorTop",
  "cursorBottom",
  ".view-line",
  "native-edit-context",
  "textarea.inputarea",
];

const PRODUCT_CODE_MARKERS = [
  "quick-access",
  "Quick access",
  "Command query",
  "runPaletteCommand(",
  "searchbox",
  "Search files and symbols",
  'data-window-id="search"',
  "Open quick access",
  "UnifiedQuickAccessPalette",
  "workspace file or symbol query",
];

const PAIRING_WINDOW = 500;

function hasMarker(text, markers) {
  return markers.some((marker) => text.includes(marker));
}

function windowAround(code, index, radius) {
  return code.slice(Math.max(0, index - radius), Math.min(code.length, index + radius));
}

// A hoisted `const NAME = "...ControlOrMeta...";` (workspace-search-2090's SHELL_CHORD_MODIFIER,
// editor-run-verification-2215's PALETTE_CHORD) puts the literal at ONE declaration but the risk of
// a future swap lives at every place the name is actually pressed — so each reference becomes its
// own pairing site, not just the declaration.
function hoistedControlOrMetaNames(code) {
  const names = new Set();
  for (const match of code.matchAll(
    /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"[^"]*ControlOrMeta[^"]*"/gu,
  )) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

function pairingSites(code) {
  const sites = [];
  for (const match of code.matchAll(/editorModifier\(page\)/gu)) {
    sites.push({ index: match.index ?? 0, kind: "monaco" });
  }
  for (const match of code.matchAll(/ControlOrMeta/gu)) {
    sites.push({ index: match.index ?? 0, kind: "product" });
  }
  for (const name of hoistedControlOrMetaNames(code)) {
    for (const match of code.matchAll(new RegExp(`\\b${name}\\b`, "gu"))) {
      const index = match.index ?? 0;
      const lineStart = code.lastIndexOf("\n", index) + 1;
      const lineEnd = code.indexOf("\n", index);
      const line = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd);
      // The declaration line itself already produced a "product" site from the literal
      // "ControlOrMeta" match above; counting the name there too would double-count one location.
      if (/^\s*const\s/u.test(line)) continue;
      sites.push({ index, kind: "product" });
    }
  }
  return sites;
}

/**
 * Findings where the sanctioned form used at a call site disagrees with the surface markers found
 * in its surrounding window: `editorModifier` with only product markers nearby, or "ControlOrMeta"
 * with only Monaco markers nearby. Exported implicitly via the describe block below for reuse by its
 * own fixtures.
 */
function pairingViolationsIn(source) {
  const code = stripComments(source);
  const violations = [];
  for (const site of pairingSites(code)) {
    const window = windowAround(code, site.index, PAIRING_WINDOW);
    const wrongDomainPresent =
      site.kind === "monaco"
        ? hasMarker(window, PRODUCT_CODE_MARKERS) && !hasMarker(window, MONACO_CODE_MARKERS)
        : hasMarker(window, MONACO_CODE_MARKERS) && !hasMarker(window, PRODUCT_CODE_MARKERS);
    if (wrongDomainPresent) {
      violations.push({ line: code.slice(0, site.index).split("\n").length, kind: site.kind });
    }
  }
  return violations;
}

function scanPairingAcrossRepository() {
  const files = typeScriptFilesUnder(E2E_ROOT);
  const findings = [];
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      findings.push(`${relative(repoRoot, file)}: unreadable (${String(error)})`);
      continue;
    }
    for (const violation of pairingViolationsIn(source)) {
      findings.push(
        `${relative(repoRoot, file)}:${String(violation.line)} (${violation.kind} call site paired with the wrong surface)`,
      );
    }
  }
  return findings;
}

describe("editorModifier is paired with Monaco surfaces, ControlOrMeta with product surfaces", () => {
  it("scans the real suite and finds no swapped pairing", () => {
    expect(scanPairingAcrossRepository()).toEqual([]);
  });

  // Reproduces, as a minimal synthetic fixture, the exact bug class already fixed three times this
  // round (multi-root-search-2526.spec.ts, workspace-search-2090.spec.ts, workspace-trust-2523.spec.ts):
  // a PRODUCT chord (recognizable by its "Command query" combobox / quick-access surface) wrongly
  // reading the browser-derived helper instead of the host-derived shorthand.
  it("flags editorModifier reintroduced at a product call site", () => {
    const source = `
      async function openCommandPalette(page) {
        const modifier = await editorModifier(page);
        await page.keyboard.press(\`\${modifier}+Shift+KeyP\`);
        const combobox = page.getByRole("combobox", { name: "Command query" });
        await expect(combobox).toBeVisible();
      }
    `;
    const violations = pairingViolationsIn(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((violation) => violation.kind === "monaco")).toBe(true);
  });

  // The mirror image: a MONACO chord (recognizable by `.monaco-editor`) wrongly reading the
  // host-derived shorthand instead of the browser-derived helper — the ORIGINAL host-derived-modifier
  // defect class this file's process.platform ban exists for, spelled with the other sanctioned form.
  it("flags ControlOrMeta reintroduced at a Monaco call site", () => {
    const source = `
      async function selectAllInFile(page, editorWindow) {
        const editor = editorWindow.locator(".monaco-editor").first();
        await editor.click();
        await page.keyboard.press("ControlOrMeta+KeyA");
      }
    `;
    const violations = pairingViolationsIn(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((violation) => violation.kind === "product")).toBe(true);
  });

  // The counterpart: both correctly-paired forms must NOT be flagged, or the guard would teach
  // authors to route around it.
  it.each([
    [
      "editorModifier at a Monaco call site",
      `async function selectAllInFile(page, editorWindow) {
         const editor = editorWindow.locator(".monaco-editor").first();
         await editor.click();
         const modifier = await editorModifier(page);
         await page.keyboard.press(\`\${modifier}+KeyA\`);
       }`,
    ],
    [
      "ControlOrMeta at a product call site",
      `async function openCommandPalette(page) {
         await page.keyboard.press("ControlOrMeta+Shift+KeyP");
         const combobox = page.getByRole("combobox", { name: "Command query" });
         await expect(combobox).toBeVisible();
       }`,
    ],
  ])("does not flag %s", (_label, source) => {
    expect(pairingViolationsIn(source)).toEqual([]);
  });
});
