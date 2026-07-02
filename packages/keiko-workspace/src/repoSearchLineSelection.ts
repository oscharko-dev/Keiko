import type { LineMatcher } from "./repoSearchMatchers.js";

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
}

export interface LineSelectionState {
  truncated: boolean;
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

function looksLikeBlockHeader(line: string): boolean {
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
  return /\b[A-Za-z_$][\w$<>,.[\]?]*\s+[A-Za-z_$][\w$]*\s*\([^;{}]*\)\s*(?:throws\s+[^{]+)?\{/u.test(
    trimmed,
  );
}

function looksLikeControlFlowHeader(trimmedLine: string): boolean {
  return /^(?:if|for|while|switch|catch|else|do|try|finally|using|lock|when)\b/u.test(trimmedLine);
}

function looksLikeSignatureStart(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || looksLikeControlFlowHeader(trimmed)) {
    return false;
  }
  return (
    looksLikeBlockHeader(trimmed) ||
    /\b(?:[A-Za-z_$][\w$<>,.[\]?]*\s+)+[A-Za-z_$][\w$]*\s*\(/u.test(trimmed)
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
    /^\[[A-Za-z_][\w]*(?:Attribute)?(?:\([^;\n]*\))?\]$/u.test(trimmedLine)
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

// eslint-disable-next-line complexity -- Brace balancing is a single bounded state machine.
function braceRange(lines: readonly string[], index: number): { start: number; end: number } {
  let start = index;
  let balanceStart = index;
  for (let i = index; i >= Math.max(0, index - MAX_ENCLOSING_RANGE_LINES); i -= 1) {
    const line = lines[i] ?? "";
    if (line.includes("{")) {
      const candidate = braceStartLine(lines, i);
      if (candidate === undefined) {
        continue;
      }
      start = candidate;
      balanceStart = i;
      break;
    }
  }
  if (start === index && !looksLikeBlockHeader(lines[index] ?? "")) {
    return { start: index + 1, end: index + 1 };
  }
  let balance = 0;
  let seenOpen = false;
  let end = index;
  for (
    let i = balanceStart;
    i < Math.min(lines.length, balanceStart + MAX_ENCLOSING_RANGE_LINES);
    i += 1
  ) {
    for (const char of lines[i] ?? "") {
      if (char === "{") {
        balance += 1;
        seenOpen = true;
      } else if (char === "}") {
        balance -= 1;
      }
    }
    end = i;
    if (seenOpen && balance <= 0) {
      break;
    }
  }
  return { start: start + 1, end: end + 1 };
}

function enclosingRange(lines: readonly string[], index: number): { start: number; end: number } {
  const line = lines[index] ?? "";
  if (/^\s*(?:async\s+def|def|class)\s+\w+/u.test(line) || lineIndent(line) > 0) {
    const range = pythonRange(lines, index);
    if (range.start < range.end) {
      return range;
    }
  }
  return braceRange(lines, index);
}

function elapsed(runner: LineSelectionRunner): number {
  return runner.nowMs() - runner.startMs;
}

function timedOut(
  runner: LineSelectionRunner,
  state: LineSelectionState,
  lineIndex: number,
): boolean {
  if (
    lineIndex % LINE_TIMEOUT_CHECK_INTERVAL !== 0 ||
    elapsed(runner) <= runner.limits.elapsedMsMax
  ) {
    return false;
  }
  state.truncated = true;
  return true;
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
): readonly ScoredLine[] {
  const best: ScoredLine[] = [];
  const lines = text.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (timedOut(runner, state, lineIndex)) {
      break;
    }
    const score = runner.matcher.match(lines[lineIndex] ?? "");
    if (score > 0) {
      const range = enclosingRange(lines, lineIndex);
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
