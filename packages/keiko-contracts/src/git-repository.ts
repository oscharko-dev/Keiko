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

export type GitStatusCode = " " | "M" | "A" | "D" | "R" | "C" | "U" | "?" | "!";

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

function validateChange(input: unknown, reasons: string[], index: number): void {
  if (!isRecord(input)) {
    reasons.push(`changes[${String(index)}] must be an object`);
    return;
  }
  for (const key of ["path", "indexStatus", "worktreeStatus"] as const) {
    if (!isString(input[key])) reasons.push(`changes[${String(index)}].${key} must be a string`);
  }
  for (const key of ["staged", "unstaged", "untracked", "conflicted"] as const) {
    if (!isBoolean(input[key])) reasons.push(`changes[${String(index)}].${key} must be a boolean`);
  }
  if (input.oldPath !== undefined && !isString(input.oldPath)) {
    reasons.push(`changes[${String(index)}].oldPath must be a string when present`);
  }
}

// Git status is a compact wire envelope with several required counters and flags; keeping the
// validator in one place makes failure messages predictable for tests and callers.
// eslint-disable-next-line complexity
export function validateGitRepositoryStatusResponse(input: unknown): GitRepositoryValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  if (input.schemaVersion !== GIT_REPOSITORY_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isString(input.root)) reasons.push("root must be a string");
  if (!GIT_REPOSITORY_STATES.includes(input.state as GitRepositoryState)) {
    reasons.push("state invalid");
  }
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
  if (!Array.isArray(input.changes)) reasons.push("changes must be an array");
  else {
    input.changes.forEach((change, index) => {
      validateChange(change, reasons, index);
    });
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// eslint-disable-next-line complexity
export function validateGitRepositoryDiffResponse(input: unknown): GitRepositoryValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  if (input.schemaVersion !== GIT_REPOSITORY_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isString(input.root)) reasons.push("root must be a string");
  if (!GIT_REPOSITORY_STATES.includes(input.state as GitRepositoryState)) {
    reasons.push("state invalid");
  }
  if (!isBoolean(input.available)) reasons.push("available must be a boolean");
  if (!["all", "worktree", "staged"].includes(String(input.scope))) reasons.push("scope invalid");
  if (!isString(input.diff)) reasons.push("diff must be a string");
  if (!isBoolean(input.truncated)) reasons.push("truncated must be a boolean");
  if (!isNonNegativeInteger(input.maxBytes))
    reasons.push("maxBytes must be a non-negative integer");
  if (input.path !== undefined && !isString(input.path)) reasons.push("path must be a string");
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
