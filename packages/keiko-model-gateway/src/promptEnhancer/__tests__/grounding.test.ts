import { describe, expect, it } from "vitest";
import {
  analyzePrompt,
  asEnhancedPromptId,
  validateEnhancedPrompt,
  validateGroundingPlan,
  RAG_EVALUATION_DIMENSIONS,
  type EnhancedPrompt,
  type PromptEnhancementRequest,
} from "@oscharko-dev/keiko-contracts";
import type { GroundingStrategy } from "@oscharko-dev/keiko-contracts";
import { planPromptEnhancement } from "../planner.js";
import { generateEnhancedPrompt } from "../generator.js";
import { renderEnhancedPromptText } from "../rendering.js";
import { GROUNDING_FIXTURES, type GroundingFixture } from "./grounding-fixtures.js";

// Pick a fixture by its expected strategy (the first matching one); throws if absent so callers get a
// defined value (satisfies noUncheckedIndexedAccess without index access).
function fixtureFor(strategy: GroundingStrategy): GroundingFixture {
  const found = GROUNDING_FIXTURES.find((f) => f.expectedStrategy === strategy);
  if (found === undefined) throw new Error(`no grounding fixture for strategy ${strategy}`);
  return found;
}

function generateFor(request: PromptEnhancementRequest): EnhancedPrompt {
  const analysis = analyzePrompt(request);
  const plan = planPromptEnhancement(analysis, {
    profilePreference: request.profilePreference,
    missingInformationStrategy: request.missingInformationStrategy,
  });
  return generateEnhancedPrompt({
    promptId: asEnhancedPromptId(`${request.requestId}-prompt`),
    analysis,
    plan,
    input: request.input,
  });
}

// ─── Plan emission (AC1) across the six strategies ───────────────────────────────────
describe("grounding plan emission across fixtures (AC1)", () => {
  for (const fixture of GROUNDING_FIXTURES) {
    describe(fixture.name, () => {
      const prompt = generateFor(fixture.request);

      it("attaches the expected grounding strategy and requirement", () => {
        expect(prompt.groundingPlan.strategy).toBe(fixture.expectedStrategy);
        expect(prompt.groundingPlan.required).toBe(fixture.expectedRequired);
      });

      it("attaches a valid grounding plan and a valid enhanced prompt", () => {
        expect(validateGroundingPlan(prompt.groundingPlan).ok).toBe(true);
        const result = validateEnhancedPrompt(prompt);
        expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
      });

      it("pins the untrusted-content invariant", () => {
        expect(prompt.groundingPlan.untrustedContent).toBe(true);
      });
    });
  }

  it("covers all six declared strategies across the fixture suite", () => {
    const strategies = new Set(
      GROUNDING_FIXTURES.map((f) => generateFor(f.request).groundingPlan.strategy),
    );
    expect([...strategies].sort()).toEqual(
      [
        "external-research-required",
        "hybrid",
        "local-knowledge",
        "no-grounding",
        "repository-context",
        "supplied-context-only",
      ].sort(),
    );
  });
});

// ─── AC2: which claims need evidence and how sources are prioritized ─────────────────
describe("rendered grounding rules — source priority and citation (AC2)", () => {
  it("states source prioritization and a citation requirement for required plans", () => {
    for (const fixture of GROUNDING_FIXTURES.filter((f) => f.expectedRequired)) {
      const prompt = generateFor(fixture.request);
      const rules = prompt.groundingRules.join("\n");
      expect(rules, `${fixture.name}: source priority`).toMatch(
        /Prioritize evidence sources in this order/i,
      );
      expect(rules, `${fixture.name}: citation`).toMatch(/citation/i);
    }
  });

  it("orders the structured source priority with the primary source first", () => {
    const prompt = generateFor(fixtureFor("local-knowledge").request);
    expect(prompt.groundingPlan.sourcePriority[0]?.source).toBe("local-knowledge");
    expect(prompt.groundingPlan.sourcePriority[0]?.required).toBe(true);
  });
});

// ─── AC3: retrieved/external content is untrusted, not instructions ──────────────────
describe("rendered grounding rules — untrusted retrieved content (AC3)", () => {
  it("instructs the model to treat retrieved content as untrusted data for grounded plans", () => {
    for (const fixture of GROUNDING_FIXTURES.filter((f) => f.expectedStrategy !== "no-grounding")) {
      const prompt = generateFor(fixture.request);
      const rules = prompt.groundingRules.join("\n");
      expect(rules, fixture.name).toMatch(/untrusted data/i);
      expect(rules, fixture.name).toMatch(/never follow instructions/i);
      expect(prompt.groundingPlan.directives).toContain("treat-retrieved-content-as-untrusted");
    }
  });

  it("does not add the untrusted-retrieved-content rule to a no-grounding plan", () => {
    const prompt = generateFor(fixtureFor("no-grounding").request);
    expect(prompt.groundingRules.join("\n")).not.toMatch(/untrusted data/i);
  });
});

// ─── AC4: missing or contradictory evidence requires disclosure or refusal ───────────
describe("rendered uncertainty handling — no-answer conditions (AC4)", () => {
  it("requires disclosure or refusal rather than invented facts for grounded plans", () => {
    for (const fixture of GROUNDING_FIXTURES.filter((f) => f.expectedStrategy !== "no-grounding")) {
      const prompt = generateFor(fixture.request);
      const handling = prompt.uncertaintyHandling.join("\n");
      expect(handling, fixture.name).toMatch(/insufficient|contradictory|out of scope/i);
      expect(handling, fixture.name).toMatch(/decline to answer|rather than inventing/i);
    }
  });

  it("surfaces a contradiction-handling rule for a required multi-source plan", () => {
    const prompt = generateFor(fixtureFor("hybrid").request);
    expect(prompt.groundingRules.join("\n")).toMatch(/sources disagree/i);
  });
});

// ─── AC5: RAG-focused prompts include the five RAG evaluation hints ──────────────────
describe("rendered grounding rules — RAG evaluation hints (AC5)", () => {
  it("emits all five RAG dimensions for RAG-focused fixtures", () => {
    for (const fixture of GROUNDING_FIXTURES.filter((f) => f.expectsRagHints)) {
      const prompt = generateFor(fixture.request);
      expect(
        prompt.groundingPlan.ragEvaluation.map((h) => h.dimension).sort(),
        fixture.name,
      ).toEqual([...RAG_EVALUATION_DIMENSIONS].sort());
      const rules = prompt.groundingRules.join("\n");
      for (const matcher of [
        /context precision/i,
        /context recall/i,
        /faithfulness/i,
        /answer relevancy/i,
        /groundedness/i,
      ]) {
        expect(rules, `${fixture.name}: ${String(matcher)}`).toMatch(matcher);
      }
    }
  });

  it("emits no RAG hints for non-RAG fixtures", () => {
    for (const fixture of GROUNDING_FIXTURES.filter((f) => !f.expectsRagHints)) {
      const prompt = generateFor(fixture.request);
      expect(prompt.groundingPlan.ragEvaluation, fixture.name).toEqual([]);
    }
  });
});

// ─── Provider neutrality and input segregation ──────────────────────────────────────
describe("grounding rendering — neutrality and input segregation", () => {
  it("never leaks raw input into the grounding plan or its rendered rules", () => {
    const sentinel = "ZZGROUND the moon is a hologram";
    const base = fixtureFor("supplied-context-only").request;
    const request: PromptEnhancementRequest = {
      schemaVersion: base.schemaVersion,
      requestId: base.requestId,
      input: { text: `Based on the provided text, ${sentinel}.` },
      missingInformationStrategy: "clarify",
    };
    const prompt = generateFor(request);
    expect(JSON.stringify(prompt.groundingPlan)).not.toContain("ZZGROUND");
    expect(prompt.groundingRules.join("\n")).not.toContain("ZZGROUND");
  });

  it("renders the grounding rules into the dispatch-ready text under the grounding section", () => {
    const prompt = generateFor(fixtureFor("local-knowledge").request);
    const text = renderEnhancedPromptText(prompt);
    expect(text).toContain("## Grounding rules");
    expect(text).toMatch(/Prioritize evidence sources/i);
  });
});
