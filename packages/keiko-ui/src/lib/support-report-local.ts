import {
  buildSupportReportEnvelope,
  canonicalSupportJson,
  clientOnlySupportReportSections,
  defectFingerprintPreimage,
  MAX_SUPPORT_REPORT_BYTES,
  isActivityLogCorrelationId,
  isClientReportFailure,
  looksLikeSecret,
  looksLikePersonalIdentifier,
  sealSupportReportEnvelope,
  serializeSupportReport,
  supportIncidentBuild,
  supportReportFileName,
  UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT,
  type DesktopSupportReportResponse,
  type SupportReport,
  type ClientOnlySupportReportInput,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import type { SupportReportDownload } from "./support-report-api";
import { retainedClientDiagnosticFailure, recordClientDiagnosticLoss } from "./client-diagnostics";

type LocalFailureContext = Pick<ClientOnlySupportReportInput, "correlationId" | "failure"> &
  Partial<Pick<ClientOnlySupportReportInput, "availabilityReason">>;

export interface PreparedLocalSupportReport {
  readonly report: DesktopSupportReportResponse;
  readonly download: SupportReportDownload;
}

async function browserDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mergeFailure(
  retained: NonNullable<ClientOnlySupportReportInput["failure"]>,
  original: ClientOnlySupportReportInput["failure"],
): NonNullable<ClientOnlySupportReportInput["failure"]> {
  const fallback: NonNullable<ClientOnlySupportReportInput["failure"]> = original ?? {
    errorKind: "unknown",
    context: [],
  };
  const errorEvidence = retained.errorEvidence ?? fallback.errorEvidence;
  return {
    ...(errorEvidence === undefined ? {} : { errorEvidence }),
    errorKind: retained.errorKind === "unknown" ? fallback.errorKind : retained.errorKind,
    context: retained.context.length === 0 ? fallback.context : retained.context,
  };
}

function validatedOriginalFailure(
  failure: ClientOnlySupportReportInput["failure"],
): ClientOnlySupportReportInput["failure"] {
  if (isClientReportFailure(failure)) return failure;
  recordClientDiagnosticLoss("errorsSuppressed");
  return undefined;
}

function validatedLocalCorrelationId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    isActivityLogCorrelationId(value) &&
    !looksLikeSecret(value) &&
    !looksLikePersonalIdentifier(value)
  )
    return value;
  recordClientDiagnosticLoss("errorsSuppressed");
  return undefined;
}

export function originalSupportReportFailure(
  context: LocalFailureContext,
): ClientOnlySupportReportInput["failure"] {
  const original = validatedOriginalFailure(context.failure);
  if (context.correlationId === undefined) return original;
  const retained = validatedOriginalFailure(retainedClientDiagnosticFailure(context.correlationId));
  return retained === undefined ? original : mergeFailure(retained, original);
}

async function localReport(
  signal: AbortSignal,
  context: LocalFailureContext,
): Promise<DesktopSupportReportResponse> {
  signal.throwIfAborted();
  const correlationId = validatedLocalCorrelationId(context.correlationId);
  const failure = originalSupportReportFailure({ ...context, correlationId });
  const sections = clientOnlySupportReportSections({
    incidentId: crypto.randomUUID().replaceAll("-", ""),
    nowMs: Date.now(),
    build: supportIncidentBuild(KEIKO_PRODUCT_VERSION, "other-other"),
    defectFingerprint: await browserDigest(
      defectFingerprintPreimage(UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT),
    ),
    availabilityReason: context.availabilityReason ?? "service-unavailable",
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(failure === undefined ? {} : { failure }),
  });
  const [incidentDigest, selectionDigest, evidenceDigest] = await Promise.all([
    browserDigest(canonicalSupportJson(sections.incident)),
    browserDigest(canonicalSupportJson(sections.selection)),
    browserDigest(canonicalSupportJson(sections.evidence)),
  ]);
  const unsigned = buildSupportReportEnvelope(
    sections.incident,
    sections.selection,
    sections.evidence,
    {
      incidentDigest,
      selectionDigest,
      evidenceDigest,
    },
  );
  const report = sealSupportReportEnvelope(
    unsigned,
    await browserDigest(canonicalSupportJson(unsigned)),
  );
  signal.throwIfAborted();
  return localReportResponse(report);
}

function localReportResponse(report: SupportReport): DesktopSupportReportResponse {
  return {
    fileName: supportReportFileName(
      report.schemaVersion,
      report.incident.incidentId,
      report.incident.createdAtMs,
    ),
    reportJson: serializeSupportReport(report),
    evidenceScope: "client-only",
    summary: {
      status: report.selection.status,
      reasons: report.selection.reasons,
      recordCount: report.evidence.recordCount,
      reportDigest: report.integrity.reportDigest,
      incidentId: report.incident.incidentId,
      manifestUnreadableCount: 0,
      manifestReusedCount: 0,
      completeness: report.incident.completeness,
      loss: report.incident.loss,
      pinDisposition: report.incident.pin.status,
      availabilityReason: report.incident.clientReport?.availabilityReason,
    },
  };
}

/** A standard gzip transport preserves the canonical bytes in native browser download handlers. */
export async function prepareCachedSupportReport(
  report: DesktopSupportReportResponse,
  signal: AbortSignal,
): Promise<PreparedLocalSupportReport> {
  signal.throwIfAborted();
  const source = new Blob([report.reportJson], { type: "application/octet-stream" });
  if (source.size > MAX_SUPPORT_REPORT_BYTES) throw new TypeError("Support report budget exceeded");
  const blob = await new Response(source.stream().pipeThrough(new CompressionStream("gzip")), {
    headers: { "Content-Type": "application/gzip" },
  }).blob();
  signal.throwIfAborted();
  if (blob.size > MAX_SUPPORT_REPORT_BYTES) throw new TypeError("Support report budget exceeded");
  const href = URL.createObjectURL(blob);
  return {
    report,
    download: {
      href,
      fileName: `${report.fileName}.gz`,
      expiresAtMs: Date.now() + 15 * 60_000,
      dispose: (): void => URL.revokeObjectURL(href),
    },
  };
}

export async function prepareLocalSupportReport(
  signal: AbortSignal,
  context: LocalFailureContext = {},
): Promise<PreparedLocalSupportReport> {
  return prepareCachedSupportReport(await localReport(signal, context), signal);
}
