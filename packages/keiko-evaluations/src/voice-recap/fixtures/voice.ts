// Baseline voice-enabled recap fixtures (Epic #491, Issue #504; AC2/AC3/AC5). These exercise the recap
// under capture-capable profiles (`speech-to-text`, `full-realtime`) with committed text, proving the
// committed projection feeds the candidate model and that clean user-spoken spans reach the governed
// "proposed" status that surfaces in the existing review queue. Pure value modules.

import type { VoiceRecapEvalFixture } from "../types.js";
import { buildSegments } from "./segment.js";

export const sttDictationRecap: VoiceRecapEvalFixture = {
  name: "stt-dictation-recap",
  category: "voice",
  description:
    "Committed STT dictation spans derive governed memory candidates that enter the 'proposed' status (AC3).",
  profile: "speech-to-text",
  source: "dictation",
  userSpans: [
    {
      segments: buildSegments(
        [{ id: "a1", seq: 1, state: "committed", text: "I prefer dark mode in the editor" }],
        "dictation",
      ),
      expectsSecret: false,
    },
    {
      segments: buildSegments(
        [{ id: "b1", seq: 2, state: "committed", text: "my timezone is central european" }],
        "dictation",
      ),
      expectsSecret: false,
    },
  ],
  assistantSpans: [{ turnIndex: 0, text: "Got it, dark mode noted." }],
  dimensions: new Set([
    "dormant-no-voice",
    "corrections-excluded",
    "raw-audio-never-stored",
    "secrets-redacted",
    "candidate-governed",
    "assistant-claims-not-user-fact",
    "content-free-audit",
  ]),
  oracle: {
    expectedRecapAllowed: true,
    expectedCandidatesProposed: 2,
    expectedCandidatesRejected: 0,
    expectedCandidateStatus: "proposed",
  },
};

export const realtimeFullRecap: VoiceRecapEvalFixture = {
  name: "realtime-full-recap",
  category: "voice",
  description:
    "A full-realtime session whose committed spoken spans derive governed candidates (the primary gap #504 fills).",
  profile: "full-realtime",
  source: "realtime",
  userSpans: [
    {
      segments: buildSegments(
        [{ id: "c1", seq: 1, state: "committed", text: "schedule weekly reviews on monday" }],
        "realtime",
      ),
      expectsSecret: false,
    },
    {
      // A partial-only span: uncommitted text that the committed-only projection drops entirely, so it
      // contributes no candidate even under a capture-capable profile (AC2 at the span level).
      segments: buildSegments(
        [{ id: "c2", seq: 2, state: "partial", text: "and maybe also archive" }],
        "realtime",
      ),
      expectsSecret: false,
    },
  ],
  assistantSpans: [
    { turnIndex: 0, text: "Weekly reviews on Monday, understood." },
    { turnIndex: 1, text: "Anything else to capture?" },
  ],
  dimensions: new Set([
    "dormant-no-voice",
    "corrections-excluded",
    "raw-audio-never-stored",
    "candidate-governed",
    "assistant-claims-not-user-fact",
    "content-free-audit",
  ]),
  oracle: {
    expectedRecapAllowed: true,
    expectedCandidatesProposed: 1,
    expectedCandidatesRejected: 0,
    expectedCandidateStatus: "proposed",
  },
};

export const VOICE_FIXTURES: readonly VoiceRecapEvalFixture[] = [
  sttDictationRecap,
  realtimeFullRecap,
];
