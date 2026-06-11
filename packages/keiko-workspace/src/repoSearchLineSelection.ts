import type { LineMatcher } from "./repoSearchMatchers.js";

// Per-file cap on emitted lexical matches (Epic #177 retrieval fix). A connected-scope question
// carries several content tokens, so a prose-heavy file can match many low-signal lines. Keeping
// only each file's best lines makes the evidence diverse across the scope.
const MAX_MATCHES_PER_FILE = 3;
const LINE_TIMEOUT_CHECK_INTERVAL = 256;

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
  readonly score: number;
}

function elapsed(runner: LineSelectionRunner): number {
  return runner.nowMs() - runner.startMs;
}

function timedOut(runner: LineSelectionRunner, state: LineSelectionState, lineIndex: number): boolean {
  if (lineIndex % LINE_TIMEOUT_CHECK_INTERVAL !== 0 || elapsed(runner) <= runner.limits.elapsedMsMax) {
    return false;
  }
  state.truncated = true;
  return true;
}

function insertBestLine(best: ScoredLine[], candidate: ScoredLine): void {
  best.push(candidate);
  best.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.line - b.line));
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
  let lineStart = 0;
  let lineNumber = 1;
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && text.charCodeAt(i) !== 10 /* \n */) {
      continue;
    }
    if (timedOut(runner, state, lineNumber - 1)) {
      break;
    }
    const score = runner.matcher.match(text.slice(lineStart, i));
    if (score > 0) {
      insertBestLine(best, { line: lineNumber, score });
    }
    lineStart = i + 1;
    lineNumber += 1;
  }
  return best.sort((a, b) => a.line - b.line);
}
