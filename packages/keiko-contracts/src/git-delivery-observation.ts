/** One body-free observation vocabulary for governed CI and lifecycle reads (#3388/#3389). */
export const GIT_DELIVERY_OBSERVATION_FAILURE_STATES = Object.freeze({
  "authority-denied": "blocked",
  "auth-required": "blocked",
  "invalid-binding": "blocked",
  cancelled: "blocked",
  "provider-forbidden": "unknown",
  "provider-not-found": "unknown",
  "rate-limited": "pending",
  "provider-unavailable": "pending",
  timeout: "pending",
  "pagination-exhausted": "unknown",
  "output-truncated": "unknown",
  "malformed-response": "unknown",
  "visibility-unknown": "unknown",
  "requirements-ambiguous": "unknown",
  "revision-changed": "pending",
} as const);

export type GitDeliveryObservationFailureReason =
  keyof typeof GIT_DELIVERY_OBSERVATION_FAILURE_STATES;

export interface GitDeliveryObservationFailure {
  readonly reason: GitDeliveryObservationFailureReason;
  readonly state: "pending" | "blocked" | "unknown";
}

interface GitDeliveryReadCounts {
  readonly pages: number;
  readonly entries: number;
  readonly bytes: number;
}

export type GitDeliveryReadCompleteness = GitDeliveryReadCounts &
  (
    | { readonly complete: true }
    | { readonly complete: false; readonly failure: GitDeliveryObservationFailure }
  );

export function gitDeliveryObservationFailure(
  reason: GitDeliveryObservationFailureReason,
): GitDeliveryObservationFailure {
  return { reason, state: GIT_DELIVERY_OBSERVATION_FAILURE_STATES[reason] };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isGitDeliveryObservationFailure(
  value: unknown,
): value is GitDeliveryObservationFailure {
  if (!record(value) || !exactKeys(value, ["reason", "state"]) || typeof value.reason !== "string")
    return false;
  return (
    Object.hasOwn(GIT_DELIVERY_OBSERVATION_FAILURE_STATES, value.reason) &&
    value.state ===
      GIT_DELIVERY_OBSERVATION_FAILURE_STATES[value.reason as GitDeliveryObservationFailureReason]
  );
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isGitDeliveryReadCompleteness(
  value: unknown,
): value is GitDeliveryReadCompleteness {
  if (!record(value) || !count(value.pages) || !count(value.entries) || !count(value.bytes))
    return false;
  if (value.complete === true) return exactKeys(value, ["complete", "pages", "entries", "bytes"]);
  return (
    value.complete === false &&
    exactKeys(value, ["complete", "pages", "entries", "bytes", "failure"]) &&
    isGitDeliveryObservationFailure(value.failure)
  );
}
