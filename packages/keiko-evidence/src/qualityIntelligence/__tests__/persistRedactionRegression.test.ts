// Persist-time redaction of coverageMatrix + modelParameters (Issue #273 audit, AC#3).
//
// recordQualityIntelligenceRun runs the QI persist redactor over EVERY string leaf of the input
// collections before assembling the manifest. coverageMatrix.requirementExcerptRedacted (derived
// from raw source text) and modelParameters (a free-shaped Record) previously bypassed that persist
// redactor — they were written straight from the raw input. They now flow through `redacted.*`, so a
// secret-shaped string planted in either field is scrubbed before it reaches durable storage.
//
// Mutation thinking: reverting the store fix (persist from `input.coverageMatrix` /
// `input.modelParameters` instead of `redacted.*`) leaves the planted AKIA/sk- token intact in the
// persisted manifest, failing the two "redacts" tests below. The clean round-trip test guards the
// opposite direction: redaction must be a no-op on clean data (no spurious mutation, integrity hash
// stable) so the fix stays backward-compatible.

import { describe, expect, it } from "vitest";
import {
  createInMemoryQualityIntelligenceLocalStore,
  recordQualityIntelligenceRun,
  type QualityIntelligenceRecordInput,
} from "../store.js";
import type { QualityIntelligenceEvidenceManifest } from "../manifestSchema.js";

function baseInput(runId: string): QualityIntelligenceRecordInput {
  return {
    runId,
    planAt: "2026-06-05T10:00:00.000Z",
    completedAt: "2026-06-05T10:05:00.000Z",
    status: "succeeded",
    policyProfileIds: ["qi:short-30d"],
    retentionPolicyId: "qi:short-30d",
    modelGatewayCallCount: 1,
    totals: { candidates: 0, findings: 0, exports: 0 },
    findings: [],
    exports: [],
    evidenceRefs: [],
    provenanceRefs: {
      envelopeIds: [],
      auditSummaryId:
        "audit-273-red" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
  };
}

// AWS access-key-id shape (AKIA + 16 uppercase/digits) — caught by the security-package redactor.
const PLANTED_AKIA = `AKIA${"C".repeat(16)}`;
// OpenAI-style secret-key shape (sk- + 20+ chars) — also caught by the security-package redactor.
const PLANTED_SK = `sk-${"D".repeat(24)}`;

describe("recordQualityIntelligenceRun — persist-time redaction of coverageMatrix (#273)", () => {
  it("redacts a planted secret out of coverageMatrix.requirementExcerptRedacted before persist", () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const input: QualityIntelligenceRecordInput = {
      ...baseInput("qi-run-cov-redact"),
      coverageMatrix: [
        {
          atomId: "atom-1",
          status: "uncovered",
          confidence: 0,
          coveringCandidateIds: [],
          requirementExcerptRedacted: `Use key ${PLANTED_AKIA} to call the payments API.`,
        },
      ],
    };

    const result = recordQualityIntelligenceRun(input, { store });
    // Read the manifest back from the store, not the in-memory result, to prove what was persisted.
    const persisted = store.load("qi-run-cov-redact");
    const row = persisted?.coverageMatrix?.[0];
    expect(row?.atomId).toBe("atom-1");
    expect(row?.requirementExcerptRedacted).toContain("[REDACTED]");
    expect(row?.requirementExcerptRedacted).not.toContain(PLANTED_AKIA);
    expect(row?.requirementExcerptRedacted).not.toContain("AKIA");
    // The result manifest the caller gets back must already be redacted (it IS the persisted one).
    expect(result.manifest.coverageMatrix?.[0]?.requirementExcerptRedacted).not.toContain("AKIA");
    // Non-secret structural fields survive untouched.
    expect(row?.status).toBe("uncovered");
  });
});

describe("recordQualityIntelligenceRun — persist-time redaction of modelParameters (#273)", () => {
  it("redacts a planted secret out of a modelParameters value before persist", () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const input: QualityIntelligenceRecordInput = {
      ...baseInput("qi-run-mp-redact"),
      modelParameters: {
        responseFormat: "json_schema",
        seed: 42,
        note: `provider key ${PLANTED_SK} embedded`,
      },
    };

    recordQualityIntelligenceRun(input, { store });
    const persisted = store.load("qi-run-mp-redact");
    const note = persisted?.modelParameters?.note;
    expect(typeof note).toBe("string");
    expect(note as string).toContain("[REDACTED]");
    expect(note as string).not.toContain(PLANTED_SK);
    expect(note as string).not.toContain("sk-");
    // Non-string scalars in modelParameters are preserved (deep redaction skips numbers).
    expect(persisted?.modelParameters?.responseFormat).toBe("json_schema");
    expect(persisted?.modelParameters?.seed).toBe(42);
  });
});

describe("recordQualityIntelligenceRun — clean data round-trips unchanged (backward-compat)", () => {
  it("leaves a clean coverageMatrix byte-identical and keeps the integrity hash stable", () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const cleanMatrix = [
      {
        atomId: "atom-1",
        status: "covered" as const,
        confidence: 0.9,
        coveringCandidateIds: ["tc-1"],
        requirementExcerptRedacted: "Lock the account after five failed logins.",
      },
      {
        atomId: "atom-2",
        status: "uncovered" as const,
        confidence: 0,
        coveringCandidateIds: [],
      },
    ];
    const input: QualityIntelligenceRecordInput = {
      ...baseInput("qi-run-cov-clean"),
      coverageMatrix: cleanMatrix,
      modelParameters: { responseFormat: "json_schema", seed: 7 },
    };

    const result = recordQualityIntelligenceRun(input, { store });

    // Redaction is a no-op on clean data: the persisted matrix equals the supplied one byte-for-byte.
    expect(result.manifest.coverageMatrix).toEqual(cleanMatrix);
    expect(JSON.stringify(result.manifest.coverageMatrix)).toBe(JSON.stringify(cleanMatrix));
    expect(result.manifest.modelParameters).toEqual({ responseFormat: "json_schema", seed: 7 });

    // The coverageMatrix integrity hash equals the hash of the unmodified clean matrix — i.e. the
    // redactor did not perturb the bytes the hash is computed over, so the round-trip is stable.
    expect(result.manifest.integrityHashes.coverageMatrix).toBeDefined();
    const loaded = store.load("qi-run-cov-clean");
    // A clean manifest loads back without an integrity error (assertOptionalHashMatches passes).
    expect(loaded?.coverageMatrix).toEqual(cleanMatrix);
    expect(loaded?.integrityHashes.coverageMatrix).toBe(
      result.manifest.integrityHashes.coverageMatrix,
    );
  });
});
