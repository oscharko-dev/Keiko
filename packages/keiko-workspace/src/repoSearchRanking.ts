import { expandedQueryTerms } from "./repoSearchQueryTerms.js";
import { naturalLanguageContentTerms } from "./repoSearchMatchers.js";

export interface PathLexicalSignals {
  readonly score: number;
  readonly matchedTerms: number;
  readonly coverageBonus: number;
  readonly exactPathBoost: number;
  readonly basenameBoost: number;
  readonly segmentBoost: number;
  readonly tokenBoost: number;
  readonly substringBoost: number;
}

type PathBoostSignal =
  "exactPathBoost" | "basenameBoost" | "segmentBoost" | "tokenBoost" | "substringBoost";

interface LexicalPathContext {
  readonly path: string;
  readonly name: string;
  readonly segments: readonly string[];
  readonly pathTerms: ReadonlySet<string>;
}

interface PathTermMatch {
  readonly signal: PathBoostSignal;
  readonly boost: number;
}

interface MutablePathLexicalSignals {
  matchedTerms: number;
  exactPathBoost: number;
  basenameBoost: number;
  segmentBoost: number;
  tokenBoost: number;
  substringBoost: number;
}

function basename(scopePath: string): string {
  const index = scopePath.lastIndexOf("/");
  return index >= 0 ? scopePath.slice(index + 1) : scopePath;
}

function normalizedPath(scopePath: string): string {
  return scopePath.split("\\").join("/").toLowerCase();
}

function pathSegments(scopePath: string): readonly string[] {
  return normalizedPath(scopePath)
    .split("/")
    .filter((segment) => segment.length > 0);
}

function termWeight(term: string): number {
  return term.length <= 3 ? 4 : Math.min(term.length, 12);
}

function emptyPathSignals(): PathLexicalSignals {
  return {
    score: 0,
    matchedTerms: 0,
    coverageBonus: 0,
    exactPathBoost: 0,
    basenameBoost: 0,
    segmentBoost: 0,
    tokenBoost: 0,
    substringBoost: 0,
  };
}

function pathContext(scopePath: string): LexicalPathContext {
  const path = normalizedPath(scopePath);
  return {
    path,
    name: basename(path),
    segments: pathSegments(path),
    pathTerms: new Set(expandedQueryTerms(scopePath, false)),
  };
}

function emptyMutableSignals(): MutablePathLexicalSignals {
  return {
    matchedTerms: 0,
    exactPathBoost: 0,
    basenameBoost: 0,
    segmentBoost: 0,
    tokenBoost: 0,
    substringBoost: 0,
  };
}

function pathTermMatch(context: LexicalPathContext, term: string): PathTermMatch | undefined {
  const weight = termWeight(term);
  if (context.path === term || context.path.endsWith(`/${term}`)) {
    return { signal: "exactPathBoost", boost: 36 + weight };
  }
  if (context.name === term || context.name.startsWith(`${term}.`)) {
    return { signal: "basenameBoost", boost: 26 + weight };
  }
  if (context.segments.includes(term)) {
    return { signal: "segmentBoost", boost: 18 + weight };
  }
  if (context.pathTerms.has(term)) {
    return { signal: "tokenBoost", boost: 14 + weight };
  }
  if (context.path.includes(term)) {
    return { signal: "substringBoost", boost: 8 + Math.min(weight, 8) };
  }
  return undefined;
}

function addPathTermMatch(signals: MutablePathLexicalSignals, match: PathTermMatch): void {
  signals[match.signal] += match.boost;
  signals.matchedTerms += 1;
}

export function queryRankingTerms(task: string | undefined): readonly string[] {
  if (task === undefined || task.trim().length === 0) {
    return [];
  }
  return naturalLanguageContentTerms(task, false);
}

export function lexicalPathSignals(
  scopePath: string,
  queryTerms: readonly string[],
): PathLexicalSignals {
  if (queryTerms.length === 0) {
    return emptyPathSignals();
  }
  const context = pathContext(scopePath);
  const signals = emptyMutableSignals();
  for (const term of queryTerms) {
    const match = pathTermMatch(context, term);
    if (match !== undefined) addPathTermMatch(signals, match);
  }
  const coverageBonus =
    signals.matchedTerms === 0 ? 0 : Math.round((signals.matchedTerms / queryTerms.length) * 24);
  return {
    score:
      signals.exactPathBoost +
      signals.basenameBoost +
      signals.segmentBoost +
      signals.tokenBoost +
      signals.substringBoost +
      coverageBonus,
    matchedTerms: signals.matchedTerms,
    coverageBonus,
    exactPathBoost: signals.exactPathBoost,
    basenameBoost: signals.basenameBoost,
    segmentBoost: signals.segmentBoost,
    tokenBoost: signals.tokenBoost,
    substringBoost: signals.substringBoost,
  };
}
