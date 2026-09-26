// Git fetch/pull sync preview + execute wire contract (Issue #1573, Epic #1572).
// Pure types + validation helpers only: no filesystem, no process, no clock, no crypto.
// Reuses GitRepositoryState / GitUnavailableReason / GitRepositoryValidation from git-repository
// and GitUpstreamSummary from git-repository-summary.

import type {
  GitRepositoryState,
  GitUnavailableReason,
  GitRepositoryValidation,
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

export function isGitSyncOperation(v: unknown): v is GitSyncOperation {
  return v === "fetch" || v === "pull";
}

export function isGitSyncOutcome(v: unknown): v is GitSyncOutcome {
  return typeof v === "string" && GIT_SYNC_OUTCOMES.includes(v as GitSyncOutcome);
}

function validateSyncPreviewIdentity(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  if (input.schemaVersion !== GIT_SYNC_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isGitSyncOperation(input.operation)) reasons.push("operation invalid");
  if (!GIT_REPOSITORY_STATES.includes(input.state as GitRepositoryState)) {
    reasons.push("state invalid");
  }
  if (input.reason !== undefined && !isGitWireUnavailableReason(input.reason)) {
    reasons.push("reason invalid");
  }
}

function validateSyncPreviewBranchFields(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  for (const key of ["branch", "remote"] as const) {
    if (input[key] !== undefined && !isString(input[key])) {
      reasons.push(`${key} must be a string when present`);
    }
  }
  if (input.upstream !== undefined && !isGitUpstreamSummary(input.upstream)) {
    reasons.push("upstream must be { ref, remote?, branch? } when present");
  }
}

function validateSyncPreviewFlags(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  for (const key of [
    "available",
    "detached",
    "hasRemote",
    "hasUpstream",
    "dirty",
    "executable",
  ] as const) {
    if (!isBoolean(input[key])) reasons.push(`${key} must be a boolean`);
  }
  for (const key of ["ahead", "behind"] as const) {
    if (!isNonNegativeInteger(input[key])) reasons.push(`${key} must be a non-negative integer`);
  }
}

// The producer (keiko-server syncExecution.ts buildSyncPreview) sets
// `executable: blockReason === undefined` directly, so the two fields are exact complements: an
// executable preview never carries a block reason, and a blocked one always does.
function validateSyncPreviewExecutableGate(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  if (
    input.blockReason !== undefined &&
    !GIT_SYNC_BLOCK_REASONS.includes(input.blockReason as GitSyncBlockReason)
  ) {
    reasons.push("blockReason invalid");
  }
  if (input.executable === true && input.blockReason !== undefined) {
    reasons.push("blockReason must be absent when executable is true");
  }
  if (input.executable === false && input.blockReason === undefined) {
    reasons.push("blockReason must be present when executable is false");
  }
}

// The preview is a read-only readiness envelope (branch/upstream/ahead/behind + executable gate);
// centralizing the validator keeps per-field failure messages predictable for callers.
export function validateGitSyncPreview(input: unknown): GitRepositoryValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  validateSyncPreviewIdentity(input, reasons);
  validateSyncPreviewBranchFields(input, reasons);
  validateSyncPreviewFlags(input, reasons);
  validateSyncPreviewExecutableGate(input, reasons);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// eslint-disable-next-line complexity
export function validateGitSyncExecuteResponse(input: unknown): GitRepositoryValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  if (input.schemaVersion !== GIT_SYNC_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isGitSyncOperation(input.operation)) reasons.push("operation invalid");
  if (!isGitSyncOutcome(input.status)) reasons.push("status invalid");
  if (!isBoolean(input.available)) reasons.push("available must be a boolean");
  if (!isBoolean(input.truncated)) reasons.push("truncated must be a boolean");
  for (const key of ["ahead", "behind"] as const) {
    if (input[key] !== undefined && !isNonNegativeInteger(input[key])) {
      reasons.push(`${key} must be a non-negative integer when present`);
    }
  }
  for (const key of ["branch", "remote"] as const) {
    if (input[key] !== undefined && !isString(input[key])) {
      reasons.push(`${key} must be a string when present`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
