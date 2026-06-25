// No-voice dormancy fixtures (Epic #491, Issue #504; AC1). These prove the whole recap layer is dormant
// for profiles with no capture capability (`none`, `speech-output`): even with committed text present,
// `voiceRecapAllowed` is false, the recap short-circuits before reading any transcript, and no memory
// candidate can ever be proposed in a no-voice deployment. Pure value modules.

import type { VoiceRecapEvalFixture } from "../types.js";
import { buildSegments } from "./segment.js";

export const noVoiceDormant: VoiceRecapEvalFixture = {
  name: "no-voice-capable",
  category: "no-voice",
  description:
    "A `none` profile with committed text present; the recap layer is dormant so no candidate forms (AC1).",
  profile: "none",
  source: "dictation",
  userSpans: [
    {
      segments: buildSegments(
        [{ id: "s1", seq: 1, state: "committed", text: "remember my standup is at nine" }],
        "dictation",
      ),
      expectsSecret: false,
    },
  ],
  assistantSpans: [],
  dimensions: new Set(["dormant-no-voice", "content-free-audit", "raw-audio-never-stored"]),
  oracle: {
    expectedRecapAllowed: false,
    expectedCandidatesProposed: 0,
    expectedCandidatesRejected: 0,
    expectedCandidateStatus: "proposed",
  },
};

export const speechOutputDormant: VoiceRecapEvalFixture = {
  name: "speech-output-dormant",
  category: "no-voice",
  description:
    "A playback-only `speech-output` profile cannot capture, so the recap stays dormant even with text (AC1).",
  profile: "speech-output",
  source: "realtime",
  userSpans: [
    {
      segments: buildSegments(
        [{ id: "s1", seq: 1, state: "committed", text: "note that the project ships friday" }],
        "realtime",
      ),
      expectsSecret: false,
    },
  ],
  assistantSpans: [{ turnIndex: 0, text: "Understood, I will keep that in mind." }],
  dimensions: new Set(["dormant-no-voice", "content-free-audit", "raw-audio-never-stored"]),
  oracle: {
    expectedRecapAllowed: false,
    expectedCandidatesProposed: 0,
    expectedCandidatesRejected: 0,
    expectedCandidateStatus: "proposed",
  },
};

export const NO_VOICE_FIXTURES: readonly VoiceRecapEvalFixture[] = [
  noVoiceDormant,
  speechOutputDormant,
];
