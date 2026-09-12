import { isValidScopePath } from "./connected-context.js";
import { regexSafetyIssue } from "./workspace-search.js";
import { WORKSPACE_PORTABLE_PATH_MAX_BYTES } from "./workspace-contract-primitives.js";

/** Handler limits; catalog identity and model-visible projection belong to #3406/#3414. */
export const CODING_REPOSITORY_LIMITS = Object.freeze({
  queryChars: 200,
  returnedHits: 50,
  scannedFiles: 2_000,
  fileBytes: 512 * 1024,
  elapsedMs: 5_000,
  snippetBytes: 512,
  outputBytes: 64 * 1024,
  globs: 32,
  globChars: 200,
  inventoryFiles: 50_000,
  yieldEvery: 32,
});

export type CodingRepositorySearchMode = "lexical" | "literal" | "regex" | "symbol";

export interface CodingRepositorySearchRequest {
  readonly kind: "search";
  readonly mode: CodingRepositorySearchMode;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
  readonly maxResults: number;
}

export interface CodingRepositoryReadRequest {
  readonly kind: "read";
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly maxBytes: number;
}

export type CodingRepositoryRequest = CodingRepositorySearchRequest | CodingRepositoryReadRequest;
export type CodingRepositoryFailureReason =
  | "invalid-request"
  | "authority-stale"
  | "backend-unavailable"
  | "scope-denied"
  | "file-too-large"
  | "file-unreadable"
  | "cancelled"
  | "timeout"
  | "failed";
export type CodingRepositoryTruncationReason =
  | "result-limit"
  | "file-limit"
  | "inventory-limit"
  | "output-limit"
  | "depth-limit"
  | "file-too-large";

/**
 * How a search's order was produced (#3416). Body-free by construction: a ranking label, an index
 * identity digest, counts and one closed reason -- never a query, a path, a snippet, a score or a
 * provider endpoint.
 */
export type CodingRepositoryRanking = "lexical" | "semantic" | "hybrid";

/**
 * Why a requested rerank did not happen. The first four are the retrieval path's own content-free
 * pod observations; the rest are the governance answers a run can carry. A rerank that does not
 * happen is never an error: the deterministic lexical order stands, and says so.
 */
export type CodingRepositoryRerankFallbackReason =
  | "capability-not-offered"
  | "provider-absent"
  | "pod-absent"
  | "pod-unavailable"
  | "pod-no-fresh-candidates"
  | "pod-query-failed"
  | "authority-denied"
  | "budget-exhausted";

export type CodingRepositoryIndexFreshness = "fresh" | "stale" | "absent";

export interface CodingRepositorySearchProvenance {
  readonly ranking: CodingRepositoryRanking;
  /** 64-hex identity of the index the rerank read, or `null` when no index was read. */
  readonly indexIdentityDigest: string | null;
  readonly indexFreshness: CodingRepositoryIndexFreshness;
  /** Hits the rerank placed, and hits left in the lexical order the handler produced. */
  readonly rerankedHits: number;
  readonly lexicalHits: number;
  readonly fallbackReason?: CodingRepositoryRerankFallbackReason | undefined;
}

export interface CodingRepositoryMetrics {
  readonly candidatesDiscovered: number;
  readonly filesScanned: number;
  readonly skippedFiles: number;
  readonly durationMs: number;
}

export interface CodingRepositoryHit {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly snippet: string;
  readonly redacted: boolean;
  readonly snippetTruncated: boolean;
}

interface CodingRepositorySuccess {
  readonly ok: true;
  readonly metrics: CodingRepositoryMetrics;
  readonly truncationReasons: readonly CodingRepositoryTruncationReason[];
}

export type CodingRepositoryResult =
  | (CodingRepositorySuccess & {
      readonly kind: "search";
      readonly hits: readonly CodingRepositoryHit[];
      // Set where the index facts are known -- the governed server port that may rerank (#3416) --
      // never by the workspace handler, which has neither an index nor an authority to ask.
      readonly provenance?: CodingRepositorySearchProvenance | undefined;
    })
  | (CodingRepositorySuccess & { readonly kind: "read"; readonly excerpt: CodingRepositoryHit })
  | { readonly ok: false; readonly reason: CodingRepositoryFailureReason };

function ownDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === null || prototype === Object.prototype) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (entry) => "value" in entry && entry.enumerable === true,
    )
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0 && value <= maximum;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}

function validGlobs(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    value.length <= CODING_REPOSITORY_LIMITS.globs &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Object.keys(value).length === value.length &&
    Object.keys(value).every((key, index) => key === String(index)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => "value" in entry) &&
    value.every(
      (glob: unknown) =>
        typeof glob === "string" &&
        glob.length > 0 &&
        glob.length <= CODING_REPOSITORY_LIMITS.globChars &&
        !hasControlCharacter(glob) &&
        !glob.startsWith("/") &&
        !glob.startsWith("~") &&
        !glob.includes(":") &&
        !glob.includes("\\") &&
        !glob.split("/").some((segment) => segment === "." || segment === ".."),
    )
  );
}

function validQuery(query: unknown, mode: unknown): boolean {
  if (
    typeof query !== "string" ||
    query.trim().length === 0 ||
    query.length > CODING_REPOSITORY_LIMITS.queryChars
  )
    return false;
  if (typeof mode !== "string" || !new Set(["lexical", "literal", "regex", "symbol"]).has(mode))
    return false;
  if (mode === "symbol" && /\s/u.test(query)) return false;
  return mode !== "regex" || regexSafetyIssue(query) === undefined;
}

function validSearch(value: Record<string, unknown>): boolean {
  if (
    !exactKeys(value, [
      "kind",
      "mode",
      "query",
      "caseSensitive",
      "includeGlobs",
      "excludeGlobs",
      "maxResults",
    ])
  )
    return false;
  if (!validQuery(value.query, value.mode)) return false;
  return (
    typeof value.caseSensitive === "boolean" &&
    boundedInteger(value.maxResults, CODING_REPOSITORY_LIMITS.returnedHits) &&
    validGlobs(value.includeGlobs) &&
    validGlobs(value.excludeGlobs) &&
    value.includeGlobs.length + value.excludeGlobs.length <= CODING_REPOSITORY_LIMITS.globs
  );
}

function validRead(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["kind", "path", "startLine", "endLine", "maxBytes"]) &&
    typeof value.path === "string" &&
    new TextEncoder().encode(value.path).length <= WORKSPACE_PORTABLE_PATH_MAX_BYTES &&
    isValidScopePath(value.path, { mustBeRelative: true }) &&
    boundedInteger(value.startLine, Number.MAX_SAFE_INTEGER) &&
    boundedInteger(value.endLine, Number.MAX_SAFE_INTEGER) &&
    value.endLine >= value.startLine &&
    boundedInteger(value.maxBytes, CODING_REPOSITORY_LIMITS.outputBytes)
  );
}

export function isCodingRepositoryRequest(value: unknown): value is CodingRepositoryRequest {
  if (!ownDataRecord(value)) return false;
  return value.kind === "search" ? validSearch(value) : value.kind === "read" && validRead(value);
}

/** Capture caller-owned data before authority checks or asynchronous workspace work. */
export function captureCodingRepositoryRequest(
  value: unknown,
): CodingRepositoryRequest | undefined {
  if (!isCodingRepositoryRequest(value)) return undefined;
  return value.kind === "read"
    ? Object.freeze({ ...value })
    : Object.freeze({
        ...value,
        includeGlobs: Object.freeze([...value.includeGlobs]),
        excludeGlobs: Object.freeze([...value.excludeGlobs]),
      });
}

const CODING_REPOSITORY_RANKINGS: ReadonlySet<string> = new Set<CodingRepositoryRanking>([
  "lexical",
  "semantic",
  "hybrid",
]);
const CODING_REPOSITORY_INDEX_FRESHNESS: ReadonlySet<string> =
  new Set<CodingRepositoryIndexFreshness>(["fresh", "stale", "absent"]);
const CODING_REPOSITORY_RERANK_FALLBACK_REASONS: ReadonlySet<string> =
  new Set<CodingRepositoryRerankFallbackReason>([
    "capability-not-offered",
    "provider-absent",
    "pod-absent",
    "pod-unavailable",
    "pod-no-fresh-candidates",
    "pod-query-failed",
    "authority-denied",
    "budget-exhausted",
  ]);
const PROVENANCE_KEYS = [
  "ranking",
  "indexIdentityDigest",
  "indexFreshness",
  "rerankedHits",
  "lexicalHits",
] as const;

function hitCount(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    typeof value === "number" &&
    value >= 0 &&
    value <= CODING_REPOSITORY_LIMITS.returnedHits
  );
}

// Each half of the disclosure answers one question, the way this file already validates a request
// (`validQuery`, `validGlobs`, `validSearch`): a reader can see which one refused.
function provenanceVocabularyValid(value: Record<string, unknown>): boolean {
  return (
    typeof value.ranking === "string" &&
    CODING_REPOSITORY_RANKINGS.has(value.ranking) &&
    typeof value.indexFreshness === "string" &&
    CODING_REPOSITORY_INDEX_FRESHNESS.has(value.indexFreshness)
  );
}

function provenanceIdentityValid(value: Record<string, unknown>): boolean {
  if (value.indexIdentityDigest === null) return true;
  return (
    typeof value.indexIdentityDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(value.indexIdentityDigest)
  );
}

function provenanceReasonValid(value: Record<string, unknown>, declared: boolean): boolean {
  if (!declared) return true;
  return (
    typeof value.fallbackReason === "string" &&
    CODING_REPOSITORY_RERANK_FALLBACK_REASONS.has(value.fallbackReason)
  );
}

function provenanceCountsValid(value: Record<string, unknown>): boolean {
  return hitCount(value.rerankedHits) && hitCount(value.lexicalHits);
}

// The two ways a disclosure can contradict itself: a lexical order that claims reranked hits, and a
// stated fallback reason beside a rerank that did happen. Either one makes the record unreadable to
// the operator it exists for, so it is refused rather than reported.
function provenanceConsistent(value: Record<string, unknown>, declared: boolean): boolean {
  if (value.ranking === "lexical") return value.rerankedHits === 0;
  return !declared;
}

/**
 * Validates a disclosure: the closed vocabularies, the index identity, the counts, and the two ways
 * the record could contradict itself. Shape and consistency only -- never a limit the producing
 * port already enforced.
 */
export function isCodingRepositorySearchProvenance(
  value: unknown,
): value is CodingRepositorySearchProvenance {
  if (!ownDataRecord(value)) return false;
  const declared = Object.hasOwn(value, "fallbackReason");
  return (
    exactKeys(value, declared ? [...PROVENANCE_KEYS, "fallbackReason"] : PROVENANCE_KEYS) &&
    provenanceVocabularyValid(value) &&
    provenanceIdentityValid(value) &&
    provenanceReasonValid(value, declared) &&
    provenanceCountsValid(value) &&
    provenanceConsistent(value, declared)
  );
}
