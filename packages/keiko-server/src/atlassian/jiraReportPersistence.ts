import { exportJiraReport, type JiraReportStore } from "@oscharko-dev/keiko-connectors";
import type { UiHandlerDeps } from "../deps.js";
import type { JiraReportExportStore } from "../store/jiraReportExports.js";
import { recordJiraReportActivity } from "./jiraReportActivity.js";

type FinishedSession = ReturnType<JiraReportStore["finished"]>[number];

function retain(store: JiraReportExportStore, session: FinishedSession): boolean {
  const { report } = session;
  if (report === undefined) return false;
  if (store.touch(session.id, session.owner, report.digest, session.lastUsedAt)) return true;
  return store.put({
    reportId: session.id,
    owner: session.owner,
    lastUsedAt: session.lastUsedAt,
    reportDigest: report.digest,
    markdown: exportJiraReport(report, "markdown").content,
    csv: exportJiraReport(report, "csv").content,
  });
}

/** Persist final, computed downloads before the tool publishes their card; no authority is saved. */
export function retainJiraReportExports(
  deps: Pick<UiHandlerDeps, "store" | "activityLog">,
  reports: JiraReportStore,
  owner: string,
  correlationId: string,
): void {
  const store = deps.store.jiraReportExports;
  if (store === undefined) return;
  const startedAt = Date.now();
  let retainedReportCount = 0;
  let failed = false;
  for (const session of reports.finished(owner)) {
    try {
      if (retain(store, session)) retainedReportCount++;
      else failed = true;
    } catch {
      // SQLite or projection errors may contain private report text. Record only the closed failure.
      failed = true;
    }
  }
  recordJiraReportActivity(deps.activityLog, correlationId, {
    phase: "retain",
    retainedReportCount,
    ...(failed ? { refusal: "export-unavailable" } : {}),
    durationMs: Date.now() - startedAt,
  });
}
