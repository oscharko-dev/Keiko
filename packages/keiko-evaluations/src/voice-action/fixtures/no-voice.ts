// No-voice dormancy fixtures (Epic #491, Issue #503; AC1). These prove the whole spoken-action layer is
// dormant for profiles with no capture capability (`none`, `speech-output`): even with committed text
// present, `voiceCanProposeAction` is false and `normalizeSpokenActionProposal` returns undefined, so no
// spoken action can ever be proposed in a no-voice deployment. Pure value modules.

import type { VoiceActionEvalFixture } from "../types.js";
import { buildSegments } from "./segment.js";

export const noVoiceDormant: VoiceActionEvalFixture = {
  name: "no-voice-dormant",
  category: "no-voice",
  description:
    "A `none` profile with committed text present; the layer is dormant so no proposal is produced (AC1).",
  profile: "none",
  source: "dictation",
  turnIndex: 0,
  segments: buildSegments(
    [{ id: "s1", seq: 1, state: "committed", text: "delete the invoice" }],
    "dictation",
  ),
  dimensions: new Set(["capability-gating", "committed-only"]),
  oracle: {
    expectedGatingAllowed: false,
    expectsProposal: false,
  },
};

export const speechOutputDormant: VoiceActionEvalFixture = {
  name: "speech-output-dormant",
  category: "no-voice",
  description:
    "A playback-only `speech-output` profile cannot capture, so the layer stays dormant even with text (AC1).",
  profile: "speech-output",
  source: "realtime",
  turnIndex: 0,
  segments: buildSegments(
    [{ id: "s1", seq: 1, state: "committed", text: "transfer the funds" }],
    "realtime",
  ),
  dimensions: new Set(["capability-gating", "committed-only"]),
  oracle: {
    expectedGatingAllowed: false,
    expectsProposal: false,
  },
};

export const NO_VOICE_FIXTURES: readonly VoiceActionEvalFixture[] = [
  noVoiceDormant,
  speechOutputDormant,
];
