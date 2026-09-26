import { describe, expect, it } from "vitest";
import {
  asQualityIntelligenceHandoffId,
  asQualityIntelligenceRunId,
  asQualityIntelligenceSourceEnvelopeId,
} from "../ids.js";
import {
  assertQualityIntelligenceConversationCenterHandoffInvariant,
  QUALITY_INTELLIGENCE_HANDOFF_MAX_SOURCE_ENVELOPE_IDS,
  QUALITY_INTELLIGENCE_HANDOFF_PROMPTED_ACTIONS,
} from "../handoffEnvelope.js";
import type {
  QualityIntelligenceConversationCenterHandoff,
  QualityIntelligenceHandoffPromptedAction,
} from "../handoffEnvelope.js";

const makeHandoff = (
  promptedAction: QualityIntelligenceHandoffPromptedAction,
): QualityIntelligenceConversationCenterHandoff => ({
  id: asQualityIntelligenceHandoffId("handoff-1"),
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
      id: asQualityIntelligenceHandoffId("handoff-2"),
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

// KEIKO-0593: payloadRef.sourceEnvelopeIds previously declared no upper bound. Mirrors the 16-
// source run-start cap (bffWire.ts / MAX_QI_SOURCES in keiko-server's runIngestion.ts).
describe("assertQualityIntelligenceConversationCenterHandoffInvariant (KEIKO-0593)", () => {
  const withSourceCount = (count: number): QualityIntelligenceConversationCenterHandoff => ({
    id: asQualityIntelligenceHandoffId("handoff-bound"),
    requestedByChatMessageId: "msg-001",
    promptedAction: "design-tests",
    payloadRef: {
      sourceEnvelopeIds: Array.from({ length: count }, (_unused, i) =>
        asQualityIntelligenceSourceEnvelopeId(`env-${String(i)}`),
      ),
    },
  });

  it("pins the documented maximum at 16", () => {
    expect(QUALITY_INTELLIGENCE_HANDOFF_MAX_SOURCE_ENVELOPE_IDS).toBe(16);
  });

  it("accepts a handoff at exactly the maximum", () => {
    expect(() => {
      assertQualityIntelligenceConversationCenterHandoffInvariant(
        withSourceCount(QUALITY_INTELLIGENCE_HANDOFF_MAX_SOURCE_ENVELOPE_IDS),
      );
    }).not.toThrow();
  });

  it("throws RangeError one past the maximum", () => {
    // Before KEIKO-0593 no such bound existed anywhere in this contract, so this call could not
    // throw at all -- payloadRef.sourceEnvelopeIds accepted any length.
    expect(() => {
      assertQualityIntelligenceConversationCenterHandoffInvariant(
        withSourceCount(QUALITY_INTELLIGENCE_HANDOFF_MAX_SOURCE_ENVELOPE_IDS + 1),
      );
    }).toThrow(RangeError);
  });

  it("accepts an empty sourceEnvelopeIds array", () => {
    expect(() => {
      assertQualityIntelligenceConversationCenterHandoffInvariant(withSourceCount(0));
    }).not.toThrow();
  });
});
