import { describe, expect, it } from "vitest";
import { observeChatContinuityStructure } from "../testing/coding-workbench-lab/chat-continuity-structure.mjs";

describe("production-path continuity measurements", () => {
  it("observes actual summary inputs and leaves canonical originals available", async () => {
    const report = await observeChatContinuityStructure();
    expect(report.summarySourceCoverage.availableMessages).toBe(40);
    expect(report.summarySourceCoverage.modelCalls).toBeGreaterThan(0);
    expect(report.summarySourceCoverage.witnessesDelivered).toBeGreaterThan(0);
    expect(report.summarySourceCoverage.witnessesDelivered).toBeLessThanOrEqual(40);
    expect(report.summarySourceCoverage.summaryStatus).toBe("valid");
    expect(report.summarySourceCoverage.declaredCoveredItems).not.toBeNull();
    expect(report.canonicalMessagesAfter).toBe(40);
    expect(report.shortIdentifierRecall.originalExists).toBe(true);
    expect(report.identifierRecallBenchmark).toMatchObject({
      version: "literal-identifier-v1",
      total: 8,
    });
    expect(report.identifierRecallBenchmark.score).toBeGreaterThanOrEqual(0);
    expect(report.identifierRecallBenchmark.score).toBeLessThanOrEqual(10);
    expect(report.identifierRecallBenchmark.cases.every((entry) => entry.originalsPreserved)).toBe(
      true,
    );
    expect(report.logOperations).toContain("chat.continuity.rehydration");
  });
  it("reports counts and closed states without retaining fixture bodies or ephemeral identifiers", async () => {
    const report = await observeChatContinuityStructure();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("ochre");
    for (const content of [
      "WitnessMarker",
      "8100",
      "Q7-42",
      "Synthetic discussion",
      "keiko-continuity-structure-",
    ])
      expect(serialized).not.toContain(content);
    expect(report.measurementKind).toBe(
      "deterministic-production-path-observation-not-model-quality",
    );
  });
  it("produces repeatable measurements without pinning the current information-loss behavior", async () => {
    const first = await observeChatContinuityStructure();
    const second = await observeChatContinuityStructure();
    expect(second).toEqual(first);
    expect(first.manualProjection.tokensBefore).toBeGreaterThan(0);
    expect(first.manualProjection.tokensAfter).toBeGreaterThan(0);
  });
});
