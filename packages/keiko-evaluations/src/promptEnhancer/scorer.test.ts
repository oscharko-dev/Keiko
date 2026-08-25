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

function withCriticScore(
  obs: EnhancementObservation,
  dimension: "clarity" | "completeness" | "token-efficiency",
  score: number,
): EnhancementObservation {
  return {
    ...obs,
    critic: {
      ...obs.critic,
      dimensionScores: obs.critic.dimensionScores.map((candidate) =>
        candidate.dimension === dimension ? { ...candidate, score } : candidate,
      ),
    },
  };
}

const GROUNDED = { expectedTaskClasses: ["rag-question-answering", "factual-qa"] } as const;

describe("scorePromptQuality regression gates (AC2)", () => {
  // Each test asserts the baseline observation PASSES the dimension, removes exactly ONE piece of the
  // mandated apparatus, and asserts the dimension flips to FAIL — proving the gate is regression-
  // sensitive. The first test also confirms the mutation helper actually applied the patch.

  it("clarity fails when the task structure is removed", () => {
    const obs = observe("task-research");
    const oracle: PromptEnhancerOracle = { expectedTaskClasses: ["research"] };
    expect(outcomeOf(obs, ["clarity"], oracle, "clarity")).toBe("pass");
    const stripped = withPrompt(obs, { taskDecomposition: [] });
    expect(stripped.prompt.taskDecomposition).toEqual([]);
    expect(outcomeOf(stripped, ["clarity"], oracle, "clarity")).toBe("fail");
  });

  it("completeness fails when the task structure is removed", () => {
    const obs = observe("task-research");
    const oracle: PromptEnhancerOracle = { expectedTaskClasses: ["research"] };
    expect(outcomeOf(obs, ["completeness"], oracle, "completeness")).toBe("pass");
    const stripped = withPrompt(obs, { taskDecomposition: [] });
    expect(outcomeOf(stripped, ["completeness"], oracle, "completeness")).toBe("fail");
  });

  it("completeness fails when the quality criteria are removed", () => {
    const obs = observe("task-research");
    const oracle: PromptEnhancerOracle = { expectedTaskClasses: ["research"] };
    expect(outcomeOf(obs, ["completeness"], oracle, "completeness")).toBe("pass");
    const stripped = withPrompt(obs, { qualityCriteria: [] });
    expect(outcomeOf(stripped, ["completeness"], oracle, "completeness")).toBe("fail");
  });

  it("groundedness fails when the grounding rules are removed", () => {
    const obs = observe("task-rag-qa");
    expect(outcomeOf(obs, ["groundedness"], GROUNDED, "groundedness")).toBe("pass");
    const stripped = withPrompt(obs, { groundingRules: [] });
    expect(outcomeOf(stripped, ["groundedness"], GROUNDED, "groundedness")).toBe("fail");
  });

  it("faithfulness fails when the grounding directives are removed", () => {
    const obs = observe("task-rag-qa");
    expect(outcomeOf(obs, ["faithfulness"], GROUNDED, "faithfulness")).toBe("pass");
    const stripped = withGroundingPlan(obs, { directives: [] });
    expect(outcomeOf(stripped, ["faithfulness"], GROUNDED, "faithfulness")).toBe("fail");
  });

  it("safety fails when the safety rules are removed (scorer structural gate)", () => {
    const obs = observe("task-code-generation");
    const oracle: PromptEnhancerOracle = { expectedTaskClasses: ["code-generation"] };
    expect(obs.prompt.safetyRules.length).toBeGreaterThanOrEqual(2);
    expect(outcomeOf(obs, ["safety"], oracle, "safety")).toBe("pass");
    const stripped = withPrompt(obs, { safetyRules: [] });
    expect(outcomeOf(stripped, ["safety"], oracle, "safety")).toBe("fail");
  });

  it("safety re-assessment rejects when the safety rules are removed (defence in depth)", () => {
    const fixture = promptEnhancerFixtureByName("task-code-generation");
    if (fixture === undefined) throw new Error("fixture missing");
    const obs = runEnhancement(fixture.name, fixture.request);
    expect(obs.safety.decision).not.toBe("rejected");
    const strippedPrompt: EnhancedPrompt = { ...obs.prompt, safetyRules: [] };
    const reassessed = PromptEnhancer.assessPromptSafety({
      prompt: strippedPrompt,
      analysis: obs.analysis,
      input: { text: fixture.request.text },
    });
    expect(reassessed.decision).toBe("rejected");
    expect(reassessed.verificationStatus).toBe("failed");
  });

  it("format-adherence fails when the output schema loses its structured flag", () => {
    const obs = observe("task-structured-extraction");
    const oracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["structured-extraction"],
      expectedOutputStructured: true,
      expectedOutputFormat: "json",
    };
    expect(outcomeOf(obs, ["format-adherence"], oracle, "format-adherence")).toBe("pass");
    const stripped = withPrompt(obs, {
      outputSchema: { ...obs.prompt.outputSchema, structured: false },
    });
    expect(outcomeOf(stripped, ["format-adherence"], oracle, "format-adherence")).toBe("fail");
  });

  // KEIKO-0676: the task-data-analysis fixture's oracle previously left expectedOutputStructured/
  // expectedOutputFormat undefined, so scoreFormatAdherence's first two checks passed vacuously
  // regardless of the analyzer's actual output. Now that the fixture pins the pipeline's observed
  // values, the same mutation that flips task-structured-extraction's outcome above must also flip
  // this fixture's outcome, proving the checks are load-bearing here too.
  it("format-adherence is load-bearing for task-data-analysis (KEIKO-0676)", () => {
    const fixture = promptEnhancerFixtureByName("task-data-analysis");
    if (fixture === undefined) {
      throw new Error("unknown fixture: task-data-analysis");
    }
    const obs = observe("task-data-analysis");
    expect(outcomeOf(obs, ["format-adherence"], fixture.oracle, "format-adherence")).toBe("pass");
    const stripped = withPrompt(obs, {
      outputSchema: { ...obs.prompt.outputSchema, structured: false },
    });
    expect(outcomeOf(stripped, ["format-adherence"], fixture.oracle, "format-adherence")).toBe(
      "fail",
    );
  });

  it("format-adherence fails when a structured schema loses its format hints", () => {
    const obs = observe("task-structured-extraction");
    const oracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["structured-extraction"],
      expectedOutputStructured: true,
    };
    expect(outcomeOf(obs, ["format-adherence"], oracle, "format-adherence")).toBe("pass");
    const stripped = withPrompt(obs, {
      outputSchema: { ...obs.prompt.outputSchema, hints: [] },
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

  it.each(["clarity", "completeness", "token-efficiency"] as const)(
    "%s fails closed for a non-finite critic score or floor",
    (dimension) => {
      const obs = observe("task-research");
      const floorKey = {
        clarity: "minClarityScore",
        completeness: "minCompletenessScore",
        "token-efficiency": "minTokenEfficiencyScore",
      }[dimension];
      const invalidFloor = {
        expectedTaskClasses: ["research"],
        [floorKey]: Number.POSITIVE_INFINITY,
      } as PromptEnhancerOracle;
      expect(outcomeOf(obs, [dimension], invalidFloor, dimension)).toBe("fail");
      expect(
        outcomeOf(
          withCriticScore(obs, dimension, Number.POSITIVE_INFINITY),
          [dimension],
          { expectedTaskClasses: ["research"] },
          dimension,
        ),
      ).toBe("fail");
    },
  );

  it("token-efficiency fails closed for a non-finite estimate or ceiling", () => {
    const obs = observe("task-research");
    expect(
      outcomeOf(
        { ...obs, estimatedTokens: Number.NaN },
        ["token-efficiency"],
        { expectedTaskClasses: ["research"] },
        "token-efficiency",
      ),
    ).toBe("fail");
    expect(
      outcomeOf(
        obs,
        ["token-efficiency"],
        { expectedTaskClasses: ["research"], maxEstimatedTokens: Number.POSITIVE_INFINITY },
        "token-efficiency",
      ),
    ).toBe("fail");
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

// ─── KEIKO-0266: per-check regression pins for the six unguarded dimension checks ────
//
// Each of the six checks below is a distinct literal inside a gate([...]) call in scorer.ts. The
// existing AC2 pins prove a whole "structural apparatus was removed" flip (task decomposition
// stripped, safety rules stripped, etc.) but none of them isolates a single Check literal — a
// mutation that commented out just one of these six checks would leave every existing test green.
//
// Each new test constructs a baseline pass, mutates exactly the field the paired Check reads, and
// asserts the dimension flips to fail. The mutation must be minimal so no sibling check inside the
// same gate() array flips: that is what makes each test pin one Check independently.

describe("KEIKO-0266 dimension-check regression pins", () => {
  const GROUNDED_ORACLE: PromptEnhancerOracle = {
    expectedTaskClasses: ["rag-question-answering", "factual-qa"],
  };

  it("groundedness fails when the grounded plan's sourcePriority is emptied", () => {
    const obs = observe("task-rag-qa");
    expect(outcomeOf(obs, ["groundedness"], GROUNDED_ORACLE, "groundedness")).toBe("pass");
    const stripped = withGroundingPlan(obs, { sourcePriority: [] });
    expect(outcomeOf(stripped, ["groundedness"], GROUNDED_ORACLE, "groundedness")).toBe("fail");
  });

  it("groundedness fails when the citation discipline drops to 'not-required'", () => {
    const obs = observe("task-rag-qa");
    expect(outcomeOf(obs, ["groundedness"], GROUNDED_ORACLE, "groundedness")).toBe("pass");
    const stripped = withGroundingPlan(obs, {
      citation: { ...obs.prompt.groundingPlan.citation, discipline: "not-required" },
    });
    expect(outcomeOf(stripped, ["groundedness"], GROUNDED_ORACLE, "groundedness")).toBe("fail");
  });

  it("groundedness fails when the treat-retrieved-content-as-untrusted directive is dropped", () => {
    const obs = observe("task-rag-qa");
    expect(outcomeOf(obs, ["groundedness"], GROUNDED_ORACLE, "groundedness")).toBe("pass");
    const stripped = withGroundingPlan(obs, {
      directives: obs.prompt.groundingPlan.directives.filter(
        (d) => d !== "treat-retrieved-content-as-untrusted",
      ),
    });
    expect(outcomeOf(stripped, ["groundedness"], GROUNDED_ORACLE, "groundedness")).toBe("fail");
  });

  it("safety fails when leastPrivilege shrinks below the baseline (one denial removed)", () => {
    const obs = observe("task-code-generation");
    const oracle: PromptEnhancerOracle = { expectedTaskClasses: ["code-generation"] };
    expect(outcomeOf(obs, ["safety"], oracle, "safety")).toBe("pass");
    const stripped: EnhancementObservation = {
      ...obs,
      safety: {
        ...obs.safety,
        // Drop exactly one baseline denial so only the leastPrivilege sibling flips.
        leastPrivilege: obs.safety.leastPrivilege.slice(1),
      },
    };
    expect(outcomeOf(stripped, ["safety"], oracle, "safety")).toBe("fail");
  });

  it("format-adherence fails when a structured schema loses its 'Output controllability' criterion", () => {
    const obs = observe("task-structured-extraction");
    const oracle: PromptEnhancerOracle = {
      expectedTaskClasses: ["structured-extraction"],
      expectedOutputStructured: true,
    };
    expect(outcomeOf(obs, ["format-adherence"], oracle, "format-adherence")).toBe("pass");
    // Drop only quality criteria starting with 'Output controllability' — every other sibling stays
    // satisfied so this test independently pins the criterion check.
    const stripped = withPrompt(obs, {
      qualityCriteria: obs.prompt.qualityCriteria.filter(
        (c) => !c.startsWith("Output controllability"),
      ),
    });
    expect(outcomeOf(stripped, ["format-adherence"], oracle, "format-adherence")).toBe("fail");
    // KEIKO-0770 (partial): the inline `.startsWith("Output controllability")` literal moved to a
    // named constant (OUTPUT_CONTROLLABILITY_CRITERION_PREFIX in scorer.ts) so keiko-evaluations has
    // one place to update, but this is behaviourally a no-op refactor -- it does not decouple the
    // check from keiko-model-gateway's own independent copies of the same literal (generator.ts's
    // buildQualityCriteria and critic.ts's scoreOutputControllability), which this
    // keiko-evaluations-only change cannot reach. No new pass/fail assertion is added here: a test
    // that cannot distinguish the refactor from its absence would prove nothing (AGENTS.md §7). This
    // existing pin (drop-the-criterion -> fail) is what continues to prove the check still functions.
  });

  it("task-success fails when the role is blanked", () => {
    const obs = observe("task-factual-qa");
    const oracle: PromptEnhancerOracle = { expectedTaskClasses: ["factual-qa"] };
    expect(outcomeOf(obs, ["task-success"], oracle, "task-success")).toBe("pass");
    const stripped = withPrompt(obs, { role: "   " });
    expect(outcomeOf(stripped, ["task-success"], oracle, "task-success")).toBe("fail");
  });

  it("task-success fails when the goal is blanked", () => {
    const obs = observe("task-factual-qa");
    const oracle: PromptEnhancerOracle = { expectedTaskClasses: ["factual-qa"] };
    expect(outcomeOf(obs, ["task-success"], oracle, "task-success")).toBe("pass");
    const stripped = withPrompt(obs, { goal: "   " });
    expect(outcomeOf(stripped, ["task-success"], oracle, "task-success")).toBe("fail");
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
