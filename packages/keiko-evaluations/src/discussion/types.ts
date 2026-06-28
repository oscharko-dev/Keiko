// Discussion Intelligence evaluation types (Epic #491, Issue #502; ADR-0065).
//
// This subpackage scores the deterministic discussion scaffold defined by the keiko-contracts
// `discussion-intelligence` leaf module — the five colleague-like modes, the disagreement structure,
// the capability gating, and the interruption-recovery turn model. It is NOT the agent-trajectory
// harness (`../types.ts`, `../scorer.ts`), which is bounded to workflow runs (unit-tests /
// bug-investigation): the discussion scaffold is a different artefact judged on its own closed set of
// discussion-quality dimensions, so it carries its own deterministic fixture type and scorer, mirroring
// the Prompt Enhancer subpackage (`../promptEnhancer/`).
//
// Determinism: the "pipeline" that produces an observation is pure data derivation over the frozen
// contract tables (`DISCUSSION_MODE_PLANS`, `DISCUSSION_DIRECTIVE_TEMPLATES`) plus the pure recovery
// helpers. No model call, clock read, or randomness is involved, so the suite gives reproducible CI
// coverage. Every field is content-free (enums, bools, ints, bounded fixed-template strings).

import type {
  DisagreementFacet,
  DiscussionMode,
  DiscussionModePlan,
  DiscussionTurnContext,
  VoiceProfile,
} from "@oscharko-dev/keiko-contracts";

// ─── Dimensions ────────────────────────────────────────────────────────────────────
// The seven discussion-quality dimensions Issue #502's scope mandates. Deliberately DISTINCT from the
// agent-trajectory dimensions and the Prompt Enhancer dimensions: they judge the discussion scaffold.
export type DiscussionQualityDimension =
  | "mode-appropriateness"
  | "disagreement-completeness"
  | "uncertainty-discipline"
  | "evidence-citation-discipline"
  | "correction-handling"
  | "interruption-recovery"
  | "capability-gating";

export const DISCUSSION_QUALITY_DIMENSIONS: readonly DiscussionQualityDimension[] = [
  "mode-appropriateness",
  "disagreement-completeness",
  "uncertainty-discipline",
  "evidence-citation-discipline",
  "correction-handling",
  "interruption-recovery",
  "capability-gating",
] as const;

// ─── Fixture categories ──────────────────────────────────────────────────────────
// Coverage buckets: text-only (no-voice) discussion, voice-enabled discussion, and the correction /
// contradiction-handling slice. AC6 requires both no-voice AND voice-enabled profiles.
export type DiscussionFixtureCategory = "no-voice" | "voice" | "correction";

export const DISCUSSION_FIXTURE_CATEGORIES: readonly DiscussionFixtureCategory[] = [
  "no-voice",
  "voice",
  "correction",
] as const;

// ─── Fixture shape ─────────────────────────────────────────────────────────────────
// The oracle a fixture asserts. Every field is content-free. `expectedMandatedFacets` and
// `expectedGatingAllowed` are derived facts the deterministic pipeline must reproduce from the contract;
// the recovery facets only apply to fixtures that declare an interruption trajectory.
export interface DiscussionOracle {
  // disagreement-completeness: the mode plan must mandate exactly these facets (order-insensitive).
  readonly expectedMandatedFacets: readonly DisagreementFacet[];
  // capability-gating: voiceCanDriveDiscussion(profile) must equal this.
  readonly expectedGatingAllowed: boolean;
  // uncertainty-discipline: the mode plan's requiresUncertaintyDisclosure must equal this.
  readonly expectedUncertaintyDisclosure: boolean;
  // mode-appropriateness: the mode plan's producesDecisionRecommendation must equal this.
  readonly expectedDecisionRecommendation: boolean;
  // correction-handling: when present, the plan's contradictionPolicy must be one of these.
  readonly expectedContradictionPolicies?: readonly DiscussionModePlan["contradictionPolicy"][];
  // interruption-recovery: present only for fixtures with an interruption trajectory. The recovered
  // context must preserve the same mode/topicId/turnIndex (the AC4 no-context-loss proof).
  readonly expectsRecoveredContext?: boolean;
}

// A discussion-evaluation fixture. `interruption` opts the fixture into a begin -> interrupt -> recover
// trajectory; the deterministic pipeline reproduces it from the contract recovery helpers.
export interface DiscussionEvalFixture {
  readonly name: string;
  readonly category: DiscussionFixtureCategory;
  readonly description: string;
  readonly profile: VoiceProfile;
  readonly mode: DiscussionMode;
  // An opaque, bounded, content-free topic identity used to seed the turn context (never raw text).
  readonly topicId: string;
  readonly interruption?: boolean;
  readonly dimensions: ReadonlySet<DiscussionQualityDimension>;
  readonly oracle: DiscussionOracle;
}

// ─── Observation ─────────────────────────────────────────────────────────────────
// The deterministic artefacts the pipeline derives for one fixture. The scorer reads ONLY this; it never
// re-derives, so scoring stays pure and reproducible. `recovery` is present only when the fixture
// declares an interruption trajectory.
export interface DiscussionRecoveryTrajectory {
  readonly initial: DiscussionTurnContext;
  readonly interrupted: DiscussionTurnContext;
  readonly recovered: DiscussionTurnContext;
}

export interface DiscussionObservation {
  readonly plan: DiscussionModePlan;
  // The directive templates rendered verbatim from the contract for the mode's directives.
  readonly renderedDirectives: readonly string[];
  readonly gatingAllowed: boolean;
  readonly recovery?: DiscussionRecoveryTrajectory;
}

// ─── Scoring results ─────────────────────────────────────────────────────────────────
export type DiscussionQualityOutcome = "pass" | "fail" | "not-applicable";

export interface DiscussionDimensionResult {
  readonly dimension: DiscussionQualityDimension;
  readonly outcome: DiscussionQualityOutcome;
  // Harness-authored, content-free explanation: structural counts, closed-vocabulary labels, numbers
  // only. Never echoes a topicId or any raw text.
  readonly rationale: string;
}

export interface DiscussionFixtureResult {
  readonly fixtureName: string;
  readonly category: DiscussionFixtureCategory;
  readonly observation: DiscussionObservation;
  readonly dimensionResults: readonly DiscussionDimensionResult[];
  readonly fullyPassed: boolean;
}

export interface DiscussionScorecardEntry {
  readonly dimension: DiscussionQualityDimension;
  readonly passCount: number;
  readonly failCount: number;
  readonly notApplicableCount: number;
  // pass / (pass + fail); null when no fixture exercised the dimension.
  readonly passRate: number | null;
}

export interface DiscussionEvalSummary {
  readonly totalFixtures: number;
  readonly fullyPassedFixtures: number;
  // The two AC6 coverage gates: at least one no-voice fixture and at least one voice-enabled fixture.
  readonly coversNoVoiceProfile: boolean;
  readonly coversVoiceProfile: boolean;
  readonly goNoGo: "GO" | "NO-GO";
}

export const DISCUSSION_EVAL_SCHEMA_VERSION = "1" as const;

export interface DiscussionScorecard {
  readonly schemaVersion: typeof DISCUSSION_EVAL_SCHEMA_VERSION;
  readonly fixtureResults: readonly DiscussionFixtureResult[];
  readonly dimensions: readonly DiscussionScorecardEntry[];
  readonly summary: DiscussionEvalSummary;
  // The distinct discussion modes the suite exercised, for coverage reporting.
  readonly coveredModes: readonly DiscussionMode[];
}
