// KEIKO-0173 regression pin: the scorer's structural thresholds must be derived from the producers.
//
// Two thresholds live in `scorer.ts` — the baseline least-privilege denial count and the grounded-task
// minimum grounding-rule count. Both are also owned by producers elsewhere in the monorepo
// (`BASELINE_LEAST_PRIVILEGE` in keiko-contracts; `GROUNDING_READINESS_MIN_RULES` in the model-gateway
// critic). Restating them as local literals here would be the exact #2643 anti-pattern the AGENTS.md
// fixture-parity rule forbids: the two sides would drift silently together in a scenario a hand-written
// literal cannot detect. This suite pins the invariants by observation: change either producer constant
// and the scorer's threshold moves in lockstep, or the test fails.

import { describe, expect, it } from "vitest";
import type {
  LeastPrivilegeConstraint,
  PromptSafetyAssessment,
} from "@oscharko-dev/keiko-contracts";
import { BASELINE_LEAST_PRIVILEGE } from "@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-safety";
import { PromptEnhancer } from "@oscharko-dev/keiko-model-gateway";
import {
  promptEnhancerFixtureByName,
  runEnhancement,
  scorePromptQuality,
  type EnhancementObservation,
  type PromptEnhancerEvalFixture,
} from "./index.js";

function observe(name: string): EnhancementObservation {
  const fixture = promptEnhancerFixtureByName(name);
  if (fixture === undefined) {
    throw new Error(`unknown fixture: ${name}`);
  }
  return runEnhancement(fixture.name, fixture.request);
}

function withLeastPrivilege(
  obs: EnhancementObservation,
  leastPrivilege: readonly LeastPrivilegeConstraint[],
): EnhancementObservation {
  const patchedSafety: PromptSafetyAssessment = { ...obs.safety, leastPrivilege };
  return { ...obs, safety: patchedSafety };
}

const SAFETY_FIXTURE: PromptEnhancerEvalFixture = {
  name: "scorer-constants-test",
  category: "task-class",
  description: "safety-gate structural threshold pin",
  request: { text: "safety-gate structural threshold pin" },
  dimensions: new Set(["safety"]),
  oracle: { expectedTaskClasses: ["code-generation"] },
};

const GROUNDED_FIXTURE: PromptEnhancerEvalFixture = {
  name: "scorer-constants-grounded-test",
  category: "task-class",
  description: "grounded-task rule-count threshold pin",
  request: { text: "grounded-task rule-count threshold pin" },
  dimensions: new Set(["groundedness"]),
  oracle: { expectedTaskClasses: ["rag-question-answering", "factual-qa"] },
};

describe("KEIKO-0173 producer-derived scorer thresholds", () => {
  it("exports BASELINE_LEAST_PRIVILEGE from keiko-contracts as a non-empty readonly set", () => {
    expect(Array.isArray(BASELINE_LEAST_PRIVILEGE)).toBe(true);
    expect(BASELINE_LEAST_PRIVILEGE.length).toBeGreaterThan(0);
    expect(new Set(BASELINE_LEAST_PRIVILEGE).size).toBe(BASELINE_LEAST_PRIVILEGE.length);
  });

  it("exports GROUNDING_READINESS_MIN_RULES from keiko-model-gateway's critic as a positive integer", () => {
    expect(Number.isInteger(PromptEnhancer.GROUNDING_READINESS_MIN_RULES)).toBe(true);
    expect(PromptEnhancer.GROUNDING_READINESS_MIN_RULES).toBeGreaterThan(0);
  });

  it("scorer safety gate flips at exactly BASELINE_LEAST_PRIVILEGE.length (producer-owned)", () => {
    const baselineObs = observe("task-code-generation");
    // Trim leastPrivilege to the baseline set (drop any conditional grants) so we drive the threshold
    // directly rather than depending on a fixture-specific superset.
    const baseline = withLeastPrivilege(baselineObs, [...BASELINE_LEAST_PRIVILEGE]);
    const passRes = scorePromptQuality(SAFETY_FIXTURE, baseline).find(
      (d) => d.dimension === "safety",
    );
    expect(passRes?.outcome).toBe("pass");

    // One less denial than the producer baseline must fail the scorer's structural gate.
    const shortLp = BASELINE_LEAST_PRIVILEGE.slice(0, BASELINE_LEAST_PRIVILEGE.length - 1);
    const short = withLeastPrivilege(baselineObs, shortLp);
    const failRes = scorePromptQuality(SAFETY_FIXTURE, short).find((d) => d.dimension === "safety");
    expect(failRes?.outcome).toBe("fail");
    expect(failRes?.rationale).toContain("baseline least-privilege denials present");
  });

  // KEIKO-0770 producer-derived output-controllability pin: three files (generator, critic, and
  // this scorer) all keyed off the same literal "Output controllability" prefix. The producer
  // now owns the single canonical constant; if the wording ever drifts, every consumer either
  // still matches (constant intact) or every consumer flips together — never one silently.
  it("exports OUTPUT_CONTROLLABILITY_CRITERION_PREFIX from keiko-model-gateway as a non-empty string", () => {
    expect(typeof PromptEnhancer.OUTPUT_CONTROLLABILITY_CRITERION_PREFIX).toBe("string");
    expect(PromptEnhancer.OUTPUT_CONTROLLABILITY_CRITERION_PREFIX.length).toBeGreaterThan(0);
    expect(
      PromptEnhancer.OUTPUT_CONTROLLABILITY_CRITERION.startsWith(
        PromptEnhancer.OUTPUT_CONTROLLABILITY_CRITERION_PREFIX,
      ),
    ).toBe(true);
  });

  it("generator writes a criterion whose prefix matches the producer constant (no drift)", () => {
    // A structured-extraction fixture forces the generator's buildQualityCriteria path that pushes
    // the output-controllability criterion. Observation: at least one written criterion must start
    // with the producer's canonical prefix — proves the writer and the checker share one source.
    const obs = observe("task-structured-extraction");
    const written = obs.prompt.qualityCriteria.some((criterion) =>
      criterion.startsWith(PromptEnhancer.OUTPUT_CONTROLLABILITY_CRITERION_PREFIX),
    );
    expect(written).toBe(true);
    // Symmetric: the OUTPUT_CONTROLLABILITY_CRITERION full text must itself pass the prefix check
    // so a wording change AFTER the colon still flows through both consumers unchanged.
    expect(
      PromptEnhancer.OUTPUT_CONTROLLABILITY_CRITERION.startsWith(
        PromptEnhancer.OUTPUT_CONTROLLABILITY_CRITERION_PREFIX,
      ),
    ).toBe(true);
  });

  it("scorer grounded-task gate flips at exactly GROUNDING_READINESS_MIN_RULES (producer-owned)", () => {
    const groundedObs = observe("task-rag-qa");
    expect(groundedObs.prompt.groundingPlan.required).toBe(true);
    expect(groundedObs.prompt.groundingRules.length).toBeGreaterThanOrEqual(
      PromptEnhancer.GROUNDING_READINESS_MIN_RULES,
    );
    // Passing baseline.
    const passRes = scorePromptQuality(GROUNDED_FIXTURE, groundedObs).find(
      (d) => d.dimension === "groundedness",
    );
    expect(passRes?.outcome).toBe("pass");

    // Trim grounding rules to one below the producer threshold — must fail the structural gate.
    const short = {
      ...groundedObs,
      prompt: {
        ...groundedObs.prompt,
        groundingRules: groundedObs.prompt.groundingRules.slice(
          0,
          PromptEnhancer.GROUNDING_READINESS_MIN_RULES - 1,
        ),
      },
    };
    const failRes = scorePromptQuality(GROUNDED_FIXTURE, short).find(
      (d) => d.dimension === "groundedness",
    );
    expect(failRes?.outcome).toBe("fail");
    expect(failRes?.rationale).toContain(
      `at least ${String(PromptEnhancer.GROUNDING_READINESS_MIN_RULES)} grounding rules`,
    );
  });
});
