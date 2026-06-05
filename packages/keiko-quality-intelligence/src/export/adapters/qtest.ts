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
    if (candidate === undefined) {
      continue;
    }
    if (candidate.steps.length === 0) {
      body += encodeSpreadsheetSafeRow([
        candidate.title,
        buildDescription(candidate),
        "Manual",
        mapPriority(candidate.priority),
        candidate.status,
        "",
        "",
        "",
      ]);
      continue;
    }
    for (let i = 0; i < candidate.steps.length; i += 1) {
      const action = candidate.steps[i] ?? "";
      const expected = candidate.expectedResults[i] ?? "";
      body += encodeSpreadsheetSafeRow([
        candidate.title,
        buildDescription(candidate),
        "Manual",
        mapPriority(candidate.priority),
        candidate.status,
        String(i + 1),
        action,
        expected,
      ]);
    }
  }
  return body;
}
