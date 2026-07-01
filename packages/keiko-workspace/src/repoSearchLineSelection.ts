import type { LineMatcher } from "./repoSearchMatchers.js";

// Per-file cap on emitted lexical matches (Epic #177 retrieval fix). A connected-scope question
// carries several content tokens, so a prose-heavy file can match many low-signal lines. Keeping
// only each file's best lines makes the evidence diverse across the scope.
const MAX_MATCHES_PER_FILE = 3;
const LINE_TIMEOUT_CHECK_INTERVAL = 256;
const MAX_DECLARATION_LOOKBACK_LINES = 120;
const MAX_ENCLOSING_WINDOW_LINES = 80;

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
  const existingIndex = best.findIndex(
    (entry) => entry.startLine === candidate.startLine && entry.endLine === candidate.endLine,
  );
  if (existingIndex >= 0) {
    const existing = best[existingIndex];
    if (existing === undefined) {
      return;
    }
    best[existingIndex] = {
      ...existing,
      line: Math.min(existing.line, candidate.line),
      score: Math.max(existing.score, candidate.score),
    };
    best.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.startLine - b.startLine));
    return;
  }
  best.push(candidate);
  best.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.startLine - b.startLine));
  if (best.length > MAX_MATCHES_PER_FILE) {
    best.pop();
  }
}

function countLeadingWhitespace(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === " ") {
      count += 1;
      continue;
    }
    if (char === "\t") {
      count += 2;
      continue;
    }
    break;
  }
  return count;
}

function stripInlineStrings(line: string): string {
  return line.replace(/(["'`])(?:\\.|(?!\1).)*\1/gu, "");
}

function braceDelta(line: string): number {
  let delta = 0;
  for (const char of stripInlineStrings(line)) {
    if (char === "{") {
      delta += 1;
    } else if (char === "}") {
      delta -= 1;
    }
  }
  return delta;
}

function isControlStatement(trimmed: string): boolean {
  return /^(?:if|else|for|while|switch|case|catch|try|finally|do|return|throw|await|using)\b/iu.test(
    trimmed,
  );
}

function isDeclarationLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("//") || trimmed.startsWith("*")) {
    return false;
  }
  if (isControlStatement(trimmed)) {
    return false;
  }
  return [
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[$_a-z][$_a-z0-9]*\b/iu,
    /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|enum|namespace|type)\s+[$_a-z][$_a-z0-9]*\b/iu,
    /^(?:export\s+)?(?:const|let|var)\s+[$_a-z][$_a-z0-9]*\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[$_a-z][$_a-z0-9]*\s*=>)/iu,
    /^(?:async\s+)?def\s+[$_a-z][$_a-z0-9]*\s*\(/iu,
    /^class\s+[$_a-z][$_a-z0-9]*\b/iu,
    /^func\s+(?:\([^)]*\)\s*)?[$_a-z][$_a-z0-9]*\s*\(/iu,
    /^(?:pub\s+)?(?:async\s+)?fn\s+[$_a-z][$_a-z0-9]*\s*\(/iu,
    /^(?:public|private|protected|internal|static|final|abstract|open|override|suspend|sealed|async|readonly)\b.*\b[$_a-z][$_a-z0-9]*\s*\([^)]*\)\s*(?:\{|=>)?/iu,
  ].some((pattern) => pattern.test(trimmed));
}

function includeLeadingDecorators(lines: readonly string[], declarationIndex: number): number {
  let start = declarationIndex;
  while (start > 0 && lines[start - 1]?.trim().startsWith("@") === true) {
    start -= 1;
  }
  return start;
}

function findDeclarationStart(lines: readonly string[], matchIndex: number): number | undefined {
  const min = Math.max(0, matchIndex - MAX_DECLARATION_LOOKBACK_LINES);
  for (let i = matchIndex; i >= min; i -= 1) {
    if (isDeclarationLine(lines[i] ?? "")) {
      return includeLeadingDecorators(lines, i);
    }
  }
  return undefined;
}

function braceWindowEnd(lines: readonly string[], startIndex: number): number | undefined {
  let balance = 0;
  let sawOpenBrace = false;
  const maxExclusive = Math.min(lines.length, startIndex + MAX_ENCLOSING_WINDOW_LINES);
  for (let i = startIndex; i < maxExclusive; i += 1) {
    const line = lines[i] ?? "";
    if (line.includes("{")) {
      sawOpenBrace = true;
    }
    balance += braceDelta(line);
    if (sawOpenBrace && balance <= 0 && i > startIndex) {
      return i;
    }
  }
  return sawOpenBrace ? maxExclusive - 1 : undefined;
}

function indentationWindowEnd(lines: readonly string[], startIndex: number): number | undefined {
  const startIndent = countLeadingWhitespace(lines[startIndex] ?? "");
  const maxExclusive = Math.min(lines.length, startIndex + MAX_ENCLOSING_WINDOW_LINES);
  let sawNestedLine = false;
  let lastContent = startIndex;
  for (let i = startIndex + 1; i < maxExclusive; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    const indent = countLeadingWhitespace(line);
    if (indent <= startIndent && sawNestedLine) {
      return lastContent;
    }
    if (indent > startIndent) {
      sawNestedLine = true;
    }
    lastContent = i;
  }
  return sawNestedLine ? lastContent : undefined;
}

function enclosingWindow(lines: readonly string[], matchIndex: number): {
  readonly startLine: number;
  readonly endLine: number;
} {
  const declarationStart = findDeclarationStart(lines, matchIndex);
  if (declarationStart === undefined) {
    return { startLine: matchIndex + 1, endLine: matchIndex + 1 };
  }
  const endIndex =
    braceWindowEnd(lines, declarationStart) ?? indentationWindowEnd(lines, declarationStart);
  if (endIndex === undefined || endIndex < matchIndex) {
    return { startLine: matchIndex + 1, endLine: matchIndex + 1 };
  }
  return { startLine: declarationStart + 1, endLine: endIndex + 1 };
}

export function collectBestLines(
  runner: LineSelectionRunner,
  text: string,
  state: LineSelectionState,
): readonly ScoredLine[] {
  const best: ScoredLine[] = [];
  const lines = text.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (timedOut(runner, state, lineIndex)) {
      break;
    }
    const score = runner.matcher.match(lines[lineIndex] ?? "");
    if (score > 0) {
      insertBestLine(best, {
        line: lineIndex + 1,
        ...enclosingWindow(lines, lineIndex),
        score,
      });
    }
  }
  return best.sort((a, b) =>
    a.startLine === b.startLine ? a.endLine - b.endLine : a.startLine - b.startLine,
  );
}
