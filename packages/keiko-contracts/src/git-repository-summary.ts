// Read-only Git repository summary + remotes wire contract (Issue #1573, Epic #1572).
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

// KEIKO-0904: bound a remote URL string on the wire in both length and content. Reject a URL
// carrying embedded credentials (userinfo) so a leaked fetchUrl/pushUrl cannot cross the redaction
// boundary the summary path already enforces by rejecting URLs outright. Length bounded at 2048
// bytes — well above the longest real Git remote URL in the wild and short enough that the
// validator cannot be turned into a DoS amplifier by a very long echoed string.
const REMOTE_URL_MAX_CHARS = 2_048;

function isSafeRemoteUrl(value: string): boolean {
  if (value.length === 0 || value.length > REMOTE_URL_MAX_CHARS) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  return true;
}

// KEIKO-0904: keep the per-field URL validation in its own helper so validateRemote stays under
// the complexity cap.
function validateRemoteUrl(
  input: Record<string, unknown>,
  field: "fetchUrl" | "pushUrl",
  reasons: string[],
  index: number,
): void {
  const value = input[field];
  if (value === undefined) return;
  if (!isString(value)) {
    reasons.push(`remotes[${String(index)}].${field} must be a string when present`);
    return;
  }
  if (!isSafeRemoteUrl(value)) {
    reasons.push(`remotes[${String(index)}].${field} is not a redaction-safe URL`);
  }
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
  validateRemoteUrl(input, "fetchUrl", reasons, index);
  validateRemoteUrl(input, "pushUrl", reasons, index);
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

// The producer (keiko-server gitPorcelainStatus.ts parseUpstreamRef) emits either { ref } alone or
// { ref, remote, branch } together -- remote/branch are always both present or both absent, never
// one without the other. Exported: git-sync.ts's GitSyncPreview.upstream is populated from the same
// parsePorcelainV2Branch parser (via syncExecution.ts), so it shares this exact shape rather than
// needing its own copy of the guard.
export function isGitUpstreamSummary(value: unknown): value is GitUpstreamSummary {
  if (!isRecord(value)) return false;
  if (!isString(value.ref)) return false;
  if (value.remote === undefined && value.branch === undefined) return true;
  return isString(value.remote) && isString(value.branch);
}

// The producer (keiko-server gitRepositoryReads.ts readLastSync) emits either undefined or
// { lastFetchAtMs } from Math.round(fs.stat(...).mtimeMs), always a non-negative integer.
function isGitLastSyncMetadata(value: unknown): value is GitLastSyncMetadata {
  if (!isRecord(value)) return false;
  return value.lastFetchAtMs === undefined || isNonNegativeInteger(value.lastFetchAtMs);
}

// Fields validateGitRepositorySummary and validateGitRemotesResponse both declare (KEIKO-0310):
// a closed-union `reason`, a bounded free-text `message` (summary only -- GitRemotesResponse has
// no message field), and a server-private `repositoryRoot`, all optional.
function validateWireEnvelopeOptionals(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
  options: { readonly checkMessage: boolean },
): void {
  if (input.reason !== undefined && !isGitWireUnavailableReason(input.reason)) {
    reasons.push("reason invalid");
  }
  if (options.checkMessage && input.message !== undefined && !isBoundedGitMessage(input.message)) {
    reasons.push("message must be a bounded string when present");
  }
  if (input.repositoryRoot !== undefined && !isString(input.repositoryRoot)) {
    reasons.push("repositoryRoot must be a string when present");
  }
}

function validateSummaryBranchFields(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  if (input.branch !== undefined && !isString(input.branch)) {
    reasons.push("branch must be a string when present");
  }
  if (input.upstream !== undefined && !isGitUpstreamSummary(input.upstream)) {
    reasons.push("upstream must be { ref, remote?, branch? } when present");
  }
  if (input.lastSync !== undefined && !isGitLastSyncMetadata(input.lastSync)) {
    reasons.push("lastSync must be { lastFetchAtMs? } when present");
  }
}

function validateSummaryCounters(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
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
}

// The summary is a compact wire envelope with required counters, ahead/behind, and a remotes
// array; keeping the validator in one place makes failure messages predictable for callers.
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
  validateWireEnvelopeOptionals(input, reasons, { checkMessage: true });
  validateSummaryBranchFields(input, reasons);
  validateSummaryCounters(input, reasons);
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
  validateWireEnvelopeOptionals(input, reasons, { checkMessage: false });
  if (!isBoolean(input.available)) reasons.push("available must be a boolean");
  if (!isBoolean(input.truncated)) reasons.push("truncated must be a boolean");
  validateRemotesArray(input.remotes, reasons, { allowUrls: true });
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
