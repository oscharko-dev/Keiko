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
import { expandedQueryTerms } from "./repoSearchQueryTerms.js";
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
  readonly lowValueRescueFilesDiscovered?: number | undefined;
  readonly lowValueRescueFilesScanned?: number | undefined;
  readonly ignoredByDiscovery: number;
  readonly deniedByDiscovery: number;
  readonly depthPrunedByDiscovery: number;
  readonly maxFilesPrunedByDiscovery: number;
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
  "build",
  "coverage",
  "dist",
  "generated",
  "out",
  "storybook-static",
  "tmp",
]);

const LOW_VALUE_IGNORE_LINES: readonly string[] = Object.freeze([
  ".parcel-cache/",
  ".svelte-kit/",
  ".vercel/",
  "build/",
  "coverage/",
  "dist/",
  "generated/",
  "out/",
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
  return expandedQueryTerms(query.text, false);
}

const CONTENT_SCORE_STOP_TERMS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

const SHORT_CODE_TERMS: ReadonlySet<string> = new Set([
  "id",
  "url",
  "uri",
  "api",
  "jwt",
  "sql",
  "db",
  "ui",
  "io",
]);

function contentQueryTerms(query: RetrievalQuery): readonly string[] {
  return normalizedQueryTerms(query).filter((term) => {
    const lower = term.toLowerCase();
    return (
      !CONTENT_SCORE_STOP_TERMS.has(lower) &&
      (term.length >= 3 || SHORT_CODE_TERMS.has(lower))
    );
  });
}

function contentTokenSet(text: string, caseSensitive: boolean): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const raw of text.matchAll(/[\p{L}\p{N}_$]+/gu)) {
    const token = caseSensitive ? raw[0] : raw[0].toLowerCase();
    tokens.add(token);
    for (const part of raw[0].split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})/gu)) {
      if (part.length > 0) {
        tokens.add(caseSensitive ? part : part.toLowerCase());
      }
    }
  }
  return tokens;
}

interface ContentTermHits {
  readonly exactHits: number;
  readonly substringHits: number;
}

function exactSymbolContentBonus(query: RetrievalQuery, haystack: string): number {
  if (query.kind !== "exact-symbol") {
    return 0;
  }
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  return haystack.includes(needle) ? 45 : 0;
}

function countContentTermHits(
  terms: readonly string[],
  haystack: string,
  tokens: ReadonlySet<string>,
  caseSensitive: boolean,
): ContentTermHits {
  let exactHits = 0;
  let substringHits = 0;
  for (const term of terms) {
    const normalized = caseSensitive ? term : term.toLowerCase();
    if (tokens.has(normalized)) {
      exactHits += 1;
    } else if (normalized.length >= 4 && haystack.includes(normalized)) {
      substringHits += 1;
    }
  }
  return { exactHits, substringHits };
}

function contentTermScore(
  hits: ContentTermHits,
  termCount: number,
  exactSymbolBonus: number,
  intent: SearchIntent,
): number {
  if (hits.exactHits === 0 && hits.substringHits === 0) {
    return 0;
  }
  const coverage = (hits.exactHits + hits.substringHits * 0.5) / Math.max(termCount, 1);
  const intentMultiplier =
    intent === "targeted-code-search" || intent === "diagnostic-search" ? 1.15 : 1;
  const rawScore =
    hits.exactHits * 14 + hits.substringHits * 6 + coverage * 45 + exactSymbolBonus;
  return Math.min(140, Math.round(rawScore * intentMultiplier));
}

export function scoreContentForSearch(
  query: RetrievalQuery,
  text: string,
  policy: SearchPolicy,
): number {
  if (query.kind !== "natural-language" && query.kind !== "exact-symbol") {
    return 0;
  }
  if (text.length === 0) {
    return 0;
  }
  const terms = contentQueryTerms(query);
  if (terms.length === 0) {
    return 0;
  }
  const haystack = query.caseSensitive ? text : text.toLowerCase();
  const tokens = contentTokenSet(text, query.caseSensitive);
  return contentTermScore(
    countContentTermHits(terms, haystack, tokens, query.caseSensitive),
    terms.length,
    exactSymbolContentBonus(query, haystack),
    policy.intent,
  );
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

function pathTermBonus(scopePath: string, terms: readonly string[]): number {
  const path = normalizedPath(scopePath);
  const name = basename(path);
  const segments = pathSegments(path);
  let exactPath = 0;
  let basenameHit = 0;
  let segmentHit = 0;
  let substringHit = 0;
  for (const term of terms) {
    if (path === term || path.endsWith(`/${term}`)) {
      exactPath = Math.max(exactPath, 35);
    } else if (name === term || name.startsWith(`${term}.`)) {
      basenameHit = Math.max(basenameHit, 25);
    } else if (segments.includes(term)) {
      segmentHit = Math.max(segmentHit, 20);
    } else if (path.includes(term)) {
      substringHit = Math.max(substringHit, 12);
    }
  }
  return Math.min(50, exactPath + basenameHit + segmentHit + substringHit);
}

function depthPenalty(scopePath: string): number {
  return Math.min(pathSegments(scopePath).length, 12);
}

interface ScoredCandidate {
  readonly file: DiscoveredFile;
  readonly bucket: CandidateBucket;
  readonly score: number;
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
  contentScores: ReadonlyMap<string, number> | undefined,
): ScoredCandidate {
  const path = file.relativePath;
  const bucket = bucketByPath(path);
  const bucketWeight = bucketScore(bucket, policy.intent);
  const termBonus = pathTermBonus(path, terms);
  const contentScore = contentScores?.get(path) ?? 0;
  const depth = depthPenalty(path);
  const ecosystem = bucket === "canonical-metadata" ? canonicalMetadataEcosystem(path) : undefined;
  const signals: CandidateSignal[] = [
    { name: `bucket:${bucket}`, value: bucketWeight },
    { name: "path-term-bonus", value: termBonus },
    { name: "content-term-score", value: contentScore },
    { name: "depth-penalty", value: -depth },
  ];
  if (ecosystem !== undefined) {
    signals.push({ name: `ecosystem:${ecosystem}`, value: 1 });
  }
  return { file, bucket, score: bucketWeight + termBonus + contentScore - depth, signals, ecosystem };
}

function rankCandidates(
  files: readonly DiscoveredFile[],
  query: RetrievalQuery,
  policy: SearchPolicy,
  contentScores?: ReadonlyMap<string, number>,
): readonly ScoredCandidate[] {
  // Score each file ONCE (query tokenization + path bucketing are O(path) and were previously
  // recomputed twice per comparison — O(n log n) blocking work on the 2000-file candidate cap).
  // Tie-break on raw code-point order, not localeCompare, so evidence ordering is reproducible
  // across locales/ICU builds (regulated-delivery determinism).
  const terms = normalizedQueryTerms(query);
  const scored = files.map((file) => scoreCandidate(file, terms, policy, contentScores));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
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

export function lowValueRescuePolicy(policy: SearchPolicy): SearchPolicy {
  return {
    ...policy,
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
  maxFilesPrunedByDiscovery = 0,
  contentScores?: ReadonlyMap<string, number>,
): CandidateOrderingResult {
  const ranked = rankCandidates(files, query, policy, contentScores);
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
      maxFilesPrunedByDiscovery,
      candidateBuckets: bucketCounts(ranked),
      rankedCandidates,
    },
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
  const terms = normalizedQueryTerms(query).filter(
    (term) =>
      term.length >= 4 ||
      SHORT_CODE_TERMS.has(term.toLowerCase()),
  );
  return terms.length === 0 || terms.some((term) => haystack.includes(term));
}
