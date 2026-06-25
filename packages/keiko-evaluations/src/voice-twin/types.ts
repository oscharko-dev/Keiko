// Voice Digital Twin evaluation types (Epic #491, Issue #505 — the capstone; ADR-0068).
//
// This subpackage is the PROOF MECHANISM for the whole Voice Digital Twin: that it is high quality when
// available and harmless when unavailable. It scores the deterministic capability / privacy / metric
// facts derivable from the keiko-contracts voice leaf modules (`voice-protocol`, `voice-transcript`,
// `voice-playback`) across the profile × environment matrix from
// `docs/voice/deployment-profile-matrix.md` §3. It is NOT the agent-trajectory harness (`../types.ts`):
// the capstone is judged on its own closed set of eleven dimensions, mirroring the Voice Action
// (`../voice-action/`), Discussion (`../discussion/`), and Recap (`../voice-recap/`) subpackages.
//
// Import boundary (ADR-0019 rule 3l): keiko-evaluations may import ONLY keiko-contracts (and node fs in
// .test.ts for the repo manifest scan). All voice RUNTIME mechanics (timing engine, turn manager,
// transcript reducer, playback controller) live in keiko-ui and are OFF LIMITS — every metric is modelled
// against keiko-contracts importable APIs and the repo manifests.
//
// Determinism: every observation is pure data derivation over the frozen contract — no model call, clock
// read, randomness, or network. Every observation / metric / rationale field is content-free: counts,
// closed-vocabulary enum labels, booleans, integers. No raw transcript text, SDP, ICE, audio, or a
// fixture's opaque topic / segment id ever enters the scorecard.

import type {
  VoiceControlMessageKind,
  VoiceMediaTransport,
  VoiceNegotiationMode,
  VoiceProfile,
} from "@oscharko-dev/keiko-contracts";

export const VOICE_TWIN_EVAL_SCHEMA_VERSION = "1" as const;

// ─── Dimensions ────────────────────────────────────────────────────────────────────
// The eleven capstone dimensions: the capability-matrix consistency check, the three graceful-degradation
// affordance dimensions (AC1/AC2 dormancy, AC3 STT bounding, AC4 transport separation), the AC5 privacy
// dimension, the five AC6 metric dimensions, and the latency-posture-class dimension (the Deliverable
// "latency": the deterministic latency class per profile; wall-clock timing is out of the pure boundary).
export type VoiceTwinDimension =
  | "capability-matrix-consistency"
  | "no-voice-dormancy"
  | "stt-affordance-bounding"
  | "transport-plane-separation"
  | "external-destination-privacy"
  | "interruption-metric"
  | "end-of-turn-metric"
  | "transcript-correction-metric"
  | "provider-failure-recovery-metric"
  | "buffer-boundedness-metric"
  | "latency-class-metric";

export const VOICE_TWIN_DIMENSIONS: readonly VoiceTwinDimension[] = [
  "capability-matrix-consistency",
  "no-voice-dormancy",
  "stt-affordance-bounding",
  "transport-plane-separation",
  "external-destination-privacy",
  "interruption-metric",
  "end-of-turn-metric",
  "transcript-correction-metric",
  "provider-failure-recovery-metric",
  "buffer-boundedness-metric",
  "latency-class-metric",
] as const;

// ─── Environment axis ──────────────────────────────────────────────────────────────
// The deployment environments from the matrix §1: an Azure AI Foundry dev/academic deployment, a
// customer-hosted controlled-network deployment (private RFC-1918 endpoints first-class), and a
// no-voice deployment (no provider configured) where every advertised capability degrades to `none`.
export type VoiceEnvironmentProfile = "azure-foundry" | "customer-hosted" | "no-voice-env";

export const VOICE_ENVIRONMENT_PROFILES: readonly VoiceEnvironmentProfile[] = [
  "azure-foundry",
  "customer-hosted",
  "no-voice-env",
] as const;

// ─── Egress destination class (AC5) ─────────────────────────────────────────────────
// The matrix §3 / privacy-contract §1 "external-call rule": a voice cell egresses either nowhere
// (`none`, effective-none cells) or only to the configured model endpoint for the active capability
// (`configured-model-endpoint`). `unapproved-external` is the violation class no positive cell may ever
// carry; the privacy auditor exists to catch it (the AC5 teeth).
export type EgressDestinationClass = "none" | "configured-model-endpoint" | "unapproved-external";

// ─── Fixture categories ──────────────────────────────────────────────────────────
export type VoiceTwinFixtureCategory =
  | "no-voice"
  | "stt-only"
  | "speech-output"
  | "full-realtime"
  | "privacy";

export const VOICE_TWIN_FIXTURE_CATEGORIES: readonly VoiceTwinFixtureCategory[] = [
  "no-voice",
  "stt-only",
  "speech-output",
  "full-realtime",
  "privacy",
] as const;

// ─── Oracle ─────────────────────────────────────────────────────────────────────────
// The content-free expectations a fixture declares. Each field is consumed by exactly one dimension's
// scorer; a field is present only when the fixture declares the matching dimension.
export interface VoiceTwinOracle {
  // capability-matrix-consistency / no-voice-dormancy: the profile the cell must resolve to.
  readonly expectedEffectiveProfile: VoiceProfile;
  // external-destination-privacy (AC5): whether the cell's egress ledger must audit as approved. A
  // privacy-negative fixture sets this false and PASSES the dimension by being caught (auditor returns
  // approved=false, matching the oracle).
  readonly expectedEgressApproved: boolean;
  // external-destination-privacy: whether the fixture's declared manifests must scan clean of denied
  // media packages. A denied-package negative fixture sets this false.
  readonly expectedManifestsClean: boolean;
}

// ─── Fixture ─────────────────────────────────────────────────────────────────────────
// A fixture is one environment × advertised-capability cell plus the privacy ledger / manifest list the
// cell asserts and the dimensions it exercises. `egressLedger` is a list of destination classes (the
// matrix §3 egress facts as data); `manifests` is the synthetic package-manifest list the supply-chain
// scan runs over (real-repo scan lives in the test files).
export interface VoiceTwinManifestFixture {
  readonly packageName: string;
  readonly dependencyNames: readonly string[];
}

export interface VoiceTwinEgressDestination {
  readonly class: EgressDestinationClass;
}

export interface VoiceTwinFixture {
  readonly name: string;
  readonly category: VoiceTwinFixtureCategory;
  readonly description: string;
  readonly environment: VoiceEnvironmentProfile;
  // The capability the deployment advertises BEFORE environment degradation is applied.
  readonly advertisedProfile: VoiceProfile;
  readonly egressLedger: readonly VoiceTwinEgressDestination[];
  readonly manifests: readonly VoiceTwinManifestFixture[];
  readonly dimensions: ReadonlySet<VoiceTwinDimension>;
  readonly oracle: VoiceTwinOracle;
}

// ─── Capability cell (contract-derived facts) ────────────────────────────────────────
// The contract-derived facts for one environment × capability cell. Every field is read directly from a
// frozen keiko-contracts table for the effective profile — the scorer compares these against the same
// tables, so any drift in the contract or a wrong derivation flips a dimension to FAIL.
export interface VoiceTwinCapabilityCell {
  readonly effectiveProfile: VoiceProfile;
  readonly allowedKinds: readonly VoiceControlMessageKind[];
  readonly mediaTransport: VoiceMediaTransport;
  readonly negotiation: VoiceNegotiationMode;
  // The control plane is always loopback (never browser-direct authority): AC4 invariant.
  readonly controlPlaneIsLoopback: boolean;
  readonly mediaPlaneId: "media";
  readonly egressClass: EgressDestinationClass;
}

// ─── AC6 metric records (content-free) ───────────────────────────────────────────────
export interface InterruptionMetricRecord {
  readonly interruptAllowed: boolean;
  readonly interruptedPhaseReachable: boolean;
}

export interface EndOfTurnMetricRecord {
  readonly committedKindAllowed: boolean;
  readonly captureAllowed: boolean;
  // The committed projection of the metric's fixed segment list excludes partial / stable text.
  readonly committedSegmentCount: number;
  readonly excludesUncommitted: boolean;
}

export interface TranscriptCorrectionMetricRecord {
  readonly stableToCorrectedAllowed: boolean;
  readonly committedToCorrectedAllowed: boolean;
  readonly correctedIsConsumable: boolean;
  // A `corrected` segment that supersedes a prior `committed` one drops the superseded text.
  readonly supersededTextDropped: boolean;
}

export interface ProviderFailureRecoveryMetricRecord {
  readonly providerErrorIsState: boolean;
  // provider-error is reviewable but NOT consumable downstream.
  readonly providerErrorNotConsumable: boolean;
  readonly playbackFailedIsSettled: boolean;
  // A recovery transition exists out of the playback failure phase.
  readonly recoveryTransitionExists: boolean;
}

export interface BufferBoundednessMetricRecord {
  readonly capacity: number;
  readonly maxObservedLength: number;
  // The number of admitted (replay-eligible) kinds across the modelled push sequence.
  readonly admittedCount: number;
  // Whether any ephemeral (non-replay-eligible) kind ever entered the ring.
  readonly ephemeralBuffered: boolean;
  readonly evictedOldestOnOverflow: boolean;
}

// The deterministic latency POSTURE class per profile (the Deliverable "latency"). Numeric wall-clock /
// WebRTC setup timing is OUT of the pure-harness boundary (needs clock + network reads); the keiko-ui
// voice-timebase suite (ADR-0061) covers the wall-clock ring-drain timing. Here we prove only the
// deterministic latency class the media transport implies: a `webrtc` profile is interactive-realtime,
// a `gateway-batch` profile is batch, and a `none` profile has no latency surface at all.
export interface LatencyClassMetricRecord {
  readonly mediaTransport: VoiceMediaTransport;
  readonly latencyClass: "none" | "batch" | "interactive-realtime";
  readonly isInteractive: boolean;
}

// The metric bundle a fixture declares. A field is present only when the fixture exercises the matching
// metric dimension; the runner derives exactly the declared metrics.
export interface VoiceTwinMetricBundle {
  readonly interruption?: InterruptionMetricRecord;
  readonly endOfTurn?: EndOfTurnMetricRecord;
  readonly transcriptCorrection?: TranscriptCorrectionMetricRecord;
  readonly providerFailureRecovery?: ProviderFailureRecoveryMetricRecord;
  readonly bufferBoundedness?: BufferBoundednessMetricRecord;
  readonly latencyClass?: LatencyClassMetricRecord;
}

// ─── Privacy audit (AC5) ─────────────────────────────────────────────────────────────
export interface VoiceTwinEgressAudit {
  readonly approved: boolean;
  readonly unapprovedCount: number;
}

export interface VoiceTwinDeniedManifestHit {
  readonly packageName: string;
  readonly deniedPackage: string;
}

export interface VoiceTwinManifestScan {
  readonly clean: boolean;
  readonly found: readonly VoiceTwinDeniedManifestHit[];
}

// ─── Observation ─────────────────────────────────────────────────────────────────────
// The deterministic artefacts the runner derives for one fixture. The scorer reads ONLY this; it never
// re-derives, so scoring stays pure and reproducible.
export interface VoiceTwinObservation {
  readonly environment: VoiceEnvironmentProfile;
  readonly advertisedProfile: VoiceProfile;
  readonly cell: VoiceTwinCapabilityCell;
  readonly egressAudit: VoiceTwinEgressAudit;
  readonly manifestScan: VoiceTwinManifestScan;
  readonly metrics: VoiceTwinMetricBundle;
}

// ─── Scoring results ─────────────────────────────────────────────────────────────────
export type VoiceTwinOutcome = "pass" | "fail" | "not-applicable";

export interface VoiceTwinDimensionResult {
  readonly dimension: VoiceTwinDimension;
  readonly outcome: VoiceTwinOutcome;
  // Harness-authored, content-free explanation: structural counts, closed-vocabulary labels, numbers
  // only. Never echoes transcript text, SDP, ICE, audio, or a fixture's opaque id.
  readonly rationale: string;
}

export interface VoiceTwinFixtureResult {
  readonly fixtureName: string;
  readonly category: VoiceTwinFixtureCategory;
  readonly environment: VoiceEnvironmentProfile;
  readonly effectiveProfile: VoiceProfile;
  readonly observation: VoiceTwinObservation;
  readonly dimensionResults: readonly VoiceTwinDimensionResult[];
  readonly fullyPassed: boolean;
}

export interface VoiceTwinScorecardEntry {
  readonly dimension: VoiceTwinDimension;
  readonly passCount: number;
  readonly failCount: number;
  readonly notApplicableCount: number;
  readonly passRate: number | null;
}

// One environment × effective-profile cell the suite covered, for matrix-coverage reporting.
export interface VoiceTwinMatrixCell {
  readonly environment: VoiceEnvironmentProfile;
  readonly effectiveProfile: VoiceProfile;
}

export interface VoiceTwinEvalSummary {
  readonly totalFixtures: number;
  readonly fullyPassedFixtures: number;
  readonly coversNoVoice: boolean;
  readonly coversSttOnly: boolean;
  readonly coversSpeechOutput: boolean;
  readonly coversFullRealtime: boolean;
  readonly coversAzureFoundry: boolean;
  readonly coversCustomerHosted: boolean;
  readonly coversPrivacyNegative: boolean;
  readonly goNoGo: "GO" | "NO-GO";
}

export interface VoiceTwinScorecard {
  readonly schemaVersion: typeof VOICE_TWIN_EVAL_SCHEMA_VERSION;
  readonly fixtureResults: readonly VoiceTwinFixtureResult[];
  readonly dimensions: readonly VoiceTwinScorecardEntry[];
  readonly summary: VoiceTwinEvalSummary;
  // The distinct environment × effective-profile cells the suite exercised, canonically ordered.
  readonly coveredMatrixCells: readonly VoiceTwinMatrixCell[];
}
