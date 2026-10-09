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

/** Shared authority rule, with the marker grammar actually supplied by the caller. */
export function ownAssessmentPromptRule(markerKind: "file" | "numeric" = "numeric"): string {
  const marker = markerKind === "file" ? "[path/to/file:line]" : "[n]";
  return (
    "Use learned knowledge for general explanations, recommendations and conversation, even without matching excerpts. " +
    "Put it in one <assessment></assessment> block labelled as your own knowledge, not from the sources. " +
    `Source-specific claims stay outside and need matching ${marker} citations from supplied evidence. ` +
    "Refusals, clarifications and missing-evidence declarations need no citation. " +
    "Use no citations or missing-evidence declarations inside the block. " +
    "Do not claim current or live verification from learned knowledge; state freshness limits when relevant."
  );
}

export const OWN_ASSESSMENT_PROMPT_RULE = ownAssessmentPromptRule();

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

/** Retains source formatting so literal indentation cannot become an actionable declaration. */
export function ownAssessmentSourceText(answer: string): string {
  const tags = delimiterTags(answer);
  if (tags.length === 0) return answer;
  const parts: string[] = [];
  let depth = 0;
  let cursor = 0;
  for (const tag of tags) {
    if (depth === 0) parts.push(answer.slice(cursor, tag.start));
    cursor = tag.end;
    depth = tag.closing ? Math.max(0, depth - 1) : depth + 1;
  }
  if (depth === 0) parts.push(answer.slice(cursor));
  return parts.join("\n\n");
}

/**
 * Splits an answer into its source-backed text and Keiko's assessment. Every `<assessment>` block
 * counts (tags matched case-insensitively, never inside Markdown code): a model that writes two
 * blocks, or nests one, never gets any of their words past the citation rules (PR #3678 review).
 * An unclosed block runs to the end, a stray closing tag is dropped, and an answer without a block
 * is all source-backed.
 */
export function splitOwnAssessment(answer: string): OwnAssessmentSplit {
  const grounded: string[] = [];
  const assessed: string[] = [];
  // Nested blocks count by depth: everything until the outermost block closes is assessment, so a
  // nested closing tag never hands the outer block's remaining words to the sources (PR #3678).
  let depth = 0;
  let cursor = 0;
  for (const tag of delimiterTags(answer)) {
    (depth > 0 ? assessed : grounded).push(answer.slice(cursor, tag.start));
    cursor = tag.end;
    depth = tag.closing ? Math.max(0, depth - 1) : depth + 1;
  }
  (depth > 0 ? assessed : grounded).push(answer.slice(cursor));
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
export function composeOwnAssessment(
  grounded: string,
  assessment: string | undefined,
  preserveSourceFormatting = false,
): string {
  if (assessment === undefined) return grounded;
  const block = `<assessment>\n${assessment.trim()}\n</assessment>`;
  const source = preserveSourceFormatting ? grounded : grounded.trim();
  return source.trim().length === 0 ? block : `${source}\n\n${block}`;
}

/** The answer as plain reading text, for copying or reading aloud: the tags go, the words stay. */
export function ownAssessmentPlainText(answer: string): string {
  const split = splitOwnAssessment(answer);
  return joined([split.grounded, split.assessment ?? ""]);
}

export interface PolicyOwnAssessmentSplit extends OwnAssessmentSplit {
  readonly neutralized: boolean;
}

/** A disabled block is dropped rather than promoted to source-backed text. */
export function splitOwnAssessmentForPolicy(
  answer: string,
  policy: OwnAssessmentPolicy,
): PolicyOwnAssessmentSplit {
  const split = {
    ...splitOwnAssessment(answer),
    grounded: ownAssessmentSourceText(answer).trimEnd(),
  };
  if (policy === "disabled")
    return { grounded: split.grounded, neutralized: hasOwnAssessmentTag(answer) };
  return { ...split, neutralized: false };
}
