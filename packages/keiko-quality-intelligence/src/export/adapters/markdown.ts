// Markdown export adapter (Epic #711).
//
// Produces a deterministic Markdown document with one section per candidate,
// sorted by candidateId ascending. No timestamps, no random content. Pure
// string output — byte-identical for identical input.
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

const mdList = (items: readonly string[]): string =>
  items.length === 0
    ? "_none_\n"
    : inlineFields(items)
        .map((item) => `- ${item}`)
        .join("\n") + "\n";

function renderCandidate(candidate: QualityIntelligenceTestCaseCandidate, runId: string): string {
  const lines: string[] = [];
  lines.push(`## ${inlineField(candidate.title)}\n`);
  lines.push(`**ID:** ${candidate.id}  `);
  lines.push(`**Run:** ${runId}  `);
  lines.push(`**Priority:** ${candidate.priority}  `);
  lines.push(`**Risk class:** ${candidate.riskClass}  `);
  lines.push(`**Status:** ${candidate.status}  `);
  lines.push(
    `**Tags:** ${candidate.tags.length > 0 ? inlineFields(candidate.tags).join(", ") : "_none_"}  `,
  );
  lines.push("");
  lines.push("### Preconditions\n");
  lines.push(mdList(candidate.preconditions));
  lines.push("### Steps\n");
  lines.push(
    candidate.steps.length === 0
      ? "_none_\n"
      : inlineFields(candidate.steps)
          .map((s, i) => `${String(i + 1)}. ${s}`)
          .join("\n") + "\n",
  );
  lines.push("### Expected results\n");
  lines.push(mdList(candidate.expectedResults));
  return lines.join("\n");
}

export function adaptToMarkdown(
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
  sections.push(`# Quality Intelligence Export\n`);
  sections.push(`**Bundle:** ${bundle.id}  `);
  sections.push(`**Run:** ${bundle.runId}  `);
  sections.push(`**Adapter:** ${bundle.targetAdapter}  `);
  sections.push("");
  for (const entry of sortedEntries) {
    const candidate = byId.get(entry.candidateId);
    if (candidate === undefined) {
      continue;
    }
    sections.push(renderCandidate(candidate, bundle.runId));
  }
  return sections.join("\n") + "\n";
}
