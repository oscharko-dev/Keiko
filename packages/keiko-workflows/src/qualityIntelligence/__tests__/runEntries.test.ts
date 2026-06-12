// Scripted QI run-entry lifecycle, regression, failed-run recovery, and limits (Issue #273).
//
// Covers the four scripted entries (test-design, coverage-review, validation, artifact-refinement)
// end to end against an in-memory evidence store + recording sink. The headline regression is the
// #273 "intent" bug: the scripted test-design entry emitted an undeclared "intent" stage and could
// NEVER succeed; it now succeeds with stages [plan, candidates, coverage, validate, finalize].

import { describe, expect, it } from "vitest";
import type { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import {
  createInMemoryQualityIntelligenceLocalStore,
  type QualityIntelligenceEvidenceManifest,
  type QualityIntelligenceLocalStore,
} from "@oscharko-dev/keiko-evidence";
import {
  runQualityIntelligenceArtifactRefinement,
  runQualityIntelligenceCoverageReview,
  runQualityIntelligenceTestDesign,
  runQualityIntelligenceValidation,
} from "../runEntries.js";
import { QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS } from "../descriptors.js";
import {
  CLOCK,
  candidatesFor,
  ENVELOPE,
  makeAtom,
  makePlan,
  PROVENANCE,
  recordingSink,
} from "./fixtures/runEntryFixtures.js";

// Expected ordered lifecycle trace for a happy-path run with the given declared stages.
function expectedHappyTrace(stages: readonly string[]): readonly string[] {
  const trace: string[] = ["run:queued", "run:started"];
  for (const stage of stages) {
    trace.push(`stage:started:${stage}`, `stage:completed:${stage}`);
  }
  trace.push("run:succeeded");
  return trace;
}

// Filter the trace to only lifecycle + stage frames (drops candidate:proposed / finding:recorded
// which interleave between stages), preserving order so the stage skeleton can be compared exactly.
function stageSkeleton(trace: readonly string[]): readonly string[] {
  return trace.filter(
    (t) =>
      t.startsWith("run:") || t.startsWith("stage:started:") || t.startsWith("stage:completed:"),
  );
}

describe("scripted QI entries — happy-path lifecycle + ordering + persistence", () => {
  it("test-design: succeeds with stages [plan, candidates, coverage, validate, finalize] (REGRESSION #273)", async () => {
    const cap = recordingSink();
    const store = createInMemoryQualityIntelligenceLocalStore();
    const summary = await runQualityIntelligenceTestDesign(
      {
        plan: makePlan("qi-run-td-happy"),
        envelopes: [ENVELOPE],
        atoms: [makeAtom("atom-1"), makeAtom("atom-2")],
        provenanceRefs: PROVENANCE,
      },
      { sink: cap.sink, evidenceStore: store, clock: CLOCK },
    );

    // Before the #273 fix this returned "failed": the undeclared "intent" stage threw via
    // assertStageRegistered. It must now SUCCEED.
    expect(summary.status).toBe("succeeded");
    expect(stageSkeleton(cap.trace())).toEqual(
      expectedHappyTrace(["plan", "candidates", "coverage", "validate", "finalize"]),
    );
    // The candidates stage exists; the dropped "intent" stage and the never-run scripted "judge"
    // stage must NOT appear.
    expect(cap.stageNames()).toContain("candidates");
    expect(cap.stageNames()).not.toContain("intent");
    expect(cap.stageNames()).not.toContain("judge");

    const manifest = store.load("qi-run-td-happy");
    expect(manifest?.status).toBe("succeeded");
    // Scripted test-design is model-free: zero gateway calls.
    expect(manifest?.modelGatewayCallCount).toBe(0);
  });

  it("coverage-review: happy path emits ordered [plan, analyse, report] and persists succeeded", async () => {
    const cap = recordingSink();
    const store = createInMemoryQualityIntelligenceLocalStore();
    const atoms = [makeAtom("atom-1"), makeAtom("atom-2")];
    const summary = await runQualityIntelligenceCoverageReview(
      {
        plan: makePlan("qi-run-cr-happy"),
        atoms,
        candidates: candidatesFor("qi-run-cr-happy", atoms),
        provenanceRefs: PROVENANCE,
      },
      { sink: cap.sink, evidenceStore: store, clock: CLOCK },
    );
    expect(summary.status).toBe("succeeded");
    expect(stageSkeleton(cap.trace())).toEqual(expectedHappyTrace(["plan", "analyse", "report"]));
    expect(store.load("qi-run-cr-happy")?.status).toBe("succeeded");
  });

  it("validation: happy path emits ordered [plan, run-judges, reconcile, report] and persists succeeded", async () => {
    const cap = recordingSink();
    const store = createInMemoryQualityIntelligenceLocalStore();
    const atoms = [makeAtom("atom-1"), makeAtom("atom-2")];
    const summary = await runQualityIntelligenceValidation(
      {
        plan: makePlan("qi-run-val-happy"),
        candidates: candidatesFor("qi-run-val-happy", atoms),
        provenanceRefs: PROVENANCE,
      },
      { sink: cap.sink, evidenceStore: store, clock: CLOCK },
    );
    expect(summary.status).toBe("succeeded");
    expect(stageSkeleton(cap.trace())).toEqual(
      expectedHappyTrace(["plan", "run-judges", "reconcile", "report"]),
    );
    expect(store.load("qi-run-val-happy")?.status).toBe("succeeded");
  });

  it("artifact-refinement: happy path emits ordered [plan, refine, validate, report] and persists succeeded", async () => {
    const cap = recordingSink();
    const store = createInMemoryQualityIntelligenceLocalStore();
    const atoms = [makeAtom("atom-1"), makeAtom("atom-2")];
    const summary = await runQualityIntelligenceArtifactRefinement(
      {
        plan: makePlan("qi-run-ar-happy"),
        atoms,
        candidates: candidatesFor("qi-run-ar-happy", atoms),
        provenanceRefs: PROVENANCE,
      },
      { sink: cap.sink, evidenceStore: store, clock: CLOCK },
    );
    expect(summary.status).toBe("succeeded");
    expect(stageSkeleton(cap.trace())).toEqual(
      expectedHappyTrace(["plan", "refine", "validate", "report"]),
    );
    expect(store.load("qi-run-ar-happy")?.status).toBe("succeeded");
  });

  it("emits run:queued and run:started before any stage event (sequence #0/#1)", async () => {
    const cap = recordingSink();
    const store = createInMemoryQualityIntelligenceLocalStore();
    await runQualityIntelligenceTestDesign(
      {
        plan: makePlan("qi-run-td-seq"),
        envelopes: [ENVELOPE],
        atoms: [makeAtom("atom-1")],
        provenanceRefs: PROVENANCE,
      },
      { sink: cap.sink, evidenceStore: store, clock: CLOCK },
    );
    const events = cap.events();
    expect(events[0]?.payload.kind).toBe("run:queued");
    expect(events[1]?.payload.kind).toBe("run:started");
    expect(events[0]?.sequence).toBe(0);
    expect(events[1]?.sequence).toBe(1);
    // Sequence numbers are strictly increasing across the whole run.
    const sequences = events.map((e) => e.sequence);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1] ?? -1);
    }
  });
});

// ─── Failed-run recovery ───────────────────────────────────────────────────────
//
// A stage that throws WITHOUT cancellation must settle the run as "failed", emit a stage:failed
// event, and persist a "failed" manifest via finaliseFailureOrCancellation. The cleanest seam is an
// evidence store whose record() throws while the finalize stage tries to persist the SUCCEEDED
// manifest, but lets the finaliser's subsequent FAILED manifest through — so we can read it back.
function failOnSucceededStore(): {
  store: QualityIntelligenceLocalStore;
  failedManifest: () => QualityIntelligenceEvidenceManifest | undefined;
} {
  const inner = createInMemoryQualityIntelligenceLocalStore();
  let failed: QualityIntelligenceEvidenceManifest | undefined;
  const store: QualityIntelligenceLocalStore = {
    record: (manifest) => {
      if (manifest.status === "succeeded") {
        throw new Error("disk full while persisting succeeded manifest");
      }
      if (manifest.status === "failed") failed = manifest;
      return inner.record(manifest);
    },
    load: (runId) => inner.load(runId),
    list: () => inner.list(),
    location: (runId) => inner.location(runId),
    delete: (runId) => inner.delete(runId),
  };
  return { store, failedManifest: () => failed };
}

describe("scripted QI entries — failed-run recovery", () => {
  it("test-design: a finalize-stage persist failure settles failed, emits stage:failed, persists a failed manifest", async () => {
    const cap = recordingSink();
    const { store, failedManifest } = failOnSucceededStore();
    const summary = await runQualityIntelligenceTestDesign(
      {
        plan: makePlan("qi-run-td-fail"),
        envelopes: [ENVELOPE],
        atoms: [makeAtom("atom-1"), makeAtom("atom-2")],
        provenanceRefs: PROVENANCE,
      },
      { sink: cap.sink, evidenceStore: store, clock: CLOCK },
    );

    expect(summary.status).toBe("failed");
    // The throwing stage is "finalize" (where the succeeded manifest is persisted).
    const stageFailed = cap
      .events()
      .map((e) => e.payload)
      .find((p) => p.kind === "stage:failed");
    expect(stageFailed?.kind).toBe("stage:failed");
    if (stageFailed?.kind === "stage:failed") {
      expect(stageFailed.stageName).toBe("finalize");
      // reasonSummary must be the redaction-safe generic code, never the raw error message.
      expect(stageFailed.reasonSummary).toBe("qi-run-error");
      expect(stageFailed.reasonSummary).not.toContain("disk full");
    }
    // Terminal run:failed (NOT run:succeeded, NOT run:cancelled).
    expect(cap.kinds()).toContain("run:failed");
    expect(cap.kinds()).not.toContain("run:succeeded");
    expect(cap.kinds()).not.toContain("run:cancelled");
    // The finaliser persisted a "failed" manifest.
    expect(failedManifest()?.status).toBe("failed");
    expect(summary.evidence?.manifest.status).toBe("failed");
  });

  it("validation: a finalize/report persist failure settles failed with a failed manifest", async () => {
    const cap = recordingSink();
    const { store, failedManifest } = failOnSucceededStore();
    const atoms = [makeAtom("atom-1"), makeAtom("atom-2")];
    const summary = await runQualityIntelligenceValidation(
      {
        plan: makePlan("qi-run-val-fail"),
        candidates: candidatesFor("qi-run-val-fail", atoms),
        provenanceRefs: PROVENANCE,
      },
      { sink: cap.sink, evidenceStore: store, clock: CLOCK },
    );
    expect(summary.status).toBe("failed");
    expect(cap.kinds()).toContain("stage:failed");
    expect(cap.kinds()).toContain("run:failed");
    expect(failedManifest()?.status).toBe("failed");
  });
});

// ─── Limits / truncation ─────────────────────────────────────────────────────

describe("scripted QI entries — limits and truncation", () => {
  function tinyLimits(
    maxCandidates: number,
    maxFindings: number,
  ): typeof QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS {
    return {
      ...QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS,
      maxCandidatesPerRun: maxCandidates,
      maxFindingsPerRun: maxFindings,
    };
  }

  it("test-design: caps emitted candidate:proposed events at maxCandidatesPerRun", async () => {
    const cap = recordingSink();
    const store = createInMemoryQualityIntelligenceLocalStore();
    // 4 atoms would normally yield 4 candidates; cap at 1.
    const atoms = [makeAtom("a1"), makeAtom("a2"), makeAtom("a3"), makeAtom("a4")];
    const summary = await runQualityIntelligenceTestDesign(
      {
        plan: makePlan("qi-run-td-limit"),
        envelopes: [ENVELOPE],
        atoms,
        provenanceRefs: PROVENANCE,
      },
      { sink: cap.sink, evidenceStore: store, clock: CLOCK, limits: tinyLimits(1, 512) },
    );
    expect(summary.status).toBe("succeeded");
    const proposed = cap.kinds().filter((k) => k === "candidate:proposed");
    expect(proposed.length).toBe(1);
    expect(store.load("qi-run-td-limit")?.totals.candidates).toBe(1);
  });

  it("validation: caps emitted finding:recorded events at maxFindingsPerRun", async () => {
    const cap = recordingSink();
    const store = createInMemoryQualityIntelligenceLocalStore();
    // Hand-build candidates that each yield ≥1 validation finding (empty expectedResults), so the
    // raw finding count exceeds the cap of 1 and truncation is observable.
    const atoms = [makeAtom("atom-1")];
    const base = candidatesFor("qi-run-val-limit", atoms)[0];
    if (base === undefined) throw new Error("fixture produced no candidate");
    const broken = (n: number): QI.QualityIntelligenceTestCaseCandidate =>
      Object.freeze({
        ...base,
        id: base.id,
        title: `${base.title} #${String(n)}`,
        expectedResults: Object.freeze([]),
      });
    const candidates = [
      broken(1),
      broken(2),
      broken(3),
    ] as readonly QI.QualityIntelligenceTestCaseCandidate[];

    const summary = await runQualityIntelligenceValidation(
      {
        plan: makePlan("qi-run-val-limit"),
        candidates,
        provenanceRefs: PROVENANCE,
      },
      { sink: cap.sink, evidenceStore: store, clock: CLOCK, limits: tinyLimits(256, 1) },
    );
    expect(summary.status).toBe("succeeded");
    const recorded = cap.kinds().filter((k) => k === "finding:recorded");
    // At most the cap (1), even though the raw findings exceed it.
    expect(recorded.length).toBe(1);
    expect(store.load("qi-run-val-limit")?.totals.findings).toBe(1);
  });
});
