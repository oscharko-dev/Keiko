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
  /\b(?:according\s+to|as\s+(?:stated|specified|documented)\s+in|laut|gemäß)\b|\b(?:the|this|these|that|those|our|my)\s+(?:(?:selected|attached|connected|supplied|retrieved)\s+)?(?:sources?|files?|manuals?|documents?|folders?|repositor(?:y|ies))\b|\b(?:die|das|der|diese[nrs]?|unser[e]?|mein[e]?)\s+(?:(?:ausgewählten?|verbundenen?|bereitgestellten?)\s+)?(?:quellen?|dateien?|handbuch|handbücher|dokumente?|ordner|repository)\b/iu;

/** Empty sent evidence and a positively parsed conversation grant cannot authenticate sources. */
function untaggedConversationAnswer(content: string): boolean {
  return (
    !hasOwnAssessmentTag(content) &&
    !SOURCE_ATTRIBUTION_RE.test(content) &&
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
