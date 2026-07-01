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
  const path = normalizedPath(scopePath);
  const name = basename(path);
  const segments = pathSegments(path);
  const pathTerms = new Set(expandedQueryTerms(scopePath, false));
  let matchedTerms = 0;
  let exactPathBoost = 0;
  let basenameBoost = 0;
  let segmentBoost = 0;
  let tokenBoost = 0;
  let substringBoost = 0;
  for (const term of queryTerms) {
    const weight = termWeight(term);
    if (path === term || path.endsWith(`/${term}`)) {
      exactPathBoost += 36 + weight;
      matchedTerms += 1;
      continue;
    }
    if (name === term || name.startsWith(`${term}.`)) {
      basenameBoost += 26 + weight;
      matchedTerms += 1;
      continue;
    }
    if (segments.includes(term)) {
      segmentBoost += 18 + weight;
      matchedTerms += 1;
      continue;
    }
    if (pathTerms.has(term)) {
      tokenBoost += 14 + weight;
      matchedTerms += 1;
      continue;
    }
    if (path.includes(term)) {
      substringBoost += 8 + Math.min(weight, 8);
      matchedTerms += 1;
    }
  }
  const coverageBonus =
    matchedTerms === 0 ? 0 : Math.round((matchedTerms / queryTerms.length) * 24);
  return {
    score:
      exactPathBoost +
      basenameBoost +
      segmentBoost +
      tokenBoost +
      substringBoost +
      coverageBonus,
    matchedTerms,
    coverageBonus,
    exactPathBoost,
    basenameBoost,
    segmentBoost,
    tokenBoost,
    substringBoost,
  };
}
