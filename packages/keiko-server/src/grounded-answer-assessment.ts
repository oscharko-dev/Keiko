import {
  composeOwnAssessment,
  splitOwnAssessmentForPolicy,
  type OwnAssessmentPolicy,
} from "@oscharko-dev/keiko-contracts/runtime/grounded-assessment";
import { connectedSearchNoEvidenceAnswer } from "@oscharko-dev/keiko-contracts/runtime/no-evidence-answer";
import type { GroundedAnswerResult } from "./grounded-answer.js";
import { logAnswerAssessment, type AnswerAssessmentIdentity } from "./grounded-citation-log.js";
export { isGroundedAssessmentOnly } from "./grounded-faithfulness.js";

/** Canonical assessment authority before source validation; the existing log stores sizes only. */
export function normalizeGroundedAnswerAssessment(
  answer: GroundedAnswerResult,
  policy: OwnAssessmentPolicy,
  correlationId: string | undefined,
  question = "",
  identity?: AnswerAssessmentIdentity,
): GroundedAnswerResult {
  const { grounded, assessment, neutralized } = splitOwnAssessmentForPolicy(answer.content, policy);
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
