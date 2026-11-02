// Read-only Git commit history wire contract (Issue #1573, Epic #1572).
// Pure types + validation helpers only: no filesystem, no process, no clock, no crypto.
// Reuses GitRepositoryState / GitUnavailableReason / GitRepositoryValidation from git-repository.

import type {
  GitRepositoryState,
  GitUnavailableReason,
  GitRepositoryValidation,
  GitRepositoryParseResult,
} from "./git-repository.js";
import {
  gitWireValidationVerdict,
  parseGitWireResponse,
  isGitWireRecord as isRecord,
  isString,
  isGitWireBoolean as isBoolean,
  isGitWireNonNegativeInteger as isNonNegativeInteger,
  rejectGitEnvelopeField as rejectHistoryField,
  validateGitReadIdentity,
  validateGitWireEnvelopeOptionals,
} from "./git-wire-envelope-validation.js";

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

function validateRefs(input: unknown, reasons: string[], index: number): boolean {
  if (!Array.isArray(input))
    return rejectHistoryField(reasons, `entries[${String(index)}].refs must be an array`);
  const refs: readonly unknown[] = input;
  const length = refs.length;
  for (let position = 0; position < length; position += 1) {
    if (!isString(refs[position]))
      return rejectHistoryField(
        reasons,
        `entries[${String(index)}].refs must contain only strings`,
      );
  }
  return true;
}

// `%aI` ("strict ISO 8601", the pretty-format git-history's producer uses for the author date)
// renders a UTC instant with a literal `Z` and any other offset as numeric `+HH:MM`/`-HH:MM` --
// confirmed empirically (git commit with GIT_AUTHOR_DATE=...+00:00 logs `%aI` as `...Z`, not
// `...+00:00`). Calendar validity is checked component-wise via Date.UTC rather than round-tripping
// toISOString(), because toISOString() always normalizes to a "Z"-suffixed UTC string: comparing it
// back against a non-UTC-offset input would reject every legitimately-offset date, not just invalid
// calendar dates like 2023-02-30 (which Date.parse silently rolls over to March 2 instead of
// rejecting).
// The offset group captures its sign, hour, and minute separately (rather than matching
// `[+-]\d{2}:\d{2}` as one opaque unit) so a numeric offset's own range can be checked below --
// `\d{2}` alone accepts "99", but no real UTC offset reaches even 24 hours.
const STRICT_ISO_AUTHOR_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:Z|([+-])(\d{2}):(\d{2}))$/u;

// A numeric offset (offsetSign defined) must itself be a plausible HH:MM duration -- matching what
// native Date parsing accepts (confirmed empirically: +23:59 parses, +24:00 and +13:60 do not) --
// so a value like "+99:99" fails here instead of passing with its offset silently ignored by the
// calendar-component check in isStrictIsoAuthorDate.
function isPlausibleUtcOffset(match: RegExpExecArray): boolean {
  const [, , , , , , , offsetSign, offsetHour, offsetMinute] = match;
  if (offsetSign === undefined) return true; // the "Z" branch matched; no numeric offset to check
  return Number(offsetHour ?? "") <= 23 && Number(offsetMinute ?? "") <= 59;
}

function isStrictIsoAuthorDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = STRICT_ISO_AUTHOR_DATE_PATTERN.exec(value);
  if (match === null) return false;
  if (!isPlausibleUtcOffset(match)) return false;
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

function validateEntry(input: unknown, reasons: string[], index: number): boolean {
  let valid = true;
  if (!isRecord(input)) {
    return rejectHistoryField(reasons, `entries[${String(index)}] must be an object`);
  }
  for (const key of ["sha", "shortSha", "subject", "author"] as const) {
    if (!isString(input[key]))
      valid = rejectHistoryField(reasons, `entries[${String(index)}].${key} must be a string`);
  }
  if (!isStrictIsoAuthorDate(input.date)) {
    valid = rejectHistoryField(
      reasons,
      `entries[${String(index)}].date must be a strict ISO 8601 date`,
    );
  }
  for (const key of ["parentCount", "changedFileCount"] as const) {
    if (!isNonNegativeInteger(input[key])) {
      valid = rejectHistoryField(
        reasons,
        `entries[${String(index)}].${key} must be a non-negative integer`,
      );
    }
  }
  return validateRefs(input.refs, reasons, index) && valid;
}

function validateHistoryFlags(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  if (!isBoolean(input.available))
    valid = rejectHistoryField(reasons, "available must be a boolean");
  if (!isBoolean(input.truncated))
    valid = rejectHistoryField(reasons, "truncated must be a boolean");
  if (!isNonNegativeInteger(input.limit))
    valid = rejectHistoryField(reasons, "limit must be a non-negative integer");
  if (!isNonNegativeInteger(input.skip))
    valid = rejectHistoryField(reasons, "skip must be a non-negative integer");
  return valid;
}

function validateHistoryEnvelopeFields(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  const identity = validateGitReadIdentity(input, reasons, GIT_HISTORY_SCHEMA_VERSION);
  const optional = validateGitWireEnvelopeOptionals(input, reasons, true);
  return validateHistoryFlags(input, reasons) && identity && optional;
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
): boolean {
  let valid = true;
  if (!isNonNegativeInteger(input.limit) || input.limit <= 0) return true;
  if (entries.length > input.limit) {
    valid = rejectHistoryField(reasons, "entries.length must not exceed limit");
  } else if (entries.length === input.limit && input.truncated !== true) {
    valid = rejectHistoryField(reasons, "truncated must be true when entries.length equals limit");
  }
  return valid;
}

function validateHistoryEntries(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  if (!Array.isArray(input.entries)) return rejectHistoryField(reasons, "entries must be an array");
  const entries: readonly unknown[] = input.entries;
  const length = entries.length;
  let valid = true;
  for (let index = 0; index < length; index += 1) {
    valid = validateEntry(entries[index], reasons, index) && valid;
  }
  return validateEntriesBoundedByLimit(input.entries, input, reasons) && valid;
}

function admitGitHistory(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): input is Readonly<Record<string, unknown>> & GitHistoryResponse {
  const envelope = validateHistoryEnvelopeFields(input, reasons);
  return validateHistoryEntries(input, reasons) && envelope;
}

export function parseGitHistoryResponse(
  input: unknown,
): GitRepositoryParseResult<GitHistoryResponse> {
  return parseGitWireResponse(input, admitGitHistory);
}

export function validateGitHistoryResponse(input: unknown): GitRepositoryValidation {
  return gitWireValidationVerdict(parseGitHistoryResponse(input));
}
