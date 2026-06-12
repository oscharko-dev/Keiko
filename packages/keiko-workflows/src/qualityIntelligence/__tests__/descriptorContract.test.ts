// Descriptor ↔ run-entry CONTRACT guard (Epic #270, Issue #273).
//
// Every QI run entry (the 4 scripted entries in runEntries.ts and the model-routed entry in
// modelRoutedTestDesign.ts) emits a stream of run events into the sink. The descriptor declares the
// closed set of `stageNames` and `emittedEventKinds` that entry is allowed to surface. This guard
// drives each entry against a recording sink and asserts every emitted event stays inside that
// declared surface:
//   (1) for stage:* events, payload.stageName ∈ descriptor.stageNames;
//   (2) for ALL events, payload.kind ∈ descriptor.emittedEventKinds.
//
// WHY THIS CATCHES THE #273 "intent" BUG CLASS: the scripted test-design entry previously emitted a
// `stage:started { stageName: "intent" }` for a stage the qi:test-design descriptor never declares.
// At runtime assertStageRegistered threw, so the run could never succeed. A happy-path-only test
// would just see the run fail. THIS test is stronger and on the descriptor, not the implementation:
// even if someone "fixed" the throw by loosening assertStageRegistered (silently emitting an
// undeclared stage), assertion (1) would still FAIL because "intent" ∉ descriptor.stageNames. Any
// drift between an entry's emitted stages and its descriptor is caught here.

import { describe, expect, it } from "vitest";
import type { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import {
  runQualityIntelligenceArtifactRefinement,
  runQualityIntelligenceCoverageReview,
  runQualityIntelligenceTestDesign,
  runQualityIntelligenceValidation,
} from "../runEntries.js";
import { runQualityIntelligenceModelRoutedTestDesign } from "../modelRoutedTestDesign.js";
import {
  QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR,
  QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR,
  QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR,
  QI_VALIDATION_WORKFLOW_DESCRIPTOR,
  type QualityIntelligenceWorkflowDescriptor,
} from "../descriptors.js";
import {
  CLOCK,
  candidatesFor,
  createInMemoryQualityIntelligenceLocalStore,
  ENVELOPE,
  ingestedAtomsFixture,
  makeAtom,
  makePlan,
  modelRoutedDeps,
  PROVENANCE,
  recordingSink,
} from "./fixtures/runEntryFixtures.js";

// Assert every recorded event stays inside the descriptor's declared stage + kind surface.
function assertEventsWithinDescriptor(
  events: readonly QI.QualityIntelligenceRunEvent[],
  descriptor: QualityIntelligenceWorkflowDescriptor,
): void {
  const allowedStages = new Set<string>(descriptor.stageNames);
  const allowedKinds = new Set<string>(descriptor.emittedEventKinds);
  for (const event of events) {
    const payload = event.payload;
    expect(allowedKinds).toContain(payload.kind);
    if (
      payload.kind === "stage:started" ||
      payload.kind === "stage:completed" ||
      payload.kind === "stage:failed"
    ) {
      expect(allowedStages).toContain(payload.stageName);
    }
  }
  // Sanity floor: an entry that emitted nothing would vacuously pass the loop above, so require the
  // run to have produced at least the queued/started/succeeded lifecycle frame.
  expect(events.length).toBeGreaterThanOrEqual(3);
}

describe("QI descriptor ↔ entry contract guard", () => {
  it("test-design (scripted): every emitted event is within the descriptor surface", async () => {
    const cap = recordingSink();
    await runQualityIntelligenceTestDesign(
      {
        plan: makePlan("qi-run-contract-td"),
        envelopes: [ENVELOPE],
        atoms: [makeAtom("atom-1"), makeAtom("atom-2")],
        provenanceRefs: PROVENANCE,
      },
      {
        sink: cap.sink,
        evidenceStore: createInMemoryQualityIntelligenceLocalStore(),
        clock: CLOCK,
      },
    );
    assertEventsWithinDescriptor(cap.events(), QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR);
    // Belt-and-braces on the #273 regression: the undeclared "intent" stage must NOT appear.
    expect(cap.stageNames()).not.toContain("intent");
  });

  it("coverage-review: every emitted event is within the descriptor surface", async () => {
    const cap = recordingSink();
    const atoms = [makeAtom("atom-1"), makeAtom("atom-2")];
    await runQualityIntelligenceCoverageReview(
      {
        plan: makePlan("qi-run-contract-cr"),
        atoms,
        candidates: candidatesFor("qi-run-contract-cr", atoms),
        provenanceRefs: PROVENANCE,
      },
      {
        sink: cap.sink,
        evidenceStore: createInMemoryQualityIntelligenceLocalStore(),
        clock: CLOCK,
      },
    );
    assertEventsWithinDescriptor(cap.events(), QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR);
  });

  it("validation: every emitted event is within the descriptor surface", async () => {
    const cap = recordingSink();
    const atoms = [makeAtom("atom-1"), makeAtom("atom-2")];
    await runQualityIntelligenceValidation(
      {
        plan: makePlan("qi-run-contract-val"),
        candidates: candidatesFor("qi-run-contract-val", atoms),
        provenanceRefs: PROVENANCE,
      },
      {
        sink: cap.sink,
        evidenceStore: createInMemoryQualityIntelligenceLocalStore(),
        clock: CLOCK,
      },
    );
    assertEventsWithinDescriptor(cap.events(), QI_VALIDATION_WORKFLOW_DESCRIPTOR);
  });

  it("artifact-refinement: every emitted event is within the descriptor surface", async () => {
    const cap = recordingSink();
    const atoms = [makeAtom("atom-1"), makeAtom("atom-2")];
    await runQualityIntelligenceArtifactRefinement(
      {
        plan: makePlan("qi-run-contract-ar"),
        atoms,
        candidates: candidatesFor("qi-run-contract-ar", atoms),
        provenanceRefs: PROVENANCE,
      },
      {
        sink: cap.sink,
        evidenceStore: createInMemoryQualityIntelligenceLocalStore(),
        clock: CLOCK,
      },
    );
    assertEventsWithinDescriptor(cap.events(), QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR);
  });

  it("model-routed test-design: every emitted event is within the descriptor surface", async () => {
    const cap = recordingSink();
    const store = createInMemoryQualityIntelligenceLocalStore();
    await runQualityIntelligenceModelRoutedTestDesign(
      {
        plan: makePlan("qi-run-contract-mr"),
        envelopes: [],
        ingestedAtoms: ingestedAtomsFixture(),
        provenanceRefs: PROVENANCE,
      },
      modelRoutedDeps(store, cap.sink),
    );
    assertEventsWithinDescriptor(cap.events(), QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR);
  });

  it("locks the qi:test-design descriptor stage set the scripted entry must stay a subset of", () => {
    // The scripted test-design entry deliberately emits only a SUBSET of these stages (no "judge");
    // the model-routed entry exercises the full set. Both must stay inside this surface — which the
    // per-entry tests above assert. Pinning the declared list catches a descriptor rename that drops
    // a stage the entries still emit (which the per-entry contract tests would then surface).
    expect(QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR.stageNames).toEqual([
      "plan",
      "candidates",
      "judge",
      "coverage",
      "validate",
      "finalize",
    ]);
  });
});
