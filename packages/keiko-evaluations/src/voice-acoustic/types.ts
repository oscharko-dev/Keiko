// Offline acoustic-quality gate for Keiko Voice (P10).
//
// This suite is pure deterministic data scoring. Fixtures contain harness-authored reference and
// hypothesis transcripts plus content-free event/latency traces. They never contain provider
// credentials, URLs, raw production audio, or raw provider event bodies.

export const VOICE_ACOUSTIC_EVAL_SCHEMA_VERSION = "1" as const;

export type VoiceAcousticScenario =
  | "first-word"
  | "trailing-word"
  | "noisy-room"
  | "laptop-echo"
  | "headset"
  | "fast-interrupt"
  | "long-pause"
  | "unfinished-utterance"
  | "exact-identifiers"
  | "grounded-vs-casual";

export const VOICE_ACOUSTIC_SCENARIOS: readonly VoiceAcousticScenario[] = [
  "first-word",
  "trailing-word",
  "noisy-room",
  "laptop-echo",
  "headset",
  "fast-interrupt",
  "long-pause",
  "unfinished-utterance",
  "exact-identifiers",
  "grounded-vs-casual",
] as const;

export type VoiceAcousticFixturePolarity = "positive" | "negative";

export type VoiceAcousticProfile =
  | "quiet-room"
  | "noisy-room"
  | "laptop-echo"
  | "headset"
  | "interrupt"
  | "endpointing"
  | "identifier"
  | "grounded";

export type VoiceAcousticTraceEventKind =
  | "speech.start"
  | "speech.end"
  | "transcript.partial"
  | "transcript.final"
  | "assistant.audio.start"
  | "barge-in.start"
  | "local.duck"
  | "interrupt.ack"
  | "endpoint.premature-final"
  | "grounding.tool.result";

export interface VoiceAcousticTraceEvent {
  readonly kind: VoiceAcousticTraceEventKind;
  readonly atMs: number;
}

export interface VoiceAcousticBudgets {
  readonly maxWer: number;
  readonly maxCer: number;
  readonly maxFirstPartialMs: number;
  readonly maxFinalTranscriptMs: number;
  readonly maxTtfaMs: number;
  readonly maxLocalDuckMs: number;
  readonly maxInterruptAckMs: number;
}

export interface VoiceAcousticFixture {
  readonly name: string;
  readonly scenario: VoiceAcousticScenario;
  readonly polarity: VoiceAcousticFixturePolarity;
  readonly acousticProfile: VoiceAcousticProfile;
  readonly referenceTranscript: string;
  readonly hypothesisTranscript: string;
  readonly requiredTerms: readonly string[];
  readonly trace: readonly VoiceAcousticTraceEvent[];
  readonly budgets?: Partial<VoiceAcousticBudgets> | undefined;
  readonly expectGroundedToolBeforeAnswer?: boolean | undefined;
}

export type VoiceAcousticMetric =
  | "wer"
  | "cer"
  | "first-token-retained"
  | "last-token-retained"
  | "required-identifier-exact-match"
  | "first-partial-latency"
  | "final-transcript-latency"
  | "time-to-first-assistant-audio"
  | "local-barge-in-duck-latency"
  | "interrupt-ack-latency"
  | "premature-finalization"
  | "grounded-tool-before-answer";

export const VOICE_ACOUSTIC_METRICS: readonly VoiceAcousticMetric[] = [
  "wer",
  "cer",
  "first-token-retained",
  "last-token-retained",
  "required-identifier-exact-match",
  "first-partial-latency",
  "final-transcript-latency",
  "time-to-first-assistant-audio",
  "local-barge-in-duck-latency",
  "interrupt-ack-latency",
  "premature-finalization",
  "grounded-tool-before-answer",
] as const;

export interface VoiceAcousticMetrics {
  readonly wer: number;
  readonly cer: number;
  readonly firstTokenRetained: boolean;
  readonly lastTokenRetained: boolean;
  readonly requiredIdentifierExactMatch: boolean;
  readonly firstPartialLatencyMs: number | null;
  readonly finalTranscriptLatencyMs: number | null;
  readonly timeToFirstAssistantAudioMs: number | null;
  readonly localDuckLatencyMs: number | null;
  readonly interruptAckLatencyMs: number | null;
  readonly prematureFinalization: boolean;
  readonly groundedToolBeforeAnswer: boolean | null;
}

export interface VoiceAcousticMetricCheck {
  readonly metric: VoiceAcousticMetric;
  readonly passed: boolean;
  readonly actual: number | boolean | null;
  readonly budget: number | boolean | null;
}

export interface VoiceAcousticFixtureResult {
  readonly fixtureName: string;
  readonly scenario: VoiceAcousticScenario;
  readonly polarity: VoiceAcousticFixturePolarity;
  readonly acousticProfile: VoiceAcousticProfile;
  readonly metrics: VoiceAcousticMetrics;
  readonly checks: readonly VoiceAcousticMetricCheck[];
  readonly qualityPassed: boolean;
  // Positive fixtures pass the gate when qualityPassed=true. Negative fixtures pass the gate only when
  // qualityPassed=false, proving the gate caught the adversarial condition.
  readonly gatePassed: boolean;
}

export interface VoiceAcousticMetricSummary {
  readonly metric: VoiceAcousticMetric;
  readonly passCount: number;
  readonly failCount: number;
  readonly notApplicableCount: number;
}

export interface VoiceAcousticEvalSummary {
  readonly totalFixtures: number;
  readonly positiveFixtures: number;
  readonly negativeFixtures: number;
  readonly positivePassed: number;
  readonly negativeCaught: number;
  readonly coveredScenarios: readonly VoiceAcousticScenario[];
  readonly scenarioCoverageMet: boolean;
  readonly goNoGo: "GO" | "NO-GO";
}

export interface VoiceAcousticScorecard {
  readonly schemaVersion: typeof VOICE_ACOUSTIC_EVAL_SCHEMA_VERSION;
  readonly fixtureResults: readonly VoiceAcousticFixtureResult[];
  readonly metricSummary: readonly VoiceAcousticMetricSummary[];
  readonly summary: VoiceAcousticEvalSummary;
}
