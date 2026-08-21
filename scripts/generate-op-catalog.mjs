#!/usr/bin/env node
// Activity-log op catalog generator (epic #2902, w1-op-catalog).
//
// Keiko's activity log is a machine-reconstruction contract: an autonomous agent replays a
// customer defect from an exported `server.log`, and the `op` field is the vocabulary it greps
// and pattern-matches against. A hand-maintained list of that vocabulary would drift the moment a
// new instrumentation site landed without updating it — exactly the failure
// `route-template.test.ts` already guards against for route literals (see AGENTS.md §7, "a
// fixture never restates a formula the code under test owns"). This generator DERIVES the
// vocabulary from the instrumentation sites instead, so `docs/observability/op-catalog.generated.json`
// is checked-in, generated output pinned by a drift test, never a restated copy.
//
// TWO SHAPES AN OP LITERAL TAKES IN THIS CODEBASE, BOTH HANDLED:
//   1. An object-literal property: `{ category: "gateway", op: "gateway.retry.scheduled", ... }`.
//      Most call sites in packages/keiko-server and packages/keiko-local-knowledge use this shape
//      directly against a logger (`log.warn({ op: "...", ... })`).
//   2. A positional argument to a small helper that builds the event object internally, e.g.
//      `gatewayEvent(level, op, correlationId, extra)` in packages/keiko-model-gateway/src/gateway.ts.
//      Most of packages/keiko-model-gateway uses this shape. A helper not listed in
//      POSITIONAL_OP_HELPERS below is invisible to this generator — promote it there, never infer
//      it dynamically, so the table stays an auditable, checked-in fact rather than a guess.
//
// WHAT THIS DELIBERATELY DOES NOT DO: parse a full TypeScript AST. A bracket-depth-aware scan
// (splitTopLevelArgs / readValueSpan below) is enough to find the `op` argument or property
// reliably in a codebase this consistently formatted (Prettier, one property per line). When an
// `op` value is neither a string literal nor a two-literal ternary — a template string, a member
// expression, a plain identifier — the generator does not guess: it records `op: "<dynamic>"` at
// that site, so the catalog stays honest about what it cannot enumerate rather than silently
// omitting the site or fabricating a value.
//
// THREE TIERS RESOLVE AN ENTRY'S `category`, IN ORDER:
//   1. Sibling property (findSiblingCategory): a `category: "literal"` a few lines above or below
//      the `op:` property, inside the SAME object literal — the common case.
//   2. Positional-helper category (POSITIONAL_OP_HELPERS): the helper's own table entry names a
//      fixed category, for a call site that never carries one itself (§ shape 2 above).
//   3. File-level category binding (fileCategoryBinding, #2902): some instrumentation sites bind
//      `category` upstream of every `op:` call in the file rather than repeating it at each site —
//      a `.child({ category: "…" })` construction whose returned logger every call site reuses
//      (`local-knowledge-handlers.ts`'s `indexingRouteLog`), or a small wrapper function that
//      hardcodes `category` in its own body before forwarding to the sink
//      (`embedding-batcher.ts`'s `logEmbedding`). Neither shape puts `category` anywhere near the
//      `op:` property, so tiers 1 and 2 cannot see it. When every OTHER `category: "literal"` in
//      the file (comments excluded) agrees on exactly one distinct value, that value is attributed
//      to every remaining "unknown" entry in the same file. When the file contains several
//      distinct values (e.g. `orchestrator.ts` binds both "indexing" and "embedding" depending on
//      the call path) or none at all, there is no single safe answer — every entry stays "unknown"
//      rather than guessed. This tier is deliberately whole-file and deliberately conservative:
//      it trades recall for the guarantee that an attributed category is never a guess.
//
// Exported as `generateOpCatalog()` so scripts/__tests__/op-catalog-drift.test.mjs can regenerate
// in memory and pin it against the checked-in file, and `OP_NAME_PATTERN` so both this generator
// and any future runtime-adjacent check share one definition of a well-formed op name.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main-module.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const OUTPUT_RELATIVE_PATH = "docs/observability/op-catalog.generated.json";

// A well-formed op: lowercase dot-separated segments, each starting with a letter, hyphens
// allowed within a segment, at most 6 segments and 32 characters per segment. Verified against
// every literal this generator currently extracts (58 distinct `op:` object-literal literals plus
// every positional-helper literal) before being enforced — see the generator's own violations
// output rather than a hand-picked example set.
export const OP_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31}){0,5}$/;

// Package src roots this generator walks, in the order their entries appear when unsorted (the
// catalog itself is sorted by package/op/site, so this order is cosmetic).
const SCANNED_PACKAGE_ROOTS = [
  "packages/keiko-server/src",
  "packages/keiko-model-gateway/src",
  "packages/keiko-local-knowledge/src",
  "packages/keiko-harness/src",
  "packages/keiko-security/src",
  "packages/keiko-memory-consolidation/src",
  "packages/keiko-cli/src",
];

// Explicit, checked-in table of helper functions/methods whose `op` is a positional argument
// rather than a named object-literal property. Discovered by grepping each scanned package for a
// function accepting an `op: string` parameter (or, for `note`, a returned closure whose type
// annotation does — see the comment on that entry). `argIndex` is 0-based over the call's
// arguments. `file` scopes the match to one file when the identifier is common enough to collide
// (`this.emit`, `note`); omit it when the helper name is unique across the scanned packages.
const POSITIONAL_OP_HELPERS = [
  // gatewayEvent(level, op, correlationId, extra, durationMs?, errorKind?) — category is hardcoded
  // "gateway" in the function body (`return { level, category: "gateway", op, ... }`).
  { name: "gatewayEvent", argIndex: 1, category: "gateway" },
  // retryEvent(context, level, op, durationMs, error, extra) — category hardcoded "gateway".
  { name: "retryEvent", argIndex: 2, category: "gateway" },
  // CircuitBreaker#emit(level, op, extra, correlationId) — private method, category hardcoded
  // "gateway"; scoped to resilience.ts because `emit` alone is a common identifier.
  {
    name: "this.emit",
    argIndex: 1,
    category: "gateway",
    file: "packages/keiko-model-gateway/src/resilience.ts",
  },
  // embeddingEvent(level, op, extra, status?, errorKind?) — category hardcoded "embedding".
  { name: "embeddingEvent", argIndex: 1, category: "embedding" },
  // logDispatch(log, op, fields) — forwards to embeddingEvent, category "embedding".
  { name: "logDispatch", argIndex: 1, category: "embedding" },
  // logLadderStop(log, request, op, completed, outcome) — category "embedding".
  { name: "logLadderStop", argIndex: 2, category: "embedding" },
  // degradeLogger(log, failure) returns a closure `(op, extra) => log.write(embeddingEvent(...))`
  // bound to a local `const note = degradeLogger(...)`; `note(...)` is where the four
  // "embedding.batch.degrade*"/"embedding.batch.degrading*" literals actually appear as
  // arguments. Scoped to this one file: `note` is too common an identifier to trust elsewhere.
  {
    name: "note",
    argIndex: 0,
    category: "embedding",
    file: "packages/keiko-model-gateway/src/openai-embedding-adapter.ts",
  },
  // logEmbeddingStoreRejected(op, error) — category hardcoded "memory".
  { name: "logEmbeddingStoreRejected", argIndex: 0, category: "memory" },
  // logEmbeddingRetry(options, outcome, op, durationMs, extra) — category "embedding" (via
  // logEmbedding's hardcoded category).
  { name: "logEmbeddingRetry", argIndex: 2, category: "embedding" },
  // logBatchClosed(options, level, op, counts) — category "embedding".
  { name: "logBatchClosed", argIndex: 2, category: "embedding" },
  // adoptPreflightIdentity(state, identity, op) — category "embedding" (via logEmbeddingRun's
  // hardcoded category).
  { name: "adoptPreflightIdentity", argIndex: 2, category: "embedding" },
];

function packageNameFromRoot(root) {
  const match = /^packages\/([^/]+)\/src$/.exec(root);
  if (match?.[1] === undefined) throw new Error(`Unexpected scanned root shape: ${root}`);
  return match[1];
}

// Recursively lists `.ts` source files under `dir`, skipping tests (co-located `*.test.ts` and
// any `__tests__` directory) — this generator catalogs instrumentation sites, not the fixtures
// that exercise them.
function walkTsFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir).sort((left, right) => left.localeCompare(right))) {
    if (name === "__tests__") continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

// Top-level `const UPPER_SNAKE_NAME = "literal";` declarations in a file, so an op that is
// referenced by a well-known constant (e.g. `LOG_FAILURE_NOTICE_OP`) resolves to its real literal
// instead of being reported as dynamic — the constant's value is exactly as static as an inline
// string, it is only spelled once.
function collectConstStrings(source) {
  const constMap = new Map();
  const pattern = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"\\]*)"\s*;/g;
  for (const match of source.matchAll(pattern)) {
    constMap.set(match[1], match[2]);
  }
  return constMap;
}

const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);

function depthDelta(ch) {
  if (OPEN_BRACKETS.has(ch)) return 1;
  if (CLOSE_BRACKETS.has(ch)) return -1;
  return 0;
}

// Scans `source` from `startIndex`, tracking bracket depth and string/template-literal spans (a
// backslash escape inside a string never ends it, and nothing inside a string ever changes
// depth), and returns the index of the first character for which `isStop(ch)` is true while at
// depth 0 outside any string. Shared by every extractor below, each of which only supplies a
// different `isStop` — the bracket/string bookkeeping (the part with real branching) is written
// exactly once, so no caller's own complexity carries it.
function scanBalanced(source, startIndex, isStop) {
  let depth = 0;
  let stringChar = null;
  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (stringChar !== null) {
      if (ch === "\\") i += 1;
      else if (ch === stringChar) stringChar = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      stringChar = ch;
      continue;
    }
    if (depth === 0 && isStop(ch)) return i;
    depth += depthDelta(ch);
  }
  return source.length;
}

// Finalizes the argument list at a call's closing paren: a non-empty last segment is a real
// argument; an empty one is either a genuine zero-argument call (nothing to push) or Prettier's
// trailing comma after the last real argument (already pushed by the comma branch above).
function endArgs(args, source, argStart, closeParenIndex) {
  const last = source.slice(argStart, closeParenIndex);
  if (last.trim().length > 0) args.push(last);
  return { args, endIndex: closeParenIndex };
}

const ARG_STOP = (ch) => ch === "," || ch === ")";

// Splits the arguments of a call whose `(` is at `openParenIndex`, respecting nested
// brackets/parens/braces and string/template literals so a multi-line call (this codebase's
// Prettier formatting breaks almost every helper call across several lines) is not misread as
// more arguments than it has. Returns the raw (untrimmed) argument text for each position.
function splitTopLevelArgs(source, openParenIndex) {
  const args = [];
  const argsStart = openParenIndex + 1;
  let argStart = argsStart;
  let cursor = argsStart;
  while (cursor < source.length) {
    const stopAt = scanBalanced(source, cursor, ARG_STOP);
    if (stopAt >= source.length) return { args, endIndex: source.length };
    if (source[stopAt] === ")") return endArgs(args, source, argStart, stopAt);
    args.push(source.slice(argStart, stopAt));
    argStart = stopAt + 1;
    cursor = argStart;
  }
  return { args, endIndex: source.length };
}

const VALUE_STOP = (ch) => ch === "," || ch === ";" || CLOSE_BRACKETS.has(ch);

// Reads a property/argument value starting at `startIndex`, stopping at the first top-level
// (depth-0) comma, closing brace/paren/bracket, or semicolon — the same bracket-depth scan as
// `splitTopLevelArgs`, but for a value that is not itself inside a call's argument list (an
// object-literal property, or a function parameter's type annotation).
function readValueSpan(source, startIndex) {
  return source.slice(startIndex, scanBalanced(source, startIndex, VALUE_STOP));
}

const SINGLE_LITERAL = /^"([^"\\]*)"$/;
const TERNARY_OF_LITERALS = /^[\s\S]+?\?\s*"([^"\\]*)"\s*:\s*"([^"\\]*)"\s*$/;
const CONST_IDENTIFIER = /^[A-Z][A-Z0-9_]*$/;

// Resolves a raw `op` expression (already trimmed) to the literal string(s) it can only ever be:
// a plain string, a ternary between two strings, or a reference to a well-known UPPER_SNAKE_CASE
// constant this generator already collected. Anything else (a member expression, a bare lowercase
// identifier, a function call, a template literal) is honestly dynamic — returns `null`.
function resolveLiteralValues(expr, constMap) {
  const single = SINGLE_LITERAL.exec(expr);
  if (single) return [single[1]];
  const ternary = TERNARY_OF_LITERALS.exec(expr);
  if (ternary) return [ternary[1], ternary[2]];
  if (CONST_IDENTIFIER.test(expr) && constMap.has(expr)) return [constMap.get(expr)];
  return null;
}

function lineOffsets(source) {
  const offsets = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

// Binary search for the 0-based line number containing `index`, given the offsets `lineOffsets`
// produced.
function lineNumberAt(offsets, index) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low;
}

function leadingWhitespace(line) {
  return /^\s*/.exec(line)[0];
}

// Tested against the TRIMMED line: a trailing `\s*` after `[)\s]*` would give the engine two
// overlapping ways to consume the same spaces, which is super-linear on a long whitespace run.
const CLOSING_BRACE_LINE = /^\}[)\s]*[,;]?$/;
const CATEGORY_LITERAL = /\bcategory\s*:\s*"([^"\\]*)"/;

// True when `line` is (only) a closing brace at shallower indentation than `indent` — the signal
// that the enclosing object literal has already ended, so anything further above it belongs to an
// unrelated statement and is not a candidate sibling.
function isShallowerClosingBrace(line, indent) {
  if (!CLOSING_BRACE_LINE.test(line.trim())) return false;
  return leadingWhitespace(line).length < indent.length;
}

function categoryLiteralIn(line) {
  return CATEGORY_LITERAL.exec(line)?.[1];
}

// Looks upward from `opLine` (inclusive) for a sibling `category: "literal"` — up to 6 lines,
// the object literal's other properties, since Prettier puts one property per line. Stops as
// soon as `isShallowerClosingBrace` says the enclosing object literal has already ended.
function categoryAbove(lines, opLine, opIndent) {
  for (let i = opLine; i >= Math.max(0, opLine - 6); i -= 1) {
    const line = lines[i] ?? "";
    if (i !== opLine && isShallowerClosingBrace(line, opIndent)) break;
    const found = categoryLiteralIn(line);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Rare shape: `category` declared after `op` in the same object literal. Two lines is enough for
// every real occurrence this generator has been checked against.
function categoryBelow(lines, opLine) {
  for (let i = opLine + 1; i <= Math.min(lines.length - 1, opLine + 2); i += 1) {
    const found = categoryLiteralIn(lines[i] ?? "");
    if (found !== undefined) return found;
  }
  return undefined;
}

// Looks for a sibling `category: "literal"` in the same object literal as the `op` on
// `lines[opLine]`, searching above first (the common shape) and then a short window below.
function findSiblingCategory(lines, opLine) {
  const opIndent = leadingWhitespace(lines[opLine] ?? "");
  return categoryAbove(lines, opLine, opIndent) ?? categoryBelow(lines, opLine);
}

// Removes `//` line comments and `/* … */` block comments from `source`, respecting string and
// template-literal spans exactly like `scanBalanced` (a comment marker inside a string is not a
// comment). Feeds only the file-level category-binding tier below: a doc comment illustrating a
// call shape (this very file's own header, or `server-logger.ts`'s `log.info({ category:
// "indexing", ... })` example) must never be mistaken for a real binding. Newlines inside a
// stripped block comment are preserved as newlines so line-oriented callers are unaffected; nothing
// here currently needs that, but it costs nothing and keeps this function safe to reuse later.
// One step of `stripComments`'s string/template-literal branch: an escape consumes and re-emits
// both characters (so an escaped quote never ends the string), the matching quote closes it,
// anything else is emitted unchanged. Returns the next index to resume scanning from.
function stepInsideString(source, index, stringChar, appendChar) {
  const ch = source[index];
  appendChar(ch);
  if (ch === "\\") {
    appendChar(source[index + 1] ?? "");
    return { index: index + 2, stringChar };
  }
  return { index: index + 1, stringChar: ch === stringChar ? null : stringChar };
}

// Skips a `//` line comment, emitting a single newline in its place so line-oriented callers are
// unaffected (none currently need that, but it costs nothing here).
function skipLineComment(source, index, appendChar) {
  let i = index;
  while (i < source.length && source[i] !== "\n") i += 1;
  appendChar("\n");
  return i;
}

// Skips a `/* … */` block comment, preserving every newline inside it so line numbers downstream
// of a stripped comment stay aligned.
function skipBlockComment(source, index, appendChar) {
  let i = index + 2;
  while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
    if (source[i] === "\n") appendChar("\n");
    i += 1;
  }
  return i + 2;
}

// Removes `//` line comments and `/* … */` block comments from `source`, respecting string and
// template-literal spans (a comment marker inside a string is not a comment). Each branch is its
// own function above; this loop only dispatches between them.
function stripComments(source) {
  let out = "";
  const appendChar = (text) => {
    out += text;
  };
  let stringChar = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (stringChar !== null) {
      ({ index: i, stringChar } = stepInsideString(source, i, stringChar, appendChar));
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      stringChar = ch;
      appendChar(ch);
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i = skipLineComment(source, i, appendChar);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i, appendChar);
      continue;
    }
    appendChar(ch);
    i += 1;
  }
  return out;
}

const FILE_CATEGORY_LITERAL_PATTERN = /\bcategory\s*:\s*"([^"\\]*)"/g;

// Tier 3 (see the header comment): the ONE category literal a file binds upstream of every `op:`
// call, when — and only when — the whole file (comments excluded) agrees on exactly one distinct
// value. Two or more distinct values, or none, return `undefined`, so the caller leaves those
// entries "unknown" rather than guessing which of several bindings applies to a given call site.
function fileCategoryBinding(source) {
  const distinct = new Set();
  for (const match of stripComments(source).matchAll(FILE_CATEGORY_LITERAL_PATTERN)) {
    distinct.add(match[1]);
  }
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

// Applies tier 3 to every "unknown" entry `entriesForFile` produced for one file, leaving every
// already-resolved entry (tiers 1 and 2) untouched.
function applyFileCategoryBindingTier(entries, source) {
  const binding = fileCategoryBinding(source);
  if (binding === undefined) return entries;
  return entries.map((entry) =>
    entry.category === "unknown" ? { ...entry, category: binding } : entry,
  );
}

// One extracted site, before the `package` field is attached by the caller.
function siteEntry(op, category, relPath, lineNumber) {
  return { op, category, site: `${relPath}:${lineNumber + 1}` };
}

// Scans one `op:` object-literal property match: skips TypeScript type annotations (`op: string`
// on a function parameter or interface field), otherwise resolves the value and emits one entry
// per resolved literal, or a single `<dynamic>` entry when the value cannot be enumerated.
function opPropertyEntries(source, lines, offsets, constMap, relPath, colonEnd) {
  const rawValue = readValueSpan(source, colonEnd);
  const value = rawValue.trim();
  if (value === "string" || value === "string | undefined") return [];
  const opLine = lineNumberAt(offsets, colonEnd);
  const category = findSiblingCategory(lines, opLine) ?? "unknown";
  const literals = resolveLiteralValues(value, constMap);
  if (literals === null) return [siteEntry("<dynamic>", category, relPath, opLine)];
  return literals.map((literal) => siteEntry(literal, category, relPath, opLine));
}

// Every `op:` object-literal property in `source`. The negative lookbehind — not merely `\b` —
// is required: a plain `\b` treats `-` as a non-word character, so `\bop\s*:` also matches the
// "op:" inside a prose comment's "no-op:" (a real false positive this generator hit against
// `nullKnowledgeLogSink`'s doc comment). Excluding a preceding word character OR hyphen rejects
// that compound word while still matching a standalone `op:` property. Separately, `op?:` (an
// optional interface field, none of which this codebase uses for a required `op`) never matches
// because `\s*` cannot consume the `?`, and the ES6-shorthand `op` (no colon at all) that every
// positional-helper's own `return { ..., op, ... }` uses is excluded because there is no colon —
// both are excluded for free by the pattern, not by an extra check.
function scanObjectLiteralOps(source, lines, offsets, constMap, relPath) {
  const entries = [];
  const pattern = /(?<![\w-])op\s*:\s*/g;
  for (const match of source.matchAll(pattern)) {
    const colonEnd = match.index + match[0].length;
    entries.push(...opPropertyEntries(source, lines, offsets, constMap, relPath, colonEnd));
  }
  return entries;
}

function isFunctionDeclarationSite(source, matchIndex) {
  const before = source.slice(Math.max(0, matchIndex - 12), matchIndex);
  return /function\s*$/.test(before);
}

// One helper call site's entries: reads the literal(s) out of the argument at `helper.argIndex`,
// or a single `<dynamic>` entry when that argument is not enumerable.
function helperCallEntries(source, offsets, constMap, relPath, helper, matchIndex) {
  const parenIndex = source.indexOf("(", matchIndex + helper.name.length - 1);
  const { args } = splitTopLevelArgs(source, parenIndex);
  const argText = args[helper.argIndex];
  if (argText === undefined) return [];
  const callLine = lineNumberAt(offsets, matchIndex);
  const literals = resolveLiteralValues(argText.trim(), constMap);
  if (literals === null) return [siteEntry("<dynamic>", helper.category, relPath, callLine)];
  return literals.map((literal) => siteEntry(literal, helper.category, relPath, callLine));
}

// Every call site of one positional-op helper in `source`: finds `helper.name(`, skips the
// helper's own `function name(` declaration line, and delegates the argument read to
// `helperCallEntries`.
function scanHelperCalls(source, offsets, constMap, relPath, helper) {
  const entries = [];
  const escaped = helper.name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = new RegExp(String.raw`\b${escaped}\s*\(`, "g");
  for (const match of source.matchAll(pattern)) {
    if (isFunctionDeclarationSite(source, match.index)) continue;
    entries.push(...helperCallEntries(source, offsets, constMap, relPath, helper, match.index));
  }
  return entries;
}

function applicableHelpers(relPath) {
  return POSITIONAL_OP_HELPERS.filter(
    (helper) => helper.file === undefined || helper.file === relPath,
  );
}

// Every catalog entry contributed by one file: object-literal `op:` properties plus every
// positional-helper call site that applies to this file.
function entriesForFile(absPath, relPath) {
  const source = readFileSync(absPath, "utf8");
  const lines = source.split("\n");
  const offsets = lineOffsets(source);
  const constMap = collectConstStrings(source);
  const entries = [
    ...scanObjectLiteralOps(source, lines, offsets, constMap, relPath),
    ...applicableHelpers(relPath).flatMap((helper) =>
      scanHelperCalls(source, offsets, constMap, relPath, helper),
    ),
  ];
  return applyFileCategoryBindingTier(entries, source);
}

function compareEntries(left, right) {
  return (
    left.package.localeCompare(right.package) ||
    left.op.localeCompare(right.op) ||
    left.site.localeCompare(right.site)
  );
}

function violationsIn(entries) {
  return entries
    .filter((entry) => entry.op !== "<dynamic>" && !OP_NAME_PATTERN.test(entry.op))
    .map((entry) => ({ op: entry.op, package: entry.package, site: entry.site }));
}

// Derives the full op catalog by walking every scanned package root under `repoRoot`. Exported so
// the drift test regenerates the same structure in memory and pins it against the checked-in
// file, and so the CLI entry point below only adds the write-to-disk step.
export function generateOpCatalog(repoRoot = REPO_ROOT) {
  const entries = [];
  for (const root of SCANNED_PACKAGE_ROOTS) {
    const pkg = packageNameFromRoot(root);
    const absRoot = join(repoRoot, ...root.split("/"));
    for (const absPath of walkTsFiles(absRoot)) {
      const relPath = relative(repoRoot, absPath).replaceAll("\\", "/");
      for (const entry of entriesForFile(absPath, relPath)) {
        entries.push({ ...entry, package: pkg });
      }
    }
  }
  const sorted = entries.toSorted(compareEntries);
  return {
    $schema: "keiko-op-catalog/1",
    generatedBy: "scripts/generate-op-catalog.mjs",
    entries: sorted,
    violations: violationsIn(sorted),
  };
}

function main() {
  const catalog = generateOpCatalog();
  const outPath = join(REPO_ROOT, ...OUTPUT_RELATIVE_PATH.split("/"));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  const dynamicCount = catalog.entries.filter((entry) => entry.op === "<dynamic>").length;
  console.log(
    `generate:op-catalog OK — ${catalog.entries.length} entries (${dynamicCount} dynamic), ` +
      `${catalog.violations.length} OP_NAME_PATTERN violation(s). Wrote ${OUTPUT_RELATIVE_PATH}.`,
  );
  if (catalog.violations.length > 0) {
    console.log(`  violations: ${JSON.stringify(catalog.violations)}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
