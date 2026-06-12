// Conversation Center wiring contracts (Epic #189, Issue #200). The conversation/ layer
// is the *integration seam* that exposes the #199 retrieval pipeline to the Conversation
// Center BFF. The BFF (in `packages/keiko-server`, out of scope here) calls
// `runGroundedAnswer` when a chat user submits a question with a CapsuleSet (or single
// Capsule) selected; the runner composes retrieval + grounded-context assembly + an
// injected `AnswerGenerator` and returns a structured answer with mapped citations.
//
// Three shapes live here:
//   * `ConversationGroundedQuery` — the BFF's input. Exactly one of `capsuleId` or
//     `capsuleSetId` may be set (the runner enforces this; "neither" surfaces as a
//     `no-scope` answer, the same contract the underlying retrieval runner uses).
//   * `ConversationGroundedAnswer` — the BFF's output. Carries the answer text, the
//     citations the answer is grounded in, the verbatim `LocalKnowledgeGroundedContextPack`
//     (so the audit ledger can persist the same shape #199 already documents), and the
//     `noEvidence` flag the UI uses to phrase its message.
//   * `AnswerGenerator` — the injectable port that turns a context pack into an answer
//     string. Production composition uses `ModelGatewayAnswerGenerator` to call `Gateway.chat`;
//     tests inject local fixtures at the runner boundary.
//
// `ConversationGroundedAnswer.references` is the SAME `RetrievalReference` array the pack
// was assembled from — the BFF and audit ledger need both the human-readable citation
// metadata (in `pack.citations`) and the score-bearing retrieval refs (here) without
// re-deriving one from the other.

import type { CitationReference, RetrievalReference } from "@oscharko-dev/keiko-contracts";

import type { LocalKnowledgeGroundedContextPack } from "../retrieval/context-pack-assembler.js";
import type { RetrievalNoEvidenceReason, RetrievalQuery } from "../retrieval/types.js";

// ─── Query / answer shapes ───────────────────────────────────────────────────

export interface ConversationGroundedQuery {
  // Opaque id; the runtime does not parse it. The BFF passes its chat-message id so the
  // audit ledger can correlate the persisted evidence row with the chat that produced it.
  readonly conversationId: string;
  readonly capsuleId?: RetrievalQuery["capsuleId"];
  readonly capsuleSetId?: RetrievalQuery["capsuleSetId"];
  readonly text: string;
  readonly topK?: number;
  readonly minScore?: number;
}

// `noEvidence: true` ⇒ `answer` is the empty string AND `references` is empty AND the
// model gateway was NOT called. The UI phrases the user-visible message from `reason`.
// `noEvidence: false` ⇒ `answer` is non-empty AND `references` has at least one entry
// (matched by `attachCitationsToAnswer` against inline `[n]` markers).
export interface ConversationGroundedAnswer {
  readonly answer: string;
  readonly references: readonly RetrievalReference[];
  readonly citations: readonly ConversationCitationReference[];
  readonly pack: LocalKnowledgeGroundedContextPack;
  readonly noEvidence: boolean;
  readonly reason?: RetrievalNoEvidenceReason;
}

// A `[n]` marker the answer text uses, paired with the citation it points at. `marker`
// is the literal substring (e.g. "[1]") so the UI can highlight it without re-scanning;
// `index` is the 1-based position the marker referred to (matches the order of the refs
// in `ConversationGroundedAnswer.references`). Out-of-bounds markers are dropped by
// `attachCitationsToAnswer` so this array is always well-formed.
export interface ConversationCitationReference {
  readonly marker: string;
  readonly index: number;
  readonly citation: CitationReference;
  readonly reference: RetrievalReference;
}

// ─── AnswerGenerator port ────────────────────────────────────────────────────

export interface AnswerGeneratorInput {
  readonly query: ConversationGroundedQuery;
  readonly pack: LocalKnowledgeGroundedContextPack;
  readonly references: readonly RetrievalReference[];
  readonly signal?: AbortSignal | undefined;
}

// Returns the raw answer text. Citation markers (`[1]`, `[2]`, …) are conventional but
// not enforced at the type level — `attachCitationsToAnswer` is tolerant of missing or
// out-of-bounds markers. Implementations MUST NOT mutate any input.
export interface AnswerGenerator {
  readonly generate: (input: AnswerGeneratorInput) => Promise<string>;
}
