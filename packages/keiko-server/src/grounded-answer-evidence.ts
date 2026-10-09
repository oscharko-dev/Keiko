import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import type { GroundedInsufficiencyDeclaration } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  buildInsufficiencyScopeIndex,
  validateGroundedAnswerEvidence,
} from "./grounded-faithfulness.js";
import type { GroundedAnswerResult } from "./grounded-answer.js";

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
): GroundedAnswerResult {
  const sentEvidencePacks = answer.sentEvidencePacks ?? [pack];
  const index =
    answer.evidenceScopeIndex ??
    buildInsufficiencyScopeIndex(sentEvidencePacks, verifiedPackInventory(pack));
  const evidence = validateGroundedAnswerEvidence(answer.content, index, question);
  return {
    ...answer,
    ...evidence,
    answerKind: answer.answerKind ?? evidence.answerKind,
    insufficiencyObservation: answer.insufficiencyObservation ?? evidence.insufficiencyObservation,
    evidenceScopeIndex: index,
    sentEvidencePacks,
    filesInPrompt: new Set(
      sentEvidencePacks.flatMap((sent) =>
        sent.files.filter((file) => file.excerpts.length > 0).map((file) => file.scopePath),
      ),
    ).size,
  };
}
