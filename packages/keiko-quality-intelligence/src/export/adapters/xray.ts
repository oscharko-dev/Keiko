// Xray CSV export adapter (Epic #270, Issue #283).
//
// Xray's "Test Case Importer" canonical shape: TCID, Summary, Description, Action,
// Data, Result, Test Type. Like qTest, a multi-step test occupies multiple rows
// where Summary/Description repeat across step rows.
//
// TMS-bound: invariant asserted first. Pure-domain — NO HTTP, NO Xray SDK.

import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { assertExportBundleInvariant } from "@oscharko-dev/keiko-contracts";
import { encodeSpreadsheetSafeRow } from "./spreadsheetSafeCsv.js";

export const XRAY_CSV_HEADERS: readonly string[] = Object.freeze([
  "TCID",
  "Summary",
  "Description",
  "Action",
  "Data",
  "Result",
  "TestType",
]);

const buildDescription = (candidate: QualityIntelligenceTestCaseCandidate): string => {
  if (candidate.preconditions.length === 0) {
    return "";
  }
  return candidate.preconditions.join(" ; ");
};

export function adaptToXray(
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
  let body = encodeSpreadsheetSafeRow(XRAY_CSV_HEADERS);
  for (const id of sortedIds) {
    const candidate = byId.get(id);
    if (candidate === undefined) {
      continue;
    }
    if (candidate.steps.length === 0) {
      body += encodeSpreadsheetSafeRow([
        candidate.id,
        candidate.title,
        buildDescription(candidate),
        "",
        "",
        "",
        "Manual",
      ]);
      continue;
    }
    for (let i = 0; i < candidate.steps.length; i += 1) {
      const action = candidate.steps[i] ?? "";
      const result = candidate.expectedResults[i] ?? "";
      body += encodeSpreadsheetSafeRow([
        candidate.id,
        candidate.title,
        buildDescription(candidate),
        action,
        "",
        result,
        "Manual",
      ]);
    }
  }
  return body;
}
