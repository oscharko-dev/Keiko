// Issue #1563, Epic #1556 — the production evaluation core for the colleague-like voice dialogue mode.
//
// This module is the PURE, deterministic scoring engine the dialogue-mode production evaluation is built
// on. It proves the four issue acceptance criteria as content-free, reproducible facts:
//
//   AC1 — capability-profile coverage: every configured dialogue profile resolves to the correct
//         control gating, and a no-voice deployment that INCORRECTLY offered dialogue controls is caught
//         (a regressed gate flips the scorecard to NO-GO). Scored against the REAL production gate
//         `voiceDialogueModeForResolution`, which is injectable so the negative ("teeth") case is
//         provable without mutating production code.
//   AC2 — latency / interruption evidence is RECORDED content-free: observations carry only a
//         closed-vocabulary leg label and an integer millisecond reading — never raw audio, transcript
//         text, or SDP. Each leg is scored against a documented production budget.
//   AC3 — long-session cleanup: a balanced acquire/release ledger across microphone, audio element,
//         object URL, timer, and realtime-connection resource classes proves nothing leaks after
//         stop / unmount. The behavioural proof drives the live hook; this module scores its ledger.
//   AC4 — accessibility: a closed set of WCAG-relevant checks (keyboard operability, stable accessible
//         names, focus return on error, live-region status, reduced-motion-independent comprehension,
//         colour-independent status, and an automated axe pass) is scored into a single verdict.
//
// The engine reuses the shipped dialogue runtime rather than re-deriving it: the profile dimension calls
// the production fallback matrix, and the latency dimension consumes the content-free `latencyMs` the
// voice turn manager already records. It introduces NO second state machine and NO separate test runner;
// the behavioural suites that feed it run under the existing `test:coverage:ui` and `test:e2e:smoke`
// commands. See `docs/voice/dialogue-evaluation.md` for the full specification and report format.

import type { VoiceCapabilityResolution } from "@/lib/types";
import { voiceDialogueModeForResolution, type VoiceDialogueMode } from "../voice-dialogue-session";

export const DIALOGUE_EVAL_SCHEMA_VERSION = "1" as const;

// ─── Outcome primitive ──────────────────────────────────────────────────────────────
export type DialogueEvalOutcome = "pass" | "fail";

function outcomeOf(passed: boolean): DialogueEvalOutcome {
  return passed ? "pass" : "fail";
}

// ─── AC1: capability-profile coverage ─────────────────────────────────────────────────
// The five deployment profiles the issue scope names. `stt-tts` is the STT+TTS fallback (full-realtime
// capability WITHOUT browser WebRTC media, ADR-0090 D3); `realtime-capable` is the same capability WITH
// WebRTC media. Both must offer dialogue; the three partial / absent profiles must not.
export type DialogueProfileKey =
  | "no-voice"
  | "stt-only"
  | "speech-output-only"
  | "stt-tts"
  | "realtime-capable";

export const DIALOGUE_PROFILE_KEYS: readonly DialogueProfileKey[] = [
  "no-voice",
  "stt-only",
  "speech-output-only",
  "stt-tts",
  "realtime-capable",
] as const;

// The signature of the production gate under evaluation. Injectable so the AC1 negative case (a gate that
// wrongly offers dialogue for a no-voice deployment) is provable against a stub without touching prod.
export type DialogueGate = (
  resolution: VoiceCapabilityResolution | undefined,
  browserCaptureSupported: boolean,
) => VoiceDialogueMode;

export interface DialogueProfileFixture {
  readonly key: DialogueProfileKey;
  readonly label: string;
  readonly resolution: VoiceCapabilityResolution;
  readonly browserCaptureSupported: boolean;
  // Oracle: whether a correct deployment MUST offer the spoken-dialogue controls for this profile.
  readonly expectedDialogueOffered: boolean;
}

const ALL_PERSONAS = ["male", "female", "neutral"] as const;

// The capability resolutions for the five profiles, mirroring the live e2e capability stubs so the
// evaluation and the browser smoke describe the identical deployments.
export const DIALOGUE_PROFILE_FIXTURES: readonly DialogueProfileFixture[] = [
  {
    key: "no-voice",
    label: "No-voice deployment (no voice model configured)",
    resolution: {
      available: false,
      profile: "none",
      capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
      transport: { websocketControl: false, webrtcMedia: false },
      availableVoicePersonas: [],
      reason: "no-voice-provider",
    },
    browserCaptureSupported: true,
    expectedDialogueOffered: false,
  },
  {
    key: "stt-only",
    label: "Speech-to-text-only deployment (dictation, no spoken answer)",
    resolution: {
      available: true,
      profile: "speech-to-text",
      capabilities: { speechToText: true, speechOutput: false, realtimeVoice: false },
      transport: { websocketControl: true, webrtcMedia: false },
      availableVoicePersonas: [...ALL_PERSONAS],
      providerLocality: "azure-foundry",
    },
    browserCaptureSupported: true,
    expectedDialogueOffered: false,
  },
  {
    key: "speech-output-only",
    label: "Speech-output-only deployment (spoken answer, no capture)",
    resolution: {
      available: true,
      profile: "speech-output",
      capabilities: { speechToText: false, speechOutput: true, realtimeVoice: false },
      transport: { websocketControl: true, webrtcMedia: false },
      availableVoicePersonas: [...ALL_PERSONAS],
      providerLocality: "azure-foundry",
    },
    browserCaptureSupported: true,
    expectedDialogueOffered: false,
  },
  {
    key: "stt-tts",
    label: "STT+TTS fallback deployment (full-realtime capability without browser WebRTC media)",
    resolution: {
      available: true,
      profile: "full-realtime",
      capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
      transport: { websocketControl: true, webrtcMedia: false },
      availableVoicePersonas: [...ALL_PERSONAS],
      providerLocality: "azure-foundry",
    },
    browserCaptureSupported: true,
    expectedDialogueOffered: true,
  },
  {
    key: "realtime-capable",
    label: "Realtime-capable deployment (full-realtime capability with browser WebRTC media)",
    resolution: {
      available: true,
      profile: "full-realtime",
      capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
      transport: { websocketControl: true, webrtcMedia: true },
      availableVoicePersonas: [...ALL_PERSONAS],
      providerLocality: "azure-foundry",
    },
    browserCaptureSupported: true,
    expectedDialogueOffered: true,
  },
];

export interface DialogueProfileResult {
  readonly key: DialogueProfileKey;
  readonly expectedOffered: boolean;
  readonly actualOffered: boolean;
  readonly capture: VoiceDialogueMode["capture"];
  readonly speaks: boolean;
  readonly canInterrupt: boolean;
  readonly outcome: DialogueEvalOutcome;
}

// Score every fixture against the gate. `outcome` is `pass` only when the gate's offered decision matches
// the oracle, so a regression that offers dialogue for a partial / no-voice deployment fails here.
export function evaluateDialogueProfiles(
  fixtures: readonly DialogueProfileFixture[] = DIALOGUE_PROFILE_FIXTURES,
  gate: DialogueGate = voiceDialogueModeForResolution,
): readonly DialogueProfileResult[] {
  return fixtures.map((fixture) => {
    const mode = gate(fixture.resolution, fixture.browserCaptureSupported);
    return {
      key: fixture.key,
      expectedOffered: fixture.expectedDialogueOffered,
      actualOffered: mode.offered,
      capture: mode.capture,
      speaks: mode.speaks,
      canInterrupt: mode.canInterrupt,
      outcome: outcomeOf(mode.offered === fixture.expectedDialogueOffered),
    };
  });
}

// ─── AC2: latency / interruption budgets ──────────────────────────────────────────────
export type DialogueLatencyLeg =
  | "start-latency"
  | "end-of-turn-latency"
  | "interruption-latency"
  | "time-to-first-audio";

// Canonical order follows the dialogue turn flow: arm capture → settle the user turn → first audio →
// barge-in. Consumers that map a turn onto these legs emit observations in this order.
export const DIALOGUE_LATENCY_LEGS: readonly DialogueLatencyLeg[] = [
  "start-latency",
  "end-of-turn-latency",
  "time-to-first-audio",
  "interruption-latency",
] as const;

export interface DialogueLatencyBudget {
  readonly leg: DialogueLatencyLeg;
  readonly budgetMs: number;
  // `true` when the leg is fully client-controlled (deterministically gated in the harness); `false` when
  // it depends on the speech provider and is closed in production by the headphone walkthrough.
  readonly clientControlled: boolean;
}

// Production budgets for a responsive colleague-like dialogue with headphones (see
// docs/voice/dialogue-evaluation.md §latency). Client-controlled legs (arming capture, stopping playback
// on barge-in) are proven deterministically; provider legs carry a budget for manual closure evidence.
export const DIALOGUE_LATENCY_BUDGETS: readonly DialogueLatencyBudget[] = [
  { leg: "start-latency", budgetMs: 1500, clientControlled: true },
  { leg: "interruption-latency", budgetMs: 300, clientControlled: true },
  { leg: "end-of-turn-latency", budgetMs: 4000, clientControlled: false },
  { leg: "time-to-first-audio", budgetMs: 4000, clientControlled: false },
];

// A single content-free latency reading. By construction it carries no transcript, audio, or SDP — only a
// closed-vocabulary leg and an integer millisecond value — which is the AC2 "without storing raw audio"
// guarantee made structural.
export interface DialogueLatencyObservation {
  readonly leg: DialogueLatencyLeg;
  readonly observedMs: number;
}

export interface DialogueLatencyResult {
  readonly leg: DialogueLatencyLeg;
  readonly observedMs: number;
  readonly budgetMs: number;
  readonly clientControlled: boolean;
  readonly withinBudget: boolean;
  readonly outcome: DialogueEvalOutcome;
}

function budgetForLeg(
  leg: DialogueLatencyLeg,
  budgets: readonly DialogueLatencyBudget[],
): DialogueLatencyBudget {
  const found = budgets.find((budget) => budget.leg === leg);
  if (found === undefined) {
    throw new Error(`no latency budget configured for leg: ${leg}`);
  }
  return found;
}

// A reading is valid only when it is a finite, non-negative integer count of milliseconds; a negative or
// non-finite reading is a measurement error and fails the leg rather than silently passing.
function isValidReading(observedMs: number): boolean {
  return Number.isFinite(observedMs) && observedMs >= 0;
}

export function scoreDialogueLatency(
  observations: readonly DialogueLatencyObservation[],
  budgets: readonly DialogueLatencyBudget[] = DIALOGUE_LATENCY_BUDGETS,
): readonly DialogueLatencyResult[] {
  return observations.map((observation) => {
    const budget = budgetForLeg(observation.leg, budgets);
    const withinBudget =
      isValidReading(observation.observedMs) && observation.observedMs <= budget.budgetMs;
    return {
      leg: observation.leg,
      observedMs: observation.observedMs,
      budgetMs: budget.budgetMs,
      clientControlled: budget.clientControlled,
      withinBudget,
      outcome: outcomeOf(withinBudget),
    };
  });
}

// ─── AC3: long-session cleanup ledger ──────────────────────────────────────────────────
// The resource ledger a long dialogue session leaves behind, captured AFTER stop / unmount. Every count
// is content-free; the dialogue path never opens a realtime connection (ADR-0090 D7), so its expected
// value is zero.
export interface DialogueCleanupObservation {
  readonly micAcquired: number;
  readonly micReleased: number;
  readonly audioElementsCreated: number;
  readonly audioElementsReleased: number;
  readonly objectUrlsCreated: number;
  readonly objectUrlsRevoked: number;
  readonly pendingTimers: number;
  readonly realtimeConnectionsOpened: number;
}

export interface DialogueCleanupResult {
  readonly micBalanced: boolean;
  readonly audioBalanced: boolean;
  readonly objectUrlsBalanced: boolean;
  readonly timersDrained: boolean;
  readonly noRealtimeConnection: boolean;
  readonly outcome: DialogueEvalOutcome;
}

export function scoreDialogueCleanup(
  observation: DialogueCleanupObservation,
): DialogueCleanupResult {
  const micBalanced = observation.micAcquired === observation.micReleased;
  const audioBalanced = observation.audioElementsCreated === observation.audioElementsReleased;
  const objectUrlsBalanced = observation.objectUrlsCreated === observation.objectUrlsRevoked;
  const timersDrained = observation.pendingTimers === 0;
  const noRealtimeConnection = observation.realtimeConnectionsOpened === 0;
  return {
    micBalanced,
    audioBalanced,
    objectUrlsBalanced,
    timersDrained,
    noRealtimeConnection,
    outcome: outcomeOf(
      micBalanced && audioBalanced && objectUrlsBalanced && timersDrained && noRealtimeConnection,
    ),
  };
}

// ─── AC4: accessibility checks ──────────────────────────────────────────────────────────
export type DialogueA11yCheck =
  | "keyboard-operable"
  | "stable-accessible-names"
  | "focus-return-on-error"
  | "live-region-status"
  | "reduced-motion-independent"
  | "color-independent-status"
  | "axe-clean";

export const DIALOGUE_A11Y_CHECKS: readonly DialogueA11yCheck[] = [
  "keyboard-operable",
  "stable-accessible-names",
  "focus-return-on-error",
  "live-region-status",
  "reduced-motion-independent",
  "color-independent-status",
  "axe-clean",
] as const;

export interface DialogueAccessibilityObservation {
  readonly check: DialogueA11yCheck;
  readonly satisfied: boolean;
}

export interface DialogueAccessibilityResult {
  readonly check: DialogueA11yCheck;
  readonly satisfied: boolean;
  readonly outcome: DialogueEvalOutcome;
}

export function scoreDialogueAccessibility(
  observations: readonly DialogueAccessibilityObservation[],
): readonly DialogueAccessibilityResult[] {
  return observations.map((observation) => ({
    check: observation.check,
    satisfied: observation.satisfied,
    outcome: outcomeOf(observation.satisfied),
  }));
}

// ─── Summary + scorecard ────────────────────────────────────────────────────────────────
export interface DialogueEvaluationSummary {
  readonly coversAllProfiles: boolean;
  readonly catchesNoVoiceMisgating: boolean;
  readonly profilesPassed: boolean;
  readonly latencyPassed: boolean;
  readonly cleanupPassed: boolean;
  readonly accessibilityPassed: boolean;
  readonly goNoGo: "GO" | "NO-GO";
}

export interface DialogueEvaluationParts {
  readonly profiles: readonly DialogueProfileResult[];
  readonly latency: readonly DialogueLatencyResult[];
  readonly cleanup: DialogueCleanupResult | undefined;
  readonly accessibility: readonly DialogueAccessibilityResult[];
}

export interface DialogueEvaluationScorecard extends DialogueEvaluationParts {
  readonly schemaVersion: typeof DIALOGUE_EVAL_SCHEMA_VERSION;
  readonly summary: DialogueEvaluationSummary;
}

function allPass(results: readonly { readonly outcome: DialogueEvalOutcome }[]): boolean {
  return results.length > 0 && results.every((result) => result.outcome === "pass");
}

// The no-voice deployment must be present AND its oracle must require dialogue to be absent — this is the
// structural guard that the suite is actually testing the "no dialog controls for no-voice" property and
// not silently dropping it.
function catchesNoVoiceMisgating(profiles: readonly DialogueProfileResult[]): boolean {
  const noVoice = profiles.find((profile) => profile.key === "no-voice");
  return noVoice !== undefined && noVoice.expectedOffered === false && noVoice.outcome === "pass";
}

function coversAllProfiles(profiles: readonly DialogueProfileResult[]): boolean {
  const seen = new Set(profiles.map((profile) => profile.key));
  return DIALOGUE_PROFILE_KEYS.every((key) => seen.has(key));
}

export function summarizeDialogueEvaluation(
  parts: DialogueEvaluationParts,
): DialogueEvaluationSummary {
  const coversProfiles = coversAllProfiles(parts.profiles);
  const catchesMisgating = catchesNoVoiceMisgating(parts.profiles);
  const profilesPassed = allPass(parts.profiles);
  const latencyPassed = allPass(parts.latency);
  const cleanupPassed = parts.cleanup !== undefined && parts.cleanup.outcome === "pass";
  const accessibilityPassed = allPass(parts.accessibility);
  const go =
    coversProfiles &&
    catchesMisgating &&
    profilesPassed &&
    latencyPassed &&
    cleanupPassed &&
    accessibilityPassed;
  return {
    coversAllProfiles: coversProfiles,
    catchesNoVoiceMisgating: catchesMisgating,
    profilesPassed,
    latencyPassed,
    cleanupPassed,
    accessibilityPassed,
    goNoGo: go ? "GO" : "NO-GO",
  };
}

export function buildDialogueEvaluationScorecard(
  parts: DialogueEvaluationParts,
): DialogueEvaluationScorecard {
  return {
    schemaVersion: DIALOGUE_EVAL_SCHEMA_VERSION,
    profiles: parts.profiles,
    latency: parts.latency,
    cleanup: parts.cleanup,
    accessibility: parts.accessibility,
    summary: summarizeDialogueEvaluation(parts),
  };
}

// ─── Report rendering ────────────────────────────────────────────────────────────────────
// A human-readable, content-free closure report. Mirrors the Voice Digital Twin renderer (#505): a
// verdict line, one section per dimension, and explicit coverage flags. Used as the final verification
// report format requested by the issue scope.
function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function renderProfileLines(profiles: readonly DialogueProfileResult[]): string {
  return profiles
    .map(
      (profile) =>
        `  - ${profile.key.padEnd(20)} offered=${yesNo(profile.actualOffered)} ` +
        `expected=${yesNo(profile.expectedOffered)} ${profile.outcome.toUpperCase()}`,
    )
    .join("\n");
}

function renderLatencyLines(latency: readonly DialogueLatencyResult[]): string {
  return latency
    .map(
      (result) =>
        `  - ${result.leg.padEnd(22)} ${result.observedMs}ms / budget ${result.budgetMs}ms ` +
        `(${result.clientControlled ? "client" : "provider"}) ${result.outcome.toUpperCase()}`,
    )
    .join("\n");
}

function renderCleanupLines(cleanup: DialogueCleanupResult | undefined): string {
  if (cleanup === undefined) {
    return "  - (not observed)";
  }
  return (
    `  - microphone balanced=${yesNo(cleanup.micBalanced)}\n` +
    `  - audio element balanced=${yesNo(cleanup.audioBalanced)}\n` +
    `  - object URLs balanced=${yesNo(cleanup.objectUrlsBalanced)}\n` +
    `  - timers drained=${yesNo(cleanup.timersDrained)}\n` +
    `  - no realtime connection=${yesNo(cleanup.noRealtimeConnection)}\n` +
    `  - verdict ${cleanup.outcome.toUpperCase()}`
  );
}

function renderAccessibilityLines(accessibility: readonly DialogueAccessibilityResult[]): string {
  return accessibility
    .map((result) => `  - ${result.check.padEnd(26)} ${result.outcome.toUpperCase()}`)
    .join("\n");
}

export function renderDialogueEvaluationReport(scorecard: DialogueEvaluationScorecard): string {
  const { summary } = scorecard;
  return [
    `Voice dialogue mode production evaluation (schema v${scorecard.schemaVersion})`,
    "",
    "Capability profiles:",
    renderProfileLines(scorecard.profiles),
    "",
    "Latency / interruption:",
    renderLatencyLines(scorecard.latency),
    "",
    "Long-session cleanup:",
    renderCleanupLines(scorecard.cleanup),
    "",
    "Accessibility:",
    renderAccessibilityLines(scorecard.accessibility),
    "",
    `Coverage: all-profiles=${yesNo(summary.coversAllProfiles)} ` +
      `no-voice-misgating-caught=${yesNo(summary.catchesNoVoiceMisgating)}`,
    `Verdict: ${summary.goNoGo}`,
  ].join("\n");
}
