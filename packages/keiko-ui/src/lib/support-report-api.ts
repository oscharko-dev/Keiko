import type { DesktopSupportReportResponse } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { MAX_SUPPORT_REPORT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { bffFetchJson } from "./http";
import {
  ensureClientDiagnosticDelivery,
  CLIENT_DIAGNOSTIC_ACK_TIMEOUT_MS,
} from "./client-diagnostics";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";

export class SupportReportEvidenceUnavailable extends Error {
  constructor() {
    super("Support report evidence delivery unavailable");
    this.name = "SupportReportEvidenceUnavailable";
  }
}

export class SupportReportResponseInvalid extends TypeError {}

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
  correlationId?: string,
  signal?: AbortSignal,
): Promise<DesktopSupportReportResponse> {
  const deadline = AbortSignal.timeout(35_000);
  const requestSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  await codingAppSessionPairingSettled();
  requestSignal.throwIfAborted();
  if (correlationId !== undefined) await ensureReportEvidence(correlationId, requestSignal);
  requestSignal.throwIfAborted();
  return bffFetchJson<DesktopSupportReportResponse>(
    "/api/diagnostics/report",
    {
      method: "POST",
      body: JSON.stringify({
        ...(correlationId === undefined ? {} : { correlationId }),
      }),
      signal: requestSignal,
    },
    {
      validator: (_path, value): DesktopSupportReportResponse =>
        validateSupportReportResponse(value),
    },
  );
}

export interface SupportReportDownload {
  readonly href: string;
  readonly fileName?: string | undefined;
  readonly expiresAtMs?: number | undefined;
  readonly dispose: () => void;
}

/** A stable download target until the report action is dismissed or its cache is evicted. */
export function createSupportReportDownload(
  report: DesktopSupportReportResponse,
): SupportReportDownload {
  if (report.downloadPath !== undefined)
    return {
      href: report.downloadPath,
      fileName: `${report.fileName}.gz`,
      expiresAtMs: report.downloadExpiresAtMs,
      dispose: (): void => undefined,
    };
  const href = URL.createObjectURL(new Blob([report.reportJson], { type: "application/json" }));
  return { href, dispose: (): void => URL.revokeObjectURL(href) };
}

function validateSupportReportResponse(value: unknown): DesktopSupportReportResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("fileName" in value) ||
    !("reportJson" in value)
  )
    throw new SupportReportResponseInvalid("Invalid support report response");
  if (
    typeof value.fileName !== "string" ||
    !/^keiko-support-v1-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}\.json$/u.test(value.fileName) ||
    typeof value.reportJson !== "string" ||
    new TextEncoder().encode(value.reportJson).byteLength > MAX_SUPPORT_REPORT_BYTES
  )
    throw new SupportReportResponseInvalid("Invalid support report response");
  return {
    fileName: value.fileName,
    reportJson: value.reportJson,
    ...validateDownloadTarget(value),
    ...validateEvidenceScope(value),
  };
}

function validateDownloadTarget(
  value: object,
): Pick<DesktopSupportReportResponse, "downloadPath" | "downloadExpiresAtMs"> {
  if (!("downloadPath" in value) && !("downloadExpiresAtMs" in value)) return {};
  if (
    !("downloadPath" in value) ||
    typeof value.downloadPath !== "string" ||
    !/^\/api\/diagnostics\/report\/download\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      value.downloadPath,
    ) ||
    !("downloadExpiresAtMs" in value) ||
    typeof value.downloadExpiresAtMs !== "number" ||
    !Number.isSafeInteger(value.downloadExpiresAtMs) ||
    value.downloadExpiresAtMs <= Date.now()
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
