import { isDraftDeliveryRecord, type DraftDeliveryRecord } from "./draft-delivery.js";
import { validateUntrustedDisplayText } from "./coding-workbench-runtime-api-validation.js";

export const CODING_RUNTIME_DELIVERY_UNAVAILABLE_REASONS = [
  "authority-denied",
  "issue-unavailable",
  "verified-commit-required",
  "proposal-unavailable",
  "operation-in-flight",
  "payload-invalid",
  "provider-unavailable",
] as const;

export type CodingRuntimeDeliveryResult =
  | { readonly status: "recorded"; readonly record: DraftDeliveryRecord }
  | {
      readonly status: "unavailable";
      readonly reason: (typeof CODING_RUNTIME_DELIVERY_UNAVAILABLE_REASONS)[number];
    };

/** Authenticated transient approval payload. Only its body-free record can enter durable state. */
export type CodingRuntimeDeliveryReview =
  | { readonly record: DraftDeliveryRecord }
  | { readonly record: DraftDeliveryRecord; readonly title: string; readonly body: string };

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(
  CODING_RUNTIME_DELIVERY_UNAVAILABLE_REASONS,
);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
export function isCodingRuntimeDeliveryResult(
  value: unknown,
): value is CodingRuntimeDeliveryResult {
  if (!record(value)) return false;
  if (value.status === "recorded")
    return exact(value, ["status", "record"]) && isDraftDeliveryRecord(value.record);
  return (
    value.status === "unavailable" &&
    exact(value, ["status", "reason"]) &&
    typeof value.reason === "string" &&
    UNAVAILABLE_REASONS.has(value.reason)
  );
}
function validText(value: unknown, maxBytes: number): value is string {
  return (
    validateUntrustedDisplayText(value, maxBytes) &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    new TextEncoder().encode(value).length <= maxBytes
  );
}
export function isCodingRuntimeDeliveryReview(
  value: unknown,
): value is CodingRuntimeDeliveryReview {
  if (!record(value) || !isDraftDeliveryRecord(value.record)) return false;
  if (value.record.phase === "push-proposed") return exact(value, ["record"]);
  return (
    value.record.phase === "pr-proposed" &&
    exact(value, ["record", "title", "body"]) &&
    validText(value.title, 256) &&
    !/[\r\n]/u.test(value.title) &&
    validText(value.body, 65_536)
  );
}
