import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import type { GroundedInsufficiencyDeclaration } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  buildInsufficiencyScopeIndex,
  validateGroundedAnswerEvidence,
} from "./grounded-faithfulness.js";
import type { GroundedAnswerResult } from "./grounded-answer.js";
import { sentGroundedFileCount } from "./grounded-prompt.js";
import { extractAnchors } from "@oscharko-dev/keiko-workflows";
import { withContextualHintConfidence } from "./grounded-selection-quality.js";

/** Manifest source hashes describe the actual dispatch; usage still records all retrieval work. */
export function withSentEvidenceInventory(
  pack: ConnectedContextPack,
  sentPacks: readonly ConnectedContextPack[] | undefined,
): ConnectedContextPack {
  if (sentPacks === undefined) return pack;
  const sent = sentPacks.find(
    (entry) =>
      entry.scope.scopeId === pack.scope.scopeId &&
      entry.scope.workspaceRoot === pack.scope.workspaceRoot,
  );
  return { ...pack, files: sent?.files ?? [] };
}

/** Keep retrieval accounting while projecting confidence from the sources actually dispatched. */
export function withSentSelectionDiagnostics(
  pack: ConnectedContextPack,
  sentPacks: readonly ConnectedContextPack[] | undefined,
  nowMs: number,
): ConnectedContextPack {
  if (sentPacks === undefined) return pack;
  const observed = withContextualHintConfidence(
    withSentEvidenceInventory(pack, sentPacks),
    extractAnchors({
      text: pack.query.text,
      maxAnchors: 8,
      caseSensitive: pack.query.caseSensitive,
    }).anchors,
    nowMs,
  );
  return { ...observed, files: pack.files };
}

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
  discovered?: ReadonlyMap<string, GroundedInsufficiencyDeclaration["state"]>,
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
