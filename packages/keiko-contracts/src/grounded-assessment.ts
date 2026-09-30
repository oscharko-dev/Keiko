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

const OPEN_TAG = /<assessment>/iu;
const CLOSE_TAG = /<\/assessment>/iu;
const ANY_TAG = /<\/?assessment>/giu;
const SOME_TAG = /<\/?assessment>/iu;

function withoutTags(text: string): string {
  return text.replace(ANY_TAG, "");
}

function joined(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * Splits an answer at its first `<assessment>` block (tags matched case-insensitively). An
 * unclosed block runs to the end; text after a closed block stays source-backed; stray tags are
 * dropped. An answer without a block is all source-backed.
 */
export function splitOwnAssessment(answer: string): OwnAssessmentSplit {
  const open = OPEN_TAG.exec(answer);
  if (open === null) return { grounded: withoutTags(answer).trim() };
  const before = answer.slice(0, open.index);
  const rest = answer.slice(open.index + open[0].length);
  const close = CLOSE_TAG.exec(rest);
  const inside = close === null ? rest : rest.slice(0, close.index);
  const after = close === null ? "" : rest.slice(close.index + close[0].length);
  const grounded = joined([withoutTags(before), withoutTags(after)]);
  const assessment = withoutTags(inside).trim();
  return assessment.length === 0 ? { grounded } : { grounded, assessment };
}

/** True when `answer` carries an assessment tag at all. */
export function hasOwnAssessmentTag(answer: string): boolean {
  return SOME_TAG.test(answer);
}

/** Removes every assessment tag and keeps the text inline: the answer when the policy disables it. */
export function withoutOwnAssessmentTags(answer: string): string {
  return withoutTags(answer).trim();
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
