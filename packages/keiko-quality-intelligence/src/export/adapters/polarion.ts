// Polarion CSV export adapter (Epic #270, Issue #283).
//
// Polarion's bulk-import canonical shape: ID, Title, Type, Severity, Description,
// TestSteps (semicolon-joined). One row per test case (Polarion stores steps as a
// single repeating attribute via its Excel/CSV importer).
//
// TMS-bound: invariant asserted first. Pure-domain — NO HTTP, NO Polarion SDK.

import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { assertExportBundleInvariant } from "@oscharko-dev/keiko-contracts";
import { encodeSpreadsheetSafeRow } from "./spreadsheetSafeCsv.js";

export const POLARION_CSV_HEADERS: readonly string[] = Object.freeze([
  "ID",
  "Title",
  "Type",
  "Severity",
  "Description",
  "TestSteps",
]);

const mapSeverity = (priority: QualityIntelligenceTestCaseCandidate["priority"]): string => {
  // Polarion default severities; closest mapping to QI's P0..P3.
  switch (priority) {
    case "P0":
      return "blocker";
    case "P1":
      return "critical";
    case "P2":
      return "major";
    case "P3":
      return "minor";
  }
};

const buildDescription = (candidate: QualityIntelligenceTestCaseCandidate): string => {
  const parts: string[] = [];
  if (candidate.preconditions.length > 0) {
    parts.push(`Preconditions: ${candidate.preconditions.join(" ; ")}`);
  }
  if (candidate.expectedResults.length > 0) {
    parts.push(`Expected: ${candidate.expectedResults.join(" ; ")}`);
  }
  return parts.join(" || ");
};

export function adaptToPolarion(
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
  let body = encodeSpreadsheetSafeRow(POLARION_CSV_HEADERS);
  for (const id of sortedIds) {
    const candidate = byId.get(id);
    if (candidate === undefined) {
      continue;
    }
    body += encodeSpreadsheetSafeRow([
      candidate.id,
      candidate.title,
      "testcase",
      mapSeverity(candidate.priority),
      buildDescription(candidate),
      candidate.steps.join(" ; "),
    ]);
  }
  return body;
}
