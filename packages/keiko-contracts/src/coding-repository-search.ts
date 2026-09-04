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
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return true;
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
