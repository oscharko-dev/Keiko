// Plain-text export adapter (Epic #711).
//
// Produces a deterministic plain-text document with one section per candidate,
// sorted by candidateId ascending. No timestamps, no random content. Pure
// string output — byte-identical for identical input.
//
// Pure-domain leaf. NO IO. NO node:* imports. NO new runtime dependency.

import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { assertExportBundleInvariant } from "@oscharko-dev/keiko-contracts";

const byCandidateIdAsc = (a: { candidateId: string }, b: { candidateId: string }): number =>
  a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;

const RULE = "=".repeat(60);
const DIVIDER = "-".repeat(40);

const listItems = (items: readonly string[], indent = "  "): string =>
  items.length === 0
    ? `${indent}(none)\n`
    : items.map((item) => `${indent}- ${item}`).join("\n") + "\n";

const numberedList = (items: readonly string[], indent = "  "): string =>
  items.length === 0
    ? `${indent}(none)\n`
    : items.map((item, i) => `${indent}${String(i + 1)}. ${item}`).join("\n") + "\n";

function renderCandidate(candidate: QualityIntelligenceTestCaseCandidate, index: number): string {
  const lines: string[] = [];
  lines.push(`${DIVIDER}\n`);
  lines.push(`CANDIDATE ${String(index + 1)}: ${candidate.title}\n`);
  lines.push(`  ID:         ${candidate.id}`);
  lines.push(`  Priority:   ${candidate.priority}`);
  lines.push(`  Risk class: ${candidate.riskClass}`);
  lines.push(`  Status:     ${candidate.status}`);
  lines.push(`  Tags:       ${candidate.tags.length > 0 ? candidate.tags.join(", ") : "(none)"}`);
  lines.push("");
  lines.push("  Preconditions:");
  lines.push(listItems(candidate.preconditions, "    ").trimEnd());
  lines.push("");
  lines.push("  Steps:");
  lines.push(numberedList(candidate.steps, "    ").trimEnd());
  lines.push("");
  lines.push("  Expected results:");
  lines.push(listItems(candidate.expectedResults, "    ").trimEnd());
  return lines.join("\n") + "\n";
}

export function adaptToPlainText(
  bundle: QualityIntelligenceExportBundle,
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): string {
  assertExportBundleInvariant(bundle);
  const byId = new Map<string, QualityIntelligenceTestCaseCandidate>();
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate);
  }
  const sortedEntries = [...bundle.contents].sort(byCandidateIdAsc);
  const sections: string[] = [];
  sections.push(`${RULE}\n`);
  sections.push("QUALITY INTELLIGENCE EXPORT\n");
  sections.push(`${RULE}\n`);
  sections.push(`Bundle: ${bundle.id}`);
  sections.push(`Run:    ${bundle.runId}`);
  sections.push(`Format: ${bundle.targetAdapter}`);
  sections.push("");
  let index = 0;
  for (const entry of sortedEntries) {
    const candidate = byId.get(entry.candidateId);
    if (candidate === undefined) {
      continue;
    }
    sections.push(renderCandidate(candidate, index));
    index += 1;
  }
  sections.push(`${RULE}\n`);
  return sections.join("\n") + "\n";
}
