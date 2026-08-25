// Quality Intelligence Conversation Center handoff envelope (Epic #270, Issue #277).
//
// The handoff envelope is the typed message a Conversation Center chat sends to the
// QI workflow runtime to request a QI action. THE ENVELOPE CARRIES ONLY REFERENCES
// (chat message id, run id, envelope id refs) — NEVER chat content. The QI runtime
// (#281 integration) is responsible for resolving the refs against the
// Conversation Center store under the workflow handoff contract (#186).

import type {
  QualityIntelligenceHandoffId,
  QualityIntelligenceRunId,
  QualityIntelligenceSourceEnvelopeId,
} from "./ids.js";

// KEIKO-0593: mirrors the 16-source run-start cap documented in bffWire.ts's
// QualityIntelligenceRunStreamAccepted.droppedSourceCount comment ("the 16-source cap (Epic #729)")
// and enforced server-side by MAX_QI_SOURCES (packages/keiko-server/src/qualityIntelligence/
// runIngestion.ts). Named, not inlined, so the two stay easy to keep in sync if either changes.
export const QUALITY_INTELLIGENCE_HANDOFF_MAX_SOURCE_ENVELOPE_IDS = 16;

// KEIKO-0522: const-first + `(typeof X)[number]` (matches retentionPolicy.ts / testQualityRubric.ts)
// so the union type can never drift from the enumerable array it is derived from.
export const QUALITY_INTELLIGENCE_HANDOFF_PROMPTED_ACTIONS = [
  "design-tests",
  "validate-tests",
  "review-coverage",
  "request-export",
] as const;

export type QualityIntelligenceHandoffPromptedAction =
  (typeof QUALITY_INTELLIGENCE_HANDOFF_PROMPTED_ACTIONS)[number];

/**
 * Opaque ref to the originating Conversation Center chat message. Branded only as
 * a string here to keep this contract surface decoupled from `bff-wire.ts` (which
 * declares the chat-side branded types). The QI runtime resolves the ref against
 * the chat store at handoff time.
 */
export type QualityIntelligenceHandoffChatMessageRef = string;

export interface QualityIntelligenceConversationCenterHandoff {
  /** Stable id minted by the Conversation Center at the moment of the handoff. */
  readonly id: QualityIntelligenceHandoffId;
  readonly requestedByChatMessageId: QualityIntelligenceHandoffChatMessageRef;
  /** Present once a QI run has been allocated for this handoff. */
  readonly runId?: QualityIntelligenceRunId;
  readonly promptedAction: QualityIntelligenceHandoffPromptedAction;
  /** Envelope ids only — no chat content, no body, no excerpts. */
  readonly payloadRef: {
    /** At most QUALITY_INTELLIGENCE_HANDOFF_MAX_SOURCE_ENVELOPE_IDS entries; see
     * assertQualityIntelligenceConversationCenterHandoffInvariant. */
    readonly sourceEnvelopeIds: readonly QualityIntelligenceSourceEnvelopeId[];
  };
}

/**
 * Throws `RangeError` when `payloadRef.sourceEnvelopeIds` exceeds
 * `QUALITY_INTELLIGENCE_HANDOFF_MAX_SOURCE_ENVELOPE_IDS`. Returns `void` on success. Mirrors the
 * `assertCoverageMapInvariant` / `assertExportBundleInvariant` contracts-layer invariant pattern
 * used elsewhere in this package (coverageMap.ts, exportBundle.ts): a pure, directly callable
 * enforcement point for a bound the wire type alone cannot express.
 */
export const assertQualityIntelligenceConversationCenterHandoffInvariant = (
  handoff: QualityIntelligenceConversationCenterHandoff,
): void => {
  const count = handoff.payloadRef.sourceEnvelopeIds.length;
  if (count > QUALITY_INTELLIGENCE_HANDOFF_MAX_SOURCE_ENVELOPE_IDS) {
    throw new RangeError(
      `payloadRef.sourceEnvelopeIds has ${String(count)} entries, exceeding the maximum of ${String(
        QUALITY_INTELLIGENCE_HANDOFF_MAX_SOURCE_ENVELOPE_IDS,
      )}`,
    );
  }
};
