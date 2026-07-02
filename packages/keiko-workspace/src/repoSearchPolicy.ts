import type {
  CandidateOmissionReason,
  CandidateSignal,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  canonicalMetadataEcosystem,
  isCanonicalMetadataFile,
  isEcosystemLockfile,
  isEcosystemSourceFile,
  isGeneratedArtifactPath,
} from "./ecosystems.js";
import { naturalLanguageContentTerms } from "./repoSearchMatchers.js";
import { lexicalPathSignals, queryRankingTerms } from "./repoSearchRanking.js";
import { fuseLexicalAndSemanticRanks, type SemanticSearchMatch } from "./repoSearchSemantic.js";
import type { DiscoveredFile } from "./types.js";

export type SearchIntent =
  | "project-metadata"
  | "repository-overview"
  | "targeted-code-search"
  | "diagnostic-search"
  | "clarification-needed"
  | "generic";

export type SearchPolicyMode = "workspace-root-default" | "explicit-scope";

export type CandidateBucket =
  | "canonical-metadata"
  | "overview-doc"
  | "exact-path"
  | "symbol-source"
  | "config"
  | "source"
  | "test"
  | "docs"
  | "lockfile"
  | "low-value"
  | "other";

export interface SearchHints {
  readonly retrievalIntent?: SearchIntent | undefined;
}

export interface SearchPolicy {
  readonly mode: SearchPolicyMode;
  readonly intent: SearchIntent;
  readonly applyGitignore: boolean;
  readonly omitLowValueWorkspaceFiles: boolean;
}

// Explainable per-file ranking diagnostic: why a candidate ended up where it did. `signals`
// reuses the connected-context CandidateSignal contract ({ name, value }); names encode the
// contribution kind (e.g. "bucket:canonical-metadata", "path-term-bonus", "depth-penalty",
// "ecosystem:maven") and values their numeric contribution to `score`.
export interface RankedCandidateDiagnostic {
  readonly scopePath: string;
  readonly bucket: CandidateBucket;
  readonly score: number;
  readonly ecosystem: string | undefined;
  readonly signals: readonly CandidateSignal[];
}

export interface SearchDiagnostics {
  readonly policyMode: SearchPolicyMode;
  readonly intent: SearchIntent;
  readonly filesDiscovered: number;
  readonly filesAfterPolicy: number;
  readonly ignoredByDiscovery: number;
  readonly deniedByDiscovery: number;
  readonly depthPrunedByDiscovery: number;
  readonly candidateBuckets: Readonly<Record<CandidateBucket, number>>;
  // Top-ranked candidates with their ranking-signal breakdown, bounded for audit readability.
  readonly rankedCandidates: readonly RankedCandidateDiagnostic[];
}

// Upper bound on how many ranked candidates carry an explainability breakdown in diagnostics. The
// strongest-ranked files are the ones a reviewer needs to justify; the full bucket histogram still
// covers the rest via candidateBuckets.
const MAX_RANKED_CANDIDATE_DIAGNOSTICS = 25;

export interface CandidateOrderingResult {
  readonly files: readonly DiscoveredFile[];
  readonly diagnostics: SearchDiagnostics;
}

// Canonical-metadata filenames are now owned by the ecosystem registry (ecosystems.ts), which is a
// superset of the former JS/TS-only literal table and additionally covers Maven/Gradle/Go/Rust/
// Python/.NET/etc. See isCanonicalMetadataFile.

const OVERVIEW_FILENAMES = new Set([
  "readme.md",
  "agents.md",
  "contributing.md",
  "architecture.md",
  "docs/architecture.md",
  "docs/overview.md",
  "docs/readme.md",
]);

const LOCKFILE_FILENAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const LOW_VALUE_SEGMENTS = new Set([
  ".parcel-cache",
  ".svelte-kit",
  ".vercel",
  "coverage",
  "dist",
  "generated",
  "storybook-static",
  "tmp",
]);

const LOW_VALUE_IGNORE_LINES: readonly string[] = Object.freeze([
  ".parcel-cache/",
  ".svelte-kit/",
  ".vercel/",
  "coverage/",
  "dist/",
  "generated/",
  "storybook-static/",
  "tmp/",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const SOURCE_EXTENSIONS = new Set([
  "cjs",
  "cts",
  "go",
  "java",
  "js",
  "jsx",
  "mjs",
  "mts",
  "py",
  "rs",
  "ts",
  "tsx",
  "vue",
]);

const CONFIG_EXTENSIONS = new Set([
  "conf",
  "config",
  "env",
  "ini",
  "json",
  "properties",
  "toml",
  "xml",
  "yaml",
  "yml",
]);
const DOC_EXTENSIONS = new Set(["adoc", "md", "mdx", "rst", "txt"]);
const TEST_FILE_RE = /(?:^|[./_-])(?:test|spec|fixture|mock)s?(?:[./_-]|$)/iu;
const IMPLEMENTATION_INTENT_TERMS = new Set([
  "define",
  "defined",
  "definition",
  "implement",
  "implemented",
  "implementation",
  "source",
]);

function emptyBucketCounts(): Record<CandidateBucket, number> {
  return {
    "canonical-metadata": 0,
    "overview-doc": 0,
    "exact-path": 0,
    "symbol-source": 0,
    config: 0,
    source: 0,
    test: 0,
    docs: 0,
    lockfile: 0,
    "low-value": 0,
    other: 0,
  };
}

function basename(scopePath: string): string {
  const index = scopePath.lastIndexOf("/");
  return index >= 0 ? scopePath.slice(index + 1) : scopePath;
}

function extension(scopePath: string): string {
  const name = basename(scopePath).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}

function normalizedPath(scopePath: string): string {
  return scopePath.split("\\").join("/").toLowerCase();
}

function pathSegments(scopePath: string): readonly string[] {
  return normalizedPath(scopePath)
    .split("/")
    .filter((segment) => segment.length > 0);
}

function isLockfile(scopePath: string): boolean {
  return (
    LOCKFILE_FILENAMES.has(basename(scopePath).toLowerCase()) || isEcosystemLockfile(scopePath)
  );
}

function hasLowValueSegment(scopePath: string): boolean {
  return pathSegments(scopePath).some((segment) => LOW_VALUE_SEGMENTS.has(segment));
}

function isLowValueOrGenerated(scopePath: string): boolean {
  return hasLowValueSegment(scopePath) || isGeneratedArtifactPath(scopePath);
}

function isSourceExtension(ext: string, scopePath: string): boolean {
  return SOURCE_EXTENSIONS.has(ext) || isEcosystemSourceFile(scopePath);
}

function isConfigPath(scopePath: string): boolean {
  const name = basename(scopePath).toLowerCase();
  return (
    CONFIG_EXTENSIONS.has(extension(scopePath)) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".env")
  );
}

function normalizedQueryTerms(query: RetrievalQuery): readonly string[] {
  return queryRankingTerms(query.text);
}

function bucketByPath(scopePath: string): CandidateBucket {
  const path = normalizedPath(scopePath);
  const name = basename(path);
  const ext = extension(path);
  // Canonical manifests are recognized by the ecosystem registry (single source of truth) rather
  // than a JS/TS-only literal table, so pom.xml / build.gradle / go.mod / Cargo.toml / pyproject.toml
  // are bucketed as canonical-metadata (and therefore outrank prose) instead of falling to "other".
  if (isCanonicalMetadataFile(path)) {
    return "canonical-metadata";
  }
  if (OVERVIEW_FILENAMES.has(path) || OVERVIEW_FILENAMES.has(name)) {
    return "overview-doc";
  }
  if (isLockfile(path)) {
    return "lockfile";
  }
  // Generated/vendored artifacts (target/, vendor/, __pycache__/, *.pb.go, *.designer.cs, …) are
  // deprioritized so generated-heavy repos do not flood the candidate set. Detection is
  // whole-segment / anchored-suffix only — never a bare substring — so hand-authored source such as
  // src/builder.ts is unaffected.
  if (isLowValueOrGenerated(path)) {
    return "low-value";
  }
  if (isConfigPath(path)) {
    return "config";
  }
  if (TEST_FILE_RE.test(path)) {
    return "test";
  }
  if (isSourceExtension(ext, path)) {
    return "source";
  }
  if (DOC_EXTENSIONS.has(ext)) {
    return "docs";
  }
  return "other";
}

export function candidateBucketForPath(scopePath: string): CandidateBucket {
  return bucketByPath(scopePath);
}

function bucketScore(bucket: CandidateBucket, intent: SearchIntent): number {
  if (intent === "project-metadata") {
    return metadataBucketScore(bucket);
  }
  if (intent === "repository-overview") {
    return overviewBucketScore(bucket);
  }
  if (intent === "targeted-code-search" || intent === "diagnostic-search") {
    return targetedBucketScore(bucket);
  }
  return genericBucketScore(bucket);
}

function metadataBucketScore(bucket: CandidateBucket): number {
  const scores: Readonly<Record<CandidateBucket, number>> = {
    "canonical-metadata": 100,
    "overview-doc": 70,
    "exact-path": 95,
    "symbol-source": 80,
    config: 65,
    source: 45,
    test: 40,
    docs: 55,
    lockfile: 15,
    "low-value": 5,
    other: 20,
  };
  return scores[bucket];
}

function overviewBucketScore(bucket: CandidateBucket): number {
  const scores: Readonly<Record<CandidateBucket, number>> = {
    "canonical-metadata": 75,
    "overview-doc": 100,
    "exact-path": 95,
    "symbol-source": 80,
    config: 60,
    source: 50,
    test: 35,
    docs: 70,
    lockfile: 5,
    "low-value": 5,
    other: 20,
  };
  return scores[bucket];
}

function targetedBucketScore(bucket: CandidateBucket): number {
  const scores: Readonly<Record<CandidateBucket, number>> = {
    "canonical-metadata": 65,
    "overview-doc": 35,
    "exact-path": 100,
    "symbol-source": 95,
    config: 90,
    source: 80,
    test: 55,
    docs: 25,
    lockfile: 5,
    "low-value": 5,
    other: 20,
  };
  return scores[bucket];
}

function genericBucketScore(bucket: CandidateBucket): number {
  const scores: Readonly<Record<CandidateBucket, number>> = {
    "canonical-metadata": 80,
    "overview-doc": 65,
    "exact-path": 90,
    "symbol-source": 85,
    config: 75,
    source: 60,
    test: 45,
    docs: 50,
    lockfile: 5,
    "low-value": 5,
    other: 20,
  };
  return scores[bucket];
}

function depthPenalty(scopePath: string): number {
  return Math.min(pathSegments(scopePath).length, 12);
}

function queryIntentBoost(bucket: CandidateBucket, terms: readonly string[]): number {
  if (!terms.some((term) => IMPLEMENTATION_INTENT_TERMS.has(term))) {
    return 0;
  }
  if (bucket === "source" || bucket === "symbol-source" || bucket === "exact-path") {
    return 24;
  }
  if (bucket === "test" || bucket === "docs" || bucket === "overview-doc") {
    return -12;
  }
  return 0;
}

interface ScoredCandidate {
  readonly file: DiscoveredFile;
  readonly bucket: CandidateBucket;
  readonly score: number;
  readonly bucketTiebreak: number;
  readonly signals: readonly CandidateSignal[];
  readonly ecosystem: string | undefined;
}

// Score a candidate ONCE and capture the per-signal breakdown that produced the score, so the same
// computation drives both ordering and the explainable ranking diagnostics (a reviewer can see WHY
// a file was selected: which bucket, the intent-specific bucket weight, the path-term bonus, the
// depth penalty, and — for a manifest — which ecosystem classified it).
function scoreCandidate(
  file: DiscoveredFile,
  terms: readonly string[],
  policy: SearchPolicy,
): ScoredCandidate {
  const path = file.relativePath;
  const bucket = bucketByPath(path);
  const lexical = lexicalPathSignals(path, terms);
  const depth = depthPenalty(path);
  const bucketTiebreak = bucketScore(bucket, policy.intent);
  const intentBoost = queryIntentBoost(bucket, terms);
  const ecosystem = bucket === "canonical-metadata" ? canonicalMetadataEcosystem(path) : undefined;
  const signals: CandidateSignal[] = [
    { name: "query-path-score", value: lexical.score },
    { name: "query-coverage", value: lexical.coverageBonus },
    { name: "query-intent-boost", value: intentBoost },
    { name: `bucket:${bucket}`, value: bucketTiebreak / 100 },
    { name: "depth-penalty", value: -(depth / 1000) },
  ];
  if (ecosystem !== undefined) {
    signals.push({ name: `ecosystem:${ecosystem}`, value: 1 });
  }
  return {
    file,
    bucket,
    score: lexical.score + intentBoost + bucketTiebreak / 100 - depth / 1000,
    bucketTiebreak,
    signals,
    ecosystem,
  };
}

function rankCandidates(
  files: readonly DiscoveredFile[],
  query: RetrievalQuery,
  policy: SearchPolicy,
): readonly ScoredCandidate[] {
  // Score each file ONCE (query tokenization + path bucketing are O(path) and were previously
  // recomputed twice per comparison — O(n log n) blocking work on the 2000-file candidate cap).
  // Tie-break on raw code-point order, not localeCompare, so evidence ordering is reproducible
  // across locales/ICU builds (regulated-delivery determinism).
  const terms = normalizedQueryTerms(query);
  const scored = files.map((file) => scoreCandidate(file, terms, policy));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.bucketTiebreak !== b.bucketTiebreak) return b.bucketTiebreak - a.bucketTiebreak;
    if (a.file.relativePath < b.file.relativePath) return -1;
    return a.file.relativePath > b.file.relativePath ? 1 : 0;
  });
  return scored;
}

function bucketCounts(
  ranked: readonly ScoredCandidate[],
): Readonly<Record<CandidateBucket, number>> {
  const counts = emptyBucketCounts();
  for (const candidate of ranked) {
    counts[candidate.bucket] += 1;
  }
  return counts;
}

export function resolveSearchPolicy(
  hasExplicitRelativePaths: boolean,
  hints: SearchHints | undefined,
): SearchPolicy {
  const mode = hasExplicitRelativePaths ? "explicit-scope" : "workspace-root-default";
  const intent = hints?.retrievalIntent ?? "generic";
  return {
    mode,
    intent,
    applyGitignore: mode === "workspace-root-default",
    omitLowValueWorkspaceFiles: mode === "workspace-root-default",
  };
}

// The legacy `gatherCandidates(scope, limits, fs)` overload predates the search-policy work and is
// still used by importGraph / testSourcePairing, which expect FULL-tree discovery (no .gitignore
// subset, no low-value omission) — that was the hardcoded `applyGitignore: false` behavior before
// this change. Resolving the default workspace-root policy for them would silently start dropping
// gitignored / low-value files from those callers, so they get this neutral policy instead.
export function legacyDiscoveryPolicy(hasExplicitRelativePaths: boolean): SearchPolicy {
  return {
    mode: hasExplicitRelativePaths ? "explicit-scope" : "workspace-root-default",
    intent: "generic",
    applyGitignore: false,
    omitLowValueWorkspaceFiles: false,
  };
}

export function policyOmissionReason(
  scopePath: string,
  policy: SearchPolicy,
): CandidateOmissionReason | undefined {
  if (!policy.omitLowValueWorkspaceFiles) {
    return undefined;
  }
  if (isLockfile(scopePath) && policy.intent !== "project-metadata") {
    return "generated";
  }
  return hasLowValueSegment(scopePath) || isGeneratedArtifactPath(scopePath)
    ? "generated"
    : undefined;
}

export function extraIgnoreLinesForSearch(policy: SearchPolicy): readonly string[] {
  return policy.omitLowValueWorkspaceFiles ? LOW_VALUE_IGNORE_LINES : [];
}

export function orderCandidatesForSearch(
  files: readonly DiscoveredFile[],
  query: RetrievalQuery,
  policy: SearchPolicy,
  ignoredByDiscovery: number,
  deniedByDiscovery: number,
  depthPrunedByDiscovery = 0,
): CandidateOrderingResult {
  const ranked = rankCandidates(files, query, policy);
  const rankedCandidates: readonly RankedCandidateDiagnostic[] = ranked
    .slice(0, MAX_RANKED_CANDIDATE_DIAGNOSTICS)
    .map((candidate) => ({
      scopePath: candidate.file.relativePath,
      bucket: candidate.bucket,
      score: candidate.score,
      ecosystem: candidate.ecosystem,
      signals: candidate.signals,
    }));
  return {
    files: ranked.map((candidate) => candidate.file),
    diagnostics: {
      policyMode: policy.mode,
      intent: policy.intent,
      filesDiscovered: files.length,
      filesAfterPolicy: ranked.length,
      ignoredByDiscovery,
      deniedByDiscovery,
      depthPrunedByDiscovery,
      candidateBuckets: bucketCounts(ranked),
      rankedCandidates,
    },
  };
}

function semanticScoreByPath(
  matches: readonly SemanticSearchMatch[],
): ReadonlyMap<string, SemanticSearchMatch> {
  const out = new Map<string, SemanticSearchMatch>();
  for (const match of matches) {
    const current = out.get(match.scopePath);
    if (current === undefined || match.score > current.score) {
      out.set(match.scopePath, match);
    }
  }
  return out;
}

function semanticDiagnosticEntry(
  fused: ReturnType<typeof fuseLexicalAndSemanticRanks>[number],
  match: SemanticSearchMatch,
  current: RankedCandidateDiagnostic | undefined,
): RankedCandidateDiagnostic {
  const semanticSignals: readonly CandidateSignal[] = [
    { name: "semantic-score", value: match.score },
    ...fused.signals,
  ];
  return current === undefined
    ? {
        scopePath: fused.scopePath,
        bucket: candidateBucketForPath(fused.scopePath),
        score: match.score * 100 + fused.normalizedFusedScore,
        ecosystem: undefined,
        signals: semanticSignals,
      }
    : {
        ...current,
        score: Math.max(current.score, current.score + match.score * 10),
        signals: [...current.signals, ...semanticSignals],
      };
}

function compareRankedCandidateDiagnostic(
  a: RankedCandidateDiagnostic,
  b: RankedCandidateDiagnostic,
): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.scopePath < b.scopePath ? -1 : a.scopePath > b.scopePath ? 1 : 0;
}

export function withSemanticRankingDiagnostics(
  diagnostics: SearchDiagnostics,
  lexical: readonly { readonly scopePath: string; readonly score: number }[],
  matches: readonly SemanticSearchMatch[],
): SearchDiagnostics {
  if (matches.length === 0) {
    return diagnostics;
  }
  const semanticByPath = semanticScoreByPath(matches);
  const existing = new Map(diagnostics.rankedCandidates.map((entry) => [entry.scopePath, entry]));
  const fusion = fuseLexicalAndSemanticRanks(
    lexical,
    [...semanticByPath.values()].map((match) => ({
      scopePath: match.scopePath,
      score: match.score,
    })),
  );
  for (const fused of fusion) {
    const match = semanticByPath.get(fused.scopePath);
    if (match === undefined) {
      continue;
    }
    existing.set(
      fused.scopePath,
      semanticDiagnosticEntry(fused, match, existing.get(fused.scopePath)),
    );
  }
  return {
    ...diagnostics,
    rankedCandidates: [...existing.values()]
      .sort(compareRankedCandidateDiagnostic)
      .slice(0, MAX_RANKED_CANDIDATE_DIAGNOSTICS),
  };
}

export function shouldScoreContent(
  query: RetrievalQuery,
  text: string,
  policy: SearchPolicy,
): boolean {
  if (query.kind !== "natural-language" && query.kind !== "exact-symbol") {
    return true;
  }
  if (policy.intent === "repository-overview" || policy.intent === "project-metadata") {
    return true;
  }
  const haystack = query.caseSensitive ? text : text.toLowerCase();
  const terms =
    query.kind === "exact-symbol"
      ? [query.caseSensitive ? query.text : query.text.toLowerCase()]
      : naturalLanguageContentTerms(query.text, query.caseSensitive);
  return terms.length === 0 || terms.some((term) => haystack.includes(term));
}
