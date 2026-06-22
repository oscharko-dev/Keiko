// Prompt Enhancer evaluation types (Epic #1307, Issue #1315; ADR-0044 §6).
//
// The agent-trajectory harness (`../types.ts`, `../scorer.ts`) scores a workflow run on seven
// EVALUATION_DIMENSIONS. The Prompt Enhancer is a different artefact: a deterministic pipeline that
// turns a raw draft into a structured `EnhancedPrompt`. Its quality is judged on the eight prompt-
// quality dimensions the issue mandates (clarity, completeness, groundedness, faithfulness, format
// adherence, safety, task success, token efficiency), which are deliberately DISTINCT from the
// agent-trajectory dimensions (Issue #1312 notes the prompt critic's six dimensions are also distinct).
//
// These types are internal to the (private) evaluations package — they are an offline test artefact,
// not a cross-package wire contract — so they live here rather than in keiko-contracts. The pipeline
// they describe is fully deterministic: no model call, clock, or randomness (the offline-vs-live split
// the agent-trajectory harness needs does not apply, since enhancement never dispatches a model).

import type {
  GroundingStrategy,
  OutputFormat,
  PromptCandidateScorecard,
  PromptEnhancementProfileId,
  PromptSafetyAssessment,
  PromptSafetyDecision,
  PromptSafetyVerificationStatus,
  PromptTaskAnalysis,
  PromptTaskClass,
  EnhancedPrompt,
  MissingInformationStrategy,
} from "@oscharko-dev/keiko-contracts";
import type { PromptInjectionSignal } from "@oscharko-dev/keiko-security";
// The gateway exposes the Prompt Enhancer sub-module as a namespace (`export * as PromptEnhancer`).
import type { PromptEnhancer } from "@oscharko-dev/keiko-model-gateway";

// ─── Dimensions ────────────────────────────────────────────────────────────────────
// The eight prompt-quality dimensions the issue's Acceptance Criteria enumerate (AC1).
export type PromptQualityDimension =
  | "clarity"
  | "completeness"
  | "groundedness"
  | "faithfulness"
  | "format-adherence"
  | "safety"
  | "task-success"
  | "token-efficiency";

export const PROMPT_QUALITY_DIMENSIONS: readonly PromptQualityDimension[] = [
  "clarity",
  "completeness",
  "groundedness",
  "faithfulness",
  "format-adherence",
  "safety",
  "task-success",
  "token-efficiency",
] as const;

// ─── Fixture categories ──────────────────────────────────────────────────────────
// Coverage buckets the issue scope names: the ten-plus task classes, grounding-sensitive prompts,
// safety/adversarial prompts, output-format adherence, and token efficiency.
export type PromptEnhancerFixtureCategory =
  | "task-class"
  | "grounding"
  | "adversarial"
  | "format"
  | "token-efficiency";

export const PROMPT_ENHANCER_FIXTURE_CATEGORIES: readonly PromptEnhancerFixtureCategory[] = [
  "task-class",
  "grounding",
  "adversarial",
  "format",
  "token-efficiency",
] as const;

// ─── Fixture shape ─────────────────────────────────────────────────────────────────
// The raw request the fixture feeds the enhancer. Mirrors the safe subset of RawPromptInput plus the
// caller hints `PromptEnhancementRequest` accepts. The fixture never carries credentials or content
// beyond the draft itself.
export interface PromptEnhancerFixtureRequest {
  readonly text: string;
  readonly hasConnectedContext?: boolean;
  readonly attachmentCount?: number;
  readonly profilePreference?: PromptEnhancementProfileId;
  readonly missingInformationStrategy?: MissingInformationStrategy;
  readonly locale?: string;
}

// The expectations a fixture asserts. Every field is optional except the task-class expectation, so a
// fixture declares only the oracle facets relevant to the dimensions it exercises. A `min*Score` floor
// is checked against the deterministic critic's continuous score for that dimension.
export interface PromptEnhancerOracle {
  // task-success: the analyzer must classify the draft into one of these classes.
  readonly expectedTaskClasses: readonly PromptTaskClass[];
  // task-success: when present, the planner must select one of these profiles.
  readonly expectedProfiles?: readonly PromptEnhancementProfileId[];
  // groundedness: the produced grounding plan's `required` flag must equal this.
  readonly expectedGroundingRequired?: boolean;
  // groundedness: when present, the plan's strategy must be one of these.
  readonly expectedGroundingStrategies?: readonly GroundingStrategy[];
  // format-adherence: the output schema's `structured` flag must equal this.
  readonly expectedOutputStructured?: boolean;
  // format-adherence: when present, the output schema's format must equal this.
  readonly expectedOutputFormat?: OutputFormat;
  // safety: the safety assessment's decision must be one of these.
  readonly expectedSafetyDecisions?: readonly PromptSafetyDecision[];
  // safety: when present, the safety verification status must be one of these.
  readonly expectedVerificationStatuses?: readonly PromptSafetyVerificationStatus[];
  // safety/adversarial: when true, the injection detector must surface at least one signal on the draft.
  readonly expectsInjectionSignals?: boolean;
  // token-efficiency: an optional upper bound on the rendered prompt's estimated tokens.
  readonly maxEstimatedTokens?: number;
  // Per-dimension continuous critic floors (clarity/completeness/grounding-readiness/safety/
  // output-controllability/token-efficiency). A fixture sets these when it wants a graded threshold on
  // top of the structural gate.
  readonly minClarityScore?: number;
  readonly minCompletenessScore?: number;
  readonly minTokenEfficiencyScore?: number;
}

export interface PromptEnhancerEvalFixture {
  readonly name: string;
  readonly category: PromptEnhancerFixtureCategory;
  readonly description: string;
  readonly request: PromptEnhancerFixtureRequest;
  readonly dimensions: ReadonlySet<PromptQualityDimension>;
  readonly oracle: PromptEnhancerOracle;
}

// ─── Run + scoring results ──────────────────────────────────────────────────────────
// The deterministic artefacts the pipeline produces for one fixture. The scorer reads only this; it
// never re-runs the pipeline, so scoring stays pure and reproducible.
export interface EnhancementObservation {
  readonly analysis: PromptTaskAnalysis;
  readonly plan: PromptEnhancer.PromptEnhancementPlan;
  readonly prompt: EnhancedPrompt;
  readonly critic: PromptCandidateScorecard;
  readonly safety: PromptSafetyAssessment;
  readonly injectionSignals: readonly PromptInjectionSignal[];
  readonly estimatedTokens: number;
}

export type PromptQualityOutcome = "pass" | "fail" | "not-applicable";

export interface PromptQualityDimensionResult {
  readonly dimension: PromptQualityDimension;
  readonly outcome: PromptQualityOutcome;
  // Harness-authored, content-free explanation. Never echoes the untrusted draft (only structural
  // counts, closed-vocabulary labels, and numeric scores), mirroring the critic's rationale discipline.
  readonly rationale: string;
}

export interface PromptEnhancerFixtureResult {
  readonly fixtureName: string;
  readonly category: PromptEnhancerFixtureCategory;
  readonly observation: EnhancementObservation;
  readonly dimensionResults: readonly PromptQualityDimensionResult[];
  readonly fullyPassed: boolean;
}

export interface PromptQualityScorecardEntry {
  readonly dimension: PromptQualityDimension;
  readonly passCount: number;
  readonly failCount: number;
  readonly notApplicableCount: number;
  // pass / (pass + fail); null when no fixture exercised the dimension.
  readonly passRate: number | null;
}

export interface PromptEnhancerEvalSummary {
  readonly totalFixtures: number;
  readonly fullyPassedFixtures: number;
  // Every dimension a fixture exercised must have a 1.0 pass rate, and the safety gate must hold.
  readonly safetyGatePassed: boolean;
  readonly goNoGo: "GO" | "NO-GO";
}

export const PROMPT_ENHANCER_EVAL_SCHEMA_VERSION = "1" as const;

export interface PromptEnhancerScorecard {
  readonly schemaVersion: typeof PROMPT_ENHANCER_EVAL_SCHEMA_VERSION;
  readonly fixtureResults: readonly PromptEnhancerFixtureResult[];
  readonly dimensions: readonly PromptQualityScorecardEntry[];
  readonly summary: PromptEnhancerEvalSummary;
  // The distinct task classes the suite exercised, for the "at least ten task classes" coverage check.
  readonly coveredTaskClasses: readonly PromptTaskClass[];
}
