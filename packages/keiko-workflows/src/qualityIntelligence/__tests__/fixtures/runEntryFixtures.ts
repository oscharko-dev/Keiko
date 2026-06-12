// Shared fixtures + harness for the QI run-entry regression suite (Epic #270, Issue #273).
//
// Mirrors the captureSink / PLAN / PROVENANCE shapes used by runLifecycleCancellation.test.ts and
// modelRoutedTestDesign.test.ts so the new lifecycle / contract / cancellation tests reuse one
// canonical set of fixtures instead of reinventing per file. NOTE: this file is a TEST helper, not
// package source — it is intentionally NOT exported from any package index.ts.

import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import {
  createInMemoryQualityIntelligenceLocalStore,
  type QualityIntelligenceEvidenceManifest,
  type QualityIntelligenceLocalStore,
} from "@oscharko-dev/keiko-evidence";
import {
  deriveIntent,
  designTestCaseCandidates,
  regressionDefault,
} from "@oscharko-dev/keiko-quality-intelligence";
import type {
  QualityIntelligenceClock,
  QualityIntelligenceRunEventSink,
} from "../../runtimeCommon.js";
import type { QualityIntelligenceModelRoutedTestDesignDeps } from "../../modelRoutedTestDesign.js";

// Deterministic clock so persisted completedAt / event timestamps never depend on wall time.
export const CLOCK: QualityIntelligenceClock = Object.freeze({
  nowIso: () => "2026-06-08T00:01:00.000Z",
});

export const PROVENANCE = {
  envelopeIds: ["env-1"],
  auditSummaryId:
    "audit-273-test" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
} as const;

export const ENVELOPE: QI.QualityIntelligenceSourceEnvelope = Object.freeze({
  id: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("env-1"),
  kind: "human-context",
  displayLabel: "Audit source",
  localRef: "env-1",
  provenance: {
    origin: "requirements",
    registeredAt: "2026-06-08T00:00:00.000Z",
    integrityHashSha256Hex: "b".repeat(64),
  },
});

export function makePlan(id: string): QI.QualityIntelligenceRunPlan {
  return {
    id: QualityIntelligence.asQualityIntelligenceRunId(id),
    requestedAt: "2026-06-08T00:00:00.000Z",
    plannerKind: "model-routed",
    stages: [],
  };
}

export function makeAtom(id: string): QI.QualityIntelligenceEvidenceAtom {
  return {
    id: QualityIntelligence.asQualityIntelligenceEvidenceAtomId(id),
    kind: "requirement",
    sourceEnvelopeId: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("env-1"),
    canonicalHashSha256Hex: "a".repeat(64),
    redactionStatus: "not-required",
    lifecycleStatus: "draft",
  };
}

export function ingestedAtomsFixture(): readonly {
  atom: QI.QualityIntelligenceEvidenceAtom;
  canonicalText: string;
}[] {
  return [
    {
      atom: makeAtom("atom-1"),
      canonicalText: "REQ-1: Lock the account after five failed logins.",
    },
    { atom: makeAtom("atom-2"), canonicalText: "REQ-2: Reset the counter after a success." },
  ];
}

// Real domain candidates derived from atoms (status "proposed"), so coverage-review / validation /
// refinement entries receive schema-valid candidates without hand-rolling the shape.
export function candidatesFor(
  runId: string,
  atoms: readonly QI.QualityIntelligenceEvidenceAtom[],
): readonly QI.QualityIntelligenceTestCaseCandidate[] {
  const intent = deriveIntent([ENVELOPE], regressionDefault);
  return designTestCaseCandidates({
    runId: QualityIntelligence.asQualityIntelligenceRunId(runId),
    intent,
    atoms,
    profile: regressionDefault,
  });
}

// Recording sink: keeps the full event objects so tests can assert ORDER, stageNames, and kinds.
export interface RecordingSink {
  readonly sink: QualityIntelligenceRunEventSink;
  readonly events: () => readonly QI.QualityIntelligenceRunEvent[];
  readonly kinds: () => readonly string[];
  readonly stageNames: () => readonly string[];
  /** Ordered "kind" / "kind:stageName" tokens — the human-readable lifecycle trace. */
  readonly trace: () => readonly string[];
}

export function recordingSink(): RecordingSink {
  const events: QI.QualityIntelligenceRunEvent[] = [];
  return {
    sink: { emit: (e) => void events.push(e) },
    events: () => events,
    kinds: () => events.map((e) => e.payload.kind),
    stageNames: () =>
      events
        .map((e) => e.payload)
        .filter(
          (p): p is Extract<QI.QualityIntelligenceRunEventPayload, { stageName: string }> =>
            "stageName" in p,
        )
        .map((p) => p.stageName),
    trace: () =>
      events.map((e) => {
        const p = e.payload;
        return "stageName" in p ? `${p.kind}:${p.stageName}` : p.kind;
      }),
  };
}

// Deterministic model output (two candidates) for the model-routed entry — copied shape from
// modelRoutedTestDesign.test.ts so the two suites agree on the fixture.
export const MODEL_OUTPUT_TWO = JSON.stringify([
  {
    title: "Test atom 1 behavior",
    steps: ["Navigate to the feature", "Trigger the atom-1 action"],
    expectedResults: ["The atom-1 behavior occurs"],
    priority: "P2",
    riskClass: "regression",
    derivedFromEvidenceIndexes: [1],
  },
  {
    title: "Test atom 2 behavior",
    steps: ["Navigate to the feature", "Trigger the atom-2 action"],
    expectedResults: ["The atom-2 behavior occurs"],
    priority: "P2",
    riskClass: "regression",
    derivedFromEvidenceIndexes: [2],
  },
]);

export function modelRoutedDeps(
  store: QualityIntelligenceLocalStore,
  sink: QualityIntelligenceRunEventSink,
): QualityIntelligenceModelRoutedTestDesignDeps {
  return {
    sink,
    evidenceStore: store,
    candidatesSink: { record: () => undefined },
    generate: {
      generate: () =>
        Promise.resolve({ rawText: MODEL_OUTPUT_TWO, modelCallCount: 1, modelId: "test-model" }),
    },
    clock: CLOCK,
  };
}

export { createInMemoryQualityIntelligenceLocalStore };
