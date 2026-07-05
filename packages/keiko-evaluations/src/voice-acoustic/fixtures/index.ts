// Deterministic acoustic-quality fixtures. Transcripts are harness-authored strings; traces are ordered
// enum/timestamp facts. No fixture stores audio, provider credentials, provider URLs, or raw events.

import type { VoiceAcousticFixture, VoiceAcousticTraceEvent } from "../types.js";

function baseTrace(
  overrides: readonly VoiceAcousticTraceEvent[] = [],
): readonly VoiceAcousticTraceEvent[] {
  const overriddenKinds = new Set(overrides.map((event) => event.kind));
  const defaults: readonly VoiceAcousticTraceEvent[] = [
    { kind: "speech.start", atMs: 0 },
    { kind: "transcript.partial", atMs: 420 },
    { kind: "speech.end", atMs: 1400 },
    { kind: "transcript.final", atMs: 2100 },
    { kind: "assistant.audio.start", atMs: 3000 },
  ];
  return [...defaults.filter((event) => !overriddenKinds.has(event.kind)), ...overrides].sort(
    (a, b) => a.atMs - b.atMs,
  );
}

const POSITIVE_FIXTURES: readonly VoiceAcousticFixture[] = [
  {
    name: "first-word-retained",
    scenario: "first-word",
    polarity: "positive",
    acousticProfile: "quiet-room",
    referenceTranscript: "Start the server in safe mode",
    hypothesisTranscript: "Start the server in safe mode",
    requiredTerms: [],
    trace: baseTrace(),
  },
  {
    name: "trailing-word-retained",
    scenario: "trailing-word",
    polarity: "positive",
    acousticProfile: "quiet-room",
    referenceTranscript: "Save the note as final",
    hypothesisTranscript: "Save the note as final",
    requiredTerms: [],
    trace: baseTrace([{ kind: "transcript.final", atMs: 1900 }]),
  },
  {
    name: "noisy-room-tolerated",
    scenario: "noisy-room",
    polarity: "positive",
    acousticProfile: "noisy-room",
    referenceTranscript: "Schedule checkpoint review for Monday",
    hypothesisTranscript: "Schedule checkpoint review for Monday",
    requiredTerms: [],
    trace: [
      { kind: "speech.start", atMs: 0 },
      { kind: "transcript.partial", atMs: 1650 },
      { kind: "speech.end", atMs: 2100 },
      { kind: "transcript.final", atMs: 3000 },
      { kind: "assistant.audio.start", atMs: 4100 },
    ],
  },
  {
    name: "laptop-echo-tolerated",
    scenario: "laptop-echo",
    polarity: "positive",
    acousticProfile: "laptop-echo",
    referenceTranscript: "Mute the speakers before joining",
    hypothesisTranscript: "Mute the speakers before joining",
    requiredTerms: [],
    trace: [
      { kind: "speech.start", atMs: 0 },
      { kind: "transcript.partial", atMs: 1500 },
      { kind: "speech.end", atMs: 1900 },
      { kind: "transcript.final", atMs: 2800 },
      { kind: "assistant.audio.start", atMs: 3700 },
    ],
  },
  {
    name: "headset-clean",
    scenario: "headset",
    polarity: "positive",
    acousticProfile: "headset",
    referenceTranscript: "Headset audio is clear",
    hypothesisTranscript: "Headset audio is clear",
    requiredTerms: [],
    trace: [
      { kind: "speech.start", atMs: 0 },
      { kind: "transcript.partial", atMs: 280 },
      { kind: "speech.end", atMs: 1000 },
      { kind: "transcript.final", atMs: 1350 },
      { kind: "assistant.audio.start", atMs: 1900 },
    ],
  },
  {
    name: "fast-interrupt-ducks-and-acks",
    scenario: "fast-interrupt",
    polarity: "positive",
    acousticProfile: "interrupt",
    referenceTranscript: "Stop reading and pause now",
    hypothesisTranscript: "Stop reading and pause now",
    requiredTerms: [],
    trace: [
      { kind: "speech.start", atMs: 0 },
      { kind: "transcript.partial", atMs: 360 },
      { kind: "speech.end", atMs: 780 },
      { kind: "barge-in.start", atMs: 900 },
      { kind: "local.duck", atMs: 950 },
      { kind: "interrupt.ack", atMs: 1260 },
      { kind: "transcript.final", atMs: 1420 },
      { kind: "assistant.audio.start", atMs: 1850 },
    ],
  },
  {
    name: "long-pause-not-premature",
    scenario: "long-pause",
    polarity: "positive",
    acousticProfile: "endpointing",
    referenceTranscript: "Create a branch then wait for tests",
    hypothesisTranscript: "Create a branch then wait for tests",
    requiredTerms: [],
    trace: [
      { kind: "speech.start", atMs: 0 },
      { kind: "transcript.partial", atMs: 500 },
      { kind: "speech.end", atMs: 2600 },
      { kind: "transcript.final", atMs: 3300 },
      { kind: "assistant.audio.start", atMs: 4400 },
    ],
  },
  {
    name: "unfinished-utterance-preserved",
    scenario: "unfinished-utterance",
    polarity: "positive",
    acousticProfile: "endpointing",
    referenceTranscript: "Open the draft and",
    hypothesisTranscript: "Open the draft and",
    requiredTerms: [],
    trace: [
      { kind: "speech.start", atMs: 0 },
      { kind: "transcript.partial", atMs: 390 },
      { kind: "speech.end", atMs: 950 },
      { kind: "transcript.final", atMs: 1300 },
      { kind: "assistant.audio.start", atMs: 2100 },
    ],
  },
  {
    name: "exact-identifiers-preserved",
    scenario: "exact-identifiers",
    polarity: "positive",
    acousticProfile: "identifier",
    referenceTranscript: "Open issue KEIKO-497-B and call run abc-123-Z",
    hypothesisTranscript: "Open issue KEIKO-497-B and call run abc-123-Z",
    requiredTerms: ["KEIKO-497-B", "abc-123-Z"],
    trace: baseTrace([{ kind: "transcript.final", atMs: 1800 }]),
  },
  {
    name: "grounded-before-answer",
    scenario: "grounded-vs-casual",
    polarity: "positive",
    acousticProfile: "grounded",
    referenceTranscript: "Use the grounded source before answering",
    hypothesisTranscript: "Use the grounded source before answering",
    requiredTerms: [],
    expectGroundedToolBeforeAnswer: true,
    trace: [
      { kind: "speech.start", atMs: 0 },
      { kind: "transcript.partial", atMs: 430 },
      { kind: "speech.end", atMs: 1200 },
      { kind: "transcript.final", atMs: 1700 },
      { kind: "grounding.tool.result", atMs: 2100 },
      { kind: "assistant.audio.start", atMs: 2800 },
    ],
  },
];

const NEGATIVE_FIXTURES: readonly VoiceAcousticFixture[] = [
  {
    name: "negative-bad-transcript",
    scenario: "noisy-room",
    polarity: "negative",
    acousticProfile: "noisy-room",
    referenceTranscript: "Schedule checkpoint review for Monday",
    hypothesisTranscript: "Order pizza delivery for Tuesday",
    requiredTerms: [],
    trace: baseTrace(),
  },
  {
    name: "negative-missing-trailing-word",
    scenario: "trailing-word",
    polarity: "negative",
    acousticProfile: "quiet-room",
    referenceTranscript: "Save the note as final",
    hypothesisTranscript: "Save the note as",
    requiredTerms: [],
    trace: baseTrace(),
  },
  {
    name: "negative-delayed-partial",
    scenario: "first-word",
    polarity: "negative",
    acousticProfile: "quiet-room",
    referenceTranscript: "Start the server in safe mode",
    hypothesisTranscript: "Start the server in safe mode",
    requiredTerms: [],
    trace: [
      { kind: "speech.start", atMs: 0 },
      { kind: "transcript.partial", atMs: 2300 },
      { kind: "speech.end", atMs: 1400 },
      { kind: "transcript.final", atMs: 2200 },
      { kind: "assistant.audio.start", atMs: 3000 },
    ],
  },
  {
    name: "negative-premature-final",
    scenario: "long-pause",
    polarity: "negative",
    acousticProfile: "endpointing",
    referenceTranscript: "Create a branch then wait for tests",
    hypothesisTranscript: "Create a branch then wait for tests",
    requiredTerms: [],
    trace: [
      { kind: "speech.start", atMs: 0 },
      { kind: "transcript.partial", atMs: 450 },
      { kind: "endpoint.premature-final", atMs: 900 },
      { kind: "transcript.final", atMs: 900 },
      { kind: "speech.end", atMs: 2600 },
      { kind: "assistant.audio.start", atMs: 3400 },
    ],
  },
  {
    name: "negative-slow-duck",
    scenario: "fast-interrupt",
    polarity: "negative",
    acousticProfile: "interrupt",
    referenceTranscript: "Stop reading and pause now",
    hypothesisTranscript: "Stop reading and pause now",
    requiredTerms: [],
    trace: [
      { kind: "speech.start", atMs: 0 },
      { kind: "transcript.partial", atMs: 360 },
      { kind: "speech.end", atMs: 780 },
      { kind: "barge-in.start", atMs: 900 },
      { kind: "local.duck", atMs: 1040 },
      { kind: "interrupt.ack", atMs: 1260 },
      { kind: "transcript.final", atMs: 1420 },
      { kind: "assistant.audio.start", atMs: 1850 },
    ],
  },
  {
    name: "negative-missing-identifier",
    scenario: "exact-identifiers",
    polarity: "negative",
    acousticProfile: "identifier",
    referenceTranscript: "Open issue KEIKO-497-B and call run abc-123-Z",
    hypothesisTranscript: "Open issue KEIKO-497 and call run abc-123",
    requiredTerms: ["KEIKO-497-B", "abc-123-Z"],
    trace: baseTrace(),
  },
  {
    name: "negative-answer-before-grounding",
    scenario: "grounded-vs-casual",
    polarity: "negative",
    acousticProfile: "grounded",
    referenceTranscript: "Use the grounded source before answering",
    hypothesisTranscript: "Use the grounded source before answering",
    requiredTerms: [],
    expectGroundedToolBeforeAnswer: true,
    trace: [
      { kind: "speech.start", atMs: 0 },
      { kind: "transcript.partial", atMs: 430 },
      { kind: "speech.end", atMs: 1200 },
      { kind: "transcript.final", atMs: 1700 },
      { kind: "assistant.audio.start", atMs: 1800 },
      { kind: "grounding.tool.result", atMs: 2400 },
    ],
  },
];

export const ALL_VOICE_ACOUSTIC_FIXTURES: readonly VoiceAcousticFixture[] = [
  ...POSITIVE_FIXTURES,
  ...NEGATIVE_FIXTURES,
] as const;

export function voiceAcousticFixturesForScenario(
  scenario: VoiceAcousticFixture["scenario"],
): readonly VoiceAcousticFixture[] {
  return ALL_VOICE_ACOUSTIC_FIXTURES.filter((fixture) => fixture.scenario === scenario);
}

export function voiceAcousticFixtureByName(name: string): VoiceAcousticFixture | undefined {
  return ALL_VOICE_ACOUSTIC_FIXTURES.find((fixture) => fixture.name === name);
}
