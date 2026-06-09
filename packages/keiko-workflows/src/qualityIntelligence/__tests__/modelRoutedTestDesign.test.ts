// #738 — modelRoutedTestDesign coverage-gap wiring tests.
//
// Verifies that when the model produces candidates that cover only a subset of the
// evidence atoms, the uncovered atoms generate "coverage-gap" findings and their
// status is persisted in the manifest's coverageMatrix field.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import {
  createInMemoryQualityIntelligenceLocalStore,
  type QualityIntelligenceEvidenceManifest,
} from "@oscharko-dev/keiko-evidence";
import { runQualityIntelligenceModelRoutedTestDesign } from "../modelRoutedTestDesign.js";
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
    const summary = await runQualityIntelligenceModelRoutedTestDesign(input, makeDeps(store));
    expect(summary.status).toBe("succeeded");

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
    await runQualityIntelligenceModelRoutedTestDesign(input, makeDeps(store));

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
    const store = createInMemoryQualityIntelligenceLocalStore();
    // Only 2 atoms, model covers both
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
    // Atom-1 and atom-2 are cited — coverage-gap count depends on confidence threshold
    // but the 3rd-atom gap that was the focus of this epic is absent
    const gapFindings = (manifest?.findings ?? []).filter((f) => f.kind === "coverage-gap");
    // No atom-3 row in a 2-atom run
    const hasAtom3Gap = gapFindings.some((f) => f.summaryRedacted.includes("atom-3"));
    expect(hasAtom3Gap).toBe(false);
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
    // Both candidates are weak → 2 test-quality findings
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
    const firstJudgeCall = judgeCalls[0];
    const secondJudgeCall = judgeCalls[1];
    expect(firstJudgeCall?.candidateText).toContain("Title: Test atom 1 behavior");
    expect(firstJudgeCall?.sourceContext).toEqual([
      { atomId: "atom-1", text: "AC-1: Clicking Help opens the help center." },
    ]);
    expect(secondJudgeCall?.candidateText).toContain("Title: Test atom 2 behavior");
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
      "AC fidelity: Misses the stated acceptance criteria.",
    );
    expect(qualityFinding?.summaryRedacted).toContain(
      "Determinism: Relies on timing-sensitive behavior.",
    );
    expect(qualityFinding?.summaryRedacted).not.toContain("Test quality score");
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
});
