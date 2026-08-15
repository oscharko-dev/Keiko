// Read-only Git commit history wire contract (Issue #1573, Epic #1572).
// Pure types + validation helpers only: no filesystem, no process, no clock, no crypto.
// Reuses GitRepositoryState / GitUnavailableReason / GitRepositoryValidation from git-repository.

import type {
  GitRepositoryState,
  GitUnavailableReason,
  GitRepositoryValidation,
} from "./git-repository.js";
import {
  GIT_REPOSITORY_STATES,
  isBoundedGitMessage,
  isGitWireUnavailableReason,
} from "./git-repository.js";

export const GIT_HISTORY_SCHEMA_VERSION = "1" as const;

export interface GitHistoryEntry {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string; // strict ISO 8601 (author date, %aI)
  readonly refs: readonly string[]; // decoration names, e.g. ["HEAD -> main","origin/main"]
  readonly parentCount: number;
  readonly changedFileCount: number;
}

export interface GitHistoryResponse {
  readonly schemaVersion: typeof GIT_HISTORY_SCHEMA_VERSION;
  readonly root: string;
  readonly repositoryRoot?: string | undefined;
  readonly state: GitRepositoryState;
  readonly available: boolean;
  readonly reason?: GitUnavailableReason | "unsafe-repository" | "git-error" | undefined;
  readonly message?: string | undefined;
  readonly entries: readonly GitHistoryEntry[];
  readonly limit: number;
  readonly skip: number;
  readonly truncated: boolean;
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isString(input: unknown): input is string {
  return typeof input === "string";
}

function isBoolean(input: unknown): input is boolean {
  return typeof input === "boolean";
}

function isNonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input) && input >= 0;
}

function validateRefs(input: unknown, reasons: string[], index: number): void {
  if (!Array.isArray(input)) {
    reasons.push(`entries[${String(index)}].refs must be an array`);
    return;
  }
  if (!input.every(isString)) {
    reasons.push(`entries[${String(index)}].refs must contain only strings`);
  }
}

// `%aI` ("strict ISO 8601", the pretty-format git-history's producer uses for the author date)
// renders a UTC instant with a literal `Z` and any other offset as numeric `+HH:MM`/`-HH:MM` --
// confirmed empirically (git commit with GIT_AUTHOR_DATE=...+00:00 logs `%aI` as `...Z`, not
// `...+00:00`). Calendar validity is checked component-wise via Date.UTC rather than round-tripping
// toISOString(), because toISOString() always normalizes to a "Z"-suffixed UTC string: comparing it
// back against a non-UTC-offset input would reject every legitimately-offset date, not just invalid
// calendar dates like 2023-02-30 (which Date.parse silently rolls over to March 2 instead of
// rejecting).
const STRICT_ISO_AUTHOR_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:Z|[+-]\d{2}:\d{2})$/u;

function isStrictIsoAuthorDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = STRICT_ISO_AUTHOR_DATE_PATTERN.exec(value);
  if (match === null) return false;
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const asUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day &&
    asUtc.getUTCHours() === hour &&
    asUtc.getUTCMinutes() === minute &&
    asUtc.getUTCSeconds() === second
  );
}

function validateEntry(input: unknown, reasons: string[], index: number): void {
  if (!isRecord(input)) {
    reasons.push(`entries[${String(index)}] must be an object`);
    return;
  }
  for (const key of ["sha", "shortSha", "subject", "author"] as const) {
    if (!isString(input[key])) reasons.push(`entries[${String(index)}].${key} must be a string`);
  }
  if (!isStrictIsoAuthorDate(input.date)) {
    reasons.push(`entries[${String(index)}].date must be a strict ISO 8601 date`);
  }
  for (const key of ["parentCount", "changedFileCount"] as const) {
    if (!isNonNegativeInteger(input[key])) {
      reasons.push(`entries[${String(index)}].${key} must be a non-negative integer`);
    }
  }
  validateRefs(input.refs, reasons, index);
}

function validateHistoryIdentity(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  if (input.schemaVersion !== GIT_HISTORY_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isString(input.root)) reasons.push("root must be a string");
  if (!GIT_REPOSITORY_STATES.includes(input.state as GitRepositoryState)) {
    reasons.push("state invalid");
  }
}

function validateHistoryOptionalEnvelope(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  if (input.reason !== undefined && !isGitWireUnavailableReason(input.reason)) {
    reasons.push("reason invalid");
  }
  if (input.message !== undefined && !isBoundedGitMessage(input.message)) {
    reasons.push("message must be a bounded string when present");
  }
  if (input.repositoryRoot !== undefined && !isString(input.repositoryRoot)) {
    reasons.push("repositoryRoot must be a string when present");
  }
}

function validateHistoryFlags(input: Readonly<Record<string, unknown>>, reasons: string[]): void {
  if (!isBoolean(input.available)) reasons.push("available must be a boolean");
  if (!isBoolean(input.truncated)) reasons.push("truncated must be a boolean");
  if (!isNonNegativeInteger(input.limit)) reasons.push("limit must be a non-negative integer");
  if (!isNonNegativeInteger(input.skip)) reasons.push("skip must be a non-negative integer");
}

function validateHistoryEnvelopeFields(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  validateHistoryIdentity(input, reasons);
  validateHistoryOptionalEnvelope(input, reasons);
  validateHistoryFlags(input, reasons);
}

// The producer (keiko-server gitRepositoryReads.ts handleGitHistory) runs `git log
// --max-count=<limit>`, so entries.length can never exceed limit, and it always computes
// `truncated = result.truncated || entries.length === limit` -- hitting the cap ALWAYS marks
// truncated (a conservative "there might be more" even on the rare exact-count boundary), unlike
// git-repository.ts's changes/maxChanges where the analogous over-cap comparison can legitimately
// land on the boundary with truncated: false. Both directions are safe to check here. The route's
// own query-param parser floors `limit` at 1, so `limit === 0` never reaches the wire in practice;
// the guard below leaves that theoretical case (0 requested, 0 returned) unchecked rather than
// asserting a debatable invariant for input the producer cannot emit.
function validateEntriesBoundedByLimit(
  entries: readonly unknown[],
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  if (!isNonNegativeInteger(input.limit) || input.limit <= 0) return;
  if (entries.length > input.limit) {
    reasons.push("entries.length must not exceed limit");
  } else if (entries.length === input.limit && input.truncated !== true) {
    reasons.push("truncated must be true when entries.length equals limit");
  }
}

function validateHistoryEntries(input: Readonly<Record<string, unknown>>, reasons: string[]): void {
  if (!Array.isArray(input.entries)) {
    reasons.push("entries must be an array");
    return;
  }
  input.entries.forEach((entry, index) => {
    validateEntry(entry, reasons, index);
  });
  validateEntriesBoundedByLimit(input.entries, input, reasons);
}

// History is a paginated wire envelope (entries + limit/skip/truncated); centralizing the
// validator keeps per-field failure messages predictable for tests and callers.
export function validateGitHistoryResponse(input: unknown): GitRepositoryValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  validateHistoryEnvelopeFields(input, reasons);
  validateHistoryEntries(input, reasons);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
