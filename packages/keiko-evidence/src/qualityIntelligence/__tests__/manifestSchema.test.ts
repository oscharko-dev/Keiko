// Schema-version + closed-key + status-enum gates on the QI evidence manifest.
//
// JSON round-trip: a manifest serialised to JSON and parsed back validates equivalently. The
// "rejects unknown fields" check enforces the closed top-level key set.

import { describe, expect, it } from "vitest";
import {
  QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION,
  type QualityIntelligenceEvidenceManifest,
  validateQualityIntelligenceEvidenceManifest,
} from "../manifestSchema.js";

function buildValidManifest(): QualityIntelligenceEvidenceManifest {
  return {
    qiEvidenceSchemaVersion: QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION,
    runId: "qi-run-001" as QualityIntelligenceEvidenceManifest["runId"],
    planAt: "2026-06-05T10:00:00.000Z",
    completedAt: "2026-06-05T10:05:00.000Z",
    status: "succeeded",
    policyProfileIds: ["qi:short-30d"],
    retentionPolicyId: "qi:short-30d",
    modelGatewayCallCount: 3,
    totals: { candidates: 2, findings: 1, exports: 0 },
    findings: [
      {
        id: "f-1",
        kind: "logic-defect",
        severity: "medium",
        summaryRedacted: "summary",
      },
    ],
    exports: [],
    evidenceRefs: [{ envelopeId: "env-1", atomId: "atom-1", lifecycleStatus: "finalised" }],
    provenanceRefs: {
      envelopeIds: ["env-1"],
      auditSummaryId:
        "audit-1" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
    redactionSummary: {
      totalStringsScanned: 0,
      stringsRedacted: 0,
      patternsMatched: {},
    },
    integrityHashes: {
      findings: "0".repeat(64),
      exports: "0".repeat(64),
      evidenceRefs: "0".repeat(64),
    },
  };
}

describe("validateQualityIntelligenceEvidenceManifest", () => {
  it("pins the schema-version literal to 1", () => {
    expect(QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION).toBe(1);
  });

  it("accepts a valid manifest", () => {
    const result = validateQualityIntelligenceEvidenceManifest(buildValidManifest());
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("round-trips through JSON without losing validity", () => {
    const original = buildValidManifest();
    const roundTripped: unknown = JSON.parse(JSON.stringify(original));
    expect(validateQualityIntelligenceEvidenceManifest(roundTripped).ok).toBe(true);
  });

  it("rejects a wrong schema-version literal (0)", () => {
    const bad = { ...buildValidManifest(), qiEvidenceSchemaVersion: 0 };
    const result = validateQualityIntelligenceEvidenceManifest(bad);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/qiEvidenceSchemaVersion/);
  });

  it("rejects an unknown top-level key", () => {
    const bad = { ...buildValidManifest(), unknownExtra: true };
    const result = validateQualityIntelligenceEvidenceManifest(bad);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unknownExtra");
  });

  it("rejects an invalid status enum", () => {
    const bad = { ...buildValidManifest(), status: "exploded" };
    const result = validateQualityIntelligenceEvidenceManifest(bad);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("status");
  });

  it.each([null, undefined, 42, "string", []])("rejects non-object input: %p", (value) => {
    expect(validateQualityIntelligenceEvidenceManifest(value).ok).toBe(false);
  });
});
