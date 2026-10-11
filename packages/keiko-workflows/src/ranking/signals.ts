// Per-candidate signal extraction for the deterministic hybrid ranker (Epic #177, Issue #182).
// Pure JS — no IO, no clock, no randomness. The signal name list is fixed; the scoring layer
// maps weights to signals by NAME (see SIGNAL_WEIGHT_KEYS in scoring.ts), not by position.
// Penalties are emitted alongside positive signals so the scorer treats them uniformly;
// downstream code interprets values via signal names only.

import type {
  CandidateSignal,
  EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { isCanonicalMetadataFile } from "@oscharko-dev/keiko-workspace";

import type { SearchAnchor, SearchReference } from "../planner/index.js";
import { isIntentBoosted } from "./scoring.js";

export interface RankingInput {
  readonly atoms: readonly EvidenceAtom[];
  readonly anchors: readonly SearchAnchor[];
  readonly references?: readonly SearchReference[];
  readonly hints?: RankingHints;
  // Optional intent context (enterprise retrieval M4). When present with a boosted intent, two
  // extra signals are APPENDED (canonical-metadata, structural-edge); absent ⇒ the signal vector is
  // byte-identical to before, so non-boosted intents and all existing callers are unchanged.
  readonly context?: RankingContext;
}

export interface RankingContext {
  readonly retrievalIntent?: string | undefined;
}

export interface RankingHints {
  readonly recentPaths?: readonly string[];
  readonly generatedPathPatterns?: readonly string[];
  readonly duplicateOf?: ReadonlyMap<string, string>;
}

// True when this candidate is reachable via an inbound import edge, code-intelligence lookup, or a
// test↔source pairing, derived from atoms already present. No extra IO.
const STRUCTURAL_TOOLS: ReadonlySet<string> = new Set([
  "import-graph",
  "test-source-pairing",
  "code-intelligence-index",
  "discovered-symbol-definition",
  "structural-edge-target",
]);
const SEMANTIC_TOOL_PREFIX = "repo.semanticSearch";

function hasStructuralEdge(atoms: readonly EvidenceAtom[]): boolean {
  return atoms.some((atom) => STRUCTURAL_TOOLS.has(atom.provenance.tool));
}

function hasDiscoveredSymbolDefinition(atoms: readonly EvidenceAtom[]): boolean {
  return atoms.some((atom) => atom.provenance.tool === "discovered-symbol-definition");
}

function bestLexicalScore(atoms: readonly EvidenceAtom[]): number {
  return computeBestScoreByTool(atoms, (atom) => atom.provenance.kind === "lexical-search");
}

function bestSemanticScore(atoms: readonly EvidenceAtom[]): number {
  return computeBestScoreByTool(atoms, (atom) =>
    atom.provenance.tool.startsWith(SEMANTIC_TOOL_PREFIX),
  );
}

function computeGitRecency(atoms: readonly EvidenceAtom[]): number {
  let best = 0;
  for (const atom of atoms) {
    if (atom.provenance.kind !== "git-history") {
      continue;
    }
    const value = atom.metrics?.gitRecency;
    if (value !== undefined && value > best) {
      best = value;
    }
  }
  return clampUnit(best);
}

function computeGitChurn(atoms: readonly EvidenceAtom[]): number {
  let best = 0;
  for (const atom of atoms) {
    if (atom.provenance.kind !== "git-history") {
      continue;
    }
    const value = atom.metrics?.gitChurn;
    if (value !== undefined && value > best) {
      best = value;
    }
  }
  return clampUnit(best);
}

export const DEFAULT_GENERATED_PATTERNS: readonly string[] = [
  "/dist/",
  "/build/",
  "/.next/",
  "/coverage/",
  "/storybookstatic/",
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
const FUNCTION_STACK_FRAME_RE = /^\s*at\s+\S+\s+\((?<path>[^\s:]+):\d+(?::\d+)?\)/;
const BARE_STACK_FRAME_RE = /^\s*at\s+(?<path>[^\s:]+):\d+(?::\d+)?/;

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function isGeneratedRankingPath(
  scopePath: string,
  patterns: readonly string[] = DEFAULT_GENERATED_PATTERNS,
): boolean {
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
  return computeBestScoreByTool(atoms, () => true);
}

function computeBestScoreByTool(
  atoms: readonly EvidenceAtom[],
  predicate: (atom: EvidenceAtom) => boolean,
): number {
  if (atoms.length === 0) {
    return 0;
  }
  let best = 0;
  for (const candidate of atoms) {
    if (predicate(candidate) && candidate.score > best) {
      best = candidate.score;
    }
  }
  return clampUnit(best);
}

function computeProvenanceCount(atoms: readonly EvidenceAtom[]): number {
  return Math.min(atoms.length, 10) / 10;
}

function normalizedPathTerm(term: string): string {
  return term
    .replace(/:\d{1,9}(?::\d{1,9})?$/u, "")
    .replace(/^\.\//u, "")
    .toLowerCase();
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function exactPathMatch(scopePath: string, anchor: SearchAnchor): number {
  if (anchor.kind !== "path") return 0;
  const path = normalizedPathTerm(anchor.sourceTerm ?? anchor.term);
  const candidate = scopePath.toLowerCase();
  if (candidate === path) return clampUnit(anchor.weight);
  return candidate.endsWith(`/${path}`) ? 0.8 * clampUnit(anchor.weight) : 0;
}

function directorySegments(path: string): ReadonlySet<string> {
  return new Set(path.toLowerCase().split("/").slice(0, -1).filter(Boolean));
}

function segmentAffinity(scopePath: string, path: string): number {
  const requested = directorySegments(path);
  if (requested.size === 0) return 0;
  const candidate = directorySegments(scopePath);
  return [...requested].filter((segment) => candidate.has(segment)).length / requested.size;
}

function pathAnchors(
  anchors: readonly SearchAnchor[],
  references: readonly SearchReference[],
): readonly SearchAnchor[] {
  const combined = new Map(anchors.map((anchor) => [normalizedPathTerm(anchor.term), anchor]));
  for (const reference of references) {
    const term = normalizedPathTerm(reference.path);
    const existing = combined.get(term);
    if (existing?.kind !== "path")
      combined.set(term, { term, sourceTerm: reference.path, kind: "path", weight: 0.95 });
  }
  return [...combined.values()];
}

function anchorMatch(scopePath: string, anchor: SearchAnchor): number {
  if (anchor.kind === "path") return exactPathMatch(scopePath, anchor);
  const tokens = new Set(scopePath.toLowerCase().split(/[/._-]+/u));
  if (!tokens.has(anchor.term.toLowerCase())) return 0;
  const kindWeight = anchor.kind === "literal" ? 0.5 : 1;
  return kindWeight * clampUnit(anchor.weight);
}

function computeAnchorOverlap(scopePath: string, anchors: readonly SearchAnchor[]): number {
  if (anchors.length === 0) return 0;
  return clampUnit(
    anchors.reduce((sum, anchor) => sum + anchorMatch(scopePath, anchor), 0) / anchors.length,
  );
}

interface PathEvidenceSignals {
  readonly exactPathMatch: number;
  readonly pathSegmentAffinity: number;
  readonly basenameMatch: number;
}

function pairedPathAffinity(scopePath: string, atoms: readonly EvidenceAtom[]): number {
  let best = 0;
  for (const atom of atoms) {
    if (atom.edge?.kind !== "test-source") continue;
    const peer =
      atom.edge.source.scopePath === scopePath
        ? atom.edge.target.scopePath
        : atom.edge.source.scopePath;
    best = Math.max(best, segmentAffinity(scopePath, peer));
  }
  return best;
}

function pathEvidenceSignals(
  scopePath: string,
  atoms: readonly EvidenceAtom[],
  anchors: readonly SearchAnchor[],
): PathEvidenceSignals {
  let exactPath = 0;
  let affinity = pairedPathAffinity(scopePath, atoms);
  let basename = 0;
  for (const anchor of anchors) {
    const term = normalizedPathTerm(anchor.sourceTerm ?? anchor.term);
    exactPath = Math.max(exactPath, exactPathMatch(scopePath, anchor));
    if (anchor.kind === "path")
      affinity = Math.max(affinity, segmentAffinity(scopePath, term) * clampUnit(anchor.weight));
    if (basenameOf(term) === basenameOf(scopePath.toLowerCase()))
      basename = Math.max(basename, clampUnit(anchor.weight));
  }
  return { exactPathMatch: exactPath, pathSegmentAffinity: affinity, basenameMatch: basename };
}

function hasPathEvidence(signals: PathEvidenceSignals): boolean {
  return signals.exactPathMatch > 0 || signals.pathSegmentAffinity > 0 || signals.basenameMatch > 0;
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
    const match = FUNCTION_STACK_FRAME_RE.exec(anc.term) ?? BARE_STACK_FRAME_RE.exec(anc.term);
    const framePath = match?.groups?.path;
    if (framePath === undefined) {
      continue;
    }
    if (framePath.toLowerCase() === lowerScopePath) {
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

function baseSignalVector(
  atoms: readonly EvidenceAtom[],
  anchors: readonly SearchAnchor[],
  scopePath: string,
  generated: boolean,
  pathEvidence: PathEvidenceSignals,
  references: readonly SearchReference[],
): CandidateSignal[] {
  return [
    { name: "provenance-best-score", value: computeProvenanceBestScore(atoms) },
    { name: "lexical-score", value: bestLexicalScore(atoms) },
    { name: "semantic-score", value: bestSemanticScore(atoms) },
    { name: "provenance-count", value: computeProvenanceCount(atoms) },
    { name: "anchor-overlap", value: computeAnchorOverlap(scopePath, anchors) },
    {
      name: "path-depth-affinity",
      value: hasPathEvidence(pathEvidence) ? 1 : computePathDepthAffinity(scopePath),
    },
    { name: "test-pair-bonus", value: computeTestPairBonus(scopePath, anchors) },
    {
      name: "stacktrace-position-bonus",
      value:
        referenceStackBonus(scopePath, references) ||
        computeStacktracePositionBonus(scopePath, anchors),
    },
    { name: "generated-penalty", value: generated ? -1 : 0 },
  ];
}

function referenceStackBonus(scopePath: string, references: readonly SearchReference[]): number {
  const primary = references.find((reference) => reference.origin === "diagnostic");
  return primary?.path.toLowerCase() === scopePath.toLowerCase() ? 1 : 0;
}

function appendIntentSignals(
  signals: CandidateSignal[],
  scopePath: string,
  atoms: readonly EvidenceAtom[],
  context: RankingContext | undefined,
): void {
  if (!isIntentBoosted(context?.retrievalIntent)) return;
  signals.push(
    { name: "canonical-metadata", value: isCanonicalMetadataFile(scopePath) ? 1 : 0 },
    { name: "structural-edge", value: hasStructuralEdge(atoms) ? 1 : 0 },
  );
  if (hasDiscoveredSymbolDefinition(atoms)) signals.push({ name: "symbol-definition", value: 1 });
}

const BASE_SCORE_SIGNALS: ReadonlySet<string> = new Set([
  "provenance-best-score",
  "provenance-count",
  "anchor-overlap",
  "path-depth-affinity",
  "test-pair-bonus",
  "stacktrace-position-bonus",
]);

function baseSignalScore(signals: readonly CandidateSignal[], generated: boolean): number {
  const total = signals
    .filter((signal) => BASE_SCORE_SIGNALS.has(signal.name))
    .reduce((sum, signal) => sum + signal.value, 0);
  return clampUnit(total / BASE_SCORE_SIGNALS.size - (generated ? 1 : 0));
}

export function extractSignals(
  atomsForPath: readonly EvidenceAtom[],
  anchors: readonly SearchAnchor[],
  hints: Required<Omit<RankingHints, "recentPaths">> & Pick<RankingHints, "recentPaths">,
  context?: RankingContext,
  references: readonly SearchReference[] = [],
): ExtractedSignals {
  const scopePath = deriveScopePath(atomsForPath);
  const generatedHint = isGeneratedRankingPath(scopePath, hints.generatedPathPatterns);
  const combinedAnchors = pathAnchors(anchors, references);
  const pathEvidence = pathEvidenceSignals(scopePath, atomsForPath, combinedAnchors);
  const baseSignals = baseSignalVector(
    atomsForPath,
    combinedAnchors,
    scopePath,
    generatedHint,
    pathEvidence,
    references,
  );
  if (combinedAnchors.some((anchor) => anchor.kind === "path") || hasPathEvidence(pathEvidence)) {
    baseSignals.push(
      { name: "exact-path-match", value: pathEvidence.exactPathMatch },
      { name: "path-segment-affinity", value: pathEvidence.pathSegmentAffinity },
      { name: "basename-match", value: pathEvidence.basenameMatch },
    );
  }
  const gitRecency = computeGitRecency(atomsForPath);
  const gitChurn = computeGitChurn(atomsForPath);
  if (gitRecency > 0 || gitChurn > 0) {
    baseSignals.push(
      { name: "git-recency", value: gitRecency },
      { name: "git-churn", value: gitChurn },
    );
  }
  appendWorktreeRecency(baseSignals, scopePath, atomsForPath, hints, context);
  appendIntentSignals(baseSignals, scopePath, atomsForPath, context);
  const baseScore = baseSignalScore(baseSignals, generatedHint);
  return { scopePath, signals: baseSignals, baseScore, generatedHint };
}

function appendWorktreeRecency(
  signals: CandidateSignal[],
  scopePath: string,
  atoms: readonly EvidenceAtom[],
  hints: Pick<RankingHints, "recentPaths">,
  context: RankingContext | undefined,
): void {
  if (
    context?.retrievalIntent !== "targeted-code-search" &&
    context?.retrievalIntent !== "diagnostic-search"
  )
    return;
  if (!hints.recentPaths?.includes(scopePath) || bestLexicalScore(atoms) <= 0) return;
  signals.push({ name: "git-worktree-recency", value: 1 });
}
