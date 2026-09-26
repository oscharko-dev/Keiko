import { isGitObjectId } from "./git-repository.js";
import { isGitHubOwnerAndRepo, GITHUB_ISSUE_NUMBER_MAX } from "./github-issue-reference.js";
import {
  isGitDeliveryObservationFailure,
  isGitDeliveryReadCompleteness,
  type GitDeliveryObservationFailure,
  type GitDeliveryReadCompleteness,
} from "./git-delivery-observation.js";

export interface GitCiFailureContextEntry {
  readonly kind: "check-summary" | "annotation" | "job" | "step";
  readonly sourceKind: "check-run" | "workflow-run";
  readonly sourceId: number;
  readonly jobId?: number;
  readonly title: string;
  readonly text: string;
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}
/** Transient model data only. Neither this object nor its text is a persistence/log payload. */
export interface BoundedGitCiFailureContext {
  readonly schemaVersion: "1";
  readonly trust: "untrusted-provider-content";
  readonly usage: "diagnostic-data-only";
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly sourceCount: number;
  readonly entries: readonly GitCiFailureContextEntry[];
  readonly completeness: GitDeliveryReadCompleteness;
}
export type GitCiFailureContextResult =
  | { readonly status: "observed"; readonly context: BoundedGitCiFailureContext }
  | { readonly status: "unavailable"; readonly failure: GitDeliveryObservationFailure };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function closed(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    new TextEncoder().encode(value).byteLength <= max &&
    !/[\p{Cf}\p{Cc}]/u.test(value.replace(/[\n\t]/gu, ""))
  );
}
function absent(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => !Object.hasOwn(value, key));
}
function annotationShape(value: Record<string, unknown>): boolean {
  return (
    value.sourceKind === "check-run" &&
    absent(value, ["jobId"]) &&
    text(value.path, 256) &&
    count(value.startLine, Number.MAX_SAFE_INTEGER, 1) &&
    count(value.endLine, Number.MAX_SAFE_INTEGER, value.startLine)
  );
}
function jobShape(value: Record<string, unknown>): boolean {
  return (
    value.sourceKind === "workflow-run" &&
    count(value.jobId, Number.MAX_SAFE_INTEGER, 1) &&
    absent(value, ["path", "startLine", "endLine"])
  );
}
function entryShape(value: Record<string, unknown>): boolean {
  switch (value.kind) {
    case "check-summary":
      return (
        value.sourceKind === "check-run" && absent(value, ["jobId", "path", "startLine", "endLine"])
      );
    case "annotation":
      return annotationShape(value);
    case "job":
    case "step":
      return jobShape(value);
    default:
      return false;
  }
}
function entry(value: unknown): value is GitCiFailureContextEntry {
  return (
    object(value) &&
    closed(
      value,
      ["kind", "sourceKind", "sourceId", "title", "text"],
      ["jobId", "path", "startLine", "endLine"],
    ) &&
    count(value.sourceId, Number.MAX_SAFE_INTEGER, 1) &&
    text(value.title, 256) &&
    text(value.text, 2048) &&
    entryShape(value)
  );
}
const CONTEXT_KEYS = [
  "schemaVersion",
  "trust",
  "usage",
  "repository",
  "prNumber",
  "headSha",
  "baseSha",
  "sourceCount",
  "entries",
  "completeness",
] as const;
function contextIdentity(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === "1" &&
    value.trust === "untrusted-provider-content" &&
    value.usage === "diagnostic-data-only" &&
    typeof value.repository === "string" &&
    isGitHubOwnerAndRepo(value.repository) &&
    count(value.prNumber, GITHUB_ISSUE_NUMBER_MAX, 1) &&
    isGitObjectId(value.headSha) &&
    isGitObjectId(value.baseSha)
  );
}
function contextCompleteness(
  value: unknown,
  entries: readonly GitCiFailureContextEntry[],
): boolean {
  return (
    isGitDeliveryReadCompleteness(value) &&
    value.entries === entries.length &&
    value.pages <= 20 &&
    value.bytes <= 262144 &&
    (value.complete || value.failure.reason === "output-truncated")
  );
}
function context(value: unknown): value is BoundedGitCiFailureContext {
  if (!object(value) || !closed(value, CONTEXT_KEYS) || !contextIdentity(value)) return false;
  if (
    !count(value.sourceCount, 4) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 32 ||
    !value.entries.every(entry)
  )
    return false;
  const sources = new Set(
    value.entries.map(
      (item: GitCiFailureContextEntry) => `${item.sourceKind}:${String(item.sourceId)}`,
    ),
  );
  return (
    sources.size <= value.sourceCount && contextCompleteness(value.completeness, value.entries)
  );
}
/** This validator admits bounded diagnostic data; it never grants authority to its contents. */
export function isGitCiFailureContextResult(value: unknown): value is GitCiFailureContextResult {
  if (!object(value)) return false;
  if (value.status === "unavailable")
    return closed(value, ["status", "failure"]) && isGitDeliveryObservationFailure(value.failure);
  if (
    value.status !== "observed" ||
    !closed(value, ["status", "context"]) ||
    !context(value.context)
  )
    return false;
  return new TextEncoder().encode(JSON.stringify(value.context)).byteLength <= 16384;
}
