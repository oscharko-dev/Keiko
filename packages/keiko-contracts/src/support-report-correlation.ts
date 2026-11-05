import { looksLikePersonalIdentifier, looksLikeSecret } from "./activity-log-label-policy.js";
import {
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  isActivityLogCorrelationId,
} from "./observability.js";

/**
 * A selected failure reference, never a transport sentinel, credential or personal label.
 *
 * Lives apart from the report producer so the always-mounted report button and client error paths
 * can validate a reference without loading the report builder into the first page load.
 */
export function normalizeSupportReportCorrelationId(value: unknown): string | undefined {
  return isActivityLogCorrelationId(value) &&
    value !== ACTIVITY_LOG_UNKNOWN_CORRELATION_ID &&
    !looksLikeSecret(value) &&
    !looksLikePersonalIdentifier(value)
    ? value
    : undefined;
}
