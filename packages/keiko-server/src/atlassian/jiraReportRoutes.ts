import { exportJiraReport } from "@oscharko-dev/keiko-connectors";
import {
  JIRA_REPORT_EXPORT_FORMATS,
  JIRA_REPORT_ID_PATTERN,
  type JiraReportExportFormat,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { UiHandlerDeps } from "../deps.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { errorBody } from "../route-error.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import { recordJiraReportActivity } from "./jiraReportActivity.js";

const REPORT_ID = new RegExp(JIRA_REPORT_ID_PATTERN, "u");
const CHAT_ID = /^[A-Za-z0-9._-]{1,128}$/u;

function formatOf(value: string | null): JiraReportExportFormat | undefined {
  return JIRA_REPORT_EXPORT_FORMATS.find((format) => format === value);
}
function refused(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  refusal: "invalid-format" | "export-unavailable",
  startedAt: number,
): RouteResult {
  recordJiraReportActivity(deps.activityLog, correlationIdOrUnknown(ctx.correlationId), {
    phase: "export",
    refusal,
    durationMs: Date.now() - startedAt,
  });
  return refusal === "invalid-format"
    ? {
        status: 400,
        body: errorBody("INVALID_REQUEST", "Invalid report export.", ctx.correlationId),
      }
    : {
        status: 404,
        body: errorBody(
          "JIRA_REPORT_UNAVAILABLE",
          "The Jira report is not available. Run it again to export it.",
          ctx.correlationId,
        ),
      };
}

/**
 * The user-controlled local export of a finished Jira report (#4181): the server renders the stored,
 * computed report as Markdown or CSV and the browser saves the file. A model's prose is never the
 * source, nothing is uploaded and the report stays bound to the Chat that started it.
 */
export function exportJiraReportRoute(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const startedAt = Date.now();
  const format = formatOf(ctx.url.searchParams.get("format"));
  const reportId = ctx.params.reportId ?? "";
  const chatId = ctx.url.searchParams.get("chatId") ?? "";
  if (format === undefined || !REPORT_ID.test(reportId) || !CHAT_ID.test(chatId))
    return refused(ctx, deps, "invalid-format", startedAt);
  const report = deps.jiraReportStore?.peek(reportId, chatId)?.report;
  if (report === undefined) return refused(ctx, deps, "export-unavailable", startedAt);
  const file = exportJiraReport(report, format);
  recordJiraReportActivity(deps.activityLog, correlationIdOrUnknown(ctx.correlationId), {
    phase: "export",
    format,
    byteCount: file.byteCount,
    durationMs: Date.now() - startedAt,
  });
  return { status: 200, body: file, headers: { "Cache-Control": "no-store" } };
}

export const JIRA_REPORT_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/atlassian-connectors/jira-reports/:reportId/export",
    handler: exportJiraReportRoute,
  },
];
