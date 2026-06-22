// qTest CSV export adapter (Epic #270, Issue #283).
//
// qTest's canonical bulk-import shape carries ONE row per (test case, step) pair so
// the test-case header columns (Name, Description, Type, Priority) repeat across
// step rows of the same test case. A test case with N steps occupies N rows; a
// test case with zero steps occupies one row (with empty Step Number / Action /
// Expected). Ordering is deterministic: candidate id ASC, then 1-based step index.
//
// TMS-bound: `assertExportBundleInvariant` runs first. Pure-domain leaf — NO HTTP,
// NO qTest SDK.

import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { assertExportBundleInvariant } from "@oscharko-dev/keiko-contracts";
import { encodeSpreadsheetSafeRow } from "./spreadsheetSafeCsv.js";

export const QTEST_CSV_HEADERS: readonly string[] = Object.freeze([
  "Name",
  "Description",
  "Type",
  "Priority",
  "Status",
  "StepNumber",
  "Action",
  "Expected",
]);

const buildDescription = (candidate: QualityIntelligenceTestCaseCandidate): string => {
  if (candidate.preconditions.length === 0) {
    return "";
  }
  return `Preconditions: ${candidate.preconditions.join(" ; ")}`;
};

const mapPriority = (priority: QualityIntelligenceTestCaseCandidate["priority"]): string => {
  // qTest default priorities are P-prefixed; pass through verbatim.
  return priority;
};

// Build the qTest rows for a single candidate. One row per (step, expected) pair — the row count is
// the longer of `steps`/`expectedResults` so a trailing expected result is never dropped (Issue
// #283); a candidate with neither yields one empty-step row.
function qtestRowsFor(candidate: QualityIntelligenceTestCaseCandidate): string {
  const head: readonly string[] = [
    candidate.title,
    buildDescription(candidate),
    "Manual",
    mapPriority(candidate.priority),
    candidate.status,
  ];
  const rowCount = Math.max(candidate.steps.length, candidate.expectedResults.length);
  if (rowCount === 0) {
    return encodeSpreadsheetSafeRow([...head, "", "", ""]);
  }
  let rows = "";
  for (let i = 0; i < rowCount; i += 1) {
    const stepNumber = i < candidate.steps.length ? String(i + 1) : "";
    rows += encodeSpreadsheetSafeRow([
      ...head,
      stepNumber,
      candidate.steps[i] ?? "",
      candidate.expectedResults[i] ?? "",
    ]);
  }
  return rows;
}

export function adaptToQtest(
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
  let body = encodeSpreadsheetSafeRow(QTEST_CSV_HEADERS);
  for (const id of sortedIds) {
    const candidate = byId.get(id);
    if (candidate !== undefined) {
      body += qtestRowsFor(candidate);
    }
  }
  return body;
}
