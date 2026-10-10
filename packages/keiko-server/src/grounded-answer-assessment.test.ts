import { afterEach, describe, expect, it } from "vitest";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import {
  isGroundedAssessmentOnly,
  normalizeGroundedAnswerAssessment,
} from "./grounded-answer-assessment.js";
import { assessmentAwareUncertainty } from "./grounded-faithfulness.js";

afterEach(resetServerLogger);

describe("shared grounded assessment normalization", () => {
  it("keeps safety warnings while limiting selection warnings to actual source answers", () => {
    const markers = [
      { kind: "no-evidence" },
      { kind: "low-confidence-selection" },
      { kind: "unsupported-citation" },
      { kind: "budget-exhausted" },
    ];
    expect(assessmentAwareUncertainty("<assessment>General view.</assessment>", markers)).toEqual([
      { kind: "unsupported-citation" },
      { kind: "budget-exhausted" },
    ]);
    expect(
      assessmentAwareUncertainty("Source fact. <assessment>General view.</assessment>", markers),
    ).toBe(markers);
    expect(assessmentAwareUncertainty("Missing evidence: [src/a.ts]", markers)).toBe(markers);
  });
  it.each([
    ["<assessment>General recommendation.</assessment>", true],
    ["Fact. <assessment>General recommendation.</assessment>", false],
    ["Missing evidence: [src/a.ts]\n<assessment>General view.</assessment>", false],
    ["`<assessment>General recommendation.</assessment>`", false],
    ["My own assessment: General recommendation.", false],
  ])("classifies canonical assessment-only authority: %s", (content, expected) => {
    expect(isGroundedAssessmentOnly(content)).toBe(expected);
  });
  it.each(["allowed", "disabled"] as const)(
    "projects %s authority and existing body-free evidence",
    (policy) => {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      const answer = normalizeGroundedAnswerAssessment(
        {
          content: "Fact [src/a.ts:1]. <assessment>General recommendation.</assessment>",
          modelInvoked: true,
          completedSynthesisCallCount: 1,
          usage: { promptTokens: 0, completionTokens: 0 },
        },
        policy,
        "assessment-normalization",
        "",
        { scopeIdentitySha256: "a".repeat(64), queryIdentitySha256: "b".repeat(64) },
      );
      expect(answer.content).toContain("Fact [src/a.ts:1].");
      expect(answer.content.includes("General recommendation.")).toBe(policy === "allowed");
      expect(answer.completedSynthesisCallCount).toBe(1);
      expect(
        sink.events.find((event) => event.op === "search.answer.assessed")?.extra,
      ).toMatchObject({
        policy,
        outcome: policy === "allowed" ? "assessment" : "neutralized",
        scopeIdentitySha256: "a".repeat(64),
        queryIdentitySha256: "b".repeat(64),
      });
      expect(sink.lines().join("\n")).not.toContain("General recommendation");
      expect(sink.lines().join("\n")).not.toContain("src/a.ts");
    },
  );
  it("uses an honest localized refusal after an assessment-only block is disabled", () => {
    expect(
      normalizeGroundedAnswerAssessment(
        {
          content: "<assessment>General recommendation.</assessment>",
          usage: { promptTokens: 0, completionTokens: 0 },
        },
        "disabled",
        undefined,
        "Bitte erkläre das.",
      ).content,
    ).toBe("Keine passenden Belege für diese Suche gefunden.");
  });
});

describe("untagged conversation authority preserves source and policy boundaries", () => {
  it.each([
    ["The selected source has value 37.", "allowed", false],
    ["The selected source has value 37.", "allowed", true],
    ["I cannot access the selected files.", "allowed", true],
    ["I will compare the options.", "disabled", true],
  ] as const)(
    "does not label %s under %s / conversation=%s",
    (content, policy, conversationOnly) => {
      const answer = normalizeGroundedAnswerAssessment(
        { content, usage: { promptTokens: 0, completionTokens: 0 } },
        policy,
        undefined,
        "",
        undefined,
        conversationOnly,
      );
      expect(isGroundedAssessmentOnly(answer.content)).toBe(false);
      expect(answer.content).toBe(content);
    },
  );
});
