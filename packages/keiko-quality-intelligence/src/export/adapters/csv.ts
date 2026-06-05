// Generic Keiko-native CSV export adapter (Epic #270, Issue #283).
//
// Pure-domain leaf. Reuses the spreadsheet-safe cell encoder so EVERY CSV
// adapter (Keiko-native, Jira, qTest, Xray, Polarion, ALM) shares the same
// formula-injection mitigation — the encoder is the single primitive.

import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { assertExportBundleInvariant } from "@oscharko-dev/keiko-contracts";
import { encodeSpreadsheetSafeRow } from "./spreadsheetSafeCsv.js";

/** Schema headers for the Keiko-native CSV format. */
export const CSV_HEADERS: readonly string[] = Object.freeze([
  "CandidateId",
  "RunId",
  "Title",
  "Priority",
  "RiskClass",
  "Status",
  "Tags",
  "Preconditions",
  "Steps",
  "ExpectedResults",
  "DerivedFromAtomIds",
  "CoverageMapRefs",
  "FindingRefs",
]);

const joinSemicolon = (values: readonly string[]): string => values.join(" ; ");

export function adaptToCsv(
  bundle: QualityIntelligenceExportBundle,
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): string {
  assertExportBundleInvariant(bundle);
  const byId = new Map<string, QualityIntelligenceTestCaseCandidate>();
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate);
  }
  const sortedEntries = [...bundle.contents].sort((a, b) =>
    a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0,
  );
  let body = encodeSpreadsheetSafeRow(CSV_HEADERS);
  for (const entry of sortedEntries) {
    const candidate = byId.get(entry.candidateId);
    if (candidate === undefined) {
      continue;
    }
    body += encodeSpreadsheetSafeRow([
      candidate.id,
      candidate.runId,
      candidate.title,
      candidate.priority,
      candidate.riskClass,
      candidate.status,
      joinSemicolon(candidate.tags),
      joinSemicolon(candidate.preconditions),
      joinSemicolon(candidate.steps),
      joinSemicolon(candidate.expectedResults),
      joinSemicolon(candidate.derivedFromAtomIds),
      joinSemicolon(entry.coverageMapRefs),
      joinSemicolon(entry.findingRefs),
    ]);
  }
  return body;
}
