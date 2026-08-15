// Read-only Git repository status/diff wire contract (Issue #1386, Epic #1491).
// Pure types + validation helpers only: no filesystem, no process, no clock, no crypto.

export const GIT_REPOSITORY_SCHEMA_VERSION = "1" as const;

export const GIT_REPOSITORY_STATES = ["available", "unavailable", "unsafe", "error"] as const;
export type GitRepositoryState = (typeof GIT_REPOSITORY_STATES)[number];

export const GIT_UNAVAILABLE_REASONS = [
  "not-a-repository",
  "git-missing",
  "repository-root-outside-root",
  "unknown",
] as const;
export type GitUnavailableReason = (typeof GIT_UNAVAILABLE_REASONS)[number];

// The wire `reason` shape every git-*.ts response envelope declares: GitUnavailableReason widened
// with the two failure classes only the route layer can detect (unsafe ownership, a raw git error).
export type GitWireUnavailableReason = GitUnavailableReason | "unsafe-repository" | "git-error";

const GIT_WIRE_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  ...GIT_UNAVAILABLE_REASONS,
  "unsafe-repository",
  "git-error",
]);

// Shared by git-history.ts, git-repository-summary.ts, and git-sync.ts (KEIKO-0310): each of those
// declares the identical `reason?: GitWireUnavailableReason` field but, until this fix, none of the
// five validators in this file's territory checked it against the closed union at all.
export function isGitWireUnavailableReason(value: unknown): value is GitWireUnavailableReason {
  return typeof value === "string" && GIT_WIRE_UNAVAILABLE_REASONS.has(value);
}

// Shared bound for the free-text `message` field carried by GitHistoryResponse,
// GitRepositoryStatusResponse, and GitRepositorySummary. The real producer (keiko-server
// gitRoutes.ts genericUnavailable/unavailableBranchList) only ever assigns short, fixed English
// sentences (<100 chars); this cap is generous headroom for that, not a measured maximum, so a
// stricter validator here can never reject the current producer's output while still bounding a
// field the audit flagged as the one most likely to carry raw, unbounded git error/stderr text.
export const GIT_MESSAGE_MAX_CHARS = 1_024 as const;

export function isBoundedGitMessage(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= GIT_MESSAGE_MAX_CHARS &&
      !value.includes("\u0000"))
  );
}

export type GitStatusCode = " " | "M" | "A" | "D" | "R" | "C" | "U" | "?" | "!";

// KEIKO-0310: the runtime table for GitStatusCode used to exist only as a private copy inside
// editor-agent.ts (QUERY_GIT_STATUS_CODES) -- the type itself had no shared, exported runtime
// source of truth, so validateChange below validated indexStatus/worktreeStatus as bare strings.
// Exported from this file, the type's home module; editor-agent.ts now imports this instead of
// keeping its own copy that could silently drift from the type it is meant to enumerate.
export const GIT_STATUS_CODES: readonly GitStatusCode[] = [
  " ",
  "M",
  "A",
  "D",
  "R",
  "C",
  "U",
  "?",
  "!",
] as const;

function isGitStatusCode(value: unknown): value is GitStatusCode {
  return typeof value === "string" && (GIT_STATUS_CODES as readonly string[]).includes(value);
}

export interface GitChangedFile {
  readonly path: string;
  readonly oldPath?: string | undefined;
  readonly indexStatus: GitStatusCode;
  readonly worktreeStatus: GitStatusCode;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly conflicted: boolean;
}

export interface GitRepositoryStatusResponse {
  readonly schemaVersion: typeof GIT_REPOSITORY_SCHEMA_VERSION;
  readonly root: string;
  readonly repositoryRoot?: string | undefined;
  readonly state: GitRepositoryState;
  readonly available: boolean;
  readonly reason?: GitUnavailableReason | "unsafe-repository" | "git-error" | undefined;
  readonly message?: string | undefined;
  readonly branch?: string | undefined;
  readonly detached: boolean;
  readonly clean: boolean;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly conflictedCount: number;
  readonly changes: readonly GitChangedFile[];
  readonly truncated: boolean;
  readonly maxChanges: number;
}

export type GitDiffScope = "all" | "worktree" | "staged";

export interface GitRepositoryDiffResponse {
  readonly schemaVersion: typeof GIT_REPOSITORY_SCHEMA_VERSION;
  readonly root: string;
  readonly repositoryRoot?: string | undefined;
  readonly state: GitRepositoryState;
  readonly available: boolean;
  readonly reason?: GitUnavailableReason | "unsafe-repository" | "git-error" | undefined;
  readonly path?: string | undefined;
  readonly scope: GitDiffScope;
  readonly diff: string;
  readonly truncated: boolean;
  readonly maxBytes: number;
}

export interface GitRepositoryValidationOk {
  readonly ok: true;
}

export interface GitRepositoryValidationFail {
  readonly ok: false;
  readonly reasons: readonly string[];
}

export type GitRepositoryValidation = GitRepositoryValidationOk | GitRepositoryValidationFail;

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

const TEXT_ENCODER = new TextEncoder();

// The producer clamps `diff` to `maxBytes` by cutting the ENCODED byte buffer at an arbitrary
// offset and decoding it back to a string (Buffer.subarray(0, maxBytes).toString("utf8")), which
// can land inside a multi-byte UTF-8 sequence. The WHATWG UTF-8 decoder replaces an incomplete
// trailing sequence at end-of-input with exactly one U+FFFD replacement character, never more --
// that is the decoder's defined behaviour, not this codebase's own formula, so it cannot drift the
// way a hand-derived number could. U+FFFD itself encodes to 3 UTF-8 bytes (EF BF BD). The smallest
// number of bytes an "incomplete" trailing sequence can consist of is 1 (a lone leading byte of a
// 2/3/4-byte sequence): fewer than 1 byte isn't a sequence at all. So the worst case is a 1-byte
// remnant, still counted against maxBytes, replaced by the 3-byte replacement character on
// re-encode -- an overage of (replacement bytes) - (minimum remnant bytes).
const UTF8_REPLACEMENT_CHARACTER_BYTES = 3; // U+FFFD = EF BF BD
const MIN_INCOMPLETE_UTF8_SEQUENCE_BYTES = 1;
export const GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES =
  UTF8_REPLACEMENT_CHARACTER_BYTES - MIN_INCOMPLETE_UTF8_SEQUENCE_BYTES;

function validateChange(input: unknown, reasons: string[], index: number): void {
  if (!isRecord(input)) {
    reasons.push(`changes[${String(index)}] must be an object`);
    return;
  }
  if (!isString(input.path)) reasons.push(`changes[${String(index)}].path must be a string`);
  for (const key of ["indexStatus", "worktreeStatus"] as const) {
    if (!isGitStatusCode(input[key])) {
      reasons.push(`changes[${String(index)}].${key} must be one of the closed git status codes`);
    }
  }
  for (const key of ["staged", "unstaged", "untracked", "conflicted"] as const) {
    if (!isBoolean(input[key])) reasons.push(`changes[${String(index)}].${key} must be a boolean`);
  }
  if (input.oldPath !== undefined && !isString(input.oldPath)) {
    reasons.push(`changes[${String(index)}].oldPath must be a string when present`);
  }
}

// Fields every unavailable/available envelope in this file's territory shares: a closed-union
// `reason` and a bounded free-text `message`, both optional (KEIKO-0310).
function validateWireEnvelopeOptionals(
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

function validateStatusCounters(input: Readonly<Record<string, unknown>>, reasons: string[]): void {
  if (!isBoolean(input.available)) reasons.push("available must be a boolean");
  if (!isBoolean(input.detached)) reasons.push("detached must be a boolean");
  if (!isBoolean(input.clean)) reasons.push("clean must be a boolean");
  for (const key of [
    "stagedCount",
    "unstagedCount",
    "untrackedCount",
    "conflictedCount",
    "maxChanges",
  ] as const) {
    if (!isNonNegativeInteger(input[key])) reasons.push(`${key} must be a non-negative integer`);
  }
  if (!isBoolean(input.truncated)) reasons.push("truncated must be a boolean");
}

// The producer (keiko-server gitRoutes.ts collectStatusChanges) never pushes past maxChanges --
// `if (changes.length < maxChanges) changes.push(...)` hard-caps the array -- so exceeding it is
// always invalid. Unlike git-history's entries/limit, hitting the cap here does NOT reliably imply
// `truncated: true`: computeStatusTruncated compares the raw NUL-separated porcelain record count
// (which over-counts by one extra record per rename/copy entry) against maxChanges, so a status with
// exactly maxChanges real changes and zero renames legitimately reports `truncated: false`. Only the
// one-directional bound is safe to enforce here.
function validateChangesArray(input: Readonly<Record<string, unknown>>, reasons: string[]): void {
  if (!Array.isArray(input.changes)) {
    reasons.push("changes must be an array");
    return;
  }
  input.changes.forEach((change, index) => {
    validateChange(change, reasons, index);
  });
  if (isNonNegativeInteger(input.maxChanges) && input.changes.length > input.maxChanges) {
    reasons.push("changes.length must not exceed maxChanges");
  }
}

// Git status is a compact wire envelope with several required counters and flags; keeping the
// validator in one place makes failure messages predictable for tests and callers.
export function validateGitRepositoryStatusResponse(input: unknown): GitRepositoryValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  if (input.schemaVersion !== GIT_REPOSITORY_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isString(input.root)) reasons.push("root must be a string");
  if (!GIT_REPOSITORY_STATES.includes(input.state as GitRepositoryState)) {
    reasons.push("state invalid");
  }
  validateWireEnvelopeOptionals(input, reasons);
  if (input.branch !== undefined && !isString(input.branch)) {
    reasons.push("branch must be a string when present");
  }
  validateStatusCounters(input, reasons);
  validateChangesArray(input, reasons);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// The producer (keiko-server gitRoutes.ts handleGitDiff) always pre-clamps `diff` to at most
// `maxBytes` UTF-8 bytes before it reaches the wire, so this can only fire on a hostile or
// otherwise non-conforming payload -- which is exactly the point (git-editor.ts applies the
// identical truncated-vs-maxBytes consistency rule for its own diff/blame responses). Measured in
// UTF-8 bytes via TextEncoder, matching maxBytes' own unit -- `diff.length` (UTF-16 code units) is
// never greater than the UTF-8 byte count for the same string, so comparing length directly against
// a byte cap would silently under-detect for any non-ASCII diff content.
function validateDiffTruncationConsistency(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  if (!isString(input.diff) || !isNonNegativeInteger(input.maxBytes)) return;
  const actualBytes = TEXT_ENCODER.encode(input.diff).length;
  if (actualBytes > input.maxBytes && input.truncated !== true) {
    reasons.push("truncated must be true when diff exceeds maxBytes");
  }
  // `truncated: true` describes that the SOURCE was cut, not a waiver on the OUTPUT bound: a
  // hostile response could otherwise claim truncated: true and carry a diff of any size. The
  // producer's own truncation can legitimately overshoot maxBytes by at most
  // GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES (see its derivation above); anything past that is not a
  // truncation artifact.
  if (actualBytes > input.maxBytes + GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES) {
    reasons.push(
      `diff must not exceed maxBytes by more than ${String(GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES)} bytes`,
    );
  }
}

function validateDiffOptionalEnvelope(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  if (input.reason !== undefined && !isGitWireUnavailableReason(input.reason)) {
    reasons.push("reason invalid");
  }
  if (input.repositoryRoot !== undefined && !isString(input.repositoryRoot)) {
    reasons.push("repositoryRoot must be a string when present");
  }
  if (input.path !== undefined && !isString(input.path)) reasons.push("path must be a string");
}

function validateDiffRequiredFields(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  if (!isBoolean(input.available)) reasons.push("available must be a boolean");
  if (!["all", "worktree", "staged"].includes(String(input.scope))) reasons.push("scope invalid");
  if (!isString(input.diff)) reasons.push("diff must be a string");
  if (!isBoolean(input.truncated)) reasons.push("truncated must be a boolean");
  if (!isNonNegativeInteger(input.maxBytes))
    reasons.push("maxBytes must be a non-negative integer");
}

function validateDiffEnvelopeFields(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  validateDiffOptionalEnvelope(input, reasons);
  validateDiffRequiredFields(input, reasons);
}

export function validateGitRepositoryDiffResponse(input: unknown): GitRepositoryValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  if (input.schemaVersion !== GIT_REPOSITORY_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isString(input.root)) reasons.push("root must be a string");
  if (!GIT_REPOSITORY_STATES.includes(input.state as GitRepositoryState)) {
    reasons.push("state invalid");
  }
  validateDiffEnvelopeFields(input, reasons);
  validateDiffTruncationConsistency(input, reasons);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
