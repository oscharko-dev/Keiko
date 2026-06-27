// Git fetch/pull sync preview + execute wire contract (Issue #1573, Epic #1572).
// Pure types + validation helpers only: no filesystem, no process, no clock, no crypto.
// Reuses GitRepositoryState / GitUnavailableReason / GitRepositoryValidation from git-repository
// and GitUpstreamSummary from git-repository-summary.

import type {
  GitRepositoryState,
  GitUnavailableReason,
  GitRepositoryValidation,
} from "./git-repository.js";
import { GIT_REPOSITORY_STATES } from "./git-repository.js";
import type { GitUpstreamSummary } from "./git-repository-summary.js";

export const GIT_SYNC_SCHEMA_VERSION = "1" as const;

export type GitSyncOperation = "fetch" | "pull";
export const GIT_SYNC_OPERATIONS: readonly GitSyncOperation[] = ["fetch", "pull"];

// Evidence-friendly outcome taxonomy:
export type GitSyncOutcome =
  | "succeeded" // fetch ok / pull fast-forwarded
  | "up-to-date" // pull: already up to date
  | "no-remote"
  | "no-upstream"
  | "detached-head"
  | "dirty-worktree" // pull blocked: local changes would be overwritten
  | "not-fast-forward" // pull --ff-only refused
  | "auth-failed"
  | "timeout"
  | "git-missing"
  | "unsafe-repository"
  | "git-error";
export const GIT_SYNC_OUTCOMES: readonly GitSyncOutcome[] = [
  "succeeded",
  "up-to-date",
  "no-remote",
  "no-upstream",
  "detached-head",
  "dirty-worktree",
  "not-fast-forward",
  "auth-failed",
  "timeout",
  "git-missing",
  "unsafe-repository",
  "git-error",
];

// Preview blocked reasons (read-only readiness):
export type GitSyncBlockReason =
  | "no-remote"
  | "no-upstream"
  | "detached-head"
  | "git-missing"
  | "unsafe-repository"
  | "unavailable";
export const GIT_SYNC_BLOCK_REASONS: readonly GitSyncBlockReason[] = [
  "no-remote",
  "no-upstream",
  "detached-head",
  "git-missing",
  "unsafe-repository",
  "unavailable",
];

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

// The preview is a read-only readiness envelope (branch/upstream/ahead/behind + executable gate);
// centralizing the validator keeps per-field failure messages predictable for callers.
// eslint-disable-next-line complexity
export function validateGitSyncPreview(input: unknown): GitRepositoryValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  if (input.schemaVersion !== GIT_SYNC_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isGitSyncOperation(input.operation)) reasons.push("operation invalid");
  if (!GIT_REPOSITORY_STATES.includes(input.state as GitRepositoryState)) {
    reasons.push("state invalid");
  }
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
  if (
    input.blockReason !== undefined &&
    !GIT_SYNC_BLOCK_REASONS.includes(input.blockReason as GitSyncBlockReason)
  ) {
    reasons.push("blockReason invalid");
  }
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
