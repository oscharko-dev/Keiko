import { isReadinessSnapshot, type ReadinessSnapshot } from "./git-ci-readiness.js";
import {
  isGitCiFailureContextResult,
  type GitCiFailureContextResult,
} from "./git-ci-failure-context.js";

export const CODING_RUNTIME_CI_UNAVAILABLE_REASONS = [
  "authority-denied",
  "draft-unavailable",
  "provider-unavailable",
  "observation-in-flight",
  "poll-backoff",
  "observation-superseded",
] as const;
export type CodingRuntimeCiResult =
  | {
      readonly status: "observed";
      readonly snapshot: ReadinessSnapshot;
      /** Transient untrusted diagnostic data. Never part of the public or durable snapshot. */
      readonly failureContext?: GitCiFailureContextResult;
      readonly retryAfterMs: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason: (typeof CODING_RUNTIME_CI_UNAVAILABLE_REASONS)[number];
      readonly retryAfterMs: number;
    };
const REASONS: ReadonlySet<string> = new Set(CODING_RUNTIME_CI_UNAVAILABLE_REASONS);
function validBackoff(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 30_000;
}
function closedResult(data: Record<string, unknown>): boolean {
  const keys =
    data.status === "observed"
      ? [
          "status",
          "snapshot",
          "retryAfterMs",
          ...(Object.hasOwn(data, "failureContext") ? ["failureContext"] : []),
        ]
      : ["status", "reason", "retryAfterMs"];
  return Object.keys(data).length === keys.length && keys.every((key) => Object.hasOwn(data, key));
}
export function isCodingRuntimeCiResult(value: unknown): value is CodingRuntimeCiResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (!validBackoff(data.retryAfterMs) || !closedResult(data)) return false;
  return data.status === "observed"
    ? isReadinessSnapshot(data.snapshot) &&
        matchingFailureContext(data.failureContext, data.snapshot)
    : data.status === "unavailable" && typeof data.reason === "string" && REASONS.has(data.reason);
}
function matchingFailureContext(value: unknown, snapshot: ReadinessSnapshot): boolean {
  if (value === undefined) return true;
  if (snapshot.state !== "failed" || !isGitCiFailureContextResult(value)) return false;
  if (value.status === "unavailable") return true;
  const context = value.context;
  return (
    context.repository === snapshot.repository &&
    context.prNumber === snapshot.prNumber &&
    context.headSha === snapshot.headSha &&
    context.baseSha === snapshot.baseSha
  );
}
