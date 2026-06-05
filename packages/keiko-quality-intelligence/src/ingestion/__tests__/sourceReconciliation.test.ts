// Tests for sourceReconciliation (Epic #270, Issue #278).

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import { reconcileSourceGroups } from "../sourceReconciliation.js";

const ZERO_HASH = "0".repeat(64);

const env = (
  id: string,
  kind: QualityIntelligence.QualityIntelligenceSourceKind,
): QualityIntelligence.QualityIntelligenceSourceEnvelope => {
  const common = {
    id: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(id),
    displayLabel: `label:${id}`,
    provenance: {
      origin: "test",
      registeredAt: "2026-06-05T00:00:00Z",
      integrityHashSha256Hex: ZERO_HASH,
    },
    localRef: id,
  } as const;
  if (kind === "connector-document") {
    return { ...common, kind, adapterId: "test-adapter" };
  }
  return { ...common, kind };
};

describe("reconcileSourceGroups", () => {
  it("merges distinct envelopes from multiple groups in encounter order", () => {
    const groupA = { groupLabel: "A", envelopes: [env("a", "repository-context")] };
    const groupB = { groupLabel: "B", envelopes: [env("b", "human-context")] };
    const result = reconcileSourceGroups([groupA, groupB]);
    expect(result.envelopes.map((e) => e.id)).toEqual([
      QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("a"),
      QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("b"),
    ]);
    expect(result.duplicatedAcrossGroups).toEqual([]);
    expect(result.conflictingEnvelopeIds).toEqual([]);
  });

  it("preserves provenance with contributing group labels for duplicates", () => {
    const a1 = env("a", "repository-context");
    const a2 = env("a", "repository-context");
    const result = reconcileSourceGroups([
      { groupLabel: "first", envelopes: [a1] },
      { groupLabel: "second", envelopes: [a2] },
    ]);
    expect(result.envelopes).toHaveLength(1);
    expect(result.duplicatedAcrossGroups).toEqual([a1.id]);
    const prov = result.provenance[0];
    expect(prov?.envelopeId).toBe(a1.id);
    expect(prov?.firstGroupLabel).toBe("first");
    expect(prov?.contributingGroupLabels).toEqual(["first", "second"]);
  });

  it("treats same id with different kind as conflict and excludes both", () => {
    const repo = env("x", "repository-context");
    const human = env("x", "human-context");
    const result = reconcileSourceGroups([
      { groupLabel: "A", envelopes: [repo] },
      { groupLabel: "B", envelopes: [human] },
    ]);
    expect(result.envelopes).toEqual([]);
    expect(result.conflictingEnvelopeIds).toEqual([repo.id]);
    expect(result.duplicatedAcrossGroups).toEqual([]);
  });

  it("returns empty result for empty groups", () => {
    const result = reconcileSourceGroups([]);
    expect(result.envelopes).toEqual([]);
    expect(result.provenance).toEqual([]);
  });
});
