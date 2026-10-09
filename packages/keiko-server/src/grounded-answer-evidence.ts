import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import type { GroundedInsufficiencyDeclaration } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  buildInsufficiencyScopeIndex,
  validateGroundedAnswerEvidence,
} from "./grounded-faithfulness.js";
import type { GroundedAnswerResult } from "./grounded-answer.js";
import { sentGroundedFileCount } from "./grounded-prompt.js";

/** Absent legacy metadata may use assembly; an authoritative empty inventory grants no support. */
export function singleSentEvidencePack(
  answer: Pick<GroundedAnswerResult, "sentEvidencePacks">,
  assembled: ConnectedContextPack,
): ConnectedContextPack {
  if (answer.sentEvidencePacks === undefined) return assembled;
  return answer.sentEvidencePacks[0] ?? { ...assembled, files: [] };
}

function verifiedPackInventory(
  pack: ConnectedContextPack,
): ReadonlyMap<string, GroundedInsufficiencyDeclaration["state"]> {
  const eligible = new Set(["low-relevance", "near-duplicate", "budget-exhausted"]);
  return new Map(
    [...pack.files, ...pack.omitted.filter((entry) => eligible.has(entry.reason))].map((entry) => [
      entry.scopePath,
      "unread-in-scope",
    ]),
  );
}

export function validateSingleAnswerEvidence(
  answer: GroundedAnswerResult,
  pack: ConnectedContextPack,
  question: string,
  discovered?: ReadonlyMap<string, GroundedInsufficiencyDeclaration["state"]> | undefined,
): GroundedAnswerResult {
  const sentEvidencePacks = answer.sentEvidencePacks ?? [pack];
  const index =
    answer.evidenceScopeIndex ??
    buildInsufficiencyScopeIndex(
      sentEvidencePacks,
      new Map([...verifiedPackInventory(pack), ...(discovered ?? [])]),
    );
  const evidence = validateGroundedAnswerEvidence(answer.content, index, question);
  const filesInPrompt = sentGroundedFileCount(sentEvidencePacks);
  return {
    ...answer,
    ...evidence,
    answerKind: answer.answerKind ?? evidence.answerKind,
    insufficiencyObservation: answer.insufficiencyObservation ?? evidence.insufficiencyObservation,
    evidenceScopeIndex: index,
    sentEvidencePacks,
    filesInPrompt,
    ...(filesInPrompt === 0 ? { noEvidence: true } : {}),
  };
}
