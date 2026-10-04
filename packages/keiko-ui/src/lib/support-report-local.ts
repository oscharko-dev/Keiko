import {
  buildSupportReportEnvelope,
  canonicalSupportJson,
  clientOnlySupportReportSections,
  defectFingerprintPreimage,
  MAX_SUPPORT_REPORT_BYTES,
  sealSupportReportEnvelope,
  serializeSupportReport,
  supportIncidentBuild,
  supportReportFileName,
  UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT,
  type DesktopSupportReportResponse,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import type { SupportReportDownload } from "./support-report-api";

export interface PreparedLocalSupportReport {
  readonly report: DesktopSupportReportResponse;
  readonly download: SupportReportDownload;
}

async function browserDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function localReport(signal: AbortSignal): Promise<DesktopSupportReportResponse> {
  signal.throwIfAborted();
  const sections = clientOnlySupportReportSections({
    incidentId: crypto.randomUUID().replaceAll("-", ""),
    nowMs: Date.now(),
    build: supportIncidentBuild(KEIKO_PRODUCT_VERSION, "other-other"),
    defectFingerprint: await browserDigest(
      defectFingerprintPreimage(UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT),
    ),
    availabilityReason: "service-unavailable",
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
  return {
    fileName: supportReportFileName(
      report.schemaVersion,
      report.incident.incidentId,
      report.incident.createdAtMs,
    ),
    reportJson: serializeSupportReport(report),
    evidenceScope: "client-only",
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
): Promise<PreparedLocalSupportReport> {
  return prepareCachedSupportReport(await localReport(signal), signal);
}
