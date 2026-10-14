// Read-only Git repository summary + remotes wire contract (Issue #1573, Epic #1572).
// Pure types + validation helpers only: no filesystem, no process, no clock, no crypto.
// Reuses GitRepositoryState / GitUnavailableReason / GitRepositoryValidation from git-repository.

import type {
  GitRepositoryState,
  GitUnavailableReason,
  GitRepositoryValidation,
  GitRepositoryParseResult,
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

function rejectSummaryField(reasons: string[], reason: string): false {
  reasons.push(reason);
  return false;
}

function isGitRepositoryState(input: unknown): input is GitRepositoryState {
  return typeof input === "string" && new Set<string>(GIT_REPOSITORY_STATES).has(input);
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

// KEIKO-0904: bound a remote URL string on the wire in both length and content. Reject a URL
// carrying embedded userinfo (username or password) so a leaked fetchUrl/pushUrl cannot cross
// the redaction boundary the summary path already enforces by rejecting URLs outright. Length
// bounded at 2048 bytes — well above the longest real Git remote URL in the wild and short
// enough that the validator cannot be turned into a DoS amplifier by a very long echoed string.
//
// Two shapes `git remote -v` emits that `new URL()` cannot parse but ARE canonical and never
// carry a secret:
//   1. scp-like SSH:   git@github.com:org/repo.git    (git-scp form, RFC 3986 non-conformant)
//   2. ssh:// with SVC user:   ssh://git@github.com/org/repo.git  (username is the well-known
//      passwordless service account, not a credential)
// Both are the DEFAULT shape produced by `git clone git@...` and `git clone ssh://git@...` —
// rejecting them here would false-positive most SSH remotes.
const REMOTE_URL_MAX_CHARS = 2_048;
const SCP_LIKE_SSH_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]*$/u;
const SSH_SERVICE_USERS: ReadonlySet<string> = new Set(["git", "hg", "svn"]);

function isSafeRemoteUrl(value: string): boolean {
  if (value.length === 0 || value.length > REMOTE_URL_MAX_CHARS) return false;
  // scp-like SSH remotes never carry a password; the "user" part before `@` is always the
  // service account. Accept and stop before new URL() throws.
  if (SCP_LIKE_SSH_RE.test(value)) return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.password !== "") return false;
  if (parsed.username !== "" && !SSH_SERVICE_USERS.has(parsed.username)) return false;
  return true;
}

// KEIKO-0904: keep the per-field URL validation in its own helper so validateRemote stays under
// the complexity cap.
function validateRemoteUrl(
  input: Record<string, unknown>,
  field: "fetchUrl" | "pushUrl",
  reasons: string[],
  index: number,
): boolean {
  let valid = true;
  const value = input[field];
  if (value === undefined) return true;
  if (!isString(value)) {
    return rejectSummaryField(
      reasons,
      `remotes[${String(index)}].${field} must be a string when present`,
    );
  }
  if (!isSafeRemoteUrl(value)) {
    valid = rejectSummaryField(
      reasons,
      `remotes[${String(index)}].${field} is not a redaction-safe URL`,
    );
  }
  return valid;
}

function validateRemote(
  input: unknown,
  reasons: string[],
  index: number,
  options: { readonly allowUrls: boolean },
): boolean {
  let valid = true;
  if (!isRecord(input)) {
    valid = rejectSummaryField(reasons, `remotes[${String(index)}] must be an object`);
    return valid;
  }
  if (!isString(input.name))
    valid = rejectSummaryField(reasons, `remotes[${String(index)}].name must be a string`);
  if (!options.allowUrls) {
    if (input.fetchUrl !== undefined) {
      valid = rejectSummaryField(
        reasons,
        `remotes[${String(index)}].fetchUrl is not allowed in summary`,
      );
    }
    if (input.pushUrl !== undefined) {
      valid = rejectSummaryField(
        reasons,
        `remotes[${String(index)}].pushUrl is not allowed in summary`,
      );
    }
    return valid;
  }
  valid = validateRemoteUrl(input, "fetchUrl", reasons, index) && valid;
  return validateRemoteUrl(input, "pushUrl", reasons, index) && valid;
}

function validateRemotesArray(
  input: unknown,
  reasons: string[],
  options: { readonly allowUrls: boolean },
): boolean {
  if (!Array.isArray(input)) return rejectSummaryField(reasons, "remotes must be an array");
  const remotes: readonly unknown[] = input;
  const length = remotes.length;
  let valid = true;
  for (let index = 0; index < length; index += 1) {
    valid = validateRemote(remotes[index], reasons, index, options) && valid;
  }
  return valid;
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
): boolean {
  let valid = true;
  if (input.reason !== undefined && !isGitWireUnavailableReason(input.reason)) {
    valid = rejectSummaryField(reasons, "reason invalid");
  }
  if (options.checkMessage && input.message !== undefined && !isBoundedGitMessage(input.message)) {
    valid = rejectSummaryField(reasons, "message must be a bounded string when present");
  }
  if (input.repositoryRoot !== undefined && !isString(input.repositoryRoot)) {
    valid = rejectSummaryField(reasons, "repositoryRoot must be a string when present");
  }
  return valid;
}

function validateSummaryBranchFields(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  if (input.branch !== undefined && !isString(input.branch)) {
    valid = rejectSummaryField(reasons, "branch must be a string when present");
  }
  if (input.upstream !== undefined && !isGitUpstreamSummary(input.upstream)) {
    valid = rejectSummaryField(reasons, "upstream must be { ref, remote?, branch? } when present");
  }
  if (input.lastSync !== undefined && !isGitLastSyncMetadata(input.lastSync)) {
    valid = rejectSummaryField(reasons, "lastSync must be { lastFetchAtMs? } when present");
  }
  return valid;
}

function validateSummaryCounters(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  if (!isBoolean(input.available))
    valid = rejectSummaryField(reasons, "available must be a boolean");
  if (!isBoolean(input.detached)) valid = rejectSummaryField(reasons, "detached must be a boolean");
  if (!isBoolean(input.clean)) valid = rejectSummaryField(reasons, "clean must be a boolean");
  if (!isBoolean(input.truncated))
    valid = rejectSummaryField(reasons, "truncated must be a boolean");
  for (const key of [
    "ahead",
    "behind",
    "stagedCount",
    "unstagedCount",
    "untrackedCount",
    "conflictedCount",
  ] as const) {
    if (!isNonNegativeInteger(input[key]))
      valid = rejectSummaryField(reasons, `${key} must be a non-negative integer`);
  }
  return valid;
}

function validateGitReadIdentity(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): boolean {
  let valid = true;
  if (input.schemaVersion !== GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION)
    valid = rejectSummaryField(reasons, "schemaVersion invalid");
  if (!isString(input.root)) valid = rejectSummaryField(reasons, "root must be a string");
  if (!isGitRepositoryState(input.state)) valid = rejectSummaryField(reasons, "state invalid");
  return valid;
}

function admitGitSummary(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): input is Readonly<Record<string, unknown>> & GitRepositorySummary {
  let valid = validateGitReadIdentity(input, reasons);
  valid = validateWireEnvelopeOptionals(input, reasons, { checkMessage: true }) && valid;
  valid = validateSummaryBranchFields(input, reasons) && valid;
  valid = validateSummaryCounters(input, reasons) && valid;
  return validateRemotesArray(input.remotes, reasons, { allowUrls: false }) && valid;
}

function admitGitRemotes(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): input is Readonly<Record<string, unknown>> & GitRemotesResponse {
  let valid = validateGitReadIdentity(input, reasons);
  valid = validateWireEnvelopeOptionals(input, reasons, { checkMessage: false }) && valid;
  if (!isBoolean(input.available))
    valid = rejectSummaryField(reasons, "available must be a boolean");
  if (!isBoolean(input.truncated))
    valid = rejectSummaryField(reasons, "truncated must be a boolean");
  return validateRemotesArray(input.remotes, reasons, { allowUrls: true }) && valid;
}

export function parseGitRepositorySummary(
  input: unknown,
): GitRepositoryParseResult<GitRepositorySummary> {
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  const reasons: string[] = [];
  return admitGitSummary(input, reasons) ? { ok: true, value: input } : { ok: false, reasons };
}

export function parseGitRemotesResponse(
  input: unknown,
): GitRepositoryParseResult<GitRemotesResponse> {
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  const reasons: string[] = [];
  return admitGitRemotes(input, reasons) ? { ok: true, value: input } : { ok: false, reasons };
}

export function validateGitRepositorySummary(input: unknown): GitRepositoryValidation {
  const parsed = parseGitRepositorySummary(input);
  return parsed.ok ? { ok: true } : parsed;
}

export function validateGitRemotesResponse(input: unknown): GitRepositoryValidation {
  const parsed = parseGitRemotesResponse(input);
  return parsed.ok ? { ok: true } : parsed;
}
