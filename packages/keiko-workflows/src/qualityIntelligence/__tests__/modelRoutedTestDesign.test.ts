// #738 — modelRoutedTestDesign coverage-gap wiring tests.
//
// Verifies that when the model produces candidates that cover only a subset of the
// evidence atoms, the uncovered atoms generate "coverage-gap" findings and their
// status is persisted in the manifest's coverageMatrix field.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { DETERMINISTIC_BASELINE_PROVENANCE_TAG } from "@oscharko-dev/keiko-quality-intelligence";
import {
  createInMemoryQualityIntelligenceLocalStore,
  type QualityIntelligenceEvidenceManifest,
} from "@oscharko-dev/keiko-evidence";
import { runQualityIntelligenceModelRoutedTestDesign } from "../modelRoutedTestDesign.js";
import { QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS } from "../descriptors.js";
import type {
  QualityIntelligenceJudgeInput,
  QualityIntelligenceModelRoutedTestDesignInput,
  QualityIntelligenceModelRoutedTestDesignDeps,
  QualityIntelligenceJudgePort,
} from "../modelRoutedTestDesign.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAtom(id: string): QualityIntelligence.QualityIntelligenceEvidenceAtom {
  return {
    id: QualityIntelligence.asQualityIntelligenceEvidenceAtomId(id),
    kind: "requirement",
    sourceEnvelopeId: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("env-1"),
    canonicalHashSha256Hex: "a".repeat(64),
    redactionStatus: "not-required",
    lifecycleStatus: "draft",
  };
}

function makeIngestedAtom(
  id: string,
  canonicalText: string,
): { atom: QualityIntelligence.QualityIntelligenceEvidenceAtom; canonicalText: string } {
  return { atom: makeAtom(id), canonicalText };
}

const PLAN: QualityIntelligence.QualityIntelligenceRunPlan = {
  id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-cov-test-001"),
  requestedAt: "2026-06-08T00:00:00.000Z",
  plannerKind: "model-routed",
  stages: [],
};

const PROVENANCE = {
  envelopeIds: ["env-1"],
  auditSummaryId:
    "audit-cov-test-001" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
} as const;

// Model output: two candidates, each citing only atoms 1 and 2 (1-based indexes).
// Atom 3 is deliberately not cited — it will be classified uncovered.
const MODEL_OUTPUT_COVERING_TWO = JSON.stringify([
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

function makeDeps(
  evidenceStore: ReturnType<typeof createInMemoryQualityIntelligenceLocalStore>,
): QualityIntelligenceModelRoutedTestDesignDeps {
  return {
    sink: { emit: () => undefined },
    evidenceStore,
    candidatesSink: { record: () => undefined },
    generate: {
      generate: () =>
        Promise.resolve({
          rawText: MODEL_OUTPUT_COVERING_TWO,
          modelCallCount: 1,
          modelId: "test-model",
        }),
    },
    clock: { nowIso: () => "2026-06-08T00:01:00.000Z" },
  };
}

function makeDepsWithCandidateCap(
  evidenceStore: ReturnType<typeof createInMemoryQualityIntelligenceLocalStore>,
  maxCandidatesPerRun: number,
): QualityIntelligenceModelRoutedTestDesignDeps {
  return {
    ...makeDeps(evidenceStore),
    limits: {
      ...QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS,
      maxCandidatesPerRun,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runQualityIntelligenceModelRoutedTestDesign — coverage-gap wiring", () => {
  it("emits coverage-gap findings for atoms not covered by any candidate", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    // 3 atoms; model output covers only atoms 1 and 2
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement atom 1"),
      makeIngestedAtom("atom-2", "Requirement atom 2"),
      makeIngestedAtom("atom-3", "Requirement atom 3 — not covered"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: PLAN,
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    const summary = await runQualityIntelligenceModelRoutedTestDesign(
      input,
      makeDepsWithCandidateCap(store, 2),
    );
    expect(summary.status).toBe("succeeded");
    // A non-degraded (model-backed) run carries no degradation reason — the wire `done` frame must
    // not flag it as degraded.
    expect(summary.reasonSummary).toBeUndefined();

    const manifest = store.load(String(PLAN.id));
    expect(manifest).toBeDefined();
    if (manifest === undefined) throw new Error("manifest not found");

    const gapFindings = manifest.findings.filter((f) => f.kind === "coverage-gap");
    // atom-3 has no candidate citing it → 1 coverage-gap finding
    expect(gapFindings.length).toBeGreaterThanOrEqual(1);
    // The finding summary must reference the uncovered atom id
    const uncoveredFinding = gapFindings.find((f) => f.summaryRedacted.includes("atom-3"));
    expect(uncoveredFinding).toBeDefined();
    // A requirement with zero tracing tests is the headline audit gap -> high severity.
    expect(uncoveredFinding?.severity).toBe("high");
  });

  it("persists the coverageMatrix with the uncovered atom recorded", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement atom 1"),
      makeIngestedAtom("atom-2", "Requirement atom 2"),
      makeIngestedAtom("atom-3", "Requirement atom 3 — not covered"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: PLAN,
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    await runQualityIntelligenceModelRoutedTestDesign(input, makeDepsWithCandidateCap(store, 2));

    const manifest = store.load(String(PLAN.id));
    expect(manifest?.coverageMatrix).toBeDefined();
    const matrix = manifest?.coverageMatrix ?? [];
    // All 3 atoms must appear in the matrix
    expect(matrix.length).toBe(3);
    const uncoveredRow = matrix.find((row) => row.atomId === "atom-3");
    expect(uncoveredRow).toBeDefined();
    expect(uncoveredRow?.status).toBe("uncovered");
  });

  it("records the generating modelId and seed in evidence (Epic #761)", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [makeIngestedAtom("atom-1", "Requirement atom 1")];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: PLAN,
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    await runQualityIntelligenceModelRoutedTestDesign(input, makeDeps(store));

    const manifest = store.load(String(PLAN.id));
    // The fake generation port reports modelId "test-model"; no seed is plumbed → seedUsed null.
    expect(manifest?.modelId).toBe("test-model");
    expect(manifest?.seedUsed).toBeNull();
  });

  it("keeps deterministic baseline candidates and appends model output as an attributed delta", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const recorded: QualityIntelligence.QualityIntelligenceTestCaseCandidate[] = [];
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement atom 1"),
      makeIngestedAtom("atom-2", "Requirement atom 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: PLAN,
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, {
      ...makeDeps(store),
      candidatesSink: {
        record: (candidates) => {
          recorded.push(...candidates);
        },
      },
    });

    expect(summary.status).toBe("succeeded");
    expect(recorded).toHaveLength(4);
    expect(
      recorded.slice(0, 2).map((candidate) => candidate.derivedFromAtomIds.map(String)),
    ).toEqual([["atom-1"], ["atom-2"]]);
    expect(recorded.slice(2).map((candidate) => candidate.title)).toEqual([
      "Test atom 1 behavior",
      "Test atom 2 behavior",
    ]);
    // Provenance discriminator: only the deterministic baseline (slice 0..2) carries the tag;
    // the appended model-delta candidates (slice 2..) never do. This is what lets the render layer
    // sort baselines to the end while the PERSISTED order above stays [...baseline, ...delta].
    for (const baseline of recorded.slice(0, 2)) {
      expect(baseline.tags).toContain(DETERMINISTIC_BASELINE_PROVENANCE_TAG);
    }
    for (const delta of recorded.slice(2)) {
      expect(delta.tags).not.toContain(DETERMINISTIC_BASELINE_PROVENANCE_TAG);
    }
    const manifest = store.load(String(PLAN.id));
    expect(manifest?.modelId).toBe("test-model");
    expect(manifest?.totals.candidates).toBe(4);
  });

  it("bounds the model-delta request below the persisted run candidate limit", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    let requestedMaxCandidates = 0;
    let requestedInstruction = "";
    const ingestedAtoms = Array.from({ length: 9 }, (_, index) =>
      makeIngestedAtom(`atom-${String(index + 1)}`, `Requirement atom ${String(index + 1)}`),
    );
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: PLAN,
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };

    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, {
      ...makeDeps(store),
      generate: {
        generate: (args) => {
          requestedMaxCandidates = args.maxCandidates;
          requestedInstruction = args.instruction;
          return Promise.resolve({
            rawText: MODEL_OUTPUT_COVERING_TWO,
            modelCallCount: 1,
            modelId: "test-model",
          });
        },
      },
    });

    expect(summary.status).toBe("succeeded");
    expect(requestedMaxCandidates).toBe(16);
    expect(requestedInstruction).toContain("Entwirf bis zu 16 Testfälle");
    expect(store.load(String(PLAN.id))?.totals.candidates).toBeGreaterThan(0);
  });

  // Issue #763 (Epic #761) AC2: a numeric applied seed (and its modelParameters) must thread from
  // the generation result through persistRun into the manifest. The test above only exercises the
  // `seedUsed ?? null` fallback (no seed), leaving the positive-integer branch and the
  // modelParameters threading mutation-blind at the workflow-unit level.
  it("records a numeric applied seed and modelParameters in evidence (Epic #761)", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [makeIngestedAtom("atom-1", "Requirement atom 1")];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: PLAN,
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    await runQualityIntelligenceModelRoutedTestDesign(input, {
      sink: { emit: () => undefined },
      evidenceStore: store,
      candidatesSink: { record: () => undefined },
      generate: {
        generate: () =>
          Promise.resolve({
            rawText: MODEL_OUTPUT_COVERING_TWO,
            modelCallCount: 1,
            modelId: "seeded-model",
            seedUsed: 42,
            modelParameters: { responseFormat: "json_schema", seed: 42 },
          }),
      },
      clock: { nowIso: () => "2026-06-08T00:01:00.000Z" },
    });

    const manifest = store.load(String(PLAN.id));
    expect(manifest?.modelId).toBe("seeded-model");
    expect(manifest?.seedUsed).toBe(42);
    expect(manifest?.modelParameters).toEqual({ responseFormat: "json_schema", seed: 42 });
  });

  it("uses the deterministic structural baseline when generation is model-free", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const recorded: QualityIntelligence.QualityIntelligenceTestCaseCandidate[] = [];
    const ingestedAtoms = [
      makeIngestedAtom(
        "atom-1",
        "REQ-DETERMINISM-001: A payment approval screen must require a second approver.",
      ),
      makeIngestedAtom(
        "atom-2",
        "REQ-DETERMINISM-002: The approval screen must reject same-user approval.",
      ),
    ];
    const plan: QualityIntelligence.QualityIntelligenceRunPlan = {
      ...PLAN,
      id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-baseline-test-001"),
    };
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan,
      envelopes: [
        {
          id: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("env-1"),
          kind: "human-context",
          displayLabel: "Determinism audit source",
          localRef: "env-1",
          provenance: {
            origin: "requirements",
            registeredAt: "2026-06-08T00:00:00.000Z",
            integrityHashSha256Hex: "b".repeat(64),
          },
        },
      ],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, {
      sink: { emit: () => undefined },
      evidenceStore: store,
      candidatesSink: {
        record: (candidates) => {
          recorded.push(...candidates);
        },
      },
      generate: {
        generate: () =>
          Promise.resolve({
            rawText: JSON.stringify({ testCases: [] }),
            modelCallCount: 0,
          }),
      },
      clock: { nowIso: () => "2026-06-08T00:01:00.000Z" },
    });

    expect(summary.status).toBe("succeeded");
    expect(summary.modelGatewayCallCount).toBe(0);
    expect(recorded).toHaveLength(2);
    expect(recorded.map((candidate) => candidate.derivedFromAtomIds.map(String))).toEqual([
      ["atom-1"],
      ["atom-2"],
    ]);
    expect(recorded.map((candidate) => candidate.title)).toEqual([
      "#001 Prüfe REQ-DETERMINISM-001: A payment approval screen must require a second approver.",
      "#002 Prüfe REQ-DETERMINISM-002: The approval screen must reject same-user approval.",
    ]);
    expect(recorded[0]?.preconditions).toContain(
      "Quellanforderung: REQ-DETERMINISM-001: A payment approval screen must require a second approver.",
    );

    const manifest = store.load(String(plan.id));
    expect(manifest?.modelId).toBeUndefined();
    expect(manifest?.seedUsed).toBeUndefined();
    expect(manifest?.totals.candidates).toBe(2);
    expect(manifest?.coverageMatrix?.map((row) => row.status)).toEqual(["covered", "covered"]);
  });

  it("persists sourceFingerprints for each supplied envelope", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement atom 1"),
      makeIngestedAtom("atom-2", "Requirement atom 2"),
    ];
    const envelopes: QualityIntelligence.QualityIntelligenceSourceEnvelope[] = [
      {
        id: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("env-fp-1"),
        kind: "human-context",
        displayLabel: "Spec v1",
        localRef: "env-fp-1",
        provenance: {
          origin: "requirements",
          registeredAt: "2026-06-08T00:00:00.000Z",
          integrityHashSha256Hex: "b".repeat(64),
        },
      },
    ];
    const plan: QualityIntelligence.QualityIntelligenceRunPlan = {
      ...PLAN,
      id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-fp-test-001"),
    };
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan,
      envelopes,
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    await runQualityIntelligenceModelRoutedTestDesign(input, makeDeps(store));

    const manifest = store.load(String(plan.id));
    expect(manifest?.sourceFingerprints).toBeDefined();
    expect(manifest?.sourceFingerprints?.length).toBe(1);
    expect(manifest?.sourceFingerprints?.[0]?.envelopeId).toBe("env-fp-1");
    expect(manifest?.sourceFingerprints?.[0]?.integrityHashSha256Hex).toBe("b".repeat(64));
  });

  it("does not set sourceFingerprints when no envelopes are supplied", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [makeIngestedAtom("atom-1", "Requirement atom 1")];
    const plan: QualityIntelligence.QualityIntelligenceRunPlan = {
      ...PLAN,
      id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-fp-test-002"),
    };
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan,
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    await runQualityIntelligenceModelRoutedTestDesign(input, makeDeps(store));
    const manifest = store.load(String(plan.id));
    // No envelopes supplied → sourceFingerprints absent (not set to empty array)
    expect(manifest?.sourceFingerprints).toBeUndefined();
  });

  it("does not emit coverage-gap findings when all atoms are covered", async () => {
    // T1 — strengthened: prove ZERO gap findings AND every coverageMatrix row is "covered".
    // Mutation target: the gap loop guard `s.status !== "covered"` in modelRoutedTestDesign.ts.
    // Flipping it to `true` causes every atom to emit a gap entry → toHaveLength(0) fails.
    const store = createInMemoryQualityIntelligenceLocalStore();
    // Only 2 atoms; MODEL_OUTPUT_COVERING_TWO cites each with a single-atom index list
    // → bestFocus=1 ≤ FOCUS_COVERED_MAX(3) → both atoms are "covered".
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement atom 1"),
      makeIngestedAtom("atom-2", "Requirement atom 2"),
    ];
    const plan: QualityIntelligence.QualityIntelligenceRunPlan = {
      ...PLAN,
      id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-cov-test-002"),
    };
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan,
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    await runQualityIntelligenceModelRoutedTestDesign(input, makeDeps(store));

    const manifest = store.load(String(plan.id));
    expect(manifest).toBeDefined();
    if (manifest === undefined) throw new Error("manifest not found");

    // Deliverable: a fully-covered run produces ZERO coverage-gap findings.
    const gapFindings = manifest.findings.filter((f) => f.kind === "coverage-gap");
    expect(gapFindings).toHaveLength(0);

    // Deliverable: every coverageMatrix row must be "covered" (not "weakly-covered" / "uncovered").
    const matrix = manifest.coverageMatrix ?? [];
    expect(matrix.length).toBe(2);
    expect(matrix.every((row) => row.status === "covered")).toBe(true);
  });

  it("computes coverage from the persisted candidate set, not only the model delta", async () => {
    // The user receives baseline + model-delta candidates. Coverage must assess that same
    // persisted set; otherwise the manifest can report gaps for atoms that are actually covered by
    // delivered baseline candidates.
    const store = createInMemoryQualityIntelligenceLocalStore();
    const recorded: QualityIntelligence.QualityIntelligenceTestCaseCandidate[] = [];
    const plan: QualityIntelligence.QualityIntelligenceRunPlan = {
      ...PLAN,
      id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-cov-test-003"),
    };

    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement atom 1"),
      makeIngestedAtom("atom-2", "Requirement atom 2"),
      makeIngestedAtom("atom-3", "Requirement atom 3"),
      makeIngestedAtom("atom-4", "Requirement atom 4 — broad citer only"),
    ];

    // One candidate citing all 4 atoms → bestFocus=4 > FOCUS_COVERED_MAX(3) → weakly-covered.
    const rawTextBroadCoverage = JSON.stringify([
      {
        title: "Broad integration test touching all requirements",
        steps: ["Trigger the combined flow"],
        expectedResults: ["All requirements satisfied"],
        priority: "P2",
        riskClass: "regression",
        derivedFromEvidenceIndexes: [1, 2, 3, 4],
      },
    ]);

    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan,
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    const deps: QualityIntelligenceModelRoutedTestDesignDeps = {
      sink: { emit: () => undefined },
      evidenceStore: store,
      candidatesSink: {
        record: (candidates) => {
          recorded.push(...candidates);
        },
      },
      generate: {
        generate: () =>
          Promise.resolve({
            rawText: rawTextBroadCoverage,
            modelCallCount: 1,
            modelId: "test-model",
          }),
      },
      clock: { nowIso: () => "2026-06-08T00:01:00.000Z" },
    };
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    expect(summary.status).toBe("succeeded");

    const manifest = store.load(String(plan.id));
    expect(manifest).toBeDefined();
    if (manifest === undefined) throw new Error("manifest not found");

    expect(manifest.totals.candidates).toBe(5);
    expect(recorded).toHaveLength(5);

    const gapFindings = manifest.findings.filter((f) => f.kind === "coverage-gap");
    expect(gapFindings).toHaveLength(0);

    const matrix = manifest.coverageMatrix ?? [];
    expect(matrix).toHaveLength(4);
    expect(matrix.every((row) => row.status === "covered")).toBe(true);
    const atom4Row = matrix.find((row) => row.atomId === "atom-4");
    expect(atom4Row).toBeDefined();
    expect(atom4Row?.coveringCandidateIds.some((id) => recorded.some((c) => c.id === id))).toBe(
      true,
    );
  });
});

// ─── Judge stage wiring ──────────────────────────────────────────────────────

const WEAK_VERDICT = {
  verdict: "weak" as const,
  dimensions: [
    { name: "verifiability" as const, score: 20, rationale: "unclear" },
    { name: "atomicity" as const, score: 20, rationale: "too many" },
    { name: "determinism" as const, score: 20, rationale: "flaky" },
    { name: "ac-fidelity" as const, score: 20, rationale: "mismatched" },
  ],
  overallRationale: "weak test",
};

const STRONG_VERDICT = {
  verdict: "strong" as const,
  dimensions: [
    { name: "verifiability" as const, score: 90, rationale: "clear" },
    { name: "atomicity" as const, score: 85, rationale: "single action" },
    { name: "determinism" as const, score: 95, rationale: "deterministic" },
    { name: "ac-fidelity" as const, score: 80, rationale: "matches" },
  ],
  overallRationale: "strong test",
};

const MEDIUM_WEAK_VERDICT = {
  verdict: "weak" as const,
  dimensions: [
    { name: "verifiability" as const, score: 55, rationale: "expected result is vague" },
    { name: "atomicity" as const, score: 55, rationale: "multiple concerns are mixed" },
    { name: "determinism" as const, score: 55, rationale: "timing-sensitive wait remains" },
    { name: "ac-fidelity" as const, score: 55, rationale: "only partially matches the AC" },
  ],
  overallRationale: "medium severity weak test",
};

const DISTINCT_WEAK_RATIONALE_VERDICT = {
  verdict: "weak" as const,
  dimensions: [
    { name: "verifiability" as const, score: 82, rationale: "Expected result is measurable." },
    { name: "atomicity" as const, score: 78, rationale: "The flow is narrow enough." },
    { name: "determinism" as const, score: 25, rationale: "Relies on timing-sensitive behavior." },
    {
      name: "ac-fidelity" as const,
      score: 10,
      rationale: "Misses the stated acceptance criteria.",
    },
  ],
  overallRationale: "weak because it misses the originating AC and remains timing-sensitive",
};

function makeDepsWithJudge(
  evidenceStore: ReturnType<typeof createInMemoryQualityIntelligenceLocalStore>,
  judgeImpl: QualityIntelligenceJudgePort["judge"],
): QualityIntelligenceModelRoutedTestDesignDeps {
  return {
    sink: { emit: () => undefined },
    evidenceStore,
    candidatesSink: { record: () => undefined },
    generate: {
      generate: () =>
        Promise.resolve({
          rawText: MODEL_OUTPUT_COVERING_TWO,
          modelCallCount: 1,
          modelId: "test-model",
        }),
    },
    judge: { judge: judgeImpl },
    clock: { nowIso: () => "2026-06-08T00:01:00.000Z" },
  };
}

describe("runQualityIntelligenceModelRoutedTestDesign — judge stage wiring", () => {
  const JUDGE_PLAN: QualityIntelligence.QualityIntelligenceRunPlan = {
    id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-001"),
    requestedAt: "2026-06-08T00:00:00.000Z",
    plannerKind: "model-routed",
    stages: [],
  };

  const JUDGE_PROVENANCE = {
    envelopeIds: ["env-1"],
    auditSummaryId:
      "audit-judge-001" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
  } as const;

  it("emits test-quality findings for weak candidates", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: JUDGE_PLAN,
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const deps = makeDepsWithJudge(store, (_input) => Promise.resolve(WEAK_VERDICT));
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    expect(summary.status).toBe("succeeded");

    const manifest = store.load(String(JUDGE_PLAN.id));
    expect(manifest).toBeDefined();
    if (manifest === undefined) throw new Error("manifest not found");

    const qualityFindings = manifest.findings.filter((f) => f.kind === "test-quality");
    // Both model-delta candidates are weak → 2 test-quality findings.
    expect(qualityFindings.length).toBe(2);
    // Each test-quality finding is candidate-scoped so the UI can flag the exact test (#748).
    expect(qualityFindings.every((f) => typeof f.candidateId === "string")).toBe(true);
  });

  it("sets a lower qualityScore when candidates are weak", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-002"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const deps = makeDepsWithJudge(store, (_input) => Promise.resolve(WEAK_VERDICT));
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBeDefined();
    expect(summary.qualityScore).not.toBeNull();
    // Pass-rate formula (#747): every candidate weak → 0 strong of N → score 0.
    expect(summary.qualityScore).toBe(0);
  });

  it("computes qualityScore as the strong-candidate pass rate (1 strong of 2 → 50)", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-005"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    let call = 0;
    const deps = makeDepsWithJudge(store, (_input) => {
      call += 1;
      return Promise.resolve(call === 1 ? STRONG_VERDICT : WEAK_VERDICT);
    });
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBe(50);

    const manifest = store.load(String(input.plan.id));
    const qualityFindings = (manifest?.findings ?? []).filter((f) => f.kind === "test-quality");
    // Only the weak candidate is flagged.
    expect(qualityFindings.length).toBe(1);
  });

  it("passes candidate preconditions into the judge prompt", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [makeIngestedAtom("atom-1", "AC-1: Admins can approve refunds.")];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-preconditions"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const rawText = JSON.stringify([
      {
        title: "Approve refund as an admin",
        preconditions: ["User has admin role", "Refund request is pending"],
        steps: ["Open the refund request", "Click approve"],
        expectedResults: ["The refund is approved"],
        priority: "P1",
        riskClass: "functional",
        derivedFromEvidenceIndexes: [1],
      },
    ]);
    const judgeCalls: QualityIntelligenceJudgeInput[] = [];
    const deps: QualityIntelligenceModelRoutedTestDesignDeps = {
      ...makeDepsWithJudge(store, (judgeInput) => {
        judgeCalls.push(judgeInput);
        return Promise.resolve(STRONG_VERDICT);
      }),
      generate: {
        generate: () =>
          Promise.resolve({
            rawText,
            modelCallCount: 1,
            modelId: "test-model",
          }),
      },
    };

    await runQualityIntelligenceModelRoutedTestDesign(input, deps);

    const modelCall = judgeCalls.find((call) =>
      call.candidateText.includes("Titel: Approve refund as an admin"),
    );
    expect(modelCall?.candidateText).toContain(
      "Vorbedingungen: User has admin role; Refund request is pending",
    );
  });

  it("passes per-candidate quality verdicts to candidate persistence for strong and weak tests", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const recorded: QualityIntelligence.QualityIntelligenceTestCaseCandidate[] = [];
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-verdict-persist"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const deps: QualityIntelligenceModelRoutedTestDesignDeps = {
      ...makeDepsWithJudge(store, (judgeInput) =>
        Promise.resolve(
          judgeInput.candidateText.includes("Test atom 1 behavior") ? STRONG_VERDICT : WEAK_VERDICT,
        ),
      ),
      candidatesSink: {
        record: (candidates) => {
          recorded.push(...candidates);
        },
      },
    };

    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);

    expect(summary.status).toBe("succeeded");
    expect(recorded).toHaveLength(4);
    const withVerdicts =
      recorded as readonly (QualityIntelligence.QualityIntelligenceTestCaseCandidate & {
        readonly qualityVerdict?: QualityIntelligence.TestQualityJudgeVerdict & {
          readonly score: number;
        };
      })[];
    const strongCandidate = withVerdicts.find((candidate) =>
      candidate.title.includes("Test atom 1 behavior"),
    );
    const weakCandidate = withVerdicts.find((candidate) =>
      candidate.title.includes("Test atom 2 behavior"),
    );
    expect(strongCandidate?.qualityVerdict).toEqual(
      expect.objectContaining({
        verdict: "strong",
        score: 87.5,
        overallRationale: "strong test",
      }),
    );
    expect(weakCandidate?.qualityVerdict).toEqual(
      expect.objectContaining({
        verdict: "weak",
        score: 20,
        overallRationale: "weak test",
      }),
    );
    expect(strongCandidate?.qualityVerdict?.dimensions).toEqual(STRONG_VERDICT.dimensions);
    expect(weakCandidate?.qualityVerdict?.dimensions).toEqual(WEAK_VERDICT.dimensions);
  });

  it("does not emit test-quality findings for strong candidates", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-003"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const deps = makeDepsWithJudge(store, (_input) => Promise.resolve(STRONG_VERDICT));
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    expect(summary.status).toBe("succeeded");

    const manifest = store.load(String(input.plan.id));
    const qualityFindings = (manifest?.findings ?? []).filter((f) => f.kind === "test-quality");
    expect(qualityFindings.length).toBe(0);
  });

  it("passes the originating requirement context into the judge for ac-fidelity scoring", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "AC-1: Clicking Help opens the help center."),
      makeIngestedAtom("atom-2", "AC-2: The Help center focuses the search field."),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-006"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const judgeCalls: QualityIntelligenceJudgeInput[] = [];
    const deps = makeDepsWithJudge(store, (judgeInput) => {
      judgeCalls.push(judgeInput);
      return Promise.resolve(STRONG_VERDICT);
    });

    await runQualityIntelligenceModelRoutedTestDesign(input, deps);

    expect(judgeCalls).toHaveLength(2);
    const firstJudgeCall = judgeCalls.find((call) =>
      call.candidateText.includes("Titel: Test atom 1 behavior"),
    );
    const secondJudgeCall = judgeCalls.find((call) =>
      call.candidateText.includes("Titel: Test atom 2 behavior"),
    );
    expect(firstJudgeCall?.candidateText).toContain("Titel: Test atom 1 behavior");
    expect(firstJudgeCall?.sourceContext).toEqual([
      { atomId: "atom-1", text: "AC-1: Clicking Help opens the help center." },
    ]);
    expect(secondJudgeCall?.candidateText).toContain("Titel: Test atom 2 behavior");
    expect(secondJudgeCall?.sourceContext).toEqual([
      { atomId: "atom-2", text: "AC-2: The Help center focuses the search field." },
    ]);
  });

  it("persists judge rationale instead of a generic score sentence for weak-test findings", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-007"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const deps = makeDepsWithJudge(store, (_input) =>
      Promise.resolve(DISTINCT_WEAK_RATIONALE_VERDICT),
    );

    await runQualityIntelligenceModelRoutedTestDesign(input, deps);

    const manifest = store.load(String(input.plan.id));
    const qualityFinding = manifest?.findings.find((finding) => finding.kind === "test-quality");
    expect(qualityFinding?.summaryRedacted).toContain(
      "AC-Treue: Misses the stated acceptance criteria.",
    );
    expect(qualityFinding?.summaryRedacted).toContain(
      "Determinismus: Relies on timing-sensitive behavior.",
    );
    expect(qualityFinding?.summaryRedacted).not.toContain("Test quality score");
  });

  it("preserves weak-test findings ahead of same-severity validator findings when the cap is hit", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const plan: QualityIntelligence.QualityIntelligenceRunPlan = {
      ...JUDGE_PLAN,
      id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-cap-quality"),
    };
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
      makeIngestedAtom("atom-3", "Requirement 3"),
    ];
    const rawText = JSON.stringify(
      [1, 2, 3].map((n) => ({
        title: `Cap saturation candidate ${String(n)}`,
        preconditions: ["User is approved"],
        steps: ["Open the review page", "Open the review page"],
        expectedResults: ["User is not approved"],
        priority: "P2",
        riskClass: "regression",
        derivedFromEvidenceIndexes: [n],
      })),
    );
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan,
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const deps: QualityIntelligenceModelRoutedTestDesignDeps = {
      ...makeDepsWithJudge(store, (_input) => Promise.resolve(MEDIUM_WEAK_VERDICT)),
      generate: {
        generate: () =>
          Promise.resolve({
            rawText,
            modelCallCount: 1,
            modelId: "test-model",
          }),
      },
      limits: {
        ...QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS,
        maxFindingsPerRun: 4,
      },
    };

    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBe(0);

    const manifest = store.load(String(plan.id));
    expect(manifest).toBeDefined();
    if (manifest === undefined) throw new Error("manifest not found");
    expect(manifest.findings).toHaveLength(4);
    const qualityFindings = manifest.findings.filter((finding) => finding.kind === "test-quality");
    expect(qualityFindings).toHaveLength(3);
    expect(qualityFindings.every((finding) => finding.severity === "medium")).toBe(true);
    expect(qualityFindings.every((finding) => finding.candidateId !== undefined)).toBe(true);
  });

  it("returns qualityScore: null when no judge is configured", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-004"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    // No judge in deps
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, makeDeps(store));
    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBeNull();
  });

  it("counts every judge gateway dispatch in modelGatewayCallCount (audit integrity)", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-count"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const deps = makeDepsWithJudge(store, (_input) => Promise.resolve(WEAK_VERDICT));
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    // 1 generation call + 2 judge calls (one per model-delta candidate) = 3 gateway dispatches.
    expect(summary.modelGatewayCallCount).toBe(3);
    const manifest = store.load(String(input.plan.id));
    expect(manifest?.modelGatewayCallCount).toBe(3);
  });

  it("does not count locally guarded judge verdicts as gateway dispatches", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-local-guard"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const deps = makeDepsWithJudge(store, (_input) =>
      Promise.resolve({ ...WEAK_VERDICT, gatewayCallCount: 0 }),
    );
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBe(0);
    // 1 generation call + 0 real judge gateway dispatches.
    expect(summary.modelGatewayCallCount).toBe(1);
    const manifest = store.load(String(input.plan.id));
    expect(manifest?.modelGatewayCallCount).toBe(1);
    expect((manifest?.findings ?? []).filter((f) => f.kind === "test-quality")).toHaveLength(2);
  });

  it("is fail-soft: a transient judge error becomes an explicit weak finding", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const recorded: QualityIntelligence.QualityIntelligenceTestCaseCandidate[] = [];
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-failsoft"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    // The judge errors on one model-delta candidate (transient gateway failure) but scores the
    // remaining model candidate strong.
    const deps: QualityIntelligenceModelRoutedTestDesignDeps = {
      ...makeDepsWithJudge(store, (judgeInput) => {
        if (judgeInput.candidateText.includes("Test atom 1 behavior")) {
          return Promise.reject(new Error("HTTP 429 rate limited"));
        }
        return Promise.resolve(STRONG_VERDICT);
      }),
      candidatesSink: {
        record: (candidates) => {
          recorded.push(...candidates);
        },
      },
    };
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    // The run survives the judge error and persists baseline plus model-delta candidates.
    expect(summary.status).toBe("succeeded");
    expect(recorded).toHaveLength(4);
    const manifest = store.load(String(input.plan.id));
    expect(manifest?.totals.candidates).toBe(4);
    // The failed judge call is represented as an explicit weak verdict so it cannot look strong.
    expect(summary.qualityScore).toBe(50);
    const qualityFindings = (manifest?.findings ?? []).filter((f) => f.kind === "test-quality");
    expect(qualityFindings).toHaveLength(1);
    expect(qualityFindings[0]?.summaryRedacted).toContain(
      "konnte diesen Kandidaten nicht bewerten",
    );
    expect(qualityFindings[0]?.summaryRedacted).not.toContain("HTTP 429");
    // Both model-delta judge dispatches are still counted for an honest audit trail.
    expect(summary.modelGatewayCallCount).toBe(3);
  });

  it("is fail-soft when EVERY judge call errors: run succeeds with weak findings", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-allfail"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const deps = makeDepsWithJudge(store, (_input) =>
      Promise.reject(new Error("gateway 503 unavailable")),
    );
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBe(0);
    const manifest = store.load(String(input.plan.id));
    expect(manifest?.totals.candidates).toBe(4);
    const qualityFindings = (manifest?.findings ?? []).filter((f) => f.kind === "test-quality");
    expect(qualityFindings).toHaveLength(2);
    expect(qualityFindings.map((f) => f.summaryRedacted)).toEqual(
      expect.arrayContaining([expect.stringContaining("konnte diesen Kandidaten nicht bewerten")]),
    );
    expect(qualityFindings.map((f) => f.summaryRedacted).join("\n")).not.toContain("gateway 503");
  });

  it("bounds gateway calls by maxJudgeCallsPerRun and marks overflow candidates weak", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-budget"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    let judgeCallCount = 0;
    const deps: QualityIntelligenceModelRoutedTestDesignDeps = {
      ...makeDepsWithJudge(store, (_input) => {
        judgeCallCount += 1;
        return Promise.resolve(STRONG_VERDICT);
      }),
      limits: { ...QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS, maxJudgeCallsPerRun: 1 },
    };
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    expect(summary.status).toBe("succeeded");
    // Only one of the two model-delta candidates is judged under the budget of 1.
    expect(judgeCallCount).toBe(1);
    // 1 generation + 1 judge call.
    expect(summary.modelGatewayCallCount).toBe(2);
    expect(summary.qualityScore).toBe(50);
    const manifest = store.load(String(input.plan.id));
    const qualityFindings = (manifest?.findings ?? []).filter((f) => f.kind === "test-quality");
    expect(qualityFindings).toHaveLength(1);
    expect(qualityFindings[0]?.summaryRedacted).toContain("Budget war vor der Bewertung");
  });

  it("classifies a run cancelled when the judge is aborted mid-stage (not failed)", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const controller = new AbortController();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...JUDGE_PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-judge-test-cancel"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: JUDGE_PROVENANCE,
    };
    const deps: QualityIntelligenceModelRoutedTestDesignDeps = {
      ...makeDepsWithJudge(store, (_input) => {
        controller.abort();
        return Promise.reject(new Error("aborted"));
      }),
      signal: controller.signal,
    };
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);
    // Cancellation must NOT be fail-soft-swallowed into "succeeded"; it is a genuine cancel.
    expect(summary.status).toBe("cancelled");
  });
});

// ─── Requirement excerpts on coverage surfaces (#790) ───────────────────────────

describe("runQualityIntelligenceModelRoutedTestDesign — requirement excerpts (#790)", () => {
  const RUN_ID = QualityIntelligence.asQualityIntelligenceRunId("qi-run-excerpt-test-001");

  async function runWithAtoms(
    store: ReturnType<typeof createInMemoryQualityIntelligenceLocalStore>,
    ingestedAtoms: QualityIntelligenceModelRoutedTestDesignInput["ingestedAtoms"],
    maxCandidatesPerRun?: number,
  ): Promise<void> {
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: { ...PLAN, id: RUN_ID },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    await runQualityIntelligenceModelRoutedTestDesign(
      input,
      maxCandidatesPerRun === undefined
        ? makeDeps(store)
        : makeDepsWithCandidateCap(store, maxCandidatesPerRun),
    );
  }

  it("persists a redacted requirement excerpt on every coverage matrix row", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    await runWithAtoms(store, [
      makeIngestedAtom("atom-1", "docs/auth.md\nLock the account after five failed logins."),
      makeIngestedAtom("atom-2", "Requirement atom 2"),
      makeIngestedAtom("atom-3", "Reset the lockout counter after a successful login."),
    ]);
    const matrix = store.load(String(RUN_ID))?.coverageMatrix ?? [];
    expect(matrix.length).toBe(3);
    const row1 = matrix.find((row) => row.atomId === "atom-1");
    // The path\ntext canonical shape collapses to a single readable line.
    expect(row1?.requirementExcerptRedacted).toBe(
      "docs/auth.md Lock the account after five failed logins.",
    );
    const row3 = matrix.find((row) => row.atomId === "atom-3");
    expect(row3?.requirementExcerptRedacted).toBe(
      "Reset the lockout counter after a successful login.",
    );
  });

  it("names the requirement in the gap-finding summary, not just the atom id", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    await runWithAtoms(
      store,
      [
        makeIngestedAtom("atom-1", "Requirement atom 1"),
        makeIngestedAtom("atom-2", "Requirement atom 2"),
        makeIngestedAtom("atom-3", "Reject a checkout when the cart is empty."),
      ],
      2,
    );
    const manifest = store.load(String(RUN_ID));
    const gap = (manifest?.findings ?? []).find(
      (f) => f.kind === "coverage-gap" && f.summaryRedacted.includes("atom-3"),
    );
    expect(gap?.summaryRedacted).toBe(
      'Atom atom-3 ("Reject a checkout when the cart is empty.") hat keinen zugeordneten Test (uncovered).',
    );
  });

  it("redacts a planted secret out of the excerpt and the gap summary", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const secretText = `Use key AKIA${"C".repeat(16)} to call the payments API.`;
    await runWithAtoms(
      store,
      [
        makeIngestedAtom("atom-1", "Requirement atom 1"),
        makeIngestedAtom("atom-2", "Requirement atom 2"),
        makeIngestedAtom("atom-3", secretText),
      ],
      2,
    );
    const manifest = store.load(String(RUN_ID));
    const row = (manifest?.coverageMatrix ?? []).find((r) => r.atomId === "atom-3");
    expect(row?.requirementExcerptRedacted).toContain("[REDACTED]");
    expect(row?.requirementExcerptRedacted).not.toContain("AKIA");
    const gap = (manifest?.findings ?? []).find(
      (f) => f.kind === "coverage-gap" && f.summaryRedacted.includes("atom-3"),
    );
    expect(gap?.summaryRedacted).not.toContain("AKIA");
  });

  it("omits the excerpt field (and keeps the id-only summary) for empty canonical text", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    await runWithAtoms(
      store,
      [
        makeIngestedAtom("atom-1", "Requirement atom 1"),
        makeIngestedAtom("atom-2", "Requirement atom 2"),
        makeIngestedAtom("atom-3", "   \n\t "),
      ],
      2,
    );
    const manifest = store.load(String(RUN_ID));
    const row = (manifest?.coverageMatrix ?? []).find((r) => r.atomId === "atom-3");
    expect(row).toBeDefined();
    expect(row?.requirementExcerptRedacted).toBeUndefined();
    const gap = (manifest?.findings ?? []).find(
      (f) => f.kind === "coverage-gap" && f.summaryRedacted.includes("atom-3"),
    );
    expect(gap?.summaryRedacted).toBe("Atom atom-3 hat keinen zugeordneten Test (uncovered).");
  });
});

// ─── Generation undercount regression (#273 / #843 undercount class) ─────────────
//
// A FAILED generation must still count its gateway dispatch as one attempt: the generation port
// makes at most one dispatch per call, so a rejection (Azure 5xx / timeout / network / abort) still
// means one call was attempted and billed. Counting only result.modelCallCount AFTER a successful
// await under-reported a failed run's audit trail as 0 gateway calls. generateCandidates now does
// `ctx.modelGatewayCallCount += 1` in the catch before rethrowing, mirroring the judge contract.
//
// Mutation thinking: reverting the catch-side increment makes both modelGatewayCallCount assertions
// below collapse to 0, so this test fails closed on the regression. The companion baseline test
// guards the opposite direction — the deterministic (model-free) port must NOT be over-counted.

describe("runQualityIntelligenceModelRoutedTestDesign — generation gateway-call audit (#273)", () => {
  it("falls back to deterministic candidates and counts a rejected generation dispatch", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const recorded: QualityIntelligence.QualityIntelligenceTestCaseCandidate[] = [];
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "Requirement 1"),
      makeIngestedAtom("atom-2", "Requirement 2"),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-gen-reject-001"),
      },
      envelopes: [],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    const deps: QualityIntelligenceModelRoutedTestDesignDeps = {
      sink: { emit: () => undefined },
      evidenceStore: store,
      candidatesSink: {
        record: (candidates) => {
          recorded.push(...candidates);
        },
      },
      // The gateway dispatch rejects (Azure 503): one call was attempted, none succeeded.
      generate: { generate: () => Promise.reject(new Error("HTTP 503 Service Unavailable")) },
      clock: { nowIso: () => "2026-06-08T00:01:00.000Z" },
    };

    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);

    // The model delta failed, but valid evidence still produces deterministic baseline candidates.
    expect(summary.status).toBe("succeeded");
    // QI-DEG-01: the degradation must be visible on the SUMMARY (which the BFF surfaces on the wire
    // `done` frame as degraded+reasonSummary), not buried only in the offline manifest. Without this a
    // provider failure looks like a fully successful model-backed run.
    expect(summary.reasonSummary).toBe("qi-run-error");
    expect(summary.modelGatewayCallCount).toBeGreaterThanOrEqual(1);
    expect(recorded).toHaveLength(2);
    for (const candidate of recorded) {
      expect(candidate.tags).toContain(DETERMINISTIC_BASELINE_PROVENANCE_TAG);
    }
    // The persisted manifest must carry the same honest call count (not 0) and fallback reason.
    const manifest = store.load(String(input.plan.id));
    expect(manifest?.status).toBe("succeeded");
    expect(manifest?.totals.candidates).toBe(2);
    expect(manifest?.modelGatewayCallCount).toBeGreaterThanOrEqual(1);
    expect(manifest?.modelParameters).toEqual({ generationFallbackReason: "qi-run-error" });
    // The raw provider message must never leak into the persisted/summary reason.
    expect(JSON.stringify(manifest)).not.toContain("503");
  });

  it("does NOT over-count the deterministic model-free baseline (modelCallCount 0 → 0 dispatches)", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const ingestedAtoms = [
      makeIngestedAtom("atom-1", "REQ-1: Lock the account after five failed logins."),
      makeIngestedAtom("atom-2", "REQ-2: Reset the counter after a success."),
    ];
    const input: QualityIntelligenceModelRoutedTestDesignInput = {
      plan: {
        ...PLAN,
        id: QualityIntelligence.asQualityIntelligenceRunId("qi-run-gen-baseline-001"),
      },
      envelopes: [
        {
          id: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("env-1"),
          kind: "human-context",
          displayLabel: "Audit source",
          localRef: "env-1",
          provenance: {
            origin: "requirements",
            registeredAt: "2026-06-08T00:00:00.000Z",
            integrityHashSha256Hex: "b".repeat(64),
          },
        },
      ],
      ingestedAtoms,
      provenanceRefs: PROVENANCE,
    };
    const deps: QualityIntelligenceModelRoutedTestDesignDeps = {
      sink: { emit: () => undefined },
      evidenceStore: store,
      candidatesSink: { record: () => undefined },
      // Deterministic baseline port: resolves, modelCallCount 0, no modelId → no gateway dispatch.
      generate: {
        generate: () =>
          Promise.resolve({ rawText: JSON.stringify({ testCases: [] }), modelCallCount: 0 }),
      },
      clock: { nowIso: () => "2026-06-08T00:01:00.000Z" },
    };

    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, deps);

    expect(summary.status).toBe("succeeded");
    // The successful, model-free baseline must report exactly zero gateway dispatches.
    expect(summary.modelGatewayCallCount).toBe(0);
    expect(store.load(String(input.plan.id))?.modelGatewayCallCount).toBe(0);
  });
});
