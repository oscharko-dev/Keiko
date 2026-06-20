// Prompt Enhancer scorer + regression tests (Epic #1307, Issue #1315; AC1/AC2).
//
// AC2 is the load-bearing contract here: the suite must FAIL when prompt structure, grounding rules,
// safety rules, or output-schema requirements are accidentally removed. Each regression test takes a
// passing observation, removes exactly one piece of the mandated apparatus, and asserts the relevant
// dimension flips from pass to fail. The remaining tests cover every dimension's pass/fail/na paths and
// the suite aggregation so the scorer's branches are exercised.

import { describe, expect, it } from "vitest";
import { PromptEnhancer } from "@oscharko-dev/keiko-model-gateway";
import type { EnhancedPrompt } from "@oscharko-dev/keiko-contracts";
import {
  aggregatePromptQuality,
  promptEnhancerFixtureByName,
  runEnhancement,
  scorePromptQuality,
  type EnhancementObservation,
  type PromptEnhancerEvalFixture,
  type PromptEnhancerOracle,
  type PromptQualityDimension,
  type PromptQualityDimensionResult,
  type PromptQualityOutcome,
} from "./index.js";

function observe(name: string): EnhancementObservation {
  const fixture = promptEnhancerFixtureByName(name);
  if (fixture === undefined) {
    throw new Error(`unknown fixture: ${name}`);
  }
  return runEnhancement(fixture.name, fixture.request);
}

function evalFixture(
  dimensions: readonly PromptQualityDimension[],
  oracle: PromptEnhancerOracle,
): PromptEnhancerEvalFixture {
  return {
    name: "scorer-test",
    category: "task-class",
    description: "scorer unit fixture",
    request: { text: "scorer unit fixture" },
    dimensions: new Set(dimensions),
    oracle,
  };
}

function outcomeOf(
  obs: EnhancementObservation,
  dimensions: readonly PromptQualityDimension[],
  oracle: PromptEnhancerOracle,
  dimension: PromptQualityDimension,
): PromptQualityOutcome {
  const result = scorePromptQuality(evalFixture(dimensions, oracle), obs).find(
    (d) => d.dimension === dimension,
  );
  return result?.outcome ?? "not-applicable";
}

function withPrompt(
  obs: EnhancementObservation,
  patch: Partial<EnhancedPrompt>,
): EnhancementObservation {
  return { ...obs, prompt: { ...obs.prompt, ...patch } };
}

function withGroundingPlan(
  obs: EnhancementObservation,
  patch: Partial<EnhancedPrompt["groundingPlan"]>,
): EnhancementObservation {
  return {
    ...obs,
    prompt: { ...obs.prompt, groundingPlan: { ...obs.prompt.groundingPlan, ...patch } },
  };
}

const GROUNDED = { expectedTaskClasses: ["rag-question-answering", "factual-qa"] } as const;

describe("scorePromptQuality regression gates (AC2)", () => {
  it("clarity and completeness fail when the task structure is removed", () => {
    const obs = observe("task-research");
    const oracle: PromptEnhancerOracle = { expectedTaskClasses: ["research"] };
    expect(outcomeOf(obs, ["clarity", "completeness"], oracle, "clarity")).toBe("pass");
    const stripped = withPrompt(obs, { taskDecomposition: [] });
    expect(outcomeOf(stripped, ["clarity"], oracle, "clarity")).toBe("fail");
    expect(outcomeOf(stripped, ["completeness"], oracle, "completeness")).toBe("fail");
  });

  it("completeness fails when the quality criteria are removed", () => {
    const obs = observe("task-research");
    const oracle: PromptEnhancerOracle = { expectedTaskClasses: ["research"] };
    const stripped = withPrompt(obs, { qualityCriteria: [] });
    expect(outcomeOf(stripped, ["completeness"], oracle, "completeness")).toBe("fail");
  });

  it("groundedness and faithfulness fail when grounding rules and directives are removed", () => {
    const obs = observe("task-rag-qa");
    expect(outcomeOf(obs, ["groundedness"], GROUNDED, "groundedness")).toBe("pass");
    expect(outcomeOf(obs, ["faithfulness"], GROUNDED, "faithfulness")).toBe("pass");
    const stripped = withGroundingPlan(withPrompt(obs, { groundingRules: [] }), {
      directives: [],
      sourcePriority: [],
      noAnswerConditions: [],
    });
    expect(outcomeOf(stripped, ["groundedness"], GROUNDED, "groundedness")).toBe("fail");
    expect(outcomeOf(stripped, ["faithfulness"], GROUNDED, "faithfulness")).toBe("fail");
  });

  it("safety fails when the safety rules are removed (structural gate)", () => {
    const obs = observe("task-code-generation");
    const oracle: PromptEnhancerOracle = { expectedTaskClasses: ["code-generation"] };
    expect(outcomeOf(obs, ["safety"], oracle, "safety")).toBe("pass");
    const stripped = withPrompt(obs, { safetyRules: [] });
    expect(outcomeOf(stripped, ["safety"], oracle, "safety")).toBe("fail");
  });

  it("safety fails when the safety rules are removed (re-assessed decision flips to rejected)", () => {
    const fixture = promptEnhancerFixtureByName("task-code-generation");
    if (fixture === undefined) throw new Error("fixture missing");
    const obs = runEnhancement(fixture.name, fixture.request);
    const strippedPrompt: EnhancedPrompt = { ...obs.prompt, safetyRules: [] };
    const reassessed = PromptEnhancer.assessPromptSafety({
      prompt: strippedPrompt,
      analysis: obs.analysis,
      input: { text: fixture.request.text },
    });
    expect(reassessed.decision).toBe("rejected");
    expect(reassessed.verificationStatus).toBe("failed");
  });

  it("format-adherence fails when the structured output schema is removed", () => {
    const obs = observe("task-structured-extraction");
    const oracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["structured-extraction"],
      expectedOutputStructured: true,
      expectedOutputFormat: "json",
    };
    expect(outcomeOf(obs, ["format-adherence"], oracle, "format-adherence")).toBe("pass");
    const stripped = withPrompt(obs, {
      outputSchema: { ...obs.prompt.outputSchema, structured: false, hints: [] },
    });
    expect(outcomeOf(stripped, ["format-adherence"], oracle, "format-adherence")).toBe("fail");
  });
});

describe("scorePromptQuality dimension paths", () => {
  it("groundedness ungrounded branch fails when the base grounding rule is removed", () => {
    const obs = observe("grounding-not-required");
    const oracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["factual-qa"],
      expectedGroundingRequired: false,
    };
    expect(outcomeOf(obs, ["groundedness"], oracle, "groundedness")).toBe("pass");
    const stripped = withPrompt(obs, { groundingRules: [] });
    expect(outcomeOf(stripped, ["groundedness"], oracle, "groundedness")).toBe("fail");
  });

  it("groundedness fails when the required flag does not match the expectation", () => {
    const obs = observe("grounding-not-required");
    const oracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["factual-qa"],
      expectedGroundingRequired: true,
    };
    expect(outcomeOf(obs, ["groundedness"], oracle, "groundedness")).toBe("fail");
  });

  it("faithfulness ungrounded branch fails when uncertainty handling is removed", () => {
    const obs = observe("grounding-not-required");
    const oracle: PromptEnhancerOracle = { expectedTaskClasses: ["factual-qa"] };
    expect(outcomeOf(obs, ["faithfulness"], oracle, "faithfulness")).toBe("pass");
    const stripped = withPrompt(obs, { uncertaintyHandling: [] });
    expect(outcomeOf(stripped, ["faithfulness"], oracle, "faithfulness")).toBe("fail");
  });

  it("format-adherence passes for an unstructured prose answer and fails on a wrong format", () => {
    const obs = observe("format-prose");
    const passOracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["factual-qa"],
      expectedOutputStructured: false,
    };
    expect(outcomeOf(obs, ["format-adherence"], passOracle, "format-adherence")).toBe("pass");
    const failOracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["factual-qa"],
      expectedOutputFormat: "json",
    };
    expect(outcomeOf(obs, ["format-adherence"], failOracle, "format-adherence")).toBe("fail");
  });

  it("safety fails when injection signals are expected but the draft is benign", () => {
    const obs = observe("task-code-generation");
    const oracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["code-generation"],
      expectsInjectionSignals: true,
    };
    expect(outcomeOf(obs, ["safety"], oracle, "safety")).toBe("fail");
  });

  it("safety passes for an adversarial draft escalated to human review", () => {
    const obs = observe("adversarial-instruction-override");
    const oracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["factual-qa"],
      expectsInjectionSignals: true,
      expectedSafetyDecisions: ["requires-human-review"],
      expectedVerificationStatuses: ["passed-with-review"],
    };
    expect(outcomeOf(obs, ["safety"], oracle, "safety")).toBe("pass");
  });

  it("task-success fails on a task-class mismatch and on a profile mismatch", () => {
    const obs = observe("task-factual-qa");
    expect(
      outcomeOf(obs, ["task-success"], { expectedTaskClasses: ["research"] }, "task-success"),
    ).toBe("fail");
    expect(
      outcomeOf(
        obs,
        ["task-success"],
        { expectedTaskClasses: ["factual-qa"], expectedProfiles: ["fast"] },
        "task-success",
      ),
    ).toBe("fail");
  });

  it("token-efficiency fails when the estimate exceeds the ceiling or the critic floor", () => {
    const obs = observe("task-research");
    const ceilingOracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["research"],
      maxEstimatedTokens: 1,
    };
    expect(outcomeOf(obs, ["token-efficiency"], ceilingOracle, "token-efficiency")).toBe("fail");
    const floorOracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["research"],
      minTokenEfficiencyScore: 0.99,
    };
    expect(outcomeOf(obs, ["token-efficiency"], floorOracle, "token-efficiency")).toBe("fail");
  });

  it("completeness fails when the critic floor is set above the actual score", () => {
    const obs = observe("task-writing-editing");
    const oracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["writing-editing"],
      minCompletenessScore: 0.99,
    };
    expect(outcomeOf(obs, ["completeness"], oracle, "completeness")).toBe("fail");
  });

  it("a dimension a fixture does not declare scores not-applicable", () => {
    const obs = observe("task-factual-qa");
    const results = scorePromptQuality(
      evalFixture(["clarity"], { expectedTaskClasses: ["factual-qa"] }),
      obs,
    );
    const grounded = results.find((d) => d.dimension === "groundedness");
    expect(grounded?.outcome).toBe("not-applicable");
    expect(grounded?.rationale).toContain("not exercised");
  });
});

describe("aggregatePromptQuality", () => {
  it("counts pass/fail/not-applicable per dimension and a null rate when unscored", () => {
    const results: readonly (readonly PromptQualityDimensionResult[])[] = [
      [
        { dimension: "clarity", outcome: "pass", rationale: "" },
        { dimension: "safety", outcome: "fail", rationale: "" },
      ],
      [
        { dimension: "clarity", outcome: "pass", rationale: "" },
        { dimension: "safety", outcome: "not-applicable", rationale: "" },
      ],
    ];
    const entries = aggregatePromptQuality(results);
    const clarity = entries.find((e) => e.dimension === "clarity");
    const safety = entries.find((e) => e.dimension === "safety");
    const groundedness = entries.find((e) => e.dimension === "groundedness");
    expect(clarity).toMatchObject({ passCount: 2, failCount: 0, passRate: 1 });
    expect(safety).toMatchObject({
      passCount: 0,
      failCount: 1,
      notApplicableCount: 1,
      passRate: 0,
    });
    expect(groundedness?.passRate).toBeNull();
  });
});
