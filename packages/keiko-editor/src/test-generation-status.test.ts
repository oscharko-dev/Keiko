import { describe, expect, it } from "vitest";
import {
  describeTestGenerationStatus,
  IDLE_TEST_GENERATION_STATE,
  isTestGenerationBusy,
  isTestGenerationPreviewing,
  testGenerationReducer,
  type TestGenerationFlowState,
} from "./test-generation-status.js";
import type {
  EditorOutputProvenance,
  EditorRequestIdentity,
  EditorTestGenerationFunnel,
  EditorTestGenerationOutcome,
  EditorTestGenerationResult,
} from "./types.js";

const REQUEST: EditorRequestIdentity = { requestId: "r1", streamId: "s", sequence: 1 };
const FUNNEL: EditorTestGenerationFunnel = {
  executionEnabled: false,
  candidatesGenerated: 0,
  candidatesSurfaced: 0,
  stabilityRunsRequired: 5,
  build: "not-run",
  pass: "not-run",
  stability: "not-run",
  coverage: "not-run",
  mutation: "not-run",
  antiTautology: "not-run",
};
const EXECUTED_FUNNEL: EditorTestGenerationFunnel = {
  executionEnabled: true,
  candidatesGenerated: 2,
  candidatesSurfaced: 1,
  stabilityRunsRequired: 5,
  build: "passed",
  pass: "passed",
  stability: "passed",
  coverage: "passed",
  mutation: "passed",
  antiTautology: "passed",
  coverageLineDelta: 3,
  coverageBranchDelta: 1,
  mutantsKilled: 2,
  mutantsTotal: 2,
};
const PROVENANCE: EditorOutputProvenance = {
  origin: "generated-test",
  model: { modelId: "m", gatewayPolicyVersion: "p", promptHash: "h", producedAt: 1 },
};
const RESULT: EditorTestGenerationResult = {
  request: REQUEST,
  patch: { patchId: "p1", changes: [], status: "previewed", provenance: PROVENANCE },
  provenance: PROVENANCE,
};

function requesting(): TestGenerationFlowState {
  return testGenerationReducer(IDLE_TEST_GENERATION_STATE, {
    type: "request",
    requestId: REQUEST.requestId,
  });
}

describe("testGenerationReducer — resolution", () => {
  it("maps each matching outcome to its state", () => {
    const outcomes: readonly EditorTestGenerationOutcome[] = [
      { status: "disabled", request: REQUEST, reason: "off" },
      { status: "deferred", request: REQUEST, reason: "wave 2", funnel: FUNNEL },
      {
        status: "generated",
        request: REQUEST,
        result: RESULT,
        funnel: FUNNEL,
        assurance: "unverified",
      },
      { status: "failed", request: REQUEST, reason: "boom" },
    ];
    const kinds = outcomes.map(
      (outcome) => testGenerationReducer(requesting(), { type: "resolve", outcome }).kind,
    );
    expect(kinds).toEqual(["disabled", "deferred", "preview", "failed"]);
  });

  it("discards a stale outcome whose request id does not match", () => {
    const stale: EditorTestGenerationOutcome = {
      status: "disabled",
      request: { requestId: "other", streamId: "s", sequence: 2 },
      reason: "off",
    };
    const state = requesting();
    expect(testGenerationReducer(state, { type: "resolve", outcome: stale })).toBe(state);
  });

  it("ignores a resolve when not requesting", () => {
    const outcome: EditorTestGenerationOutcome = {
      status: "disabled",
      request: REQUEST,
      reason: "off",
    };
    expect(testGenerationReducer(IDLE_TEST_GENERATION_STATE, { type: "resolve", outcome })).toBe(
      IDLE_TEST_GENERATION_STATE,
    );
  });
});

describe("testGenerationReducer — error, cancel, dismiss", () => {
  it("fails an in-flight run and falls back to a generic reason for an empty message", () => {
    expect(testGenerationReducer(requesting(), { type: "error", reason: "net" })).toMatchObject({
      kind: "failed",
      reason: "net",
    });
    const generic = testGenerationReducer(requesting(), { type: "error", reason: "" });
    expect(generic.kind).toBe("failed");
    if (generic.kind === "failed") {
      expect(generic.reason.length).toBeGreaterThan(0);
    }
  });

  it("cancels an in-flight run but ignores error/cancel when idle", () => {
    expect(testGenerationReducer(requesting(), { type: "cancel" }).kind).toBe("cancelled");
    expect(testGenerationReducer(IDLE_TEST_GENERATION_STATE, { type: "cancel" }).kind).toBe("idle");
    expect(
      testGenerationReducer(IDLE_TEST_GENERATION_STATE, { type: "error", reason: "x" }).kind,
    ).toBe("idle");
  });

  it("dismisses any terminal state back to idle", () => {
    const failed = testGenerationReducer(requesting(), { type: "error", reason: "x" });
    expect(testGenerationReducer(failed, { type: "dismiss" }).kind).toBe("idle");
  });
});

describe("status helpers", () => {
  it("reports busy and previewing predicates", () => {
    expect(isTestGenerationBusy(requesting())).toBe(true);
    expect(isTestGenerationBusy(IDLE_TEST_GENERATION_STATE)).toBe(false);
    const preview = testGenerationReducer(requesting(), {
      type: "resolve",
      outcome: {
        status: "generated",
        request: REQUEST,
        result: RESULT,
        funnel: FUNNEL,
        assurance: "unverified",
      },
    });
    expect(isTestGenerationPreviewing(preview)).toBe(true);
    expect(isTestGenerationPreviewing(IDLE_TEST_GENERATION_STATE)).toBe(false);
  });

  it("describes content-free status lines for each state", () => {
    expect(describeTestGenerationStatus(IDLE_TEST_GENERATION_STATE)).toBe("");
    expect(describeTestGenerationStatus(requesting())).toContain("Generating");
    expect(describeTestGenerationStatus({ kind: "disabled", reason: "switched off" })).toBe(
      "switched off",
    );
    expect(
      describeTestGenerationStatus({ kind: "deferred", reason: "wave 2", funnel: FUNNEL }),
    ).toBe("wave 2");
    expect(describeTestGenerationStatus({ kind: "cancelled" })).toContain("cancelled");
  });

  it("describes an assured vs unverified preview distinctly (ADR-0043)", () => {
    const base = { kind: "preview", result: RESULT, funnel: EXECUTED_FUNNEL } as const;
    const assured = describeTestGenerationStatus({ ...base, assurance: "assured" });
    expect(assured).toContain("assured pre-filter");
    expect(assured).toContain("2 generated, 1 surfaced");
    expect(assured).toContain("coverage delta lines 3, branches 1");
    expect(assured).toContain("mutation 2/2 killed");
    expect(
      describeTestGenerationStatus({
        ...base,
        assurance: "unverified",
        reason: "coverage did not increase",
      }),
    ).toContain("coverage did not increase");
    expect(describeTestGenerationStatus({ ...base, assurance: "unverified" })).toContain(
      "not apply-ready",
    );
  });

  it("carries the rejection reason into the preview state for an unverified candidate", () => {
    const state = testGenerationReducer(requesting(), {
      type: "resolve",
      outcome: {
        status: "generated",
        request: REQUEST,
        result: RESULT,
        funnel: FUNNEL,
        assurance: "unverified",
        reason: "weak oracle",
      },
    });
    expect(state.kind).toBe("preview");
    if (state.kind === "preview") {
      expect(state.reason).toBe("weak oracle");
    }
  });
});
