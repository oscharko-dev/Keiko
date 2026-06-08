// Run-lifecycle cancellation classification (Epic #270, Issue #280).
//
// A run cancelled while a stage is mid-flight (the common case: the AbortSignal fires during the
// model-generation call and the gateway rejects) MUST settle as "cancelled", not "failed". The
// cooperative checkCancelled() at stage boundaries only fires when the body returns normally; when
// the body THROWS because of the abort, withStage() and finaliseFailureOrCancellation() must still
// classify the run as a cancellation. These tests lock that in (mutation-robust: reverting either
// guard flips a run to "failed" and fails here).

import { describe, expect, it } from "vitest";
import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import {
  createInMemoryQualityIntelligenceLocalStore,
  type QualityIntelligenceEvidenceManifest,
} from "@oscharko-dev/keiko-evidence";
import {
  finaliseFailureOrCancellation,
  makeContext,
  StageCancelledError,
  withStage,
  type FinaliseArgs,
  type RunContext,
} from "../runtimeCommon.js";
import { QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR } from "../descriptors.js";

const PLAN: QI.QualityIntelligenceRunPlan = {
  id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-cancel-test"),
  requestedAt: "2026-06-01T00:00:00.000Z",
  plannerKind: "model-routed",
  stages: [],
};

const PROVENANCE = {
  envelopeIds: [],
  auditSummaryId:
    "audit-cancel-test" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
} as const;

function captureSink(): {
  sink: { emit: (e: QI.QualityIntelligenceRunEvent) => void };
  kinds: () => readonly string[];
} {
  const events: QI.QualityIntelligenceRunEvent[] = [];
  return {
    sink: { emit: (e): void => void events.push(e) },
    kinds: () => events.map((e) => e.payload.kind),
  };
}

function context(
  signal: AbortSignal | undefined,
  sink: ReturnType<typeof captureSink>["sink"],
): RunContext {
  return makeContext({ descriptor: QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR, plan: PLAN, sink, signal });
}

const finaliseArgs = (): FinaliseArgs => ({
  candidatesCount: 0,
  findings: Object.freeze([]),
  provenanceRefs: PROVENANCE,
  evidenceStore: createInMemoryQualityIntelligenceLocalStore(),
});

describe("withStage — cancellation reclassification", () => {
  it("reclassifies an error thrown while the signal is aborted as StageCancelledError", async () => {
    const controller = new AbortController();
    const cap = captureSink();
    const ctx = context(controller.signal, cap.sink);
    controller.abort();

    await expect(
      withStage(ctx, "candidates", () =>
        Promise.reject(new Error("gateway aborted: socket hang up")),
      ),
    ).rejects.toBeInstanceOf(StageCancelledError);
    // The interrupted stage is NOT a failure: no stage:failed event must be emitted.
    expect(cap.kinds()).not.toContain("stage:failed");
  });

  it("emits stage:failed and rethrows the original error when the body fails without cancellation", async () => {
    const cap = captureSink();
    const ctx = context(undefined, cap.sink);
    const boom = new Error("a genuine validation failure");

    await expect(withStage(ctx, "candidates", () => Promise.reject(boom))).rejects.toBe(boom);
    expect(cap.kinds()).toContain("stage:failed");
  });
});

describe("finaliseFailureOrCancellation — terminal classification", () => {
  it("classifies an abort-induced error as a cancelled run (not failed)", () => {
    const controller = new AbortController();
    const cap = captureSink();
    const ctx = context(controller.signal, cap.sink);
    controller.abort();

    const summary = finaliseFailureOrCancellation(
      ctx,
      new Error("gateway aborted"),
      finaliseArgs(),
    );

    expect(summary.status).toBe("cancelled");
    expect(cap.kinds()).toContain("run:cancelled");
    expect(cap.kinds()).not.toContain("run:failed");
  });

  it("classifies a StageCancelledError as a cancelled run", () => {
    const cap = captureSink();
    const ctx = context(undefined, cap.sink);

    const summary = finaliseFailureOrCancellation(ctx, new StageCancelledError(), finaliseArgs());

    expect(summary.status).toBe("cancelled");
    expect(cap.kinds()).toContain("run:cancelled");
  });

  it("classifies a genuine error (no cancellation) as a failed run", () => {
    const cap = captureSink();
    const ctx = context(undefined, cap.sink);

    const summary = finaliseFailureOrCancellation(ctx, new Error("boom"), finaliseArgs());

    expect(summary.status).toBe("failed");
    expect(cap.kinds()).toContain("run:failed");
    expect(cap.kinds()).not.toContain("run:cancelled");
  });
});
