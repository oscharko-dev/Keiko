import {
  composeOwnAssessment,
  hasOwnAssessmentTag,
  splitOwnAssessmentForPolicy,
  type OwnAssessmentPolicy,
} from "@oscharko-dev/keiko-contracts/runtime/grounded-assessment";
import { connectedSearchNoEvidenceAnswer } from "@oscharko-dev/keiko-contracts/runtime/no-evidence-answer";
import { citationMarkerIndices } from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import { extractPathReferences } from "@oscharko-dev/keiko-workflows";
import {
  classifyGroundedAnswerKind,
  declaredInsufficiencyPaths,
  parseInlineCitations,
} from "./grounded-faithfulness.js";
import type { GroundedAnswerResult } from "./grounded-answer.js";
import { logAnswerAssessment, type AnswerAssessmentIdentity } from "./grounded-citation-log.js";
export { isGroundedAssessmentOnly } from "./grounded-faithfulness.js";

// A claim about selected evidence remains source-authoritative even without a marker or path.
const SOURCE_ATTRIBUTION_RE =
  /\b(?:according\s+to|as\s+(?:stated|specified|documented)\s+in|laut|gemäß)\b/iu;
const SOURCE_DETERMINER_RE =
  /^(?:the|this|these|that|those|our|my|your|his|her|its|their|die|das|der|den|dem|des|dies(?:e|en|em|er|es)|(?:unser|mein|dein|euer|ihr)(?:e|en|em|er|es)?|eur(?:e|en|em|er|es))$/iu;
const SOURCE_NOUN_RE =
  /^(?:sources?|files?|manuals?|documents?|folders?|repositor(?:y|ies)|quellen?|datei(?:en)?|handbuchs?|handbüchern?|dokument(?:e|en|s)?|ordnern?|repository)$/iu;
const SOURCE_PHRASE_TOKEN_RE = /[\p{L}\p{N}-]+|[^\p{L}\p{N}\s-]/gu;
const SOURCE_PHRASE_BOUNDARY_RE =
  /^(?:am|is|are|was|were|be|been|being|do|does|did|have|has|had|can|could|may|might|must|shall|should|will|would|to|for|from|with|without|before|after|during|on|in|at|into|over|under|by|about|against|between|through|bin|bist|ist|sind|war|waren|sein|habe|hat|haben|kann|können|könnte|könnten|muss|müssen|soll|sollen|sollte|sollten|wird|werden|würde|würden|zu|für|von|mit|ohne|vor|nach|während|auf|an|über|unter|bei|gegen|zwischen|durch)$/iu;

/** Modifiers retain attribution within a noun phrase, not across a separate predicate or clause. */
function attributedSourcePhrase(content: string): boolean {
  let determined = false;
  for (const match of content.matchAll(SOURCE_PHRASE_TOKEN_RE)) {
    const token = match[0];
    if (determined && SOURCE_NOUN_RE.test(token)) return true;
    if (SOURCE_DETERMINER_RE.test(token)) determined = true;
    else if (SOURCE_PHRASE_BOUNDARY_RE.test(token) || !/^[\p{L}\p{N}-]+$/u.test(token))
      determined = false;
  }
  return false;
}

/** Empty sent evidence and a positively parsed conversation grant cannot authenticate sources. */
function untaggedConversationAnswer(content: string): boolean {
  return (
    !hasOwnAssessmentTag(content) &&
    !SOURCE_ATTRIBUTION_RE.test(content) &&
    !attributedSourcePhrase(content) &&
    classifyGroundedAnswerKind(content) === "answer" &&
    parseInlineCitations(content).length === 0 &&
    citationMarkerIndices(content).length === 0 &&
    declaredInsufficiencyPaths(content).length === 0 &&
    extractPathReferences(content).length === 0
  );
}

/** Canonical assessment authority before source validation; the existing log stores sizes only. */
export function normalizeGroundedAnswerAssessment(
  answer: GroundedAnswerResult,
  policy: OwnAssessmentPolicy,
  correlationId: string | undefined,
  question = "",
  identity?: AnswerAssessmentIdentity,
  conversationWithoutEvidence = false,
): GroundedAnswerResult {
  const split = splitOwnAssessmentForPolicy(answer.content, policy);
  const { grounded, assessment, neutralized } =
    policy === "allowed" &&
    conversationWithoutEvidence &&
    untaggedConversationAnswer(answer.content)
      ? { grounded: "", assessment: answer.content.trim(), neutralized: false }
      : split;
  logAnswerAssessment(
    { policy, sourceBacked: grounded, assessment, neutralized },
    correlationId,
    identity,
  );
  const content = composeOwnAssessment(grounded, assessment, true);
  return {
    ...answer,
    content: content.trim().length === 0 ? connectedSearchNoEvidenceAnswer(question) : content,
  };
}
