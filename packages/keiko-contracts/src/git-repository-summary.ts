// Read-only Git repository summary + remotes wire contract (Issue #1573, Epic #1572).
// Pure types + validation helpers only: no filesystem, no process, no clock, no crypto.
// Reuses GitRepositoryState / GitUnavailableReason / GitRepositoryValidation from git-repository.

import type {
  GitRepositoryState,
  GitUnavailableReason,
  GitRepositoryValidation,
} from "./git-repository.js";
import { GIT_REPOSITORY_STATES } from "./git-repository.js";

export const GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION = "1" as const;

export interface GitRemoteSummary {
  readonly name: string;
  readonly fetchUrl?: string | undefined;
  readonly pushUrl?: string | undefined;
}

export interface GitRepositorySummaryRemote {
  readonly name: string;
}

export interface GitUpstreamSummary {
  readonly ref: string; // e.g. "origin/main"
  readonly remote?: string | undefined;
  readonly branch?: string | undefined;
}

export interface GitLastSyncMetadata {
  readonly lastFetchAtMs?: number | undefined; // FETCH_HEAD mtime when available
}

export interface GitRepositorySummary {
  readonly schemaVersion: typeof GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION;
  readonly root: string;
  readonly repositoryRoot?: string | undefined;
  readonly state: GitRepositoryState;
  readonly available: boolean;
  readonly reason?: GitUnavailableReason | "unsafe-repository" | "git-error" | undefined;
  readonly message?: string | undefined;
  readonly branch?: string | undefined;
  readonly detached: boolean;
  readonly upstream?: GitUpstreamSummary | undefined;
  readonly ahead: number;
  readonly behind: number;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly conflictedCount: number;
  readonly clean: boolean;
  readonly remotes: readonly GitRepositorySummaryRemote[];
  readonly lastSync?: GitLastSyncMetadata | undefined;
  readonly truncated: boolean;
}

// Dedicated remotes response for GET /api/git/remotes (reuses GitRemoteSummary).
export interface GitRemotesResponse {
  readonly schemaVersion: typeof GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION;
  readonly root: string;
  readonly repositoryRoot?: string | undefined;
  readonly state: GitRepositoryState;
  readonly available: boolean;
  readonly reason?: GitUnavailableReason | "unsafe-repository" | "git-error" | undefined;
  readonly remotes: readonly GitRemoteSummary[];
  readonly truncated: boolean;
}

export type GitRepositorySummaryValidation = GitRepositoryValidation; // reuse ok/fail shape

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

function validateRemote(
  input: unknown,
  reasons: string[],
  index: number,
  options: { readonly allowUrls: boolean },
): void {
  if (!isRecord(input)) {
    reasons.push(`remotes[${String(index)}] must be an object`);
    return;
  }
  if (!isString(input.name)) reasons.push(`remotes[${String(index)}].name must be a string`);
  if (!options.allowUrls) {
    if (input.fetchUrl !== undefined) {
      reasons.push(`remotes[${String(index)}].fetchUrl is not allowed in summary`);
    }
    if (input.pushUrl !== undefined) {
      reasons.push(`remotes[${String(index)}].pushUrl is not allowed in summary`);
    }
    return;
  }
  if (input.fetchUrl !== undefined && !isString(input.fetchUrl)) {
    reasons.push(`remotes[${String(index)}].fetchUrl must be a string when present`);
  }
  if (input.pushUrl !== undefined && !isString(input.pushUrl)) {
    reasons.push(`remotes[${String(index)}].pushUrl must be a string when present`);
  }
}

function validateRemotesArray(
  input: unknown,
  reasons: string[],
  options: { readonly allowUrls: boolean },
): void {
  if (!Array.isArray(input)) {
    reasons.push("remotes must be an array");
    return;
  }
  input.forEach((remote, index) => {
    validateRemote(remote, reasons, index, options);
  });
}

// The summary is a compact wire envelope with required counters, ahead/behind, and a remotes
// array; keeping the validator in one place makes failure messages predictable for callers.
// eslint-disable-next-line complexity
export function validateGitRepositorySummary(input: unknown): GitRepositoryValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  if (input.schemaVersion !== GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION) {
    reasons.push("schemaVersion invalid");
  }
  if (!isString(input.root)) reasons.push("root must be a string");
  if (!GIT_REPOSITORY_STATES.includes(input.state as GitRepositoryState)) {
    reasons.push("state invalid");
  }
  if (!isBoolean(input.available)) reasons.push("available must be a boolean");
  if (!isBoolean(input.detached)) reasons.push("detached must be a boolean");
  if (!isBoolean(input.clean)) reasons.push("clean must be a boolean");
  if (!isBoolean(input.truncated)) reasons.push("truncated must be a boolean");
  for (const key of [
    "ahead",
    "behind",
    "stagedCount",
    "unstagedCount",
    "untrackedCount",
    "conflictedCount",
  ] as const) {
    if (!isNonNegativeInteger(input[key])) reasons.push(`${key} must be a non-negative integer`);
  }
  validateRemotesArray(input.remotes, reasons, { allowUrls: false });
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function validateGitRemotesResponse(input: unknown): GitRepositoryValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  if (input.schemaVersion !== GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION) {
    reasons.push("schemaVersion invalid");
  }
  if (!isString(input.root)) reasons.push("root must be a string");
  if (!GIT_REPOSITORY_STATES.includes(input.state as GitRepositoryState)) {
    reasons.push("state invalid");
  }
  if (!isBoolean(input.available)) reasons.push("available must be a boolean");
  if (!isBoolean(input.truncated)) reasons.push("truncated must be a boolean");
  validateRemotesArray(input.remotes, reasons, { allowUrls: true });
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
