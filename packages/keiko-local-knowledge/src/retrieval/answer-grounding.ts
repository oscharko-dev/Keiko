// Answer-grounding policy decision (Epic #189, Issue #199). Pure function over the
// retrieval result + the capsule's configured `answerGroundingPolicy`. Lives at the
// boundary between retrieval and the future #200 Conversation Center integration: the
// runner uses it to decide whether to release retrieved evidence to the LLM grounding
// prompt, and the UI layer reads `noEvidence` / `reason` to phrase the user-visible
// message.
//
// Three policies (matching `CapsuleAnswerGroundingPolicy` in contracts):
//   * "require-citations" — empty refs MUST block; no answer can fire.
//   * "require-citations-or-state-no-evidence" — empty refs are allowed *if* the caller
//     surfaces a "no evidence" message; the decision marks `noEvidence: true` so the
//     caller knows it has to.
//   * "best-effort" — empty refs are allowed; the LLM may answer without citations.
//
// `validateAnswerGrounding` is deliberately a *function*, not a method on a capsule or a
// store call. No IO, no allocation beyond the returned record. Tests pin every branch.

import type {
  CapsuleAnswerGroundingPolicy,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";

export type GroundingDecisionReason =
  | "allowed"
  | "require-citations-rejected"
  | "no-evidence-stated";

export interface GroundingDecision {
  // `allow=true` means the answer may fire (with or without citations). `allow=false`
  // means the runner must surface `RetrievalResult { references: [], noEvidence: true,
  // reason: "answer-grounding-rejected" }` and never release the refs to the LLM.
  readonly allow: boolean;
  readonly reason: GroundingDecisionReason;
  // `noEvidence=true` means the answer surface MUST state "no evidence found" (for the
  // "require-citations-or-state-no-evidence" policy this is the load-bearing contract).
  // For "require-citations" with refs present this is `false`. For "best-effort" with
  // refs present this is `false`; with empty refs this is `true` but `allow` stays true.
  readonly noEvidence: boolean;
}

export function validateAnswerGrounding(
  references: readonly RetrievalReference[],
  policy: CapsuleAnswerGroundingPolicy,
): GroundingDecision {
  const hasReferences = references.length > 0;
  if (policy === "require-citations") {
    if (hasReferences) return { allow: true, reason: "allowed", noEvidence: false };
    return { allow: false, reason: "require-citations-rejected", noEvidence: true };
  }
  if (policy === "require-citations-or-state-no-evidence") {
    if (hasReferences) return { allow: true, reason: "allowed", noEvidence: false };
    return { allow: true, reason: "no-evidence-stated", noEvidence: true };
  }
  // best-effort
  return { allow: true, reason: "allowed", noEvidence: !hasReferences };
}
