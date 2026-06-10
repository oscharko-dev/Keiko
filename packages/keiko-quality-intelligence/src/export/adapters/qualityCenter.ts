// Quality Center (ALM Octane) export adapter (Epic #711).
//
// TMS-bound adapter: produces a deterministic dry-run preview of the payload
// that would be submitted to Quality Center / ALM Octane. NO outbound write
// is ever performed here — this is a preview-only leaf. The route layer enforces
// the 403 QI_EXTERNAL_EXPORT_DISABLED guard on non-dry-run requests.
//
// Output format: a simple key-value text report, one test case per block, sorted
// by candidateId ascending. No timestamps. No random content. Byte-stable.
//
// Pure-domain leaf. NO IO. NO node:* imports. NO new runtime dependency.

import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { assertExportBundleInvariant } from "@oscharko-dev/keiko-contracts";
import { inlineField, inlineFields } from "../textSafety.js";

const byCandidateIdAsc = (a: { candidateId: string }, b: { candidateId: string }): number =>
  a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;

const DIVIDER = "-".repeat(60);

const joinPipe = (items: readonly string[]): string =>
  items.length === 0 ? "(none)" : inlineFields(items).join(" | ");

function renderEntry(candidate: QualityIntelligenceTestCaseCandidate, index: number): string {
  const lines: string[] = [];
  lines.push(DIVIDER);
  lines.push(`QC-${String(index + 1).padStart(4, "0")} ${inlineField(candidate.title)}`);
  lines.push(`  ID:           ${candidate.id}`);
  lines.push(`  Priority:     ${candidate.priority}`);
  lines.push(`  Risk class:   ${candidate.riskClass}`);
  lines.push(`  Status:       ${candidate.status}`);
  lines.push(`  Tags:         ${joinPipe(candidate.tags)}`);
  lines.push(`  Precond:      ${joinPipe(candidate.preconditions)}`);
  lines.push(`  Steps:        ${joinPipe(candidate.steps)}`);
  lines.push(`  Expected:     ${joinPipe(candidate.expectedResults)}`);
  return lines.join("\n");
}

export function adaptToQualityCenter(
  bundle: QualityIntelligenceExportBundle,
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): string {
  assertExportBundleInvariant(bundle);
  const byId = new Map<string, QualityIntelligenceTestCaseCandidate>();
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate);
  }
  const sortedEntries = [...bundle.contents].sort(byCandidateIdAsc);
  const header = [
    `Quality Center Export Preview`,
    `Bundle: ${bundle.id}`,
    `Run:    ${bundle.runId}`,
    `NOTE: This is a dry-run preview. Live export requires a configured connector.`,
    "",
  ].join("\n");
  const rows: string[] = [];
  let index = 0;
  for (const entry of sortedEntries) {
    const candidate = byId.get(entry.candidateId);
    if (candidate === undefined) {
      continue;
    }
    rows.push(renderEntry(candidate, index));
    index += 1;
  }
  return header + rows.join("\n") + "\n";
}
