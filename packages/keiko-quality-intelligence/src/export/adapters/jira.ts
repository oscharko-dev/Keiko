// Jira Issues CSV export adapter (Epic #270, Issue #283).
//
// Produces a Jira CSV in the canonical `Summary, Description, IssueType, Priority,
// Labels` shape. The output is the byte body only — there is NO HTTP, NO Jira REST
// SDK import, and NO authentication concern in this leaf. Live publishing of these
// CSVs to a Jira tenant is deferred to a future issue alongside connector
// authorisation (#278).
//
// TMS-bound adapter: `assertExportBundleInvariant` is invoked first, which enforces
// `redactionAttested === true` on the bundle. A non-attested bundle throws before
// any candidate is read.
//
// Pure-domain leaf. Reuses the shared spreadsheet-safe cell encoder so all CSV
// adapters share one formula-injection mitigation primitive.

import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { assertExportBundleInvariant } from "@oscharko-dev/keiko-contracts";
import { encodeSpreadsheetSafeRow } from "./spreadsheetSafeCsv.js";

/** Jira CSV columns; matches Jira's default "Bulk import" template. */
export const JIRA_CSV_HEADERS: readonly string[] = Object.freeze([
  "Summary",
  "Description",
  "IssueType",
  "Priority",
  "Labels",
]);

/** Jira `Issue Type` value used for QI exports. Spec: test cases land as Tests. */
const JIRA_ISSUE_TYPE = "Test";

const buildDescription = (candidate: QualityIntelligenceTestCaseCandidate): string => {
  const sections: string[] = [];
  if (candidate.preconditions.length > 0) {
    sections.push(`Preconditions:\n${candidate.preconditions.map((p) => `- ${p}`).join("\n")}`);
  }
  if (candidate.steps.length > 0) {
    sections.push(
      `Steps:\n${candidate.steps.map((step, i) => `${String(i + 1)}. ${step}`).join("\n")}`,
    );
  }
  if (candidate.expectedResults.length > 0) {
    sections.push(`Expected:\n${candidate.expectedResults.map((e) => `- ${e}`).join("\n")}`);
  }
  return sections.join("\n\n");
};

const mapPriority = (priority: QualityIntelligenceTestCaseCandidate["priority"]): string => {
  // Jira default priorities: Highest / High / Medium / Low / Lowest.
  switch (priority) {
    case "P0":
      return "Highest";
    case "P1":
      return "High";
    case "P2":
      return "Medium";
    case "P3":
      return "Low";
  }
};

export function adaptToJiraIssues(
  bundle: QualityIntelligenceExportBundle,
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): string {
  assertExportBundleInvariant(bundle);
  const byId = new Map<string, QualityIntelligenceTestCaseCandidate>();
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate);
  }
  const sortedIds = bundle.contents
    .map((entry) => entry.candidateId)
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let body = encodeSpreadsheetSafeRow(JIRA_CSV_HEADERS);
  for (const id of sortedIds) {
    const candidate = byId.get(id);
    if (candidate === undefined) {
      continue;
    }
    const labels = [candidate.riskClass, ...candidate.tags].join(" ");
    body += encodeSpreadsheetSafeRow([
      candidate.title,
      buildDescription(candidate),
      JIRA_ISSUE_TYPE,
      mapPriority(candidate.priority),
      labels,
    ]);
  }
  return body;
}
