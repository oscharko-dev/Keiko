// Shared transport bounds and evidence vocabulary; independent of the report/diagnostic module graph.
export const SUPPORT_REPORT_WORKER_TIMEOUT_MS = 30_000;
export const SUPPORT_REPORT_REQUEST_TIMEOUT_MS = SUPPORT_REPORT_WORKER_TIMEOUT_MS + 5_000;
export const SUPPORT_REPORT_DELIVERY_TTL_MS = 15 * 60_000;
export const SUPPORT_REPORT_AVAILABILITY_REASONS = [
  "session-unavailable",
  "diagnostic-delivery-unavailable",
  "service-unavailable",
  "client-only-selected",
  "correlation-unavailable",
] as const;
export type SupportReportAvailabilityReason = (typeof SUPPORT_REPORT_AVAILABILITY_REASONS)[number];
