// Keiko's own assessment inside a grounded answer (PR #3678, ADR-0144).
//
// A grounded answer states what the retrieved sources say and cites each statement with its [n]
// marker. A question that asks for Keiko's own view ("Which Java version do you suggest?") has no
// source-backed answer, and a sources-only prompt can then only repeat that the documents say
// nothing. When the operator allows it, the model adds its own assessment after the source-backed
// part, inside one `<assessment>` block. A plain text tag is something every model family
// reproduces reliably, open-weight models included, and it needs no structured-output support.
//
// Everything outside the block is held to the citation, entailment and refusal rules. The block is
// never cited, never judged, and always shown as Keiko's assessment rather than the sources'.

import { markdownCodeRanges } from "./citation-markers.js";

export const OWN_ASSESSMENT_POLICIES = ["allowed", "disabled"] as const;
export type OwnAssessmentPolicy = (typeof OWN_ASSESSMENT_POLICIES)[number];

/** A normal installation allows the labelled assessment; an operator may disable it. */
export const DEFAULT_OWN_ASSESSMENT_POLICY: OwnAssessmentPolicy = "allowed";

/** The system-prompt rule that allows the block. Short and plain, so small models follow it. */
export const OWN_ASSESSMENT_PROMPT_RULE =
  "Put everything the excerpts do not back (your own recommendation, opinion, general knowledge " +
  "or small talk) into one <assessment></assessment> block at the end; outside it, every " +
  "sentence needs its [n] marker. If the question needs no sources, answer inside the block " +
  "alone. When the block gives a recommendation or view, begin it by saying that it is your own " +
  "assessment, not a statement from the sources. Use no [n] markers inside it.";

export interface OwnAssessmentSplit {
  /** The source-backed part: every text outside the assessment block, trimmed. */
  readonly grounded: string;
  /** The block's content, trimmed; absent when the answer has none or it is empty. */
  readonly assessment?: string;
}

const TAG = /<\/?assessment>/giu;

interface DelimiterTag {
  readonly start: number;
  readonly end: number;
  readonly closing: boolean;
}

// The assessment tags that delimit: those outside Markdown code. A tag inside inline code or a
// fence is literal content, such as an XML example, and stays as written (PR #3678 review).
function delimiterTags(answer: string): readonly DelimiterTag[] {
  const code = markdownCodeRanges(answer);
  const tags: DelimiterTag[] = [];
  let range = 0;
  for (const match of answer.matchAll(TAG)) {
    while ((code[range]?.end ?? Number.POSITIVE_INFINITY) <= match.index) range += 1;
    if ((code[range]?.start ?? Number.POSITIVE_INFINITY) <= match.index) continue;
    const end = match.index + match[0].length;
    tags.push({ start: match.index, end, closing: match[0].charAt(1) === "/" });
  }
  return tags;
}

function joined(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * Splits an answer into its source-backed text and Keiko's assessment. Every `<assessment>` block
 * counts (tags matched case-insensitively, never inside Markdown code): a model that writes two
 * blocks never gets the second one's words past the citation rules (PR #3678 review). An unclosed
 * block runs to the end, stray tags are dropped, and an answer without a block is all
 * source-backed.
 */
export function splitOwnAssessment(answer: string): OwnAssessmentSplit {
  const grounded: string[] = [];
  const assessed: string[] = [];
  let inBlock = false;
  let cursor = 0;
  for (const tag of delimiterTags(answer)) {
    (inBlock ? assessed : grounded).push(answer.slice(cursor, tag.start));
    cursor = tag.end;
    if (tag.closing === inBlock) inBlock = !inBlock;
  }
  (inBlock ? assessed : grounded).push(answer.slice(cursor));
  const assessment = joined(assessed);
  return assessment.length === 0
    ? { grounded: joined(grounded) }
    : { grounded: joined(grounded), assessment };
}

/** True when `answer` carries an assessment tag outside Markdown code. */
export function hasOwnAssessmentTag(answer: string): boolean {
  return delimiterTags(answer).length > 0;
}

/** The stored answer: the source-backed part, then the canonical assessment block. */
export function composeOwnAssessment(grounded: string, assessment: string | undefined): string {
  if (assessment === undefined) return grounded;
  const block = `<assessment>\n${assessment.trim()}\n</assessment>`;
  return grounded.trim().length === 0 ? block : `${grounded.trim()}\n\n${block}`;
}

/** The answer as plain reading text, for copying or reading aloud: the tags go, the words stay. */
export function ownAssessmentPlainText(answer: string): string {
  const split = splitOwnAssessment(answer);
  return joined([split.grounded, split.assessment ?? ""]);
}
