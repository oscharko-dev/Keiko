// Micro Focus ALM (Quality Center) CSV export adapter (Epic #270, Issue #283).
//
// ALM's Excel-add-in bulk-import shape: Test Name, Description, Type, Designer,
// Subject, Step Name, Description (step), Expected Result. One row per (test, step)
// like qTest / Xray.
//
// TMS-bound: invariant asserted first. Pure-domain — NO HTTP, NO ALM SDK.

import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { assertExportBundleInvariant } from "@oscharko-dev/keiko-contracts";
import { encodeSpreadsheetSafeRow } from "./spreadsheetSafeCsv.js";

export const ALM_CSV_HEADERS: readonly string[] = Object.freeze([
  "TestName",
  "Description",
  "Type",
  "Designer",
  "Subject",
  "StepName",
  "StepDescription",
  "ExpectedResult",
]);

const ALM_DESIGNER = "keiko-quality-intelligence";

const buildDescription = (candidate: QualityIntelligenceTestCaseCandidate): string => {
  if (candidate.preconditions.length === 0) {
    return "";
  }
  return `Preconditions: ${candidate.preconditions.join(" ; ")}`;
};

const buildSubject = (candidate: QualityIntelligenceTestCaseCandidate): string => {
  return `Subject/${candidate.riskClass}`;
};

// Build the ALM rows for a single candidate. One row per (step, expected) pair — the row count is
// the longer of `steps`/`expectedResults` so a trailing expected result is never dropped (Issue
// #283); a candidate with neither yields one empty-step row.
function almRowsFor(candidate: QualityIntelligenceTestCaseCandidate): string {
  const head: readonly string[] = [
    candidate.title,
    buildDescription(candidate),
    "MANUAL",
    ALM_DESIGNER,
    buildSubject(candidate),
  ];
  const rowCount = Math.max(candidate.steps.length, candidate.expectedResults.length);
  if (rowCount === 0) {
    return encodeSpreadsheetSafeRow([...head, "", "", ""]);
  }
  let rows = "";
  for (let i = 0; i < rowCount; i += 1) {
    const stepName = i < candidate.steps.length ? `Step ${String(i + 1)}` : "";
    rows += encodeSpreadsheetSafeRow([
      ...head,
      stepName,
      candidate.steps[i] ?? "",
      candidate.expectedResults[i] ?? "",
    ]);
  }
  return rows;
}

export function adaptToAlm(
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
  let body = encodeSpreadsheetSafeRow(ALM_CSV_HEADERS);
  for (const id of sortedIds) {
    const candidate = byId.get(id);
    if (candidate !== undefined) {
      body += almRowsFor(candidate);
    }
  }
  return body;
}
