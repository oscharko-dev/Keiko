import { describe, expect, it, vi } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createCodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";

const digest = "b".repeat(64);
const at = "2026-07-13T10:00:00.000Z";
const settlement = {
  runId: "run-evidence",
  state: "succeeded" as const,
  revision: 1,
  settledAt: at,
  taskDigest: digest,
  workspaceDigest: digest,
  operatorDigest: digest,
  authorityDigest: digest,
  bindingDigest: digest,
  provenanceDigest: digest,
};
describe("CodingRuntimeEvidenceAggregator", () => {
  it("does not write on observe and writes one content-free manifest on settlement", () => {
    const backing = createInMemoryEvidenceStore();
    const put = vi.spyOn(backing, "put");
    const aggregator = createCodingRuntimeEvidenceAggregator(backing);
    aggregator.observe("run-evidence", {
      kind: "tool-call",
      state: "running",
      authorityDigest: digest,
    });
    expect(put).not.toHaveBeenCalled();
    aggregator.settle(settlement);
    aggregator.settle(settlement);
    expect(put).toHaveBeenCalledTimes(1);
    const json = backing.get("run-evidence") ?? "";
    expect(json).not.toContain("taskIntent");
    expect(json).not.toContain("argv");
    expect(json).not.toContain("output");
  });
  it("deletes exactly store-pruned ids without listing the evidence directory", () => {
    const backing = createInMemoryEvidenceStore();
    const list = vi.spyOn(backing, "list");
    const aggregator = createCodingRuntimeEvidenceAggregator(backing);
    aggregator.settle(settlement);
    aggregator.deletePruned(["run-evidence"]);
    expect(backing.get("run-evidence")).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });
});
