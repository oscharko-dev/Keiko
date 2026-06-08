// Unit tests for runScopedRegeneration (Epic #735, Issue #743).
// Verifies that scoped regeneration calls the underlying model-routed workflow
// with the supplied narrowed atoms and returns the summary + narrowedAtomCount.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import {
  createInMemoryQualityIntelligenceLocalStore,
  type QualityIntelligenceEvidenceManifest,
} from "@oscharko-dev/keiko-evidence";
import { runScopedRegeneration } from "../scopedRegeneration.js";
import type { ScopedRegenerationInput } from "../scopedRegeneration.js";
import type { QualityIntelligenceModelRoutedTestDesignDeps } from "../modelRoutedTestDesign.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROVENANCE = {
  envelopeIds: ["env-regen-1"],
  auditSummaryId:
    "audit-regen-001" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
} as const;

const MODEL_OUTPUT_ONE = JSON.stringify([
  {
    title: "Regenerated test case",
    steps: ["Step 1"],
    expectedResults: ["Expected result 1"],
    priority: "P2",
    riskClass: "regression",
    derivedFromEvidenceIndexes: [1],
  },
]);

function makeIngestedAtom(
  id: string,
  canonicalText: string,
  envelopeId = "env-regen-1",
): { atom: QualityIntelligence.QualityIntelligenceEvidenceAtom; canonicalText: string } {
  return {
    atom: {
      id: QualityIntelligence.asQualityIntelligenceEvidenceAtomId(id),
      kind: "requirement",
      sourceEnvelopeId: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(envelopeId),
      canonicalHashSha256Hex: "a".repeat(64),
      redactionStatus: "not-required",
      lifecycleStatus: "draft",
    },
    canonicalText,
  };
}

function makeDeps(
  store: ReturnType<typeof createInMemoryQualityIntelligenceLocalStore>,
): QualityIntelligenceModelRoutedTestDesignDeps {
  return {
    sink: { emit: () => undefined },
    evidenceStore: store,
    candidatesSink: { record: () => undefined },
    generate: {
      generate: () =>
        Promise.resolve({
          rawText: MODEL_OUTPUT_ONE,
          modelCallCount: 1,
          modelId: "test-model",
        }),
    },
    clock: { nowIso: () => "2026-06-09T00:01:00.000Z" },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runScopedRegeneration", () => {
  it("succeeds and returns a summary with status=succeeded", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const input: ScopedRegenerationInput = {
      newRunId: "qi-run-regen-001",
      requestedAt: "2026-06-09T00:00:00.000Z",
      envelopes: [],
      ingestedAtoms: [makeIngestedAtom("atom-1", "Stale requirement")],
      provenanceRefs: PROVENANCE,
    };
    const result = await runScopedRegeneration(input, makeDeps(store));
    expect(result.summary.status).toBe("succeeded");
  });

  it("reports narrowedAtomCount equal to the number of ingestedAtoms supplied", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const atoms = [
      makeIngestedAtom("atom-1", "Stale req 1"),
      makeIngestedAtom("atom-2", "Stale req 2"),
    ];
    const input: ScopedRegenerationInput = {
      newRunId: "qi-run-regen-002",
      requestedAt: "2026-06-09T00:00:00.000Z",
      envelopes: [],
      ingestedAtoms: atoms,
      provenanceRefs: PROVENANCE,
    };
    const result = await runScopedRegeneration(input, makeDeps(store));
    expect(result.narrowedAtomCount).toBe(2);
  });

  it("uses the supplied newRunId for the persisted manifest", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const input: ScopedRegenerationInput = {
      newRunId: "qi-run-regen-003",
      requestedAt: "2026-06-09T00:00:00.000Z",
      envelopes: [],
      ingestedAtoms: [makeIngestedAtom("atom-1", "Requirement text")],
      provenanceRefs: PROVENANCE,
    };
    await runScopedRegeneration(input, makeDeps(store));
    const manifest = store.load("qi-run-regen-003");
    expect(manifest).toBeDefined();
    expect(manifest?.runId).toBe("qi-run-regen-003");
  });

  it("does not write to any other run id (original is not overwritten)", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const input: ScopedRegenerationInput = {
      newRunId: "qi-run-regen-004",
      requestedAt: "2026-06-09T00:00:00.000Z",
      envelopes: [],
      ingestedAtoms: [makeIngestedAtom("atom-1", "Requirement text")],
      provenanceRefs: PROVENANCE,
    };
    await runScopedRegeneration(input, makeDeps(store));
    const runIds = store.list();
    expect(runIds).toEqual(["qi-run-regen-004"]);
  });
});
