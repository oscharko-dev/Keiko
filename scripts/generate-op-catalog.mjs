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

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

// Codepoint comparison, never `localeCompare`: the catalog's entry order (and, transitively, the
// order files are walked in) is checked-in output pinned by a drift test. `localeCompare` uses the
// runtime's ICU collation and the ambient `LANG`, so the SAME source could sort two different ways
// on two machines — turning the gate red with no source change, or masking a genuine reorder.
function compareCodepoints(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// Every workspace package's `src` root, derived from `packages/*` rather than a hand-maintained
// list — a hardcoded list can go stale the moment a new package adds `op:` instrumentation and
// nobody remembers to add it here, and the catalog would then silently stay incomplete with a
// green drift test. Sorted by codepoint so this root list — cosmetic today, since the final
// catalog is sorted by package/op/site regardless — never depends on directory-listing order.
function scannedPackageRoots(repoRoot) {
  const packagesDir = join(repoRoot, "packages");
  const names = readdirSync(packagesDir).filter((name) =>
    statSync(join(packagesDir, name)).isDirectory(),
  );
  const roots = names
    .filter((name) => existsSync(join(packagesDir, name, "src")))
    .map((name) => `packages/${name}/src`);
  return roots.toSorted(compareCodepoints);
}

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

// Functions that receive the whole log-event object literal as an argument and hardcode their own
// `category` before forwarding it to the sink (orchestrator.ts's logIndexing/logEmbeddingRun/
// logDocument, #2902 W5). Unlike POSITIONAL_OP_HELPERS, `op` here is a NAMED PROPERTY inside the
// object-literal argument, not a bare positional string — tier 1 (findSiblingCategory) never finds
// a sibling `category:` at these call sites because the category lives inside the callee's body,
// not the caller's object literal, and tier 3 (fileCategoryBinding) backs off for this file because
// it binds two distinct categories ("indexing" and "embedding") depending on which of these three
// functions is called. `file` scopes every entry, exactly like POSITIONAL_OP_HELPERS' scoped
// entries, so a same-named helper anywhere else is never misattributed.
const OBJECT_ARG_CATEGORY_FUNCTIONS = [
  {
    name: "logIndexing",
    category: "indexing",
    file: "packages/keiko-local-knowledge/src/indexing/orchestrator.ts",
  },
  {
    name: "logEmbeddingRun",
    category: "embedding",
    file: "packages/keiko-local-knowledge/src/indexing/orchestrator.ts",
  },
  {
    name: "logDocument",
    category: "indexing",
    file: "packages/keiko-local-knowledge/src/indexing/orchestrator.ts",
  },
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
  for (const name of readdirSync(dir).sort(compareCodepoints)) {
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

// Advances `depth` by one character, clamped at zero. A stray unmatched closing bracket (e.g. an
// apostrophe misread as a string boundary, or a bracket left over from a scan that started
// mid-expression) must never push depth negative: once negative, depth can drift back up past
// zero without ever landing ON zero again, and every top-level stop after it would be missed.
// Clamping recovers on the very next open bracket instead of staying corrupted for the rest of the
// scan. Split out of `scanBalanced` to keep that function's own branching under this repo's
// complexity ceiling.
function nextDepth(depth, ch) {
  const next = depth + depthDelta(ch);
  return Math.max(0, next);
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
    depth = nextDepth(depth, ch);
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
// object-literal property, or a function parameter's type annotation). Returns the stop character
// alongside the value: `opPropertyEntries` uses it to tell a declaration from a real property (see
// `closesOverDeclaration`).
function readValueSpan(source, startIndex) {
  const stopIndex = scanBalanced(source, startIndex, VALUE_STOP);
  return { value: source.slice(startIndex, stopIndex), stopChar: source[stopIndex] };
}

const SINGLE_LITERAL = /^"([^"\\]*)"$/;
const TERNARY_BRANCHES = /^\s*"([^"\\]*)"\s*:\s*"([^"\\]*)"\s*$/;
const CONST_IDENTIFIER = /^[A-Z][A-Z0-9_]*$/;

// Resolves `condition ? "a" : "b"` — but ONLY when the condition (everything before the FIRST `?`
// in the expression) contains no quoted literal. A quote there means either a nested ternary
// (`flag ? "x" : other ? "y" : "z"`, whose true, only-two-literal branches sit after the SECOND
// `?`) or a condition this generator cannot safely scan for its own top-level `?` (a quoted
// literal can itself contain a `?` character, which would misdirect a plain `indexOf`). Either
// way, guessing which `?` is the real ternary operator risks silently dropping a real literal —
// see the nested-ternary case above, where a naive scan drops `"x"` entirely — so this returns
// `null` (dynamic) instead.
function ternaryOfLiterals(expr) {
  const qIndex = expr.indexOf("?");
  if (qIndex === -1 || expr.slice(0, qIndex).includes('"')) return null;
  const branches = TERNARY_BRANCHES.exec(expr.slice(qIndex + 1));
  return branches ? [branches[1], branches[2]] : null;
}

// Resolves a raw `op` expression (already trimmed) to the literal string(s) it can only ever be:
// a plain string, a ternary between two strings, or a reference to a well-known UPPER_SNAKE_CASE
// constant this generator already collected. Anything else (a member expression, a bare lowercase
// identifier, a function call, a template literal) is honestly dynamic — returns `null`.
function resolveLiteralValues(expr, constMap) {
  const single = SINGLE_LITERAL.exec(expr);
  if (single) return [single[1]];
  const ternary = ternaryOfLiterals(expr);
  if (ternary) return ternary;
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

// The identifier that ends `text` (ignoring trailing whitespace), found by a backward scan rather
// than an end-anchored regex — `([\w$]*)\s*$` backtracks super-linearly on long lines (Sonar S8786).
function trailingIdentifier(text) {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && /[\w$]/.test(text[start - 1])) start -= 1;
  if (start === end || /\d/.test(text[start])) return undefined;
  return text.slice(start, end);
}

// Walks backward from `fromIndex` (exclusive) tracking bracket depth, and returns the index of the
// nearest UNMATCHED opening bracket — the bracket that encloses `fromIndex` one level up. Every
// closing bracket seen first increments `depth` (one more matching opener is now owed before we are
// back to the enclosing level); every opening bracket either satisfies one of those or, at depth 0,
// IS the answer. Mirrors `scanBalanced`'s forward depth bookkeeping, run in reverse, so the object
// literal an `op:` property lives in — and, one level further out, the call it is an argument
// to — can be found without a full AST. Like every other extractor in this file, this does not
// track string/template spans on the way back; on this codebase's Prettier-formatted, one-property-
// per-line source that risk is the same one `findSiblingCategory`'s line scan already accepts.
function enclosingOpenBracketIndex(source, fromIndex) {
  let depth = 0;
  for (let i = fromIndex - 1; i >= 0; i -= 1) {
    const ch = source[i];
    if (CLOSE_BRACKETS.has(ch)) {
      depth += 1;
    } else if (OPEN_BRACKETS.has(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

// Tier 2.5 (see OBJECT_ARG_CATEGORY_FUNCTIONS' header comment): resolves the category for an
// `op:` property whose enclosing object literal is itself an argument to one of those checked-in
// functions — a shape tiers 1 and 3 cannot see, since the category lives inside the callee's body,
// never near the call site. Finds the object literal's own opening `{` first (must be a `{`, not
// some other enclosing bracket — a `[`/`(` there means `op:` is not sitting in a plain object-
// literal argument), then the call's opening `(` one level further out, then reads the identifier
// immediately before it. Returns undefined — never a guess — the moment any of those structural
// expectations fails, exactly like `fileCategoryBinding`'s own "no single safe answer" contract.
function objectArgCategory(source, colonEnd, relPath) {
  const braceIndex = enclosingOpenBracketIndex(source, colonEnd);
  if (braceIndex === -1 || source[braceIndex] !== "{") return undefined;
  const parenIndex = enclosingOpenBracketIndex(source, braceIndex);
  if (parenIndex === -1 || source[parenIndex] !== "(") return undefined;
  const name = trailingIdentifier(source.slice(0, parenIndex));
  if (name === undefined) return undefined;
  const match = OBJECT_ARG_CATEGORY_FUNCTIONS.find(
    (entry) => entry.name === name && entry.file === relPath,
  );
  return match?.category;
}

// Blanks `//` line comments and `/* … */` block comments in `source` — replaces every comment
// character with a space, character for character, while every OTHER character (including every
// newline, whether inside a comment or not) passes through unchanged. Unlike removing comment
// text outright, blanking preserves `source`'s exact length and every newline's exact offset, so
// `entriesForFile` can compute `lines`/`offsets` once against the blanked text and every extractor
// below sees line numbers that agree with the real file — no separate "raw vs. stripped" offset
// bookkeeping, and no risk of a duplicated or dropped newline shifting later sites (the bug a
// remove-based version of this function had for a `//` comment). Respects string and
// template-literal spans exactly like `scanBalanced`: a comment marker inside a string is not a
// comment, and a commented-out `op: "…"` — a doc-comment example, or this very file's own header —
// can never surface as a catalog entry once every extractor scans the blanked text.
// One step of `blankComments`'s string/template-literal branch: an escape consumes and re-emits
// both characters unchanged (so an escaped quote never ends the string), the matching quote closes
// it, anything else is copied unchanged. String contents are never blanked. Returns the next index
// to resume scanning from.
function stepInsideString(source, index, stringChar, appendChar) {
  const ch = source[index];
  appendChar(ch);
  if (ch === "\\") {
    appendChar(source[index + 1] ?? "");
    return { index: index + 2, stringChar };
  }
  return { index: index + 1, stringChar: ch === stringChar ? null : stringChar };
}

// Appends the blanked form of one source character: itself if it is a newline (so line layout
// stays exact), a single space otherwise.
function appendBlanked(ch, appendChar) {
  appendChar(ch === "\n" ? "\n" : " ");
}

// Blanks a `//` line comment up to (not including) its terminating newline. The dispatch loop in
// `blankComments` copies that newline unchanged on its very next step, so it is emitted exactly
// once — the double-newline this function used to introduce (one appended here, one copied by the
// dispatch loop) is gone because this function no longer appends a newline of its own at all.
function blankLineComment(source, index, appendChar) {
  let i = index;
  while (i < source.length && source[i] !== "\n") {
    appendBlanked(source[i], appendChar);
    i += 1;
  }
  return i;
}

// Blanks a `/* … */` block comment, including its opening and closing markers, one character at a
// time, so the blanked output is exactly as long as the comment it replaces.
function blankBlockComment(source, index, appendChar) {
  appendBlanked(source[index], appendChar);
  appendBlanked(source[index + 1], appendChar);
  let i = index + 2;
  while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
    appendBlanked(source[i], appendChar);
    i += 1;
  }
  appendBlanked(source[i] ?? "", appendChar);
  appendBlanked(source[i + 1] ?? "", appendChar);
  return i + 2;
}

// Blanks every `//` line comment and `/* … */` block comment in `source` (see the header comment
// above for why blanking, not removing). Computed exactly once per file in `entriesForFile`, and
// fed to every extractor — object-literal `op:` properties, positional-helper calls, collected
// constants, and the file-level category binding — so a commented-out `op:` can never become a
// catalog entry anywhere, not only in the one tier that originally guarded against it. Each branch
// is its own function above; this loop only dispatches between them.
function blankComments(source) {
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
      i = blankLineComment(source, i, appendChar);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = blankBlockComment(source, i, appendChar);
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
// `source` here is already the blanked text `entriesForFile` computed once for the whole file.
function fileCategoryBinding(source) {
  const distinct = new Set();
  for (const match of source.matchAll(FILE_CATEGORY_LITERAL_PATTERN)) {
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

// True when `stopChar` — the character `readValueSpan` stopped at — structurally rules out an
// object-literal property: a semicolon closes an interface/type-literal member (`readonly op:
// string;`), and a bare `op: Type` sitting directly in a parameter list closes over the enclosing
// `)` with nothing of its own in between — including a nested function-type parameter, e.g. the
// `op` in `(op: () => void) => …`, whose OWN value span ends at the outer `)`, never at a `,` or
// `}` first. An object-literal property never does either: this codebase's "trailing commas
// everywhere" Prettier rule means a non-final property always stops at `,`, and a final one closes
// over `}` (an object literal is always parenthesized or braced before any enclosing `)`).
function closesOverDeclaration(stopChar) {
  return stopChar === ";" || stopChar === ")";
}

const TYPE_LIKE_IDENTIFIER = /^[A-Z]\w*$/;
// A union of two or more quoted string-literal types, e.g. `"pull" | "put"` — TypeScript syntax
// for a parameter's TYPE, never a runtime expression (`"a" | "b"` at runtime is bitwise-OR on two
// strings coerced to `NaN`, which nothing in this codebase writes or would want).
const STRING_LITERAL_UNION = /^"[^"\\]*"(\s*\|\s*"[^"\\]*")+$/;

// True when `value` can only be naming a TypeScript type, never a runtime `op` value: the plain
// annotation text this generator has always recognized, a union of quoted string-literal types, or
// a bare PascalCase identifier that is not one of this file's collected UPPER_SNAKE_CASE constants
// — a type reference such as `OpName` or `LogOp`. A genuine runtime forward always reads a dotted
// expression (`record.operation`, `event.op`) or one of those all-caps constants, never a bare
// PascalCase name, so this never mistakes a real dynamic site for a declaration.
//
// A parenthesized FUNCTION TYPE (`(x: string) => void`) is deliberately NOT classified here, even
// though it also starts with `(`. Its content alone cannot tell a function type apart from a
// runtime arrow-function VALUE — `op: (value: string) => void;` (a type) and `op: (value) =>
// value,` (a real runtime function assigned to an object-literal property) are structurally
// identical past the opening paren: both close their own parens and can be followed by `=>`. Only
// WHERE the value's span stops distinguishes them — `;` for an interface/type-literal member, or
// the enclosing `)` when `op` is a function parameter (including a nested function-type parameter,
// e.g. the `op` in `(op: () => void) => …`, whose OWN span ends at that outer `)`) — never `,` or
// `}`, which is exactly what an object-literal property closes over instead, per this codebase's
// "trailing commas everywhere" Prettier rule. `opPropertyEntries` already carries that exact
// structural signal as `stopChar` and checks it via `closesOverDeclaration` before ever calling
// this function, so gating on content here regardless of `stopChar` previously misclassified a
// real runtime arrow-function `op` value (`op: (value) => value,`) as a type and silently dropped
// the site instead of recording it `<dynamic>` (#2902 PR review, round 3).
function isTypeAnnotationValue(value, constMap) {
  if (value === "string" || value === "string | undefined") return true;
  if (STRING_LITERAL_UNION.test(value)) return true;
  return TYPE_LIKE_IDENTIFIER.test(value) && !constMap.has(value);
}

// Scans one `op:` object-literal property match: skips TypeScript type annotations (`op: string`
// or `op: SomeType` on a function parameter, function-type parameter, or interface/type field),
// otherwise resolves the value and emits one entry per resolved literal, or a single `<dynamic>`
// entry when the value cannot be enumerated.
function opPropertyEntries(source, lines, offsets, constMap, relPath, colonEnd) {
  const { value: rawValue, stopChar } = readValueSpan(source, colonEnd);
  const value = rawValue.trim();
  if (closesOverDeclaration(stopChar) || isTypeAnnotationValue(value, constMap)) return [];
  const opLine = lineNumberAt(offsets, colonEnd);
  const category =
    findSiblingCategory(lines, opLine) ?? objectArgCategory(source, colonEnd, relPath) ?? "unknown";
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
// or a single `<dynamic>` entry when that argument is not enumerable OR not readable at all — a
// missing `args[helper.argIndex]` means `splitTopLevelArgs` could not read this call (end of file,
// or a bracket scan confused by something upstream), not that the call carries no op. Recording it
// as dynamic keeps the site visible instead of silently vanishing from the catalog.
function helperCallEntries(source, offsets, constMap, relPath, helper, matchIndex) {
  const parenIndex = source.indexOf("(", matchIndex + helper.name.length - 1);
  const { args } = splitTopLevelArgs(source, parenIndex);
  const argText = args[helper.argIndex];
  const callLine = lineNumberAt(offsets, matchIndex);
  if (argText === undefined) {
    return [siteEntry("<dynamic>", helper.category, relPath, callLine)];
  }
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
// positional-helper call site that applies to this file. Comments are blanked exactly once, here,
// and every extractor below — including the file-level category-binding tier — scans that blanked
// text, so a commented-out `op:` can never become an entry and no extractor sees raw comment text.
// Blanking preserves length and every newline's offset (see `blankComments`), so `lines`/`offsets`
// computed against it are exactly the real file's line numbers.
function entriesForFile(absPath, relPath) {
  const source = blankComments(readFileSync(absPath, "utf8"));
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
    compareCodepoints(left.package, right.package) ||
    compareCodepoints(left.op, right.op) ||
    compareCodepoints(left.site, right.site)
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
  for (const root of scannedPackageRoots(repoRoot)) {
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
