import type { DesktopSupportReportResponse } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { MAX_SUPPORT_REPORT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { bffFetchJson } from "./http";

export async function createSupportReport(
  correlationId?: string,
  signal?: AbortSignal,
): Promise<DesktopSupportReportResponse> {
  return bffFetchJson<DesktopSupportReportResponse>(
    "/api/diagnostics/report",
    {
      method: "POST",
      body: JSON.stringify(correlationId === undefined ? {} : { correlationId }),
      signal:
        signal === undefined
          ? AbortSignal.timeout(35_000)
          : AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
    },
    {
      validator: (_path, value): DesktopSupportReportResponse =>
        validateSupportReportResponse(value),
    },
  );
}

export function downloadSupportReport(report: DesktopSupportReportResponse): void {
  const url = URL.createObjectURL(new Blob([report.reportJson], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = report.fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function validateSupportReportResponse(value: unknown): DesktopSupportReportResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("fileName" in value) ||
    !("reportJson" in value)
  )
    throw new TypeError("Invalid support report response");
  if (
    typeof value.fileName !== "string" ||
    !/^keiko-support-v1-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}\.json$/u.test(value.fileName) ||
    typeof value.reportJson !== "string" ||
    value.reportJson.length > MAX_SUPPORT_REPORT_BYTES
  )
    throw new TypeError("Invalid support report response");
  return { fileName: value.fileName, reportJson: value.reportJson };
}
