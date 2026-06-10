// Tests for sourceMixPlanning (Epic #270, Issue #278).

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import { planSourceMix, SOURCE_KIND_PRIORITY } from "../sourceMixPlanning.js";

const ZERO_HASH = "0".repeat(64);

const env = (
  id: string,
  kind: QualityIntelligence.QualityIntelligenceSourceKind,
  displayLabel = "label",
): QualityIntelligence.QualityIntelligenceSourceEnvelope => {
  const common = {
    id: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(id),
    displayLabel,
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

describe("planSourceMix", () => {
  it("dedupes envelopes sharing the same kind+id", () => {
    const a = env("a", "repository-context");
    const dup = env("a", "repository-context");
    const plan = planSourceMix([a, dup]);
    expect(plan.entries).toHaveLength(1);
    expect(plan.droppedForDuplicate).toEqual([dup.id]);
  });

  it("orders entries by kind priority then stable secondary key", () => {
    const repo = env("z-repo", "repository-context");
    const capsule = env("a-capsule", "local-knowledge-capsule");
    const human = env("a-human", "human-context");
    const plan = planSourceMix([human, capsule, repo]);
    expect(plan.entries.map((e) => e.envelopeId)).toEqual([repo.id, capsule.id, human.id]);
    expect(plan.entries[0]?.priority).toBe(SOURCE_KIND_PRIORITY["repository-context"]);
    expect(plan.entries[1]?.priority).toBe(SOURCE_KIND_PRIORITY["local-knowledge-capsule"]);
    expect(plan.entries[2]?.priority).toBe(SOURCE_KIND_PRIORITY["human-context"]);
  });

  it("flags oversize labels without dropping them", () => {
    const longLabel = "x".repeat(300);
    const oversize = env("a", "repository-context", longLabel);
    const plan = planSourceMix([oversize], { maxLabelBytes: 256 });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.oversize).toBe(true);
    expect(plan.oversizeCount).toBe(1);
  });

  it("drops envelopes past the maxEnvelopes cap into droppedForCap", () => {
    const items = Array.from({ length: 5 }, (_, i) => env(`id-${String(i)}`, "repository-context"));
    const plan = planSourceMix(items, { maxEnvelopes: 2 });
    expect(plan.entries).toHaveLength(2);
    expect(plan.droppedForCap).toHaveLength(3);
  });

  it("returns an empty plan for empty input", () => {
    const plan = planSourceMix([]);
    expect(plan.entries).toEqual([]);
    expect(plan.droppedForDuplicate).toEqual([]);
    expect(plan.droppedForCap).toEqual([]);
    expect(plan.oversizeCount).toBe(0);
  });
});
