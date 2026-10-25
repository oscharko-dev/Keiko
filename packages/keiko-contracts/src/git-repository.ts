import {
  gitWireValidationVerdict,
  parseGitWireResponse,
  isGitWireRecord as isRecord,
  isString,
  isGitWireBoolean as isBoolean,
  isGitWireNonNegativeInteger as isNonNegativeInteger,
  rejectGitEnvelopeField as rejectGitField,
  validateGitReadIdentity,
  validateGitWireEnvelopeOptionals,
} from "./git-wire-envelope-validation.js";
import type {
  GitRepositoryState,
  GitUnavailableReason,
  GitRepositoryValidation,
  GitRepositoryParseResult,
} from "./git-wire-envelope-validation.js";
export {
  GIT_REPOSITORY_STATES,
  GIT_UNAVAILABLE_REASONS,
  GIT_MESSAGE_MAX_CHARS,
  isBoundedGitMessage,
  isGitWireUnavailableReason,
} from "./git-wire-envelope-validation.js";
export type {
  GitRepositoryValidationOk,
  GitRepositoryValidationFail,
  GitRepositoryValidation,
  GitRepositoryParseOk,
  GitRepositoryParseResult,
  GitRepositoryState,
  GitUnavailableReason,
  GitWireUnavailableReason,
} from "./git-wire-envelope-validation.js";

// Read-only Git repository status/diff wire contract (Issue #1386, Epic #1491).
// Pure types + validation helpers only: no filesystem, no process, no clock, no crypto.

export const GIT_REPOSITORY_SCHEMA_VERSION = "1" as const;

// The one git ref-name predicate in the repository. It used to live only in keiko-tools, where the
// packages that validate a ref BEFORE it reaches git — contracts among them — could not reach it,
// because contracts is the dependency leaf (ADR-0019). A second, weaker copy grew there and
// accepted refs (`main/`, `main.`, `.hidden`) that git itself refuses, so a snapshot could pass
// contract validation and then be rejected at the git boundary. Consolidated here so both sides
// share one formula; keiko-tools imports it rather than restating it.
//
// Deliberately stricter than `git check-ref-format`: anything that could read as an option, a
// traversal, or a refspec/glob metacharacter is refused. It is NOT limited to the shapes Keiko
// derives, because a base branch is the user's own ref: the first allowlist accepted only
// `[A-Za-z0-9._/-]`, refused the customer branch `feat(GDZ-917)/...` as unsafe, and made the Coding
// Workbench unusable on that repository. The allowlist below adds the punctuation ordinary branch
// conventions use and that is inert everywhere a ref travels here: git receives every ref as one
// argv element, never through a shell, and these characters are neither URL syntax nor markup.
// Shell, URL and markup syntax stays refused even where git itself would accept it.
const SAFE_REF_CHARACTERS = /^[A-Za-z0-9._\-/()+@=,]+$/u;
const UNSAFE_REF_PREFIXES: readonly string[] = ["-", "/"];
const UNSAFE_REF_SUFFIXES: readonly string[] = ["/", "."];
const UNSAFE_REF_SUBSTRINGS: readonly string[] = ["..", "//", "@{"];
// Rules git applies to every slash-separated component rather than to the ref as a whole: no
// component may begin with a dot (`feature/.hidden`) or end with `.lock` (`a.lock/b`). Checking
// `.lock` against the whole ref only accepted `a.lock/b`, `x.lock/y/z` and `refs/heads/a.lock/b`,
// all of which `git check-ref-format --allow-onelevel` refuses. The trailing-dot rule is NOT in
// this list on purpose: git applies it to the whole ref only (`a.` is refused, `a./b` is not).
const UNSAFE_REF_COMPONENT_PREFIXES: readonly string[] = ["."];
const UNSAFE_REF_COMPONENT_SUFFIXES: readonly string[] = [".lock"];

function hasControlOrNul(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if ((value.codePointAt(index) ?? 0) <= 0x1f) return true;
  }
  return false;
}

function isUnsafeRefComponent(component: string): boolean {
  return (
    UNSAFE_REF_COMPONENT_PREFIXES.some((prefix) => component.startsWith(prefix)) ||
    UNSAFE_REF_COMPONENT_SUFFIXES.some((suffix) => component.endsWith(suffix))
  );
}

export function isSafeGitRefName(value: string): boolean {
  if (value.length === 0 || value.length > 255 || hasControlOrNul(value)) return false;
  if (UNSAFE_REF_PREFIXES.some((prefix) => value.startsWith(prefix))) return false;
  if (UNSAFE_REF_SUFFIXES.some((suffix) => value.endsWith(suffix))) return false;
  if (UNSAFE_REF_SUBSTRINGS.some((part) => value.includes(part))) return false;
  if (!SAFE_REF_CHARACTERS.test(value) || value === "@") return false;
  if (value.split("/").some(isUnsafeRefComponent)) return false;
  return !/[~^:?*[\\ ]/u.test(value);
}

/** A complete immutable Git object identity, never a ref, abbreviation or revision expression. */
export function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
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
  const codes: readonly string[] = GIT_STATUS_CODES;
  return typeof value === "string" && codes.includes(value);
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
  /** True when Git reports the selected directory itself as ignored. */
  readonly selectedRootIgnored?: boolean | undefined;
  /** Fully untracked directories, omitted when either source listing is incomplete. */
  readonly untrackedDirectories?: readonly string[] | undefined;
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

function validateChange(input: unknown, reasons: string[], index: number): input is GitChangedFile {
  if (!isRecord(input)) {
    return rejectGitField(reasons, `changes[${String(index)}] must be an object`);
  }
  let valid = true;
  if (!isString(input.path))
    valid = rejectGitField(reasons, `changes[${String(index)}].path must be a string`);
  for (const key of ["indexStatus", "worktreeStatus"] as const) {
    if (!isGitStatusCode(input[key])) {
      valid = rejectGitField(
        reasons,
        `changes[${String(index)}].${key} must be one of the closed git status codes`,
      );
    }
  }
  for (const key of ["staged", "unstaged", "untracked", "conflicted"] as const) {
    if (!isBoolean(input[key]))
      valid = rejectGitField(reasons, `changes[${String(index)}].${key} must be a boolean`);
  }
  if (input.oldPath !== undefined && !isString(input.oldPath)) {
    valid = rejectGitField(
      reasons,
      `changes[${String(index)}].oldPath must be a string when present`,
    );
  }
  return valid;
}

function validateStatusCounters(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  if (!isBoolean(input.available)) valid = rejectGitField(reasons, "available must be a boolean");
  if (!isBoolean(input.detached)) valid = rejectGitField(reasons, "detached must be a boolean");
  if (!isBoolean(input.clean)) valid = rejectGitField(reasons, "clean must be a boolean");
  for (const key of [
    "stagedCount",
    "unstagedCount",
    "untrackedCount",
    "conflictedCount",
    "maxChanges",
  ] as const) {
    if (!isNonNegativeInteger(input[key]))
      valid = rejectGitField(reasons, `${key} must be a non-negative integer`);
  }
  if (!isBoolean(input.truncated)) valid = rejectGitField(reasons, "truncated must be a boolean");
  return valid;
}

// The producer (keiko-server gitRoutes.ts collectStatusChanges) never pushes past maxChanges --
// `if (changes.length < maxChanges) changes.push(...)` hard-caps the array -- so exceeding it is
// always invalid. Unlike git-history's entries/limit, hitting the cap here does NOT reliably imply
// `truncated: true`: computeStatusTruncated compares the raw NUL-separated porcelain record count
// (which over-counts by one extra record per rename/copy entry) against maxChanges, so a status with
// exactly maxChanges real changes and zero renames legitimately reports `truncated: false`. Only the
// one-directional bound is safe to enforce here.
function validateChangesArray(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  if (!Array.isArray(input.changes)) return rejectGitField(reasons, "changes must be an array");
  const changes: readonly unknown[] = input.changes;
  const length = changes.length;
  let valid = true;
  // Inspect each position, including holes; caller-owned forEach cannot authorize unchecked items.
  for (let index = 0; index < length; index += 1) {
    valid = validateChange(changes[index], reasons, index) && valid;
  }
  if (isNonNegativeInteger(input.maxChanges) && input.changes.length > input.maxChanges) {
    valid = rejectGitField(reasons, "changes.length must not exceed maxChanges");
  }
  return valid;
}

function areGitDirectories(input: readonly unknown[]): input is readonly string[] {
  const length = input.length;
  for (let index = 0; index < length; index += 1) {
    if (!isString(input[index])) return false;
  }
  return true;
}

function validateStatusPresentation(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  if (input.selectedRootIgnored !== undefined && !isBoolean(input.selectedRootIgnored)) {
    valid = rejectGitField(reasons, "selectedRootIgnored must be a boolean when present");
  }
  if (
    input.untrackedDirectories !== undefined &&
    (!Array.isArray(input.untrackedDirectories) ||
      !areGitDirectories(input.untrackedDirectories) ||
      (isNonNegativeInteger(input.maxChanges) &&
        input.untrackedDirectories.length > input.maxChanges))
  ) {
    valid = rejectGitField(
      reasons,
      "untrackedDirectories must be a bounded string array when present",
    );
  }
  return valid;
}

function admitGitStatusResponse(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): input is Readonly<Record<string, unknown>> & GitRepositoryStatusResponse {
  let valid = validateGitReadIdentity(input, reasons, GIT_REPOSITORY_SCHEMA_VERSION);
  valid = validateGitWireEnvelopeOptionals(input, reasons, true) && valid;
  if (input.branch !== undefined && !isString(input.branch)) {
    valid = rejectGitField(reasons, "branch must be a string when present");
  }
  valid = validateStatusCounters(input, reasons) && valid;
  valid = validateChangesArray(input, reasons) && valid;
  return validateStatusPresentation(input, reasons) && valid;
}

export function parseGitRepositoryStatusResponse(
  input: unknown,
): GitRepositoryParseResult<GitRepositoryStatusResponse> {
  return parseGitWireResponse(input, admitGitStatusResponse);
}

// Keep the existing verdict-only API while both public paths share the same concrete admission.
export function validateGitRepositoryStatusResponse(input: unknown): GitRepositoryValidation {
  return gitWireValidationVerdict(parseGitRepositoryStatusResponse(input));
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
): boolean {
  if (!isString(input.diff) || !isNonNegativeInteger(input.maxBytes)) return true;
  let valid = true;
  const actualBytes = TEXT_ENCODER.encode(input.diff).length;
  if (actualBytes > input.maxBytes && input.truncated !== true) {
    valid = rejectGitField(reasons, "truncated must be true when diff exceeds maxBytes");
  }
  // `truncated: true` describes that the SOURCE was cut, not a waiver on the OUTPUT bound: a
  // hostile response could otherwise claim truncated: true and carry a diff of any size. The
  // producer's own truncation can legitimately overshoot maxBytes by at most
  // GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES (see its derivation above); anything past that is not a
  // truncation artifact.
  if (actualBytes > input.maxBytes + GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES) {
    valid = rejectGitField(
      reasons,
      `diff must not exceed maxBytes by more than ${String(GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES)} bytes`,
    );
  }
  return valid;
}

function validateDiffOptionalEnvelope(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = validateGitWireEnvelopeOptionals(input, reasons, false);
  if (input.path !== undefined && !isString(input.path))
    valid = rejectGitField(reasons, "path must be a string");
  return valid;
}

function isGitDiffScope(input: unknown): input is GitDiffScope {
  return input === "all" || input === "worktree" || input === "staged";
}

function validateDiffRequiredFields(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  if (!isBoolean(input.available)) valid = rejectGitField(reasons, "available must be a boolean");
  if (!isGitDiffScope(input.scope)) valid = rejectGitField(reasons, "scope invalid");
  if (!isString(input.diff)) valid = rejectGitField(reasons, "diff must be a string");
  if (!isBoolean(input.truncated)) valid = rejectGitField(reasons, "truncated must be a boolean");
  if (!isNonNegativeInteger(input.maxBytes))
    valid = rejectGitField(reasons, "maxBytes must be a non-negative integer");
  return valid;
}

function validateDiffEnvelopeFields(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  const optional = validateDiffOptionalEnvelope(input, reasons);
  return validateDiffRequiredFields(input, reasons) && optional;
}

function admitGitDiffResponse(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): input is Readonly<Record<string, unknown>> & GitRepositoryDiffResponse {
  let valid = validateGitReadIdentity(input, reasons, GIT_REPOSITORY_SCHEMA_VERSION);
  valid = validateDiffEnvelopeFields(input, reasons) && valid;
  return validateDiffTruncationConsistency(input, reasons) && valid;
}

export function parseGitRepositoryDiffResponse(
  input: unknown,
): GitRepositoryParseResult<GitRepositoryDiffResponse> {
  return parseGitWireResponse(input, admitGitDiffResponse);
}

export function validateGitRepositoryDiffResponse(input: unknown): GitRepositoryValidation {
  return gitWireValidationVerdict(parseGitRepositoryDiffResponse(input));
}
