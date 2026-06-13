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
import { inlineField } from "../textSafety.js";
import { startsWithFormulaLead } from "./spreadsheetSafeCsv.js";

const byCandidateIdAsc = (a: { candidateId: string }, b: { candidateId: string }): number =>
  a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;

// Untrusted candidate free-text rendered into the EXPORTED Markdown artifact must not inject active
// Markdown structure into an external viewer, nor evaluate as a formula if the .md is pasted into a
// spreadsheet (Issue #284 AC2 — "Generated artifacts are sanitized before preview or export").
// `mdText` composes content-preserving (escape-not-strip) steps on top of inlineField:
//   1. inlineField — fold line breaks so the value stays one logical unit (Epic #711);
//   2. neutralise a leading spreadsheet formula lead (=,+,-,@, incl. a trimmed leading-whitespace
//      run) with a single-quote prefix — parity with the CSV adapters / traceability.mdCell;
//   3. escape the Markdown-active vectors a single-line value can still smuggle — a link or image
//      (incl. javascript:/data: hrefs) and a fenced-code run — mirroring the accepted #278
//      untrusted-markdown escape set (ingestion/untrustedContentNormalisation). The literal text is
//      preserved so an auditor still reads the original content.
const FENCED_CODE = /```/gu;
const IMAGE_OPEN = /!\[/gu;
const LINK_OPEN = /(?<!!)\[([^\]]*)\]\(/gu;

function mdText(value: string): string {
  const oneLine = inlineField(value);
  const formulaSafe = startsWithFormulaLead(oneLine) ? `'${oneLine}` : oneLine;
  return formulaSafe
    .replace(FENCED_CODE, "\\`\\`\\`")
    .replace(IMAGE_OPEN, "\\!\\[")
    .replace(LINK_OPEN, (_match: string, inner: string): string => `\\[${inner}\\](`);
}

const mdTextList = (items: readonly string[]): string[] => items.map(mdText);

const mdList = (items: readonly string[]): string =>
  items.length === 0
    ? "_none_\n"
    : mdTextList(items)
        .map((item) => `- ${item}`)
        .join("\n") + "\n";

function renderCandidate(candidate: QualityIntelligenceTestCaseCandidate, runId: string): string {
  const lines: string[] = [];
  lines.push(`## ${mdText(candidate.title)}\n`);
  lines.push(`**ID:** ${candidate.id}  `);
  lines.push(`**Run:** ${runId}  `);
  lines.push(`**Priority:** ${candidate.priority}  `);
  lines.push(`**Risk class:** ${candidate.riskClass}  `);
  lines.push(`**Status:** ${candidate.status}  `);
  lines.push(
    `**Tags:** ${candidate.tags.length > 0 ? mdTextList(candidate.tags).join(", ") : "_none_"}  `,
  );
  lines.push("");
  lines.push("### Preconditions\n");
  lines.push(mdList(candidate.preconditions));
  lines.push("### Steps\n");
  lines.push(
    candidate.steps.length === 0
      ? "_none_\n"
      : mdTextList(candidate.steps)
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
