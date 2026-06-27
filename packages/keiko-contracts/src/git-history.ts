// Read-only Git commit history wire contract (Issue #1573, Epic #1572).
// Pure types + validation helpers only: no filesystem, no process, no clock, no crypto.
// Reuses GitRepositoryState / GitUnavailableReason / GitRepositoryValidation from git-repository.

import type {
  GitRepositoryState,
  GitUnavailableReason,
  GitRepositoryValidation,
} from "./git-repository.js";
import { GIT_REPOSITORY_STATES } from "./git-repository.js";

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

function validateRefs(input: unknown, reasons: string[], index: number): void {
  if (!Array.isArray(input)) {
    reasons.push(`entries[${String(index)}].refs must be an array`);
    return;
  }
  if (!input.every(isString)) {
    reasons.push(`entries[${String(index)}].refs must contain only strings`);
  }
}

function validateEntry(input: unknown, reasons: string[], index: number): void {
  if (!isRecord(input)) {
    reasons.push(`entries[${String(index)}] must be an object`);
    return;
  }
  for (const key of ["sha", "shortSha", "subject", "author", "date"] as const) {
    if (!isString(input[key])) reasons.push(`entries[${String(index)}].${key} must be a string`);
  }
  for (const key of ["parentCount", "changedFileCount"] as const) {
    if (!isNonNegativeInteger(input[key])) {
      reasons.push(`entries[${String(index)}].${key} must be a non-negative integer`);
    }
  }
  validateRefs(input.refs, reasons, index);
}

// History is a paginated wire envelope (entries + limit/skip/truncated); centralizing the
// validator keeps per-field failure messages predictable for tests and callers.
// eslint-disable-next-line complexity
export function validateGitHistoryResponse(input: unknown): GitRepositoryValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  if (input.schemaVersion !== GIT_HISTORY_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isString(input.root)) reasons.push("root must be a string");
  if (!GIT_REPOSITORY_STATES.includes(input.state as GitRepositoryState)) {
    reasons.push("state invalid");
  }
  if (!isBoolean(input.available)) reasons.push("available must be a boolean");
  if (!isBoolean(input.truncated)) reasons.push("truncated must be a boolean");
  if (!isNonNegativeInteger(input.limit)) reasons.push("limit must be a non-negative integer");
  if (!isNonNegativeInteger(input.skip)) reasons.push("skip must be a non-negative integer");
  if (!Array.isArray(input.entries)) reasons.push("entries must be an array");
  else {
    input.entries.forEach((entry, index) => {
      validateEntry(entry, reasons, index);
    });
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
