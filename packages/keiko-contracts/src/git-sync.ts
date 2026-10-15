// Git fetch/pull sync preview + execute wire contract (Issue #1573, Epic #1572).
// Pure types + validation helpers only: no filesystem, no process, no clock, no crypto.
// Reuses GitRepositoryState / GitUnavailableReason / GitRepositoryValidation from git-repository
// and GitUpstreamSummary from git-repository-summary.

import type {
  GitRepositoryState,
  GitUnavailableReason,
  GitRepositoryValidation,
  GitRepositoryParseResult,
} from "./git-repository.js";
import { GIT_REPOSITORY_STATES, isGitWireUnavailableReason } from "./git-repository.js";
import { isGitUpstreamSummary } from "./git-repository-summary.js";
import type { GitUpstreamSummary } from "./git-repository-summary.js";

export const GIT_SYNC_SCHEMA_VERSION = "1" as const;

export type GitSyncOperation = "fetch" | "pull";
// Object.freeze (KEIKO-0879): the `readonly GitSyncOperation[]` annotation is compile-time only.
export const GIT_SYNC_OPERATIONS: readonly GitSyncOperation[] = Object.freeze([
  "fetch",
  "pull",
] as const satisfies readonly GitSyncOperation[]);

// Evidence-friendly outcome taxonomy:
export type GitSyncOutcome =
  | "succeeded" // fetch ok / pull fast-forwarded
  | "up-to-date" // pull: already up to date
  | "no-remote"
  | "no-upstream"
  | "detached-head"
  | "dirty-worktree" // pull blocked: local changes would be overwritten
  | "not-fast-forward" // pull --ff-only refused
  | "authority-denied" // admitted authority changed or narrowed before remote dispatch
  | "auth-failed"
  | "untrusted-host-key"
  | "remote-unavailable" // the host could not be reached at all (DNS / refused / network down)
  | "timeout" // Keiko's own wall-clock budget fired
  | "output-truncated" // Keiko's own output byte cap cut the run — distinct from a timeout
  | "git-missing"
  | "unsafe-repository"
  | "git-error";
// Object.freeze (KEIKO-0879): the `readonly GitSyncOutcome[]` annotation is compile-time only.
export const GIT_SYNC_OUTCOMES: readonly GitSyncOutcome[] = Object.freeze([
  "succeeded",
  "up-to-date",
  "no-remote",
  "no-upstream",
  "detached-head",
  "dirty-worktree",
  "not-fast-forward",
  "authority-denied",
  "auth-failed",
  "untrusted-host-key",
  "remote-unavailable",
  "timeout",
  "output-truncated",
  "git-missing",
  "unsafe-repository",
  "git-error",
] as const satisfies readonly GitSyncOutcome[]);

// Preview blocked reasons (read-only readiness):
export type GitSyncBlockReason =
  | "no-remote"
  | "no-upstream"
  | "detached-head"
  | "git-missing"
  | "unsafe-repository"
  | "unavailable";
// Object.freeze (KEIKO-0879): the `readonly GitSyncBlockReason[]` annotation is compile-time only.
export const GIT_SYNC_BLOCK_REASONS: readonly GitSyncBlockReason[] = Object.freeze([
  "no-remote",
  "no-upstream",
  "detached-head",
  "git-missing",
  "unsafe-repository",
  "unavailable",
] as const satisfies readonly GitSyncBlockReason[]);

export interface GitSyncExecuteRequest {
  readonly schemaVersion: typeof GIT_SYNC_SCHEMA_VERSION;
  readonly projectId: string;
  readonly remote?: string | undefined; // optional remote alias; validated by isSafeGitRef
}

export interface GitSyncPreview {
  readonly schemaVersion: typeof GIT_SYNC_SCHEMA_VERSION;
  readonly operation: GitSyncOperation;
  readonly available: boolean;
  readonly state: GitRepositoryState;
  readonly reason?: GitUnavailableReason | "unsafe-repository" | "git-error" | undefined;
  readonly branch?: string | undefined;
  readonly detached: boolean;
  readonly upstream?: GitUpstreamSummary | undefined;
  readonly remote?: string | undefined;
  readonly ahead: number;
  readonly behind: number;
  readonly hasRemote: boolean;
  readonly hasUpstream: boolean;
  readonly dirty: boolean;
  readonly executable: boolean; // true when the op can run now
  readonly blockReason?: GitSyncBlockReason | undefined;
}

export interface GitSyncExecuteResponse {
  readonly schemaVersion: typeof GIT_SYNC_SCHEMA_VERSION;
  readonly operation: GitSyncOperation;
  readonly status: GitSyncOutcome;
  readonly available: boolean;
  readonly branch?: string | undefined;
  readonly upstream?: GitUpstreamSummary | undefined;
  readonly remote?: string | undefined;
  readonly ahead?: number | undefined; // ahead/behind AFTER the op when known
  readonly behind?: number | undefined;
  readonly truncated: boolean;
}

const GIT_REPOSITORY_STATES_VALUES: readonly unknown[] = GIT_REPOSITORY_STATES;
const GIT_SYNC_BLOCK_REASONS_VALUES: readonly unknown[] = GIT_SYNC_BLOCK_REASONS;
const GIT_SYNC_OUTCOMES_VALUES: readonly unknown[] = GIT_SYNC_OUTCOMES;

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

function rejectSyncField(reasons: string[], reason: string): false {
  reasons.push(reason);
  return false;
}

export function isGitSyncOperation(v: unknown): v is GitSyncOperation {
  return v === "fetch" || v === "pull";
}

export function isGitSyncOutcome(v: unknown): v is GitSyncOutcome {
  return typeof v === "string" && GIT_SYNC_OUTCOMES_VALUES.includes(v);
}

function validateSyncPreviewIdentity(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  if (input.schemaVersion !== GIT_SYNC_SCHEMA_VERSION)
    valid = rejectSyncField(reasons, "schemaVersion invalid");
  if (!isGitSyncOperation(input.operation)) valid = rejectSyncField(reasons, "operation invalid");
  if (!GIT_REPOSITORY_STATES_VALUES.includes(input.state)) {
    valid = rejectSyncField(reasons, "state invalid");
  }
  if (input.reason !== undefined && !isGitWireUnavailableReason(input.reason)) {
    valid = rejectSyncField(reasons, "reason invalid");
  }
  return valid;
}

function validateSyncPreviewBranchFields(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  for (const key of ["branch", "remote"] as const) {
    if (input[key] !== undefined && !isString(input[key])) {
      valid = rejectSyncField(reasons, `${key} must be a string when present`);
    }
  }
  if (input.upstream !== undefined && !isGitUpstreamSummary(input.upstream)) {
    valid = rejectSyncField(reasons, "upstream must be { ref, remote?, branch? } when present");
  }
  return valid;
}

function validateSyncPreviewFlags(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  for (const key of [
    "available",
    "detached",
    "hasRemote",
    "hasUpstream",
    "dirty",
    "executable",
  ] as const) {
    if (!isBoolean(input[key])) valid = rejectSyncField(reasons, `${key} must be a boolean`);
  }
  for (const key of ["ahead", "behind"] as const) {
    if (!isNonNegativeInteger(input[key]))
      valid = rejectSyncField(reasons, `${key} must be a non-negative integer`);
  }
  return valid;
}

// The producer (keiko-server syncExecution.ts buildSyncPreview) sets
// `executable: blockReason === undefined` directly, so the two fields are exact complements: an
// executable preview never carries a block reason, and a blocked one always does.
function validateSyncPreviewExecutableGate(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  if (
    input.blockReason !== undefined &&
    !GIT_SYNC_BLOCK_REASONS_VALUES.includes(input.blockReason)
  ) {
    valid = rejectSyncField(reasons, "blockReason invalid");
  }
  if (input.executable === true && input.blockReason !== undefined) {
    valid = rejectSyncField(reasons, "blockReason must be absent when executable is true");
  }
  if (input.executable === false && input.blockReason === undefined) {
    valid = rejectSyncField(reasons, "blockReason must be present when executable is false");
  }
  return valid;
}

// The preview is a read-only readiness envelope (branch/upstream/ahead/behind + executable gate);
// centralizing the validator keeps per-field failure messages predictable for callers.
function admitGitSyncPreview(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): input is Readonly<Record<string, unknown>> & GitSyncPreview {
  const identity = validateSyncPreviewIdentity(input, reasons);
  const branchFields = validateSyncPreviewBranchFields(input, reasons);
  const flags = validateSyncPreviewFlags(input, reasons);
  const gate = validateSyncPreviewExecutableGate(input, reasons);
  return identity && branchFields && flags && gate;
}

export function parseGitSyncPreview(input: unknown): GitRepositoryParseResult<GitSyncPreview> {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  return admitGitSyncPreview(input, reasons) ? { ok: true, value: input } : { ok: false, reasons };
}

export function validateGitSyncPreview(input: unknown): GitRepositoryValidation {
  const result = parseGitSyncPreview(input);
  return result.ok ? { ok: true } : result;
}

function validateSyncExecuteIdentity(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  if (input.schemaVersion !== GIT_SYNC_SCHEMA_VERSION)
    valid = rejectSyncField(reasons, "schemaVersion invalid");
  if (!isGitSyncOperation(input.operation)) valid = rejectSyncField(reasons, "operation invalid");
  if (!isGitSyncOutcome(input.status)) valid = rejectSyncField(reasons, "status invalid");
  return valid;
}

function validateSyncExecuteFlags(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  if (!isBoolean(input.available)) valid = rejectSyncField(reasons, "available must be a boolean");
  if (!isBoolean(input.truncated)) valid = rejectSyncField(reasons, "truncated must be a boolean");
  for (const key of ["ahead", "behind"] as const) {
    if (input[key] !== undefined && !isNonNegativeInteger(input[key])) {
      valid = rejectSyncField(reasons, `${key} must be a non-negative integer when present`);
    }
  }
  return valid;
}

function admitGitSyncExecuteResponse(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): input is Readonly<Record<string, unknown>> & GitSyncExecuteResponse {
  const identity = validateSyncExecuteIdentity(input, reasons);
  const flags = validateSyncExecuteFlags(input, reasons);
  const branchFields = validateSyncPreviewBranchFields(input, reasons);
  return identity && flags && branchFields;
}

export function parseGitSyncExecuteResponse(
  input: unknown,
): GitRepositoryParseResult<GitSyncExecuteResponse> {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  return admitGitSyncExecuteResponse(input, reasons)
    ? { ok: true, value: input }
    : { ok: false, reasons };
}

export function validateGitSyncExecuteResponse(input: unknown): GitRepositoryValidation {
  const result = parseGitSyncExecuteResponse(input);
  return result.ok ? { ok: true } : result;
}
