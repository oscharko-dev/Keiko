import type { ContextCoverageTruncationReason } from "@oscharko-dev/keiko-contracts/connected-context";
import type { LineMatcher } from "./repoSearchMatchers.js";
import { repositorySourceLines } from "./repoSearchSourceClassification.js";

// Per-file cap on emitted lexical matches (Epic #177 retrieval fix). A connected-scope question
// carries several content tokens, so a prose-heavy file can match many low-signal lines. Keeping
// only each file's best windows makes the evidence diverse across the scope without starving
// code-tracing tasks that need multiple local anchors from one file.
const MAX_MATCHES_PER_FILE = 3;
const LINE_TIMEOUT_CHECK_INTERVAL = 256;
const MAX_ENCLOSING_RANGE_LINES = 80;

export interface LineSelectionRunner {
  readonly limits: { readonly elapsedMsMax: number };
  readonly matcher: LineMatcher;
  readonly nowMs: () => number;
  readonly startMs: number;
  readonly deadlineAtMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface LineSelectionState {
  truncated: boolean;
  readonly truncationReasons?: Set<ContextCoverageTruncationReason> | undefined;
}

export interface ScoredLine {
  readonly line: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
}

function lineIndent(line: string): number {
  const match = /^\s*/u.exec(line);
  return match?.[0].length ?? 0;
}

// Exported (module-local only — not re-exported from the package barrel) so the S8786
// regression below can call it directly instead of routing an adversarial line through the
// full `collectBestLines` pipeline.
export function looksLikeBlockHeader(line: string): boolean {
  const trimmed = line.trim();
  if (looksLikeControlFlowHeader(trimmed)) {
    return false;
  }
  if (
    /\b(?:class|interface|record|struct|enum|trait|function|def|func|fn|fun|public|private|protected|static|async|const|let|var)\b/u.test(
      trimmed,
    )
  ) {
    return true;
  }
  return looksLikeFunctionSignatureTail(trimmed);
}

// All three variable-length character classes below are bounded (2000 characters is far beyond
// any realistic single-line type prefix, parameter list, or throws-clause — even a verbose real
// signature stays well under it; the trailing `throws` class was originally left unbounded and
// SonarCloud correctly flagged it — S8786 — for exactly the same reason the other two are capped:
// an adversarial line with many "ident ident() throws ident " units and no closing `{` anywhere
// makes every successfully-parsed candidate rescan the rest of the line for a `{` that never
// appears, which is quadratic without the cap). Bounding alone doesn't change the pattern's
// *shape*: leading `\b` makes
// `.test()` retry the whole pattern from every word-boundary start position in the line, which is
// the unanchored-adjacent-quantifier shape S8786 flags regardless of the per-position bound. This
// reproduces the identical `\b<pattern>` search explicitly: a manual scan over candidate
// word-boundary starts, each checked with a *sticky* (`y`-flagged) copy of the pattern pinned to
// that exact index via `lastIndex` — a single bounded pass per candidate with no
// retry-at-every-position ambiguity, and (unlike anchoring `^` and re-slicing the line per
// candidate) no per-candidate string copy either.
const FUNCTION_SIGNATURE_TAIL =
  /[A-Za-z_$][\w$<>,.[\]?]{0,2000}\s+[A-Za-z_$][\w$]*\s*\([^;{}]{0,2000}\)\s*(?:throws\s+[^{]{0,500})?\{/uy;

// Real `\b` (which the original pattern's leading `\b` relied on) fires at a position exactly
// when the character before it and the character at it disagree on being a `\w` = `[A-Za-z0-9_]`
// character — the string's start/end count as a non-word "before"/"after". `\w` does NOT include
// `$`, even though `$` is itself a valid identifier character in JS/TS, so a `$` sitting right
// after a digit or letter (e.g. "9$Type", "x$1") IS a real boundary (digit/letter is `\w`, `$`
// isn't) while a `$` at the very start of the line is NOT (both "sides" are non-word).
//
// Plain char-range comparisons instead of `/\w/u`/`/[A-Za-z_$]/u` regex calls, and reusing the
// previous iteration's word-ness instead of recomputing it for both sides of every candidate:
// this scan already runs once per character of a potentially huge adversarial line (S8786), so
// per-character constant-factor cost matters here in a way it doesn't elsewhere in this file.
function isWordChar(char: string): boolean {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "_"
  );
}

function isIdentStartChar(char: string): boolean {
  return (
    (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_" || char === "$"
  );
}

function looksLikeFunctionSignatureTail(trimmed: string): boolean {
  let previousWasWord = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const atChar = trimmed.charAt(index);
    const atIsWord = isWordChar(atChar);
    const isBoundary = previousWasWord !== atIsWord;
    previousWasWord = atIsWord;
    if (!isBoundary || !isIdentStartChar(atChar)) continue;
    FUNCTION_SIGNATURE_TAIL.lastIndex = index;
    if (FUNCTION_SIGNATURE_TAIL.test(trimmed)) return true;
  }
  return false;
}

function looksLikeControlFlowHeader(trimmedLine: string): boolean {
  return /^(?:if|for|while|switch|catch|else|do|try|finally|using|lock|when)\b/u.test(trimmedLine);
}

// Exported (module-local only — not re-exported from the package barrel) so the S8786
// regression below can call it directly instead of routing an adversarial line through the
// full `collectBestLines` pipeline.
export function looksLikeSignatureStart(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || looksLikeControlFlowHeader(trimmed)) {
    return false;
  }
  // Same S8786 shape as `looksLikeBlockHeader` (this pattern is reached from the same
  // `collectBestLines` line-scan on arbitrary source lines): the repeated group's inner class
  // `[\w$<>,.[\]?]*` includes `,`/`.`, so on a dead-end line (never followed by `(`) it overlaps
  // comma/dot-separated content and re-walks an O(remaining length) search from every one of the
  // many word-boundary start positions that creates — quadratic in line length. Bounded to 2000
  // characters per the same "far beyond any realistic single-line type prefix" reasoning as
  // `looksLikeBlockHeader`.
  return (
    looksLikeBlockHeader(trimmed) ||
    /\b(?:[A-Za-z_$][\w$<>,.[\]?]{0,2000}\s+)+[A-Za-z_$][\w$]*\s*\(/u.test(trimmed)
  );
}

function braceStartLine(lines: readonly string[], braceLineIndex: number): number | undefined {
  const line = lines[braceLineIndex] ?? "";
  if (looksLikeBlockHeader(line)) {
    return includeLeadingDecorators(lines, braceLineIndex);
  }
  for (let i = braceLineIndex - 1; i >= Math.max(0, braceLineIndex - 12); i -= 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.length === 0 || looksLikeDecoratorLine(trimmed)) {
      continue;
    }
    if (looksLikeSignatureStart(trimmed)) {
      return includeLeadingDecorators(lines, i);
    }
    if (/[;{}]/u.test(trimmed)) {
      break;
    }
  }
  return undefined;
}

function includeLeadingDecorators(lines: readonly string[], startIndex: number): number {
  let start = startIndex;
  const baseIndent = lineIndent(lines[startIndex] ?? "");
  for (let i = startIndex - 1; i >= Math.max(0, startIndex - 12); i -= 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      break;
    }
    if (looksLikeDecoratorLine(trimmed) && lineIndent(line) <= baseIndent) {
      start = i;
      continue;
    }
    break;
  }
  return start;
}

function looksLikeDecoratorLine(trimmedLine: string): boolean {
  return (
    trimmedLine.startsWith("@") ||
    /^\[[A-Za-z_]\w*(?:Attribute)?(?:\([^;\n]*\))?\]$/u.test(trimmedLine)
  );
}

// eslint-disable-next-line complexity -- Indentation walk is clearer kept as one bounded scan.
function pythonRange(lines: readonly string[], index: number): { start: number; end: number } {
  let start = index;
  let declarationStart = index;
  const currentIndent = lineIndent(lines[index] ?? "");
  for (let i = index; i >= Math.max(0, index - MAX_ENCLOSING_RANGE_LINES); i -= 1) {
    const line = lines[i] ?? "";
    if (/^\s*(?:async\s+def|def|class)\s+\w+/u.test(line) && line.trimEnd().endsWith(":")) {
      declarationStart = i;
      start = includeLeadingDecorators(lines, i);
      break;
    }
    if (i < index && line.trimEnd().endsWith(":") && lineIndent(line) < currentIndent) {
      declarationStart = i;
      start = includeLeadingDecorators(lines, i);
      break;
    }
  }
  let end = index;
  const baseIndent = lineIndent(lines[declarationStart] ?? "");
  for (
    let i = declarationStart + 1;
    i < Math.min(lines.length, declarationStart + MAX_ENCLOSING_RANGE_LINES);
    i += 1
  ) {
    const line = lines[i] ?? "";
    if (line.trim().length > 0 && lineIndent(line) <= baseIndent) {
      break;
    }
    end = i;
  }
  return { start: start + 1, end: end + 1 };
}

function locateBraceStart(
  lines: readonly string[],
  braceScans: readonly BraceLineScan[],
  index: number,
): { start: number; balanceStart: number } {
  for (let i = index; i >= Math.max(0, index - MAX_ENCLOSING_RANGE_LINES); i -= 1) {
    if (braceScans[i]?.sawOpen !== true) {
      continue;
    }
    const candidate = braceStartLine(lines, i);
    if (candidate === undefined) {
      continue;
    }
    return { start: candidate, balanceStart: i };
  }
  return { start: index, balanceStart: index };
}

interface BraceScanState {
  blockComment: boolean;
  readonly controlParenStack: boolean[];
  escaped: boolean;
  quote: '"' | "'" | "`" | undefined;
  regexAfterControlParen: boolean;
  regexCharacterClass: boolean;
  regexLiteral: boolean;
}

interface BraceLineScan {
  readonly delta: number;
  readonly sawOpen: boolean;
}

interface BraceScanCache {
  readonly lines: readonly string[];
  readonly scans: BraceLineScan[];
  readonly state: BraceScanState;
}

interface BraceCharacterResult {
  readonly advance: boolean;
  readonly delta: number;
  readonly sawOpen: boolean;
  readonly stop: boolean;
}

const IGNORED_BRACE_CHARACTER: BraceCharacterResult = {
  advance: false,
  delta: 0,
  sawOpen: false,
  stop: false,
};
const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "default",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const REGEX_BODY_CONTROL_KEYWORDS = new Set(["for", "if", "while", "with"]);

function initialBraceScanState(): BraceScanState {
  return {
    blockComment: false,
    controlParenStack: [],
    escaped: false,
    quote: undefined,
    regexAfterControlParen: false,
    regexCharacterClass: false,
    regexLiteral: false,
  };
}

function commentStart(char: string, next: string): "block" | "line" | undefined {
  if (char !== "/") return undefined;
  if (next === "/") return "line";
  if (next === "*") return "block";
  return undefined;
}

function scanQuotedBraceCharacter(
  char: string,
  next: string,
  state: BraceScanState,
): BraceCharacterResult {
  const quote = state.quote;
  if (state.escaped) {
    state.escaped = false;
    return IGNORED_BRACE_CHARACTER;
  }
  if (char === "\\") {
    state.escaped = true;
    return IGNORED_BRACE_CHARACTER;
  }
  if (char !== quote) return IGNORED_BRACE_CHARACTER;
  if (next === quote && quote !== "`") {
    return { ...IGNORED_BRACE_CHARACTER, advance: true };
  }
  state.quote = undefined;
  return IGNORED_BRACE_CHARACTER;
}

function isAsciiLetter(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}

function isIdentifierContinuation(char: string): boolean {
  return char.length > 0 && (char === "$" || /[\p{ID_Continue}\u200C\u200D]/u.test(char));
}

function isJsxTagNameCharacter(char: string): boolean {
  return isIdentifierContinuation(char) || char === "." || char === ":" || char === "-";
}

function isJsxClosingTagSlash(line: string, slashIndex: number): boolean {
  if (line.charAt(slashIndex - 1) !== "<") return false;
  let index = slashIndex + 1;
  if (line.charAt(index) === ">") return true;
  if (!isIdentStartChar(line.charAt(index))) return false;
  index += 1;
  while (isJsxTagNameCharacter(line.charAt(index))) index += 1;
  while (/\s/u.test(line.charAt(index))) index += 1;
  return line.charAt(index) === ">";
}

function hasRegexPrefixKeyword(line: string, endIndex: number): boolean {
  if (!isAsciiLetter(line.charAt(endIndex))) return false;
  let index = endIndex;
  while (index >= 0 && isAsciiLetter(line.charAt(index))) index -= 1;
  if (isIdentifierContinuation(line.charAt(index)) || ".#".includes(line.charAt(index))) {
    return false;
  }
  return REGEX_PREFIX_KEYWORDS.has(line.slice(index + 1, endIndex + 1));
}

function regexLiteralCanStart(line: string, slashIndex: number): boolean {
  if (isJsxClosingTagSlash(line, slashIndex)) return false;
  let index = slashIndex - 1;
  while (index >= 0 && /\s/u.test(line.charAt(index))) index -= 1;
  if (index < 0) return true;
  const previous = line.charAt(index);
  if ("=([{,:;!&|?<>".includes(previous)) return true;
  return hasRegexPrefixKeyword(line, index);
}

function controlHeaderBeforeOpenParen(line: string, openParenIndex: number): boolean {
  let index = openParenIndex - 1;
  while (index >= 0 && /\s/u.test(line.charAt(index))) index -= 1;
  const wordEnd = index + 1;
  while (index >= 0 && isAsciiLetter(line.charAt(index))) index -= 1;
  if (wordEnd === index + 1 || line.charAt(index) === ".") return false;
  return REGEX_BODY_CONTROL_KEYWORDS.has(line.slice(index + 1, wordEnd));
}

function scanRegexBraceCharacter(char: string, state: BraceScanState): BraceCharacterResult {
  if (state.escaped) {
    state.escaped = false;
    return IGNORED_BRACE_CHARACTER;
  }
  if (char === "\\") {
    state.escaped = true;
    return IGNORED_BRACE_CHARACTER;
  }
  if (char === "[") state.regexCharacterClass = true;
  if (char === "]") state.regexCharacterClass = false;
  if (char === "/" && !state.regexCharacterClass) state.regexLiteral = false;
  return IGNORED_BRACE_CHARACTER;
}

function scanExpressionBoundaryCharacter(
  line: string,
  index: number,
  char: string,
  state: BraceScanState,
): BraceCharacterResult | undefined {
  if (char === '"' || char === "'" || char === "`") {
    state.regexAfterControlParen = false;
    state.quote = char;
    return IGNORED_BRACE_CHARACTER;
  }
  if (char === "(") {
    state.controlParenStack.push(controlHeaderBeforeOpenParen(line, index));
    state.regexAfterControlParen = false;
    return IGNORED_BRACE_CHARACTER;
  }
  if (char === ")") {
    state.regexAfterControlParen = state.controlParenStack.pop() === true;
    return IGNORED_BRACE_CHARACTER;
  }
  return /\s/u.test(char) ? IGNORED_BRACE_CHARACTER : undefined;
}

function scanUnquotedBraceCharacter(
  line: string,
  index: number,
  char: string,
  next: string,
  regexStart: boolean,
  state: BraceScanState,
): BraceCharacterResult {
  const comment = commentStart(char, next);
  if (comment === "line") return { ...IGNORED_BRACE_CHARACTER, stop: true };
  if (comment === "block") {
    state.blockComment = true;
    return { ...IGNORED_BRACE_CHARACTER, advance: true };
  }
  if (regexStart) {
    state.regexAfterControlParen = false;
    state.regexLiteral = true;
    state.regexCharacterClass = false;
    return IGNORED_BRACE_CHARACTER;
  }
  const expressionBoundary = scanExpressionBoundaryCharacter(line, index, char, state);
  if (expressionBoundary !== undefined) return expressionBoundary;
  state.regexAfterControlParen = false;
  if (char === "{") return { ...IGNORED_BRACE_CHARACTER, delta: 1, sawOpen: true };
  if (char === "}") return { ...IGNORED_BRACE_CHARACTER, delta: -1 };
  return IGNORED_BRACE_CHARACTER;
}

function scanBraceCharacter(
  line: string,
  index: number,
  state: BraceScanState,
): BraceCharacterResult {
  const char = line.charAt(index);
  const next = line.charAt(index + 1);
  if (state.blockComment) {
    if (char === "*" && next === "/") {
      state.blockComment = false;
      return { ...IGNORED_BRACE_CHARACTER, advance: true };
    }
    return IGNORED_BRACE_CHARACTER;
  }
  if (state.regexLiteral) return scanRegexBraceCharacter(char, state);
  return state.quote === undefined
    ? scanUnquotedBraceCharacter(
        line,
        index,
        char,
        next,
        char === "/" && (state.regexAfterControlParen || regexLiteralCanStart(line, index)),
        state,
      )
    : scanQuotedBraceCharacter(char, next, state);
}

function scanBraceLine(line: string, state: BraceScanState): BraceLineScan {
  let delta = 0;
  let sawOpen = false;
  for (let index = 0; index < line.length; index += 1) {
    const scanned = scanBraceCharacter(line, index, state);
    delta += scanned.delta;
    sawOpen = sawOpen || scanned.sawOpen;
    if (scanned.stop) break;
    if (scanned.advance) index += 1;
  }
  if (state.quote !== "`") {
    state.escaped = false;
  }
  state.regexCharacterClass = false;
  state.regexLiteral = false;
  return { delta, sawOpen };
}

function createBraceScanCache(lines: readonly string[]): BraceScanCache {
  return { lines, scans: [], state: initialBraceScanState() };
}

function scanBraceLinesThrough(cache: BraceScanCache, endExclusive: number): void {
  const target = Math.min(cache.lines.length, endExclusive);
  while (cache.scans.length < target) {
    const index = cache.scans.length;
    cache.scans.push(scanBraceLine(cache.lines[index] ?? "", cache.state));
  }
}

function findBraceEnd(
  braceScans: readonly BraceLineScan[],
  balanceStart: number,
  fallbackIndex: number,
): number {
  let balance = 0;
  let seenOpen = false;
  let end = fallbackIndex;
  for (
    let i = balanceStart;
    i < Math.min(braceScans.length, balanceStart + MAX_ENCLOSING_RANGE_LINES);
    i += 1
  ) {
    const { delta, sawOpen } = braceScans[i] ?? { delta: 0, sawOpen: false };
    balance += delta;
    seenOpen = seenOpen || sawOpen;
    end = i;
    if (seenOpen && balance <= 0) {
      break;
    }
  }
  return end;
}

function braceRange(
  lines: readonly string[],
  braceScans: readonly BraceLineScan[],
  index: number,
): { start: number; end: number } {
  const { start, balanceStart } = locateBraceStart(lines, braceScans, index);
  if (start === index && !looksLikeBlockHeader(lines[index] ?? "")) {
    return { start: index + 1, end: index + 1 };
  }
  const end = findBraceEnd(braceScans, balanceStart, index);
  // A backward scan can encounter a complete one-line object before the matching line. That
  // closed brace pair is not an enclosing range; returning it would attach the match score to
  // unrelated preceding content and hide the actual evidence line from the context pack.
  if (start > index || end < index) {
    return { start: index + 1, end: index + 1 };
  }
  return { start: start + 1, end: end + 1 };
}

function enclosingRange(
  lines: readonly string[],
  braceScans: readonly BraceLineScan[],
  index: number,
): { start: number; end: number } {
  const brace = braceRange(lines, braceScans, index);
  if (brace.start < brace.end) {
    return brace;
  }
  const line = lines[index] ?? "";
  if (/^\s*(?:async\s+def|def|class)\s+\w+/u.test(line) || lineIndent(line) > 0) {
    const range = pythonRange(lines, index);
    if (range.start < range.end) {
      return range;
    }
  }
  return brace;
}

export interface EnclosingLineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Computes the same structural windows used by live lexical matching for selected zero-based line
 * indices. Workspace-index records call this once while they still hold the bounded file content,
 * so a warm exact-symbol hit cannot collapse a function body to its declaration line.
 */
export function enclosingLineRangesForIndices(
  text: string,
  lineIndices: readonly number[],
): ReadonlyMap<number, EnclosingLineRange> {
  const lines = physicalLines(text);
  const cache = createBraceScanCache(lines);
  const ranges = new Map<number, EnclosingLineRange>();
  const ordered = [...new Set(lineIndices)].sort((a, b) => a - b);
  for (const lineIndex of ordered) {
    if (lineIndex < 0 || lineIndex >= lines.length) continue;
    scanBraceLinesThrough(cache, lineIndex + MAX_ENCLOSING_RANGE_LINES);
    const range = enclosingRange(lines, cache.scans, lineIndex);
    ranges.set(lineIndex, { startLine: range.start, endLine: range.end });
  }
  return ranges;
}

function markStopped(state: LineSelectionState, reason: ContextCoverageTruncationReason): true {
  state.truncated = true;
  state.truncationReasons?.add(reason);
  return true;
}

function lineSelectionStopped(
  runner: LineSelectionRunner,
  state: LineSelectionState,
  lineIndex: number,
): boolean {
  if (runner.signal?.aborted === true) {
    return markStopped(state, "aborted");
  }
  if (lineIndex % LINE_TIMEOUT_CHECK_INTERVAL !== 0) return false;
  const currentMs = runner.nowMs();
  return (runner.deadlineAtMs !== undefined && currentMs >= runner.deadlineAtMs) ||
    currentMs - runner.startMs > runner.limits.elapsedMsMax
    ? markStopped(state, "timeout")
    : false;
}

function physicalLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function insertBestLine(best: ScoredLine[], candidate: ScoredLine): void {
  let merged: ScoredLine = candidate;
  for (let index = best.length - 1; index >= 0; index -= 1) {
    const existing = best[index];
    if (existing === undefined) {
      continue;
    }
    const overlaps = merged.startLine <= existing.endLine && existing.startLine <= merged.endLine;
    if (!overlaps) {
      continue;
    }
    merged = {
      line: Math.min(merged.line, existing.line),
      startLine: Math.min(merged.startLine, existing.startLine),
      endLine: Math.max(merged.endLine, existing.endLine),
      score: Math.max(merged.score, existing.score),
    };
    best.splice(index, 1);
  }
  best.push(merged);
  best.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.startLine - b.startLine));
  if (best.length > MAX_MATCHES_PER_FILE) {
    best.pop();
  }
}

export function collectBestLines(
  runner: LineSelectionRunner,
  text: string,
  state: LineSelectionState,
  scopePath?: string,
): readonly ScoredLine[] {
  const best: ScoredLine[] = [];
  const lines = physicalLines(text);
  const sourceLines = repositorySourceLines(text, scopePath);
  const braceScanCache = createBraceScanCache(lines);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (lineSelectionStopped(runner, state, lineIndex)) {
      break;
    }
    const score = runner.matcher.match(lines[lineIndex] ?? "", sourceLines[lineIndex]);
    if (score > 0) {
      scanBraceLinesThrough(braceScanCache, lineIndex + MAX_ENCLOSING_RANGE_LINES);
      const range = enclosingRange(lines, braceScanCache.scans, lineIndex);
      insertBestLine(best, {
        line: lineIndex + 1,
        startLine: range.start,
        endLine: range.end,
        score,
      });
    }
  }
  return best.sort((a, b) =>
    a.startLine === b.startLine ? a.endLine - b.endLine : a.startLine - b.startLine,
  );
}
