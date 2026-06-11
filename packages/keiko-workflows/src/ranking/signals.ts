// Per-candidate signal extraction for the deterministic hybrid ranker (Epic #177, Issue #182).
// Pure JS — no IO, no clock, no randomness. The signal name list is fixed; the scoring layer
// maps weights to signals by NAME (see SIGNAL_WEIGHT_KEYS in scoring.ts), not by position.
// Penalties are emitted alongside positive signals so the scorer treats them uniformly;
// downstream code interprets values via signal names only.

import type {
  CandidateSignal,
  EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";

import type { SearchAnchor } from "../planner/index.js";

export interface RankingInput {
  readonly atoms: readonly EvidenceAtom[];
  readonly anchors: readonly SearchAnchor[];
  readonly hints?: RankingHints;
}

export interface RankingHints {
  readonly generatedPathPatterns?: readonly string[];
  readonly duplicateOf?: ReadonlyMap<string, string>;
}

export const DEFAULT_GENERATED_PATTERNS: readonly string[] = [
  "/dist/",
  "/build/",
  "/.next/",
  "/coverage/",
  "/__snapshots__/",
  ".min.js",
  ".bundle.js",
  ".d.ts.map",
] as const;

export interface ExtractedSignals {
  readonly scopePath: string;
  readonly signals: readonly CandidateSignal[];
  readonly baseScore: number;
  readonly generatedHint: boolean;
}

// Fixed regex for stack-frame "at fn (path:line:col)" and "at path:line:col" detection.
// No user input is interpolated.
const STACK_FRAME_RE = /^\s*at\s+(?:\S+\s+\(([^\s:]+):\d+(?::\d+)?\)|([^\s:]+):\d+(?::\d+)?)/;

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function detectGenerated(scopePath: string, patterns: readonly string[]): boolean {
  // Scope paths are workspace-relative (no leading "/"), so a pattern like "/dist/" would
  // miss a root-level "dist/foo.js". Match leading "<pattern-without-slash>/" against the
  // path start AND the original "/<pattern>/" anywhere inside the path. .min.js / .bundle.js
  // / .d.ts.map patterns (no leading "/") use a plain substring match.
  const lower = scopePath.toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (lower.includes(p)) {
      return true;
    }
    if (p.startsWith("/") && p.endsWith("/")) {
      const stripped = p.slice(1);
      if (lower.startsWith(stripped)) {
        return true;
      }
    }
  }
  return false;
}

function computeProvenanceBestScore(atoms: readonly EvidenceAtom[]): number {
  if (atoms.length === 0) {
    return 0;
  }
  let best = 0;
  for (const candidate of atoms) {
    if (candidate.score > best) {
      best = candidate.score;
    }
  }
  return clampUnit(best);
}

function computeProvenanceCount(atoms: readonly EvidenceAtom[]): number {
  return Math.min(atoms.length, 10) / 10;
}

function computeAnchorOverlap(scopePath: string, anchors: readonly SearchAnchor[]): number {
  if (anchors.length === 0) {
    return 0;
  }
  const lowerPath = scopePath.toLowerCase();
  let hits = 0;
  for (const anc of anchors) {
    if (anc.term.length > 0 && lowerPath.includes(anc.term.toLowerCase())) {
      hits += 1;
    }
  }
  return clampUnit(hits / anchors.length);
}

function computePathDepthAffinity(scopePath: string): number {
  if (scopePath.length === 0) {
    return 0;
  }
  const depth = scopePath.split("/").length - 1;
  return 1 / (1 + depth);
}

function computeTestPairBonus(scopePath: string, anchors: readonly SearchAnchor[]): number {
  const isTest = scopePath.endsWith(".test.ts") || scopePath.endsWith(".spec.ts");
  if (!isTest) {
    return 0;
  }
  const sourcePath = scopePath.replace(/\.test\.ts$/, ".ts").replace(/\.spec\.ts$/, ".ts");
  const lowerSourcePath = sourcePath.toLowerCase();
  for (const anc of anchors) {
    if (anc.kind === "path" && anc.term.toLowerCase() === lowerSourcePath) {
      return 1;
    }
  }
  return 0;
}

function computeStacktracePositionBonus(
  scopePath: string,
  anchors: readonly SearchAnchor[],
): number {
  if (scopePath.length === 0) {
    return 0;
  }
  // The planner lowercases anchor terms, so we compare case-insensitively here too. A
  // direct equality on the captured path would miss legitimate matches whose source file
  // name has uppercase characters (and would also be inconsistent on case-insensitive
  // filesystems like macOS/Windows).
  const lowerScopePath = scopePath.toLowerCase();
  for (const anc of anchors) {
    if (anc.kind !== "quoted") {
      continue;
    }
    const match = STACK_FRAME_RE.exec(anc.term);
    if (match === null) {
      continue;
    }
    const framePath = match[1] ?? match[2];
    if (framePath?.toLowerCase() === lowerScopePath) {
      return 1;
    }
  }
  return 0;
}

function deriveScopePath(atoms: readonly EvidenceAtom[]): string {
  if (atoms.length === 0) {
    return "";
  }
  const first = atoms[0];
  return first === undefined ? "" : first.scopePath;
}

export function extractSignals(
  atomsForPath: readonly EvidenceAtom[],
  anchors: readonly SearchAnchor[],
  hints: Required<RankingHints>,
): ExtractedSignals {
  const scopePath = deriveScopePath(atomsForPath);
  const generatedHint = detectGenerated(scopePath, hints.generatedPathPatterns);
  const provBest = computeProvenanceBestScore(atomsForPath);
  const provCount = computeProvenanceCount(atomsForPath);
  const overlap = computeAnchorOverlap(scopePath, anchors);
  const depthAff = computePathDepthAffinity(scopePath);
  const testBonus = computeTestPairBonus(scopePath, anchors);
  const stackBonus = computeStacktracePositionBonus(scopePath, anchors);
  const penalty = generatedHint ? -1 : 0;
  const signals: readonly CandidateSignal[] = [
    { name: "provenance-best-score", value: provBest },
    { name: "provenance-count", value: provCount },
    { name: "anchor-overlap", value: overlap },
    { name: "path-depth-affinity", value: depthAff },
    { name: "test-pair-bonus", value: testBonus },
    { name: "stacktrace-position-bonus", value: stackBonus },
    { name: "generated-penalty", value: penalty },
  ];
  const positives = [provBest, provCount, overlap, depthAff, testBonus, stackBonus];
  const positiveMean = positives.reduce((acc, n) => acc + n, 0) / positives.length;
  const baseScore = clampUnit(positiveMean + penalty);
  return { scopePath, signals, baseScore, generatedHint };
}
