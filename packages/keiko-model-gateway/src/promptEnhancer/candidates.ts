// Prompt Enhancer candidate generation (Epic #1307, Issue #1312; ADR-0044 §1/§5/§6).
//
// Produces a bounded, ordered set of distinct, safety-preserving Enhanced Prompt candidates for one
// analysis by varying the generation profile across a deterministic slate. Each profile yields a
// structurally different prompt (reasoning strategy/depth, token budget, structural caps — see
// `profiles.ts`), giving the critic genuinely different candidates to rank.
//
// Safety floor (AC5 — candidate generation never relaxes safety, grounding, or output schema): the
// baseline plan's safety posture is the floor. A candidate is admitted only if its derived posture is
// at least as strict (a candidate that would drop the safety-critical disclaimer or the human-approval
// gate is rejected before it is ever scored). Output schema and grounding need are bound to the
// analysis by `generateEnhancedPrompt`, so they cannot drift across candidates.
//
// Because the planner escalates a critical-criticality task to the `safety-critical` profile regardless
// of preference, such tasks deterministically collapse to a single candidate — relaxing the profile to
// manufacture variety would relax safety, which AC5 forbids. The "at least three candidates" capability
// (AC1) therefore applies to tasks whose safety floor admits variation, which is the common case.
//
// Determinism: pure. No IO, clock, or randomness.

import {
  asEnhancedPromptId,
  PROMPT_ENHANCEMENT_PROFILE_IDS,
  type EnhancedPrompt,
  type PromptCandidateRejectionReason,
  type PromptEnhancementProfileId,
  type PromptTaskAnalysis,
  type RawPromptInput,
} from "@oscharko-dev/keiko-contracts";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { generateEnhancedPrompt } from "./generator.js";
import { planPromptEnhancement, type PromptEnhancementPlan } from "./planner.js";

// One generated candidate: its content-free id, the profile it was generated under, the plan, and the
// Enhanced Prompt artefact.
export interface PromptCandidate {
  readonly candidateId: string;
  readonly profile: PromptEnhancementProfileId;
  readonly plan: PromptEnhancementPlan;
  readonly prompt: EnhancedPrompt;
}

// A candidate that was generated but not admitted, with the reason it was dropped. Used to make the
// final selection auditable (the rejected alternatives, AC3).
export interface RejectedCandidate {
  readonly candidateId: string;
  readonly profile: PromptEnhancementProfileId;
  readonly reason: Extract<
    PromptCandidateRejectionReason,
    "duplicate-candidate" | "safety-floor-not-preserved"
  >;
}

export interface PromptCandidateSet {
  // Distinct, safety-preserving candidates in deterministic priority order (baseline profile first).
  readonly candidates: readonly PromptCandidate[];
  // Generation-time rejections (safety-floor or duplicate), each auditable with its reason.
  readonly rejected: readonly RejectedCandidate[];
}

export interface GeneratePromptCandidatesArgs {
  readonly analysis: PromptTaskAnalysis;
  readonly input: RawPromptInput;
  // Upper bound on the number of distinct candidates to generate (>= 1). Bounded by the slate size.
  readonly candidateCount: number;
  // Optional baseline preference / missing-information strategy, forwarded to the planner.
  readonly profilePreference?: PromptEnhancementProfileId | undefined;
}

function candidateId(analysis: PromptTaskAnalysis, profile: PromptEnhancementProfileId): string {
  const digest = sha256Hex(canonicalise({ profile, requestId: analysis.requestId }));
  return `pe-candidate-${profile}-${digest}`;
}

// The candidate-preference slate: the baseline profile first, then every other catalog profile in its
// canonical order. Planning each preference yields the actual selected profile (which may be escalated).
function preferenceSlate(
  baseline: PromptEnhancementProfileId,
): readonly PromptEnhancementProfileId[] {
  const rest = PROMPT_ENHANCEMENT_PROFILE_IDS.filter((id) => id !== baseline);
  return [baseline, ...rest];
}

// A candidate preserves the safety floor when its posture is at least as strict as the baseline on both
// safety-critical handling and the human-approval gate. (Output schema and grounding need are bound to
// the analysis by the generator, so they never drift.)
function preservesSafetyFloor(
  candidate: PromptEnhancementPlan,
  floor: PromptEnhancementPlan,
): boolean {
  const safetyCriticalOk =
    candidate.safetyPosture.safetyCritical || !floor.safetyPosture.safetyCritical;
  const humanApprovalOk =
    candidate.safetyPosture.requiresHumanApproval || !floor.safetyPosture.requiresHumanApproval;
  return safetyCriticalOk && humanApprovalOk && candidate.safetyPosture.restrictsAuthority;
}

// A wording-independent structural signature of the prompt, used to drop a candidate that is identical
// to a higher-priority one even though its nominal profile differs.
function structuralSignature(prompt: EnhancedPrompt): string {
  return JSON.stringify([
    prompt.role,
    prompt.goal,
    prompt.context,
    prompt.taskDecomposition,
    prompt.constraints,
    prompt.groundingRules,
    prompt.qualityCriteria,
    prompt.uncertaintyHandling,
    prompt.safetyRules,
    prompt.outputSchema,
    prompt.groundingPlan,
  ]);
}

/**
 * Generate a bounded, ordered set of distinct, safety-preserving Enhanced Prompt candidates. Pure.
 *
 * Candidates are produced by planning the analysis under each profile in the slate, deduplicating by
 * the actual selected profile (so a forced escalation does not produce repeats), rejecting any candidate
 * that would relax the baseline safety floor, and capping the result at `candidateCount`.
 */
export function generatePromptCandidates(args: GeneratePromptCandidatesArgs): PromptCandidateSet {
  const { analysis, input } = args;
  const count =
    Number.isInteger(args.candidateCount) && args.candidateCount > 0 ? args.candidateCount : 1;
  const floor = planPromptEnhancement(analysis, { profilePreference: args.profilePreference });
  const baselineProfile = floor.selectedProfile;

  const candidates: PromptCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const seenProfiles = new Set<PromptEnhancementProfileId>();
  const seenSignatures = new Set<string>();

  for (const preference of preferenceSlate(baselineProfile)) {
    if (candidates.length >= count) break;
    const plan = planPromptEnhancement(analysis, { profilePreference: preference });
    const actualProfile = plan.selectedProfile;
    // Deduplicate by the actual selected profile: a forced escalation (e.g. every preference escalating
    // to `safety-critical` for a critical task) is the same candidate, generated once.
    if (seenProfiles.has(actualProfile)) continue;
    seenProfiles.add(actualProfile);

    const id = candidateId(analysis, actualProfile);
    if (!preservesSafetyFloor(plan, floor)) {
      rejected.push({
        candidateId: id,
        profile: actualProfile,
        reason: "safety-floor-not-preserved",
      });
      continue;
    }
    const prompt = generateEnhancedPrompt({
      promptId: asEnhancedPromptId(id),
      analysis,
      plan,
      input,
    });
    const signature = structuralSignature(prompt);
    if (seenSignatures.has(signature)) {
      rejected.push({ candidateId: id, profile: actualProfile, reason: "duplicate-candidate" });
      continue;
    }
    seenSignatures.add(signature);
    candidates.push({ candidateId: id, profile: actualProfile, plan, prompt });
  }

  return { candidates, rejected };
}
