// Quality Intelligence Conversation Center handoff envelope (Epic #270, Issue #277).
//
// The handoff envelope is the typed message a Conversation Center chat sends to the
// QI workflow runtime to request a QI action. THE ENVELOPE CARRIES ONLY REFERENCES
// (chat message id, run id, envelope id refs) — NEVER chat content. The QI runtime
// (#281 integration) is responsible for resolving the refs against the
// Conversation Center store under the workflow handoff contract (#186).

import type { QualityIntelligenceRunId, QualityIntelligenceSourceEnvelopeId } from "./ids.js";

export type QualityIntelligenceHandoffPromptedAction =
  | "design-tests"
  | "validate-tests"
  | "review-coverage"
  | "request-export";

export const QUALITY_INTELLIGENCE_HANDOFF_PROMPTED_ACTIONS: readonly QualityIntelligenceHandoffPromptedAction[] =
  ["design-tests", "validate-tests", "review-coverage", "request-export"] as const;

/**
 * Opaque ref to the originating Conversation Center chat message. Branded only as
 * a string here to keep this contract surface decoupled from `bff-wire.ts` (which
 * declares the chat-side branded types). The QI runtime resolves the ref against
 * the chat store at handoff time.
 */
export type QualityIntelligenceHandoffChatMessageRef = string;

export interface QualityIntelligenceConversationCenterHandoff {
  /** Stable id minted by the Conversation Center at the moment of the handoff. */
  readonly id: string;
  readonly requestedByChatMessageId: QualityIntelligenceHandoffChatMessageRef;
  /** Present once a QI run has been allocated for this handoff. */
  readonly runId?: QualityIntelligenceRunId;
  readonly promptedAction: QualityIntelligenceHandoffPromptedAction;
  /** Envelope ids only — no chat content, no body, no excerpts. */
  readonly payloadRef: {
    readonly sourceEnvelopeIds: readonly QualityIntelligenceSourceEnvelopeId[];
  };
}
