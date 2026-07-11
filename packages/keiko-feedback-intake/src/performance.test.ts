import { prepareFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";
import { describe, expect, it } from "vitest";
import { createInMemoryFeedbackIntake } from "./intake.js";

describe("maximum admitted size deterministic budget", () => {
  it("admits a near-limit report in one bounded payload without input amplification", async () => {
    const prepared = prepareFeedbackReportV1({
      schemaVersion: "1",
      category: "defect",
      title: "Bounded report",
      description: "a".repeat(3_800),
      reproductionSteps: "Open Settings.",
      expectedBehavior: "Submission remains bounded.",
      actualBehavior: "The maximum-size path is exercised.",
      productVersion: "0.2.14",
      platform: "Linux",
      featureArea: "model-configuration",
      impact: "Degrades core workflow",
    });
    if (!prepared.ok) throw new Error("fixture exceeds the contract");
    const bytes = prepared.value.canonicalBody.copyBytes();
    const intake = createInMemoryFeedbackIntake();
    expect(
      (await intake.submit(bytes, prepared.value.exactBodySha256, new Uint8Array([127, 0, 0, 1])))
        .status,
    ).toBe(202);
    expect(intake.inspect()).toMatchObject({ payloadCount: 1, receiptCount: 1, dedupeCount: 1 });
    expect(bytes.byteLength).toBeLessThanOrEqual(262_144);
  });
});
