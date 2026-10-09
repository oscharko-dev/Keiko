import { afterEach, describe, expect, it } from "vitest";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { normalizeGroundedAnswerAssessment } from "./grounded-answer-assessment.js";

afterEach(resetServerLogger);

describe("shared grounded assessment normalization", () => {
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
        },
        policy,
        "assessment-normalization",
      );
      expect(answer.content).toContain("Fact [src/a.ts:1].");
      expect(answer.content.includes("General recommendation.")).toBe(policy === "allowed");
      expect(answer.completedSynthesisCallCount).toBe(1);
      expect(
        sink.events.find((event) => event.op === "search.answer.assessed")?.extra,
      ).toMatchObject({ policy, outcome: policy === "allowed" ? "assessment" : "neutralized" });
      expect(sink.lines().join("\n")).not.toContain("General recommendation");
      expect(sink.lines().join("\n")).not.toContain("src/a.ts");
    },
  );
  it("uses an honest localized refusal after an assessment-only block is disabled", () => {
    expect(
      normalizeGroundedAnswerAssessment(
        { content: "<assessment>General recommendation.</assessment>" },
        "disabled",
        undefined,
        "Bitte erkläre das.",
      ).content,
    ).toBe("Keine passenden Belege für diese Suche gefunden.");
  });
});
