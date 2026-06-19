// Keiko Editor bundle-size gate (Issue #1207; ADR-0042 D3.6).
//
// ADR-0042 D3.6 sets the editor performance budgets and assigns #1207 to "measure and enforce" them
// while #1209 "records release evidence". This gate enforces the parts that regress deterministically
// in this repo, without a full browser build:
//
//   1. Editor own-code gzip ceiling — the compiled `@oscharko-dev/keiko-editor` `dist/**/*.js` stays
//      under a committed gzip ceiling. This catches the headline regression (Monaco or another heavy
//      dependency accidentally bundled into the editor package's own code).
//   2. Monaco version pin — `monaco-editor` stays at the pinned version the ≤ 2.5 MB-gzip lazy
//      runtime budget was measured against, so the runtime footprint cannot drift unmeasured.
//   3. First-load code-split isolation — `monaco-editor` / `@monaco-editor/react` are value-imported
//      only by the allow-listed client-only runtime module(s), which are reached solely through the
//      host's `next/dynamic(..., { ssr: false })` boundary. This is the source-level guarantee behind
//      the "0 bytes gzip of Monaco/editor code in first-load JavaScript" budget.
//
// The ≤ 2.5 MB-gzip lazy editor + Monaco total and the ≤ 750 KB-gzip per-worker-chunk budgets are
// measured against the real production bundle as release evidence by #1209 (gzipping individual ESM
// source files is not a faithful proxy for a tree-shaken, minified chunk).
//
// The pure helpers are exported and unit-tested (scripts/__tests__/editor-bundle-size.test.mjs)
// without filesystem or build state; the runner does the I/O and is invoked from
// `scripts/check-package-surface.mjs` and `npm run check:editor-bundle-size`.

import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Pure helpers (no I/O) ───────────────────────────────────────────────────────────────────────

/** Gzip-compressed byte length of a buffer/string at maximum compression (deterministic). */
export function gzipSizeBytes(content) {
  return gzipSync(content, { level: 9 }).length;
}

/**
 * Evaluate the editor own-code gzip budget. `files` is a list of `{ path, gzipBytes }`; the total is
 * compared against `ceilingBytes`. Pure: the caller reads and gzips the files.
 */
export function evaluateOwnCodeBudget({ files, ceilingBytes }) {
  const totalGzipBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);
  return {
    fileCount: files.length,
    totalGzipBytes,
    ceilingBytes,
    ok: totalGzipBytes <= ceilingBytes,
  };
}

/** True when an import specifier resolves to the `monaco-editor` package or any of its subpaths. */
export function isMonacoSpecifier(specifier) {
  return (
    specifier === "monaco-editor" ||
    specifier.startsWith("monaco-editor/") ||
    specifier === "@monaco-editor/react" ||
    specifier.startsWith("@monaco-editor/react/")
  );
}

// Matches a value (non-type) import/export/dynamic-import/require of a string-literal specifier.
// `import type ... from` / `export type ... from` are excluded so type-only references — which emit no
// runtime code and never reach a bundle — do not count as first-load value imports.
const VALUE_IMPORT_PATTERNS = [
  /(?<!\btype\s)\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /^\s*import\s+["']([^"']+)["']/gm,
];

/**
 * Extract the value-import specifiers from a source string. Type-only imports (`import type … from`,
 * `export type … from`) are skipped. Best-effort and dependency-free (no TS program needed); the gate
 * uses it only to locate Monaco value imports, and the result is asserted against an allow-list.
 */
export function extractValueImportSpecifiers(source) {
  const specifiers = new Set();
  // Drop `import type`/`export type` clauses so their `from "x"` does not match the generic pattern.
  const withoutTypeOnly = source
    .replace(/\bimport\s+type\b[^;]*?;/g, ";")
    .replace(/\bexport\s+type\b[^;]*?;/g, ";");
  for (const pattern of VALUE_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(withoutTypeOnly);
    while (match !== null) {
      specifiers.add(match[1]);
      match = pattern.exec(withoutTypeOnly);
    }
  }
  return [...specifiers];
}

/**
 * Given source descriptors (`{ path, specifiers }`) and an allow-list of paths permitted to value-
 * import Monaco, return the descriptors that import Monaco but are not allow-listed. An empty result
 * means the first-load code-split isolation holds.
 */
export function findUnexpectedMonacoImporters({ sources, allowlist }) {
  const allowed = new Set(allowlist);
  return sources
    .filter((source) => source.specifiers.some(isMonacoSpecifier))
    .filter((source) => !allowed.has(source.path))
    .map((source) => source.path);
}

// ─── Runner (I/O) ─────────────────────────────────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function isTestPath(path) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.includes("/__tests__/");
}

function walkFiles(dir, predicate) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, predicate));
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function measureOwnCode(repoRoot, ceilingBytes) {
  const distDir = join(repoRoot, "packages", "keiko-editor", "dist");
  const jsFiles = walkFiles(distDir, (p) => p.endsWith(".js"));
  const files = jsFiles.map((path) => ({
    path,
    gzipBytes: gzipSizeBytes(readFileSync(path)),
  }));
  return evaluateOwnCodeBudget({ files, ceilingBytes });
}

function assertMonacoVersionPin(repoRoot, expectedVersion, fail) {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "packages", "keiko-editor", "package.json"), "utf8"),
  );
  const actual = manifest.dependencies?.["monaco-editor"];
  if (actual !== expectedVersion) {
    fail(
      `monaco-editor is pinned at ${String(actual)} but the bundle-size budget was measured against ` +
        `${expectedVersion} (scripts/editor-bundle-size.budget.json). Re-measure the runtime footprint ` +
        "and update the budget + docs/keiko-editor/1207-performance-budgets.md before changing the pin.",
    );
  }
}

function checkFirstLoadIsolation(repoRoot, allowlist, fail) {
  const uiSrc = join(repoRoot, "packages", "keiko-ui", "src");
  const sourceFiles = walkFiles(
    uiSrc,
    (p) => SOURCE_EXTENSIONS.has(p.slice(p.lastIndexOf("."))) && !isTestPath(p),
  );
  const sources = sourceFiles.map((absolute) => ({
    // Normalise to a repo-relative POSIX path so it matches the budget allow-list regardless of how
    // `repoRoot` was passed (trailing slash, absolute vs. cwd).
    path: relative(repoRoot, absolute).split(sep).join("/"),
    specifiers: extractValueImportSpecifiers(readFileSync(absolute, "utf8")),
  }));
  const unexpected = findUnexpectedMonacoImporters({ sources, allowlist });
  if (unexpected.length > 0) {
    fail(
      "Monaco is value-imported outside the allow-listed client-only runtime module(s), which breaks " +
        "the 0-bytes-in-first-load code-split budget (ADR-0042 D3.6). Offenders:\n  " +
        unexpected.join("\n  ") +
        "\nMonaco may only be value-imported behind the host's next/dynamic(ssr:false) boundary; " +
        "update editor-bundle-size.budget.json `monacoFirstLoadValueImporters` only with a documented reason.",
    );
  }
  // Guard the allow-list itself against rot: an allow-listed path that no longer imports Monaco means
  // the contract drifted and the allow-list should shrink.
  const allowlistImporters = new Set(
    sources.filter((s) => s.specifiers.some(isMonacoSpecifier)).map((s) => s.path),
  );
  for (const allowed of allowlist) {
    if (!allowlistImporters.has(allowed)) {
      fail(
        `editor-bundle-size.budget.json allow-lists ${allowed} as a Monaco value-importer, but it no ` +
          "longer imports Monaco. Remove the stale allow-list entry.",
      );
    }
  }
}

export function runEditorBundleSizeCheck({ repoRoot, fail, log, budget: budgetOverride } = {}) {
  const root = repoRoot ?? process.cwd();
  const onFail =
    fail ??
    ((message) => {
      console.error(`editor-bundle-size check failed: ${message}`);
      process.exit(1);
    });
  const onLog = log ?? ((message) => console.log(message));

  // `budget` is normally read from the committed budget file; tests may inject an override to exercise
  // the failure paths (over-ceiling, version-pin drift, stale allow-list) without mutating the repo.
  const budget =
    budgetOverride ??
    JSON.parse(readFileSync(join(root, "scripts", "editor-bundle-size.budget.json"), "utf8"));

  const ownCode = measureOwnCode(root, budget.editorOwnCodeGzipBytesCeiling);
  if (!ownCode.ok) {
    onFail(
      `editor own-code gzip footprint ${String(ownCode.totalGzipBytes)} B exceeds the ceiling ` +
        `${String(ownCode.ceilingBytes)} B across ${String(ownCode.fileCount)} dist files. ` +
        "Investigate the growth (a heavy dependency bundled into the editor package?) before raising " +
        "the ceiling in scripts/editor-bundle-size.budget.json.",
    );
  }

  assertMonacoVersionPin(root, budget.monacoEditorPinnedVersion, onFail);
  checkFirstLoadIsolation(root, budget.monacoFirstLoadValueImporters, onFail);

  onLog(
    `editor-bundle-size check passed: own-code gzip ${String(ownCode.totalGzipBytes)} B / ` +
      `${String(ownCode.ceilingBytes)} B ceiling (${String(ownCode.fileCount)} dist files); ` +
      `monaco-editor pinned at ${budget.monacoEditorPinnedVersion}; first-load Monaco isolation holds.`,
  );
  return ownCode;
}

// Run when invoked directly (`node scripts/editor-bundle-size.mjs`), not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEditorBundleSizeCheck();
}
