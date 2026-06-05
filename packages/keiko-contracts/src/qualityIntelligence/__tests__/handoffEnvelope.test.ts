import { describe, expect, it } from "vitest";
import { asQualityIntelligenceRunId, asQualityIntelligenceSourceEnvelopeId } from "../ids.js";
import { QUALITY_INTELLIGENCE_HANDOFF_PROMPTED_ACTIONS } from "../handoffEnvelope.js";
import type {
  QualityIntelligenceConversationCenterHandoff,
  QualityIntelligenceHandoffPromptedAction,
} from "../handoffEnvelope.js";

const makeHandoff = (
  promptedAction: QualityIntelligenceHandoffPromptedAction,
): QualityIntelligenceConversationCenterHandoff => ({
  id: "handoff-1",
  requestedByChatMessageId: "msg-001",
  runId: asQualityIntelligenceRunId("run-001"),
  promptedAction,
  payloadRef: {
    sourceEnvelopeIds: [asQualityIntelligenceSourceEnvelopeId("env-1")],
  },
});

describe("QualityIntelligenceConversationCenterHandoff", () => {
  it("enumerates all four prompted actions", () => {
    expect(QUALITY_INTELLIGENCE_HANDOFF_PROMPTED_ACTIONS).toEqual<
      readonly QualityIntelligenceHandoffPromptedAction[]
    >(["design-tests", "validate-tests", "review-coverage", "request-export"]);
  });

  it("carries only refs (no chat content embedded)", () => {
    const h = makeHandoff("design-tests");
    const flat = JSON.stringify(h);
    // The handoff envelope must not contain any field named "body", "content",
    // "text", or "message" that could carry chat content.
    for (const forbidden of ['"body"', '"content"', '"text"', '"message"']) {
      expect(flat).not.toContain(forbidden);
    }
  });

  it("permits omission of runId for not-yet-allocated handoffs", () => {
    const h: QualityIntelligenceConversationCenterHandoff = {
      id: "handoff-2",
      requestedByChatMessageId: "msg-002",
      promptedAction: "design-tests",
      payloadRef: { sourceEnvelopeIds: [] },
    };
    expect(h.runId).toBeUndefined();
  });

  it("round-trips through JSON.stringify / parse", () => {
    const h = makeHandoff("request-export");
    const round = JSON.parse(JSON.stringify(h)) as QualityIntelligenceConversationCenterHandoff;
    expect(round).toEqual(h);
  });
});
