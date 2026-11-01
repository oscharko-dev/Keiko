"use client";
import {
  JIRA_REPORT_EXPORT_MEDIA_TYPES,
  type JiraReportExportFormat,
  type JiraReportExportResponse,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { ApiError } from "./api";
import { bffFetchJson } from "./http";

const FILE_NAME = /^keiko-jira-report-[0-9a-f]{12}\.(?:md|csv)$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

function isExportFile(
  value: unknown,
  format: JiraReportExportFormat,
): value is JiraReportExportResponse {
  if (typeof value !== "object" || value === null) return false;
  const file: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return (
    file.format === format &&
    file.mediaType === JIRA_REPORT_EXPORT_MEDIA_TYPES[format] &&
    typeof file.fileName === "string" &&
    FILE_NAME.test(file.fileName) &&
    typeof file.content === "string" &&
    file.byteCount === new TextEncoder().encode(file.content).byteLength &&
    typeof file.reportDigest === "string" &&
    DIGEST.test(file.reportDigest)
  );
}

/**
 * The user-controlled local export of a finished Jira report (#4181): the server renders the
 * stored, computed report and the caller hands the file to the browser's own download path. A
 * response that is not the file asked for is a contract failure, never a download.
 */
export async function exportJiraReport(
  reportId: string,
  chatId: string,
  format: JiraReportExportFormat,
  correlationId?: string,
): Promise<JiraReportExportResponse> {
  const query = new URLSearchParams({ chatId, format });
  return bffFetchJson(
    `/api/atlassian-connectors/jira-reports/${encodeURIComponent(reportId)}/export?${query.toString()}`,
    { signal: AbortSignal.timeout(30_000), cache: "no-store" },
    {
      validator: (_path, value): JiraReportExportResponse => {
        if (!isExportFile(value, format))
          throw new ApiError("CONTRACT_VALIDATION_FAILED", "Invalid Jira report export", 502);
        return value;
      },
      ...(correlationId === undefined ? {} : { correlationId }),
    },
  );
}
