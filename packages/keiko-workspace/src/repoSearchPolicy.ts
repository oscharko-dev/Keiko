import type {
  CandidateOmissionReason,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
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

export interface SearchDiagnostics {
  readonly policyMode: SearchPolicyMode;
  readonly intent: SearchIntent;
  readonly filesDiscovered: number;
  readonly filesAfterPolicy: number;
  readonly ignoredByDiscovery: number;
  readonly deniedByDiscovery: number;
  readonly candidateBuckets: Readonly<Record<CandidateBucket, number>>;
}

export interface CandidateOrderingResult {
  readonly files: readonly DiscoveredFile[];
  readonly diagnostics: SearchDiagnostics;
}

const METADATA_FILENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.build.json",
  "vite.config.ts",
  "vite.config.js",
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.ts",
  "jest.config.js",
  "playwright.config.ts",
  "playwright.config.js",
  "next.config.ts",
  "next.config.js",
  "eslint.config.ts",
  "eslint.config.js",
]);

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

const DOC_EXTENSIONS = new Set(["adoc", "md", "mdx", "rst", "txt"]);
const TEST_FILE_RE = /(?:^|[./_-])(?:test|spec|fixture|mock)s?(?:[./_-]|$)/iu;
// Identifier tokens with a SINGLE greedy quantifier — no two overlapping `[A-Za-z0-9_$]*` runs
// around `[A-Z]`, which is a polynomial-ReDoS shape on uncontrolled query text (CodeQL). The
// camelCase test (an uppercase at position >= 1) is applied separately as a constant-width probe.
const IDENTIFIER_TOKEN_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/gu;
const HAS_INNER_UPPERCASE_RE = /[A-Za-z0-9_$][A-Z]/u;
const TOKEN_RE = /[A-Za-z0-9_.-]{3,}/gu;

function emptyBucketCounts(): Record<CandidateBucket, number> {
  return {
    "canonical-metadata": 0,
    "overview-doc": 0,
    "exact-path": 0,
    "symbol-source": 0,
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
  return LOCKFILE_FILENAMES.has(basename(scopePath).toLowerCase());
}

function hasLowValueSegment(scopePath: string): boolean {
  return pathSegments(scopePath).some((segment) => LOW_VALUE_SEGMENTS.has(segment));
}

function normalizedQueryTerms(query: RetrievalQuery): readonly string[] {
  const terms = new Set<string>();
  for (const match of query.text.matchAll(TOKEN_RE)) {
    terms.add(match[0].toLowerCase());
  }
  for (const match of query.text.matchAll(IDENTIFIER_TOKEN_RE)) {
    if (HAS_INNER_UPPERCASE_RE.test(match[0])) {
      terms.add(match[0].toLowerCase());
    }
  }
  return [...terms];
}

function bucketByPath(scopePath: string): CandidateBucket {
  const path = normalizedPath(scopePath);
  const name = basename(path);
  const ext = extension(path);
  if (METADATA_FILENAMES.has(name)) {
    return "canonical-metadata";
  }
  if (OVERVIEW_FILENAMES.has(path) || OVERVIEW_FILENAMES.has(name)) {
    return "overview-doc";
  }
  if (isLockfile(path)) {
    return "lockfile";
  }
  if (hasLowValueSegment(path)) {
    return "low-value";
  }
  if (TEST_FILE_RE.test(path)) {
    return "test";
  }
  if (SOURCE_EXTENSIONS.has(ext)) {
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
  let score = 0;
  for (const term of terms) {
    if (name === term || name.startsWith(`${term}.`)) {
      score = Math.max(score, 25);
    } else if (path.includes(term)) {
      score = Math.max(score, 12);
    }
  }
  return score;
}

function depthPenalty(scopePath: string): number {
  return Math.min(pathSegments(scopePath).length, 12);
}

function priorityForFile(
  file: DiscoveredFile,
  terms: readonly string[],
  policy: SearchPolicy,
): number {
  return (
    bucketScore(bucketByPath(file.relativePath), policy.intent) +
    pathTermBonus(file.relativePath, terms) -
    depthPenalty(file.relativePath)
  );
}

function bucketCounts(files: readonly DiscoveredFile[]): Readonly<Record<CandidateBucket, number>> {
  const counts = emptyBucketCounts();
  for (const file of files) {
    counts[bucketByPath(file.relativePath)] += 1;
  }
  return counts;
}

function sortFiles(
  files: readonly DiscoveredFile[],
  query: RetrievalQuery,
  policy: SearchPolicy,
): readonly DiscoveredFile[] {
  // Score each file ONCE (query tokenization + path bucketing are O(path) and were previously
  // recomputed twice per comparison — O(n log n) blocking work on the 2000-file candidate cap).
  // Tie-break on raw code-point order, not localeCompare, so evidence ordering is reproducible
  // across locales/ICU builds (regulated-delivery determinism).
  const terms = normalizedQueryTerms(query);
  const scored = files.map((file) => ({ file, score: priorityForFile(file, terms, policy) }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.file.relativePath < b.file.relativePath) return -1;
    return a.file.relativePath > b.file.relativePath ? 1 : 0;
  });
  return scored.map((entry) => entry.file);
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
  return hasLowValueSegment(scopePath) ? "generated" : undefined;
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
): CandidateOrderingResult {
  const ordered = sortFiles(files, query, policy);
  return {
    files: ordered,
    diagnostics: {
      policyMode: policy.mode,
      intent: policy.intent,
      filesDiscovered: files.length,
      filesAfterPolicy: ordered.length,
      ignoredByDiscovery,
      deniedByDiscovery,
      candidateBuckets: bucketCounts(ordered),
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
  const terms = normalizedQueryTerms(query).filter((term) => term.length >= 4);
  return terms.length === 0 || terms.some((term) => haystack.includes(term));
}
