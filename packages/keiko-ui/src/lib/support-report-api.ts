import type {
  ClientOnlySupportReportInput,
  DesktopSupportReportRequest,
  DesktopSupportReportResponse,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  isClientReportFailure,
  isSupportReportFileName,
  isSupportReportDownloadPath,
  ACTIVITY_LOG_COMPLETENESS_STATES,
  ACTIVITY_LOG_LOSS_STATES,
  DIAGNOSTIC_SUFFICIENCY_STATUSES,
  DIAGNOSTIC_SUFFICIENCY_REASONS,
  MAX_DESKTOP_SUPPORT_REPORT_REQUEST_BYTES,
  MAX_SUPPORT_REPORT_BYTES,
  SUPPORT_REPORT_REQUEST_TIMEOUT_MS,
  SUPPORT_REPORT_DELIVERY_TTL_MS,
  SUPPORT_INCIDENT_TRIGGERS,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { selectedSupportReportCorrelationId } from "./support-report-errors";
import { ApiError } from "./api";
import { bffFetchJson } from "./http";
import {
  ensureClientDiagnosticDelivery,
  CLIENT_DIAGNOSTIC_ACK_TIMEOUT_MS,
} from "./client-diagnostics";
import {
  codingAppSessionPairingSettled,
  repairLocalCodingAppSessionWithEvidence,
} from "./coding-app-session-client";

export class SupportReportEvidenceUnavailable extends Error {
  constructor() {
    super("Support report evidence delivery unavailable");
    this.name = "SupportReportEvidenceUnavailable";
  }
}

export class SupportReportResponseInvalid extends ApiError {
  constructor(message: string) {
    super("CONTRACT_VALIDATION_FAILED", message, 502);
  }
}

export function supportReportAvailabilityReason(
  error: unknown,
): ClientOnlySupportReportInput["availabilityReason"] {
  return error instanceof SupportReportEvidenceUnavailable ||
    (error instanceof ApiError && error.code === "SUPPORT_REPORT_SELECTION_UNAVAILABLE")
    ? "diagnostic-delivery-unavailable"
    : "service-unavailable";
}

async function ensureReportEvidence(
  correlationId: string,
  signal: AbortSignal,
): Promise<boolean | undefined> {
  const deliverySignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(CLIENT_DIAGNOSTIC_ACK_TIMEOUT_MS),
  ]);
  try {
    return await ensureClientDiagnosticDelivery(correlationId, deliverySignal);
  } catch (error) {
    // A stalled acknowledgement cannot consume the entire report deadline. Only the delivery
    // stage timeout still permits server evidence selection; cancellation and total expiry stop.
    if (
      !signal.aborted &&
      deliverySignal.aborted &&
      error instanceof DOMException &&
      error.name === "TimeoutError"
    )
      return false;
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw new SupportReportEvidenceUnavailable();
    throw error;
  }
}

export async function createSupportReport(
  selectedCorrelationId?: string,
  signal?: AbortSignal,
  failure?: DesktopSupportReportRequest["failure"],
  evidenceScope?: DesktopSupportReportRequest["evidenceScope"],
): Promise<DesktopSupportReportResponse> {
  const correlationId = selectedSupportReportCorrelationId(selectedCorrelationId);
  const deadline = AbortSignal.timeout(SUPPORT_REPORT_REQUEST_TIMEOUT_MS);
  const requestSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  await codingAppSessionPairingSettled(requestSignal);
  requestSignal.throwIfAborted();
  await repairLocalCodingAppSessionWithEvidence(requestSignal);
  requestSignal.throwIfAborted();
  if (correlationId !== undefined) await ensureReportEvidence(correlationId, requestSignal);
  requestSignal.throwIfAborted();
  return bffFetchJson<DesktopSupportReportResponse>(
    "/api/diagnostics/report",
    {
      method: "POST",
      body: reportRequestBody(correlationId, failure, evidenceScope),
      signal: requestSignal,
    },
    {
      validator: (_path, value, response): DesktopSupportReportResponse =>
        validateSupportReportResponse(
          value,
          response.headers,
          performance.now() - response.receivedAtMs,
        ),
    },
  );
}

function reportRequestBody(
  correlationId: string | undefined,
  failure: DesktopSupportReportRequest["failure"],
  evidenceScope: DesktopSupportReportRequest["evidenceScope"],
): string {
  if (!isClientReportFailure(failure)) throw new TypeError("Invalid support report failure");
  const request = {
    ...(evidenceScope === undefined ? {} : { evidenceScope }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(failure === undefined ? {} : { failure }),
  };
  const complete = JSON.stringify(request);
  if (new TextEncoder().encode(complete).byteLength <= MAX_DESKTOP_SUPPORT_REPORT_REQUEST_BYTES)
    return complete;
  // Optional stack evidence is unavailable on this bounded transport, never manufactured empty.
  const limited = JSON.stringify({
    ...request,
    ...(failure === undefined
      ? {}
      : { failure: { errorKind: failure.errorKind, context: failure.context } }),
  });
  if (new TextEncoder().encode(limited).byteLength > MAX_DESKTOP_SUPPORT_REPORT_REQUEST_BYTES)
    throw new TypeError("Support report request budget exceeded");
  return limited;
}

export interface SupportReportDownload {
  readonly href: string;
  readonly fileName?: string | undefined;
  readonly expiresAtMs?: number | undefined;
  readonly dispose: () => void;
}

// Keep the wire's server timestamp intact; only the existing browser expiry timer needs a local
// projection. Weak ownership follows the response through the report cache without retaining it.
const browserDownloadExpiries = new WeakMap<DesktopSupportReportResponse, number>();

/** A stable download target until the report action is dismissed or its cache is evicted. */
export function createSupportReportDownload(
  report: DesktopSupportReportResponse,
): SupportReportDownload {
  if (report.downloadPath !== undefined)
    return {
      href: report.downloadPath,
      fileName: `${report.fileName}.gz`,
      expiresAtMs: browserDownloadExpiries.get(report) ?? report.downloadExpiresAtMs,
      dispose: (): void => undefined,
    };
  const href = URL.createObjectURL(new Blob([report.reportJson], { type: "application/json" }));
  return { href, dispose: (): void => URL.revokeObjectURL(href) };
}

function validateSupportReportResponse(
  value: unknown,
  headers: Headers | undefined,
  elapsedMs: number,
): DesktopSupportReportResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("fileName" in value) ||
    !("reportJson" in value)
  )
    throw new SupportReportResponseInvalid("Invalid support report response");
  if (
    typeof value.fileName !== "string" ||
    !isSupportReportFileName(value.fileName) ||
    typeof value.reportJson !== "string" ||
    new TextEncoder().encode(value.reportJson).byteLength > MAX_SUPPORT_REPORT_BYTES
  )
    throw new SupportReportResponseInvalid("Invalid support report response");
  const report = {
    fileName: value.fileName,
    reportJson: value.reportJson,
    ...validateDownloadTarget(value),
    ...validateEvidenceScope(value),
    ...validateSummary(value),
  };
  if (report.downloadExpiresAtMs !== undefined)
    browserDownloadExpiries.set(
      report,
      browserDownloadExpiry(report.downloadExpiresAtMs, headers, elapsedMs),
    );
  return report;
}

function isExpiryTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function serverRelativeExpiry(expiry: number, date: string, elapsedMs: number): number {
  const serverNow = Date.parse(date);
  if (
    !Number.isFinite(serverNow) ||
    new Date(serverNow).toUTCString() !== date ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    expiry - serverNow > SUPPORT_REPORT_DELIVERY_TTL_MS + 999
  )
    throw new SupportReportResponseInvalid("Invalid support report download target");
  // HTTP Date has one-second precision. Only time observed after receiving its headers consumes
  // this timer; preparation before the response may precede capability creation. Unmeasurable
  // network transit remains subject to the server's authoritative expiry check on download.
  return Math.floor(expiry - serverNow - 1_000 - elapsedMs);
}

function browserDownloadExpiry(
  expiry: number,
  headers: Headers | undefined,
  elapsedMs: number,
): number {
  const now = Date.now();
  const date = headers?.get("Date");
  const remaining = date == null ? expiry - now : serverRelativeExpiry(expiry, date, elapsedMs);
  if (remaining <= 0 || remaining > SUPPORT_REPORT_DELIVERY_TTL_MS)
    throw new SupportReportResponseInvalid("Invalid support report download target");
  return now + remaining;
}

function validateDownloadTarget(
  value: object,
): Pick<DesktopSupportReportResponse, "downloadPath" | "downloadExpiresAtMs"> {
  if (!("downloadPath" in value) && !("downloadExpiresAtMs" in value)) return {};
  if (
    !("downloadPath" in value) ||
    typeof value.downloadPath !== "string" ||
    !isSupportReportDownloadPath(value.downloadPath) ||
    !("downloadExpiresAtMs" in value) ||
    !isExpiryTimestamp(value.downloadExpiresAtMs)
  )
    throw new SupportReportResponseInvalid("Invalid support report download target");
  return { downloadPath: value.downloadPath, downloadExpiresAtMs: value.downloadExpiresAtMs };
}

function validateEvidenceScope(value: object): Pick<DesktopSupportReportResponse, "evidenceScope"> {
  if (!("evidenceScope" in value)) return {};
  if (value.evidenceScope !== "client-only")
    throw new SupportReportResponseInvalid("Invalid report evidence scope");
  return { evidenceScope: "client-only" };
}

type ReportSummary = NonNullable<DesktopSupportReportResponse["summary"]>;
const SUMMARY_STATUSES = new Set<string>(DIAGNOSTIC_SUFFICIENCY_STATUSES);
const SUMMARY_REASONS = new Set<string>(DIAGNOSTIC_SUFFICIENCY_REASONS);
const SUMMARY_COMPLETENESS = new Set<string>(ACTIVITY_LOG_COMPLETENESS_STATES);
const SUMMARY_LOSS = new Set<string>(ACTIVITY_LOG_LOSS_STATES);
const SUMMARY_PIN = new Set(["pinned", "quota-exceeded", "rejected"]);
const SUMMARY_TRIGGERS = new Set<string>(SUPPORT_INCIDENT_TRIGGERS);
const SUMMARY_RETENTION = new Set(["stored", "transient"]);
const SUMMARY_AVAILABILITY = new Set([
  "session-unavailable",
  "diagnostic-delivery-unavailable",
  "service-unavailable",
  "client-only-selected",
  "correlation-unavailable",
]);
const SUMMARY_COUNTS = ["recordCount", "manifestUnreadableCount", "manifestReusedCount"];
function nonNegativeCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function optionalSummaryEnum(value: unknown, choices: ReadonlySet<string>): boolean {
  return value === undefined || (typeof value === "string" && choices.has(value));
}
function validSummaryDisposition(value: Record<string, unknown>): boolean {
  return (
    optionalSummaryEnum(value.completeness, SUMMARY_COMPLETENESS) &&
    optionalSummaryEnum(value.loss, SUMMARY_LOSS) &&
    optionalSummaryEnum(value.pinDisposition, SUMMARY_PIN) &&
    optionalSummaryEnum(value.retentionDisposition, SUMMARY_RETENTION) &&
    optionalSummaryEnum(value.availabilityReason, SUMMARY_AVAILABILITY) &&
    optionalSummaryEnum(value.incidentTrigger, SUMMARY_TRIGGERS)
  );
}
const SUMMARY_KEYS = new Set([
  "status",
  "reasons",
  ...SUMMARY_COUNTS,
  "reportDigest",
  "incidentId",
  "completeness",
  "loss",
  "pinDisposition",
  "retentionDisposition",
  "availabilityReason",
  "incidentTrigger",
]);
function isSummaryIdentity(fields: Record<string, unknown>): boolean {
  return (
    typeof fields.reportDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(fields.reportDigest) &&
    typeof fields.incidentId === "string" &&
    /^[a-f0-9]{32}$/u.test(fields.incidentId)
  );
}
function isSummarySufficiency(fields: Record<string, unknown>): boolean {
  return (
    typeof fields.status === "string" &&
    SUMMARY_STATUSES.has(fields.status) &&
    Array.isArray(fields.reasons) &&
    fields.reasons.length <= 32 &&
    fields.reasons.every(
      (reason: unknown) => typeof reason === "string" && SUMMARY_REASONS.has(reason),
    )
  );
}
function isReportSummary(value: unknown): value is ReportSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return (
    Object.keys(fields).every((key) => SUMMARY_KEYS.has(key)) &&
    isSummarySufficiency(fields) &&
    SUMMARY_COUNTS.every((key) => nonNegativeCount(fields[key])) &&
    isSummaryIdentity(fields) &&
    validSummaryDisposition(fields)
  );
}
function validateSummary(value: object): Pick<DesktopSupportReportResponse, "summary"> {
  if (!("summary" in value) || value.summary === undefined) return {};
  if (!isReportSummary(value.summary))
    throw new SupportReportResponseInvalid("Invalid report summary");
  return { summary: value.summary };
}
