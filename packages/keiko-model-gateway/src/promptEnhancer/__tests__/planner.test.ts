import { describe, expect, it } from "vitest";
import { PROMPT_ENHANCEMENT_PROFILES } from "@oscharko-dev/keiko-contracts";
import { getPromptEnhancerExecutionProfile } from "../profiles.js";
import { planPromptEnhancement } from "../planner.js";
import { makeAnalysis } from "./_support.js";

describe("planPromptEnhancement", () => {
  it("uses the analyzer recommendation when there is no preference and no escalation", () => {
    const plan = planPromptEnhancement(makeAnalysis({ recommendedProfile: "technical" }));
    expect(plan.selectedProfile).toBe("technical");
    expect(plan.profileSource).toBe("recommended");
  });

  it("honors an explicit profile preference for a non-critical task", () => {
    const plan = planPromptEnhancement(makeAnalysis({ recommendedProfile: "fast" }), {
      profilePreference: "research",
    });
    expect(plan.selectedProfile).toBe("research");
    expect(plan.profileSource).toBe("preference-honored");
  });

  it("escalates a critical task to safety-critical, overriding any preference", () => {
    const plan = planPromptEnhancement(
      makeAnalysis({ criticality: "critical", recommendedProfile: "safety-critical" }),
      { profilePreference: "fast" },
    );
    expect(plan.selectedProfile).toBe("safety-critical");
    expect(plan.profileSource).toBe("criticality-escalated");
  });

  it("derives reasoning strategy, depth, and token budget from the execution profile", () => {
    const plan = planPromptEnhancement(makeAnalysis({ recommendedProfile: "research" }));
    const profile = getPromptEnhancerExecutionProfile("research");
    expect(plan.reasoningStrategy).toBe(profile.reasoningStrategy);
    expect(plan.reasoningDepth).toBe(profile.reasoningDepth);
    expect(plan.tokenBudget).toBe(profile.tokenBudget);
    expect(plan.executionProfile).toBe(profile);
  });

  it("sources grounding-mandatory and maxClarifications from the wire-contract profile metadata", () => {
    const research = planPromptEnhancement(makeAnalysis({ recommendedProfile: "research" }));
    expect(research.groundingMandatory).toBe(
      PROMPT_ENHANCEMENT_PROFILES.research.groundingMandatory,
    );
    expect(research.maxClarifications).toBe(PROMPT_ENHANCEMENT_PROFILES.research.maxClarifications);
    const fast = planPromptEnhancement(makeAnalysis({ recommendedProfile: "fast" }));
    expect(fast.groundingMandatory).toBe(false);
  });

  it("carries the analyzer output schema and grounding need through unchanged", () => {
    const analysis = makeAnalysis({
      outputSchema: { format: "json", structured: true, hints: ["explicit-json"] },
      groundingNeed: {
        kind: "external-current",
        volatile: true,
        signals: ["temporal-recency-term"],
      },
    });
    const plan = planPromptEnhancement(analysis);
    expect(plan.outputSchema).toBe(analysis.outputSchema);
    expect(plan.groundingNeed).toBe(analysis.groundingNeed);
  });

  it("defaults the missing-information strategy to clarify and honors an explicit value", () => {
    expect(planPromptEnhancement(makeAnalysis()).missingInformationStrategy).toBe("clarify");
    expect(
      planPromptEnhancement(makeAnalysis(), { missingInformationStrategy: "assume" })
        .missingInformationStrategy,
    ).toBe("assume");
  });

  it("always restricts authority and flags safety posture for agentic tasks (AC4)", () => {
    const plan = planPromptEnhancement(makeAnalysis({ recommendedProfile: "agentic" }));
    expect(plan.safetyPosture.restrictsAuthority).toBe(true);
    expect(plan.safetyPosture.requiresHumanApproval).toBe(true);
  });

  it("requires human approval when a tool-authority or egress risk flag is present (AC4)", () => {
    const toolPlan = planPromptEnhancement(
      makeAnalysis({ recommendedProfile: "technical", riskFlags: ["tool-authority-requested"] }),
    );
    expect(toolPlan.safetyPosture.requiresHumanApproval).toBe(true);
    const egressPlan = planPromptEnhancement(
      makeAnalysis({ recommendedProfile: "precise", riskFlags: ["egress-requested"] }),
    );
    expect(egressPlan.safetyPosture.requiresHumanApproval).toBe(true);
  });

  it("does not require human approval for an ordinary task", () => {
    const plan = planPromptEnhancement(makeAnalysis({ recommendedProfile: "precise" }));
    expect(plan.safetyPosture.requiresHumanApproval).toBe(false);
    expect(plan.safetyPosture.safetyCritical).toBe(false);
  });

  it("marks safety posture as safety-critical for a critical task", () => {
    const plan = planPromptEnhancement(makeAnalysis({ criticality: "critical" }));
    expect(plan.safetyPosture.safetyCritical).toBe(true);
  });

  it("preserves the request id", () => {
    const analysis = makeAnalysis({ requestId: "abc-123" });
    expect(planPromptEnhancement(analysis).requestId).toBe(analysis.requestId);
  });
});
