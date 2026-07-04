// Voice Action Governance evaluation types (Epic #491, Issue #503; ADR-0108).
//
// This subpackage scores the deterministic spoken-action governance scaffold defined by the
// keiko-contracts `voice-action-intent` leaf module — the fail-closed effect taxonomy, the capability
// gating, the committed-only entry gate, the confirmation discipline, and the content-digest binding
// that prevents stale / misrecognized intent from executing. It is NOT the agent-trajectory harness
// (`../types.ts`, `../scorer.ts`), which is bounded to workflow runs: the governance scaffold is a
// distinct security artefact judged on its own closed set of dimensions, so it carries its own
// deterministic fixture type and scorer, mirroring the Discussion Intelligence subpackage
// (`../discussion/`) and the Prompt Enhancer subpackage (`../promptEnhancer/`).
//
// Determinism: the "pipeline" that produces an observation is pure data derivation over the frozen
// contract (`selectCommittedVoiceTranscript`, `normalizeSpokenActionProposal`,
// `classifySpokenActionEffect`, `canonicalizeSpokenActionConfirmation`, `buildSpokenActionAuditRecord`).
// No model call, clock read, or randomness is involved, so the suite gives reproducible CI coverage.
// Every observation field is content-free (enums, bools, ints, a content-free digest, fixed labels).

import type {
  SpokenActionAuditRecord,
  SpokenActionEffectClass,
  SpokenActionState,
  VoiceProfile,
  VoiceTranscriptSegment,
  VoiceTranscriptSource,
} from "@oscharko-dev/keiko-contracts";

// ─── Dimensions ────────────────────────────────────────────────────────────────────
// The six security dimensions Issue #503's scope mandates. Deliberately DISTINCT from the
// agent-trajectory and discussion dimensions: they judge the spoken-action governance scaffold.
export type VoiceActionDimension =
  | "capability-gating"
  | "committed-only"
  | "confirmation-discipline"
  | "stale-intent-prevention"
  | "injection-resistance"
  | "evidence-safety";

export const VOICE_ACTION_DIMENSIONS: readonly VoiceActionDimension[] = [
  "capability-gating",
  "committed-only",
  "confirmation-discipline",
  "stale-intent-prevention",
  "injection-resistance",
  "evidence-safety",
] as const;

// ─── Fixture categories ──────────────────────────────────────────────────────────
// Coverage buckets the issue requires: a baseline voice action, the no-voice (`none` profile) dormancy
// case, and the adversarial slice (injection, misrecognition, partial-transcript, correction,
// interruption, denied-capability). The GO/NO-GO gate requires both a no-voice and a voice fixture.
export type VoiceActionFixtureCategory = "no-voice" | "voice" | "adversarial";

export const VOICE_ACTION_FIXTURE_CATEGORIES: readonly VoiceActionFixtureCategory[] = [
  "no-voice",
  "voice",
  "adversarial",
] as const;

// ─── Fixture shape ─────────────────────────────────────────────────────────────────
// A fixture supplies REAL transcript segments (so partial / discarded / superseded segments are
// physically present in the misrecognition / partial / correction cases) plus a content-free oracle.
// The runner pipes the segments through `selectCommittedVoiceTranscript` — the AC2 integration
// boundary — so the committed-only guarantee is proven structurally, not asserted.
export interface VoiceActionOracle {
  // capability-gating (AC1): voiceCanProposeAction(profile) must equal this.
  readonly expectedGatingAllowed: boolean;
  // committed-only (AC2): whether a proposal is expected at all. False for the dormant / empty /
  // partial-only cases; the runner must reproduce `proposal === undefined` exactly when this is false.
  readonly expectsProposal: boolean;
  // confirmation-discipline (AC3): the effect class the deterministic classifier must resolve to.
  // Present only when a proposal is expected.
  readonly expectedEffectClass?: SpokenActionEffectClass;
  // confirmation-discipline (AC3): whether the proposal must require an explicit confirmation step.
  readonly expectedRequiresConfirmation?: boolean;
  // injection-resistance: when set, the classifier must NOT resolve the committed text to "read-only"
  // (an injected instruction can never slip through as a no-confirmation read).
  readonly forbidsReadOnly?: boolean;
}

// `correctedSegments` opts a fixture into a stale-intent trajectory: the runner derives the proposal
// from `segments`, then re-derives from `correctedSegments` and proves the confirmation digest changed
// (AC4). `turnAdvance` opts a fixture into the turn-advance invalidation case (AC4): the runner
// re-derives at `turnIndex + 1` and proves the digest changed.
export interface VoiceActionEvalFixture {
  readonly name: string;
  readonly category: VoiceActionFixtureCategory;
  readonly description: string;
  readonly profile: VoiceProfile;
  readonly source: VoiceTranscriptSource;
  readonly turnIndex: number;
  readonly segments: readonly VoiceTranscriptSegment[];
  readonly correctedSegments?: readonly VoiceTranscriptSegment[];
  readonly turnAdvance?: boolean;
  readonly dimensions: ReadonlySet<VoiceActionDimension>;
  readonly oracle: VoiceActionOracle;
}

// ─── Observation ─────────────────────────────────────────────────────────────────
// The deterministic artefacts the pipeline derives for one fixture. The scorer reads ONLY this; it
// never re-derives, so scoring stays pure and reproducible. `proposal` is undefined for the dormant /
// empty / partial-only cases. `staleness` is present only when the fixture declares a correction or a
// turn-advance trajectory. `audit` is the content-free record the governance layer would persist.
export interface VoiceActionStalenessTrajectory {
  // Whether the canonical confirmation seed CHANGED after the trigger. This boolean — NOT the seeds
  // themselves — is the AC4 proof: a changed seed yields a different downstream digest, so a confirmation
  // captured before the change can no longer match. The raw seeds embed the committed text and so are
  // never carried into the observation / scorecard (the content-free discipline).
  readonly seedChanged: boolean;
  // Whether BOTH seeds were non-empty (each side produced a real proposal), so the change is meaningful.
  readonly bothSeedsPresent: boolean;
  // The trigger that changed the seed, for content-free reporting.
  readonly trigger: "correction" | "turn-advance";
}

// A CONTENT-FREE projection of the normalized proposal. The contract `SpokenActionProposal` carries
// `confirmationInput.committedText` (a transient digest seed that must stay in-memory only), so the
// observation never stores the proposal itself — only these closed-vocabulary / numeric fields, which is
// everything the scorer needs and nothing that could leak committed text into the scorecard (AC5).
export interface VoiceActionProposalSummary {
  readonly effectClass: SpokenActionEffectClass;
  readonly requiresConfirmation: boolean;
  readonly state: SpokenActionState;
  readonly turnIndex: number;
  readonly committedSegmentCount: number;
  readonly committedChars: number;
}

export interface VoiceActionObservation {
  readonly gatingAllowed: boolean;
  readonly committedSegmentCount: number;
  readonly committedChars: number;
  // undefined for the dormant / empty / partial-only cases.
  readonly proposal: VoiceActionProposalSummary | undefined;
  readonly audit: SpokenActionAuditRecord;
  readonly staleness?: VoiceActionStalenessTrajectory;
}

// ─── Scoring results ─────────────────────────────────────────────────────────────────
export type VoiceActionOutcome = "pass" | "fail" | "not-applicable";

export interface VoiceActionDimensionResult {
  readonly dimension: VoiceActionDimension;
  readonly outcome: VoiceActionOutcome;
  // Harness-authored, content-free explanation: structural counts, closed-vocabulary labels, numbers
  // only. Never echoes committed text or any raw transcript content.
  readonly rationale: string;
}

export interface VoiceActionFixtureResult {
  readonly fixtureName: string;
  readonly category: VoiceActionFixtureCategory;
  readonly observation: VoiceActionObservation;
  readonly dimensionResults: readonly VoiceActionDimensionResult[];
  readonly fullyPassed: boolean;
}

export interface VoiceActionScorecardEntry {
  readonly dimension: VoiceActionDimension;
  readonly passCount: number;
  readonly failCount: number;
  readonly notApplicableCount: number;
  // pass / (pass + fail); null when no fixture exercised the dimension.
  readonly passRate: number | null;
}

export interface VoiceActionEvalSummary {
  readonly totalFixtures: number;
  readonly fullyPassedFixtures: number;
  // The two coverage gates: at least one no-voice fixture and at least one voice-enabled fixture.
  readonly coversNoVoiceProfile: boolean;
  readonly coversVoiceProfile: boolean;
  readonly goNoGo: "GO" | "NO-GO";
}

export const VOICE_ACTION_EVAL_SCHEMA_VERSION = "1" as const;

export interface VoiceActionScorecard {
  readonly schemaVersion: typeof VOICE_ACTION_EVAL_SCHEMA_VERSION;
  readonly fixtureResults: readonly VoiceActionFixtureResult[];
  readonly dimensions: readonly VoiceActionScorecardEntry[];
  readonly summary: VoiceActionEvalSummary;
  // The distinct effect classes the suite's proposals exercised, for coverage reporting.
  readonly coveredEffectClasses: readonly SpokenActionEffectClass[];
}
