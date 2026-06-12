// Fail-closed failure-summary redaction (Epic #270, Issue #279 AC3).
//
// A productive QI model call rejects through the Keiko Model Gateway with a GatewayError whose
// message can carry the provider base URL, a deployment endpoint, or a credential-shaped substring
// (the Conversation Center path proves this in keiko-server `conversation-audit.test.ts`). That raw
// message MUST NOT reach the run/stage `reasonSummary` that is streamed over SSE. These tests lock
// `safeReasonSummary` to a fail-closed taxonomy: known QI errors surface a static code, everything
// else collapses to a generic code with no message echo. Mutation-robust — reverting the guard to
// the old `error.message.slice(0, 200)` passthrough makes the leak assertions fail.

import { describe, expect, it } from "vitest";
import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import {
  QualityIntelligence as MgQI,
  QualityIntelligenceSafeErrorException,
} from "@oscharko-dev/keiko-model-gateway";
import { createInMemoryQualityIntelligenceLocalStore } from "@oscharko-dev/keiko-evidence";
import {
  finaliseFailureOrCancellation,
  makeContext,
  safeReasonSummary,
  withStage,
  type FinaliseArgs,
  type RunContext,
} from "../runtimeCommon.js";
import { QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR } from "../descriptors.js";

// Obviously-fake credential/endpoint shapes (no real secret). A pre-fix `safeReasonSummary` would
// echo the first 200 chars of this verbatim into the SSE reasonSummary.
const FAKE_BASE_URL = "https://fake-resource.openai.azure.com/openai/deployments/gpt-x";
const FAKE_BEARER = "Bearer sk-FAKE0000000000000000000000000000";
const LEAKY_MESSAGE = `401 Unauthorized calling ${FAKE_BASE_URL}/chat/completions with ${FAKE_BEARER}`;

function gatewayLikeError(): Error {
  // Shape mirrors a real gateway/provider rejection: a non-QI Error subclass whose message carries
  // endpoint + credential substrings.
  const error = new Error(LEAKY_MESSAGE);
  error.name = "GatewayError";
  return error;
}

function assertNoLeak(value: string): void {
  expect(value).not.toContain(FAKE_BASE_URL);
  expect(value).not.toContain(FAKE_BEARER);
  expect(value).not.toContain("sk-FAKE");
  expect(value).not.toContain("openai.azure.com");
  expect(value).not.toContain("Authorization");
}

describe("safeReasonSummary — fail-closed taxonomy", () => {
  it("surfaces only the qi/* code for a QI safe-error exception", () => {
    const summary = safeReasonSummary(
      new QualityIntelligenceSafeErrorException(MgQI.makeProviderError("qi:test-design")),
    );
    expect(summary).toBe("qi-safe-error: qi/provider-error");
  });

  it("surfaces the static QI_* code for an allow-listed coded QI error", () => {
    const error = new Error("The assembled prompt exceeds the model token budget.");
    error.name = "QiGenerationError";
    (error as { code?: string }).code = "QI_PROMPT_TOO_LARGE";
    expect(safeReasonSummary(error)).toBe("qi-error: QI_PROMPT_TOO_LARGE");
  });

  it("surfaces the error name for an allow-listed QI error without a code", () => {
    const error = new Error("No usable evidence atoms were ingested for the run");
    error.name = "EmptyEvidenceError";
    expect(safeReasonSummary(error)).toBe("qi-error: EmptyEvidenceError");
  });

  it("collapses a gateway/provider error to a generic code and never echoes its message", () => {
    const summary = safeReasonSummary(gatewayLikeError());
    expect(summary).toBe("qi-run-error");
    assertNoLeak(summary);
  });

  it("does not let a non-QI error masquerade via a credential-shaped code field", () => {
    // An unknown error carrying a non-QI `code` must NOT surface that code (only allow-listed
    // names reach the code branch, and only QI_* codes pass the pattern guard).
    const error = new Error(LEAKY_MESSAGE);
    error.name = "GatewayError";
    (error as { code?: string }).code = FAKE_BEARER;
    const summary = safeReasonSummary(error);
    expect(summary).toBe("qi-run-error");
    assertNoLeak(summary);
  });

  it("collapses a non-Error throw to a generic code", () => {
    expect(safeReasonSummary("raw string with secret sk-FAKE")).toBe("qi-run-error");
    expect(safeReasonSummary(undefined)).toBe("qi-run-error");
  });
});

// ─── Integration: the leak vector end to end ─────────────────────────────────

const PLAN: QI.QualityIntelligenceRunPlan = {
  id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-leak-test"),
  requestedAt: "2026-06-01T00:00:00.000Z",
  plannerKind: "model-routed",
  stages: [],
};

const PROVENANCE = {
  envelopeIds: [],
  auditSummaryId: "audit-leak-test",
} as unknown as FinaliseArgs["provenanceRefs"];

function captureSink(): {
  sink: { emit: (e: QI.QualityIntelligenceRunEvent) => void };
  events: QI.QualityIntelligenceRunEvent[];
} {
  const events: QI.QualityIntelligenceRunEvent[] = [];
  return { sink: { emit: (e): void => void events.push(e) }, events };
}

function context(sink: ReturnType<typeof captureSink>["sink"]): RunContext {
  return makeContext({
    descriptor: QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR,
    plan: PLAN,
    sink,
    signal: undefined,
  });
}

const finaliseArgs = (): FinaliseArgs => ({
  candidatesCount: 0,
  findings: Object.freeze([]),
  provenanceRefs: PROVENANCE,
  evidenceStore: createInMemoryQualityIntelligenceLocalStore(),
});

function reasonSummariesOf(events: readonly QI.QualityIntelligenceRunEvent[]): readonly string[] {
  return events
    .map((e) => (e.payload as { reasonSummary?: string }).reasonSummary)
    .filter((r): r is string => typeof r === "string");
}

describe("QI run failure events — no provider-error leak (#279 AC3)", () => {
  it("emits a stage:failed reasonSummary that does not echo the gateway error message", async () => {
    const cap = captureSink();
    const ctx = context(cap.sink);

    await expect(
      withStage(ctx, "candidates", () => Promise.reject(gatewayLikeError())),
    ).rejects.toBeInstanceOf(Error);

    const summaries = reasonSummariesOf(cap.events);
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) {
      expect(summary).toBe("qi-run-error");
      assertNoLeak(summary);
    }
  });

  it("persists/returns a run:failed reasonSummary that does not echo the gateway error message", () => {
    const cap = captureSink();
    const ctx = context(cap.sink);

    const summary = finaliseFailureOrCancellation(ctx, gatewayLikeError(), finaliseArgs());

    expect(summary.status).toBe("failed");
    expect(summary.reasonSummary).toBe("qi-run-error");
    assertNoLeak(summary.reasonSummary ?? "");
    for (const reason of reasonSummariesOf(cap.events)) {
      assertNoLeak(reason);
    }
  });
});
