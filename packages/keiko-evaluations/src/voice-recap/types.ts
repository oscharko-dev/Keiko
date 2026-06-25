// Voice Session Recap evaluation types (Epic #491, Issue #504; ADR-0067).
//
// This subpackage scores the deterministic voice-session-recap scaffold defined by the keiko-contracts
// `voice-session-recap` leaf module — the capability gating, the committed-only transcript boundary, the
// candidate lifecycle that flows into the EXISTING review queue, and the content-free audit record. It is
// NOT the agent-trajectory harness (`../types.ts`, `../scorer.ts`), which is bounded to workflow runs: the
// recap scaffold is a distinct artefact judged on its own closed set of dimensions, so it carries its own
// deterministic fixture type and scorer, mirroring the Voice Action Governance subpackage
// (`../voice-action/`) and the Discussion Intelligence subpackage (`../discussion/`).
//
// Determinism: the "pipeline" that produces an observation is pure data derivation over the frozen
// contract (`voiceRecapAllowed`, `selectCommittedVoiceTranscript`, `summarizeVoiceTranscript`,
// `summarizeVoiceSessionRecap`, `buildVoiceSessionRecapAuditRecord`) plus a small content-free candidate
// model that mirrors the observable governance semantics of `extractCandidatesFromUserText` WITHOUT
// importing it (no new runtime dependency; the eval layer is the highest-level policy consumer and nothing
// below it imports the memory-capture package). No model call, clock read, or randomness is involved, so
// the suite gives reproducible CI coverage. Every observation field is content-free (enums, bools, ints,
// fixed schema version strings) — committed text and secret strings live ONLY inside fixture spans and are
// consumed by the derivation, never carried into the observation / scorecard.

import type {
  VoiceProfile,
  VoiceRecapCandidateStatus,
  VoiceSessionRecapAuditRecord,
  VoiceSessionRecapEvidenceSummary,
  VoiceTranscriptSegment,
  VoiceTranscriptSource,
} from "@oscharko-dev/keiko-contracts";

// ─── Dimensions ────────────────────────────────────────────────────────────────────
// The seven recap dimensions Issue #504's scope mandates. Deliberately DISTINCT from the
// agent-trajectory, discussion, and voice-action dimensions: they judge the recap scaffold.
export type VoiceRecapDimension =
  | "dormant-no-voice"
  | "corrections-excluded"
  | "raw-audio-never-stored"
  | "secrets-redacted"
  | "candidate-governed"
  | "assistant-claims-not-user-fact"
  | "content-free-audit";

export const VOICE_RECAP_DIMENSIONS: readonly VoiceRecapDimension[] = [
  "dormant-no-voice",
  "corrections-excluded",
  "raw-audio-never-stored",
  "secrets-redacted",
  "candidate-governed",
  "assistant-claims-not-user-fact",
  "content-free-audit",
] as const;

// ─── Fixture categories ──────────────────────────────────────────────────────────
// Coverage buckets the issue requires: the no-voice (`none` / `speech-output`) dormancy case, a baseline
// voice recap, and the adversarial / privacy slice (secret in transcript, corrections excluded, assistant
// text excluded). The GO/NO-GO gate requires both a no-voice and a voice fixture.
export type VoiceRecapFixtureCategory = "no-voice" | "voice" | "adversarial";

export const VOICE_RECAP_FIXTURE_CATEGORIES: readonly VoiceRecapFixtureCategory[] = [
  "no-voice",
  "voice",
  "adversarial",
] as const;

// ─── User-spoken span ──────────────────────────────────────────────────────────────
// A fixture supplies REAL transcript segments so the runner can pipe them through
// `selectCommittedVoiceTranscript` — the AC2 committed-only boundary — proving structurally that
// partial / discarded / superseded text never reaches the candidate model. The `expectsSecret` flag marks
// a span whose committed text embeds a credential (e.g. "sk-test-...") that the candidate model must reject
// before any candidate is proposed (AC6).
export interface VoiceRecapUserSpan {
  readonly segments: readonly VoiceTranscriptSegment[];
  // True when the committed text of this span embeds a credential / secret that must be rejected (AC6).
  readonly expectsSecret: boolean;
}

// ─── Assistant-turn descriptor (context only) ────────────────────────────────────────
// Assistant response text is context-only and is NEVER submitted to candidate extraction (ADR-0067 D5).
// A fixture may declare assistant turns to prove they never become user-fact candidates. The text is held
// only here in the fixture and is consumed by the derivation to prove it produces no candidate.
export interface VoiceRecapAssistantSpan {
  readonly turnIndex: number;
  // Assistant response text. Present so the derivation can PROVE it produces no candidate; never carried
  // into the observation.
  readonly text: string;
}

// ─── Fixture oracle ──────────────────────────────────────────────────────────────────
// Every oracle field is content-free. The deterministic pipeline must reproduce these facts from the
// contract + the candidate model.
export interface VoiceRecapOracle {
  // dormant-no-voice (AC1): voiceRecapAllowed(profile) must equal this.
  readonly expectedRecapAllowed: boolean;
  // candidate-governed (AC3): the number of committed spans the candidate model must propose. For the
  // dormant / empty cases this is 0; the runner must reproduce it exactly.
  readonly expectedCandidatesProposed: number;
  // secrets-redacted (AC6): the number of committed spans the candidate model must reject (secret /
  // out-of-scope). For a clean voice recap this is 0; for the secret fixture it is >= 1.
  readonly expectedCandidatesRejected: number;
  // The candidate status every proposed candidate must enter — always "proposed" (the only initial state
  // the recap may assign; terminal transitions delegate to the existing governed endpoints).
  readonly expectedCandidateStatus: VoiceRecapCandidateStatus;
}

export interface VoiceRecapEvalFixture {
  readonly name: string;
  readonly category: VoiceRecapFixtureCategory;
  readonly description: string;
  readonly profile: VoiceProfile;
  readonly source: VoiceTranscriptSource;
  // The user-spoken spans whose committed text feeds candidate extraction. Each span is projected through
  // `selectCommittedVoiceTranscript` independently so per-span char / segment counts are content-free.
  readonly userSpans: readonly VoiceRecapUserSpan[];
  // Assistant turns that occurred in the session. Context only — never a candidate source (AC5).
  readonly assistantSpans: readonly VoiceRecapAssistantSpan[];
  readonly dimensions: ReadonlySet<VoiceRecapDimension>;
  readonly oracle: VoiceRecapOracle;
}

// ─── Candidate model outcome (content-free) ──────────────────────────────────────────
// The observable outcome the candidate model produces for one committed span. This mirrors the SHAPE of a
// `CaptureOutcome` reduced to its content-free verdict: a span is either proposed (status "proposed") or
// rejected (secret / out-of-scope). No proposal body, no committed text — only the verdict and the
// content-free span counts. This is everything the scorer needs and nothing that could leak text.
export type VoiceRecapCandidateVerdict = "proposed" | "rejected";

export interface VoiceRecapCandidateOutcome {
  readonly verdict: VoiceRecapCandidateVerdict;
  // The lifecycle status a proposed candidate enters; undefined for a rejected span (a rejection is never
  // stored as a record — ADR-0067 D8 / AC6).
  readonly status: VoiceRecapCandidateStatus | undefined;
  readonly spanCharCount: number;
  readonly spanSegmentCount: number;
}

// ─── Observation ─────────────────────────────────────────────────────────────────────
// The deterministic artefacts the pipeline derives for one fixture. The scorer reads ONLY this; it never
// re-derives, so scoring stays pure and reproducible. `candidateOutcomes` is empty for the dormant case.
export interface VoiceRecapObservation {
  readonly recapAllowed: boolean;
  // Total committed segments across all user spans, from the committed-only projections.
  readonly committedSegmentCount: number;
  // Total committed characters across all user spans, from the committed-only projections.
  readonly committedChars: number;
  // The number of assistant turns observed; assistant text never becomes a candidate, so this never
  // contributes to `candidateOutcomes`.
  readonly assistantTurnCount: number;
  readonly candidateOutcomes: readonly VoiceRecapCandidateOutcome[];
  readonly candidatesProposed: number;
  readonly candidatesRejected: number;
  // The content-free evidence summary and audit record the recap layer would persist.
  readonly evidence: VoiceSessionRecapEvidenceSummary;
  readonly audit: VoiceSessionRecapAuditRecord;
}

// ─── Scoring results ─────────────────────────────────────────────────────────────────
export type VoiceRecapOutcome = "pass" | "fail" | "not-applicable";

export interface VoiceRecapDimensionResult {
  readonly dimension: VoiceRecapDimension;
  readonly outcome: VoiceRecapOutcome;
  // Harness-authored, content-free explanation: structural counts, closed-vocabulary labels, numbers
  // only. Never echoes committed text or any raw transcript / secret content.
  readonly rationale: string;
}

export interface VoiceRecapFixtureResult {
  readonly fixtureName: string;
  readonly category: VoiceRecapFixtureCategory;
  readonly observation: VoiceRecapObservation;
  readonly dimensionResults: readonly VoiceRecapDimensionResult[];
  readonly fullyPassed: boolean;
}

export interface VoiceRecapScorecardEntry {
  readonly dimension: VoiceRecapDimension;
  readonly passCount: number;
  readonly failCount: number;
  readonly notApplicableCount: number;
  // pass / (pass + fail); null when no fixture exercised the dimension.
  readonly passRate: number | null;
}

export interface VoiceRecapEvalSummary {
  readonly totalFixtures: number;
  readonly fullyPassedFixtures: number;
  // The two coverage gates: at least one no-voice fixture and at least one voice-enabled fixture.
  readonly coversNoVoiceProfile: boolean;
  readonly coversVoiceProfile: boolean;
  readonly goNoGo: "GO" | "NO-GO";
}

export const VOICE_RECAP_EVAL_SCHEMA_VERSION = "1" as const;

export interface VoiceRecapScorecard {
  readonly schemaVersion: typeof VOICE_RECAP_EVAL_SCHEMA_VERSION;
  readonly fixtureResults: readonly VoiceRecapFixtureResult[];
  readonly dimensions: readonly VoiceRecapScorecardEntry[];
  readonly summary: VoiceRecapEvalSummary;
  // The distinct candidate statuses the suite's proposals exercised, for coverage reporting.
  readonly coveredCandidateStatuses: readonly VoiceRecapCandidateStatus[];
}
