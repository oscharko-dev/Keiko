import { describe, expect, it } from "vitest";
import {
  GROUNDING_NEED_KINDS,
  PROMPT_ENHANCEMENT_PROFILE_IDS,
  validateEnhancedPrompt,
  type ClarificationOrAssumption,
  type GroundingNeedKind,
  type RawPromptInput,
} from "@oscharko-dev/keiko-contracts";
import { planPromptEnhancement } from "../planner.js";
import { GENERATED_INPUT_MAX_CHARS, generateEnhancedPrompt } from "../generator.js";
import { makeAnalysis, testPromptId } from "./_support.js";
import type { EnhancedPrompt } from "@oscharko-dev/keiko-contracts";

const LIST_FIELDS = [
  "context",
  "taskDecomposition",
  "constraints",
  "groundingRules",
  "qualityCriteria",
  "uncertaintyHandling",
  "safetyRules",
] as const;

// All trusted (non-input) text concatenated — used to prove the raw user input never leaks out of the
// dedicated `input` section (AC3) and to scan for forbidden phrasing.
function trustedText(prompt: EnhancedPrompt): string {
  return [
    prompt.role,
    prompt.goal,
    ...prompt.context,
    ...prompt.taskDecomposition,
    ...prompt.constraints,
    ...prompt.groundingRules,
    ...prompt.qualityCriteria,
    ...prompt.uncertaintyHandling,
    ...prompt.safetyRules,
  ].join("\n");
}

function generateFor(
  options: Parameters<typeof makeAnalysis>[0],
  input: RawPromptInput = { text: "Do the thing." },
  planOptions?: Parameters<typeof planPromptEnhancement>[1],
): EnhancedPrompt {
  const analysis = makeAnalysis(options);
  const plan = planPromptEnhancement(analysis, planOptions);
  return generateEnhancedPrompt({ promptId: testPromptId(), analysis, plan, input });
}

describe("generateEnhancedPrompt — completeness (AC1)", () => {
  it("populates every required section and validates for every profile", () => {
    for (const id of PROMPT_ENHANCEMENT_PROFILE_IDS) {
      const prompt = generateFor({ recommendedProfile: id });
      expect(prompt.role.length).toBeGreaterThan(0);
      expect(prompt.goal.length).toBeGreaterThan(0);
      expect(prompt.input.length).toBeGreaterThan(0);
      expect(prompt.outputSchema).toBeDefined();
      for (const field of LIST_FIELDS) {
        expect(prompt[field].length, `${id}.${field}`).toBeGreaterThan(0);
      }
      const result = validateEnhancedPrompt(prompt);
      expect(result.ok, `${id} validation: ${result.ok ? "" : result.errors.join("; ")}`).toBe(
        true,
      );
    }
  });

  it("carries the schema version and output schema from the analysis", () => {
    const analysis = makeAnalysis({
      outputSchema: { format: "json", structured: true, hints: ["explicit-json"] },
    });
    const plan = planPromptEnhancement(analysis);
    const prompt = generateEnhancedPrompt({
      promptId: testPromptId(),
      analysis,
      plan,
      input: { text: "x" },
    });
    expect(prompt.schemaVersion).toBe(analysis.schemaVersion);
    expect(prompt.outputSchema).toBe(analysis.outputSchema);
  });

  it("is deterministic for identical inputs", () => {
    const a = generateFor({ recommendedProfile: "precise" });
    const b = generateFor({ recommendedProfile: "precise" });
    expect(a).toEqual(b);
  });
});

describe("generateEnhancedPrompt — no fabrication and segregated input (AC3)", () => {
  it("places the raw user input only in the input section", () => {
    const sentinel = "SENTINELZZZ the moon is made of green cheese";
    const prompt = generateFor({ recommendedProfile: "precise" }, { text: sentinel });
    expect(prompt.input).toContain("SENTINELZZZ");
    expect(trustedText(prompt)).not.toContain("SENTINELZZZ");
  });

  it("renders analyzer assumptions as clearly separated context entries", () => {
    const prompt = generateFor({
      recommendedProfile: "precise",
      missingContext: [
        { kind: "assumption", topic: "scope", statement: "Scope is limited to the EU market." },
      ],
    });
    expect(
      prompt.context.some((c) => c.startsWith("Assumption: Scope is limited to the EU market.")),
    ).toBe(true);
  });

  it("always instructs against fabricating facts", () => {
    const prompt = generateFor({ recommendedProfile: "fast" });
    expect(prompt.constraints.some((c) => /do not invent facts/i.test(c))).toBe(true);
  });

  it("notes connected context when the request supplied it", () => {
    const prompt = generateFor(
      { recommendedProfile: "precise" },
      {
        text: "x",
        hasConnectedContext: true,
      },
    );
    expect(prompt.context.some((c) => /connected workspace context/i.test(c))).toBe(true);
  });

  it("labels a high-stakes domain in the context", () => {
    const prompt = generateFor({
      recommendedProfile: "precise",
      domain: "medical",
      criticality: "elevated",
    });
    expect(prompt.context.some((c) => c.includes("Subject area: medical"))).toBe(true);
  });

  it("falls back to a placeholder when the input is empty", () => {
    const prompt = generateFor({ recommendedProfile: "fast" }, { text: "   " });
    expect(prompt.input).toBe("(no input provided)");
  });

  it("bounds and marks an over-long input so the artefact stays valid", () => {
    const prompt = generateFor({ recommendedProfile: "fast" }, { text: "a".repeat(40_000) });
    expect(prompt.input.length).toBeLessThanOrEqual(GENERATED_INPUT_MAX_CHARS);
    expect(prompt.input.endsWith("[input truncated]")).toBe(true);
    expect(validateEnhancedPrompt(prompt).ok).toBe(true);
  });
});

describe("generateEnhancedPrompt — authority and safety (AC4)", () => {
  it("never grants authority: every prompt states it is data, not an authorization", () => {
    for (const id of PROMPT_ENHANCEMENT_PROFILE_IDS) {
      const prompt = generateFor({ recommendedProfile: id });
      expect(
        prompt.safetyRules.some((r) => /grants no tool, file, network, or secret access/i.test(r)),
      ).toBe(true);
    }
  });

  it("requires explicit human approval for agentic prompts", () => {
    const prompt = generateFor({ recommendedProfile: "agentic" });
    expect(prompt.safetyRules.some((r) => /requires explicit human approval/i.test(r))).toBe(true);
    expect(prompt.constraints.some((c) => /without explicit approval/i.test(c))).toBe(true);
  });

  it("requires human approval when the analyzer flags tool-authority or egress requests", () => {
    const toolPrompt = generateFor({
      recommendedProfile: "technical",
      riskFlags: ["tool-authority-requested"],
    });
    expect(toolPrompt.safetyRules.some((r) => /requires explicit human approval/i.test(r))).toBe(
      true,
    );
  });

  it("adds a professional-advice disclaimer for safety-critical tasks", () => {
    const prompt = generateFor({ recommendedProfile: "safety-critical" });
    expect(prompt.constraints.some((c) => /do not present definitive/i.test(c))).toBe(true);
    expect(prompt.safetyRules.some((r) => /consulting a qualified professional/i.test(r))).toBe(
      true,
    );
    expect(prompt.qualityCriteria.some((q) => q.startsWith("Safety:"))).toBe(true);
  });
});

describe("generateEnhancedPrompt — grounding and uncertainty", () => {
  const cases: readonly (readonly [GroundingNeedKind, RegExp])[] = [
    ["none", /well-established general knowledge/i],
    ["supplied-context", /supplied context as the primary evidence/i],
    ["external-knowledge", /stable, well-established knowledge/i],
    ["external-current", /needs current external information/i],
  ];

  for (const [kind, matcher] of cases) {
    it(`emits the grounding rule for need kind '${kind}'`, () => {
      const prompt = generateFor({
        recommendedProfile: "precise",
        groundingNeed: { kind, volatile: false, signals: [] },
      });
      expect(prompt.groundingRules.some((r) => matcher.test(r))).toBe(true);
    });
  }

  it("flags volatile grounding needs as time-sensitive", () => {
    const prompt = generateFor({
      recommendedProfile: "precise",
      groundingNeed: { kind: "external-current", volatile: true, signals: [] },
    });
    expect(prompt.groundingRules.some((r) => /time-sensitive claims/i.test(r))).toBe(true);
  });

  it("adds source-attribution discipline for grounding-mandatory profiles", () => {
    const prompt = generateFor({ recommendedProfile: "research" });
    expect(
      prompt.groundingRules.some((r) => /attribute each material factual claim/i.test(r)),
    ).toBe(true);
  });

  it("surfaces clarification questions under the clarify strategy", () => {
    const prompt = generateFor(
      {
        recommendedProfile: "precise",
        missingContext: [
          { kind: "clarification", topic: "subject", question: "Which product line?" },
        ],
      },
      { text: "x" },
      { missingInformationStrategy: "clarify" },
    );
    expect(
      prompt.uncertaintyHandling.some((u) => u.includes("ask the user: Which product line?")),
    ).toBe(true);
  });

  it("instructs the model to proceed on assumptions under the assume strategy", () => {
    const prompt = generateFor(
      { recommendedProfile: "precise" },
      { text: "x" },
      {
        missingInformationStrategy: "assume",
      },
    );
    expect(
      prompt.uncertaintyHandling.some((u) => /Proceed using the stated assumptions/i.test(u)),
    ).toBe(true);
  });
});

describe("generateEnhancedPrompt — profile shaping (AC2)", () => {
  it("keeps the fast profile structurally lean", () => {
    const prompt = generateFor({ recommendedProfile: "fast" });
    expect(prompt.taskDecomposition.length).toBeLessThanOrEqual(2);
    expect(prompt.qualityCriteria.length).toBeLessThanOrEqual(2);
    expect(prompt.qualityCriteria.some((q) => /token efficiency/i.test(q))).toBe(true);
  });

  it("gives research a deeper task decomposition than fast", () => {
    const fast = generateFor({ recommendedProfile: "fast" });
    const research = generateFor({ recommendedProfile: "research" });
    expect(research.taskDecomposition.length).toBeGreaterThan(fast.taskDecomposition.length);
  });

  it("adds an output-controllability criterion for technical and structured outputs", () => {
    const technical = generateFor({ recommendedProfile: "technical" });
    expect(technical.qualityCriteria.some((q) => /output controllability/i.test(q))).toBe(true);
  });

  it("excludes profile-specific quality criteria from profiles that do not own them", () => {
    const creative = generateFor({ recommendedProfile: "creative" });
    expect(creative.qualityCriteria.some((q) => /token efficiency/i.test(q))).toBe(false);
    expect(creative.qualityCriteria.some((q) => /output controllability/i.test(q))).toBe(false);
    const research = generateFor({ recommendedProfile: "research" });
    expect(research.qualityCriteria.some((q) => q.startsWith("Grounding:"))).toBe(true);
  });

  it("surfaces each profile's distinctive constraint", () => {
    expect(
      generateFor({ recommendedProfile: "technical" }).constraints.some((c) =>
        /Follow the required output format exactly/i.test(c),
      ),
    ).toBe(true);
    expect(
      generateFor({ recommendedProfile: "creative" }).constraints.some((c) =>
        /Honor any tone, length, or style/i.test(c),
      ),
    ).toBe(true);
    expect(
      generateFor({ recommendedProfile: "safety-critical" }).constraints.some((c) =>
        /Do not present definitive/i.test(c),
      ),
    ).toBe(true);
  });
});

describe("generateEnhancedPrompt — cap and safety invariants", () => {
  it("never drops a critical constraint even when a profile is misconfigured below the critical count", () => {
    const analysis = makeAnalysis({ recommendedProfile: "fast" });
    const base = planPromptEnhancement(analysis);
    // A pathological profile whose cap is smaller than the two mandatory critical constraints.
    const plan = { ...base, executionProfile: { ...base.executionProfile, maxConstraints: 1 } };
    const prompt = generateEnhancedPrompt({
      promptId: testPromptId(),
      analysis,
      plan,
      input: { text: "x" },
    });
    expect(prompt.constraints.some((c) => /do not invent facts/i.test(c))).toBe(true);
    expect(prompt.constraints.some((c) => /Stay within the scope/i.test(c))).toBe(true);
    expect(prompt.constraints.length).toBeGreaterThanOrEqual(2);
  });

  it("caps clarification questions at the profile's maxClarifications", () => {
    const many: ClarificationOrAssumption[] = [
      { kind: "clarification", topic: "subject", question: "Q1?" },
      { kind: "clarification", topic: "scope", question: "Q2?" },
      { kind: "clarification", topic: "audience", question: "Q3?" },
      { kind: "clarification", topic: "constraints", question: "Q4?" },
      { kind: "clarification", topic: "data-source", question: "Q5?" },
    ];
    const prompt = generateFor(
      { recommendedProfile: "fast", missingContext: many },
      { text: "x" },
      { missingInformationStrategy: "clarify" },
    );
    const surfaced = prompt.uncertaintyHandling.filter((u) =>
      u.startsWith("Before finalizing, ask the user:"),
    );
    // The fast profile metadata caps clarifications at 1.
    expect(surfaced).toHaveLength(1);
  });

  it("renders all assumptions in context and keeps clarifications out of it", () => {
    const mixed: ClarificationOrAssumption[] = [
      { kind: "assumption", topic: "scope", statement: "Assume scope A." },
      { kind: "assumption", topic: "audience", statement: "Assume audience B." },
      { kind: "clarification", topic: "subject", question: "Which subject?" },
    ];
    const prompt = generateFor(
      { recommendedProfile: "precise", missingContext: mixed },
      { text: "x" },
      { missingInformationStrategy: "clarify" },
    );
    const assumptions = prompt.context.filter((c) => c.startsWith("Assumption: "));
    expect(assumptions).toHaveLength(2);
    expect(prompt.context.some((c) => c.includes("Which subject?"))).toBe(false);
  });

  it("flags volatile grounding as time-sensitive for every grounding-need kind", () => {
    for (const kind of GROUNDING_NEED_KINDS) {
      const prompt = generateFor({
        recommendedProfile: "precise",
        groundingNeed: { kind, volatile: true, signals: [] },
      });
      expect(
        prompt.groundingRules.some((r) => /time-sensitive claims/i.test(r)),
        `kind ${kind}`,
      ).toBe(true);
    }
  });
});
