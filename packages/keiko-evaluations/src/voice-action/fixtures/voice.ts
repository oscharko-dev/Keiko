// Baseline voice-enabled fixtures (Epic #491, Issue #503; AC2/AC3). These exercise the governance
// scaffold under capture-capable profiles (`speech-to-text`, `full-realtime`) with committed text,
// proving a read-only spoken action routes without confirmation while a mutating one demands an explicit
// confirmation step bound to the committed content. Pure value modules.

import type { VoiceActionEvalFixture } from "../types.js";
import { buildSegments } from "./segment.js";

export const voiceReadOnly: VoiceActionEvalFixture = {
  name: "voice-read-only",
  category: "voice",
  description:
    "STT committed read-only request (`show ...`); classifies read-only and needs no confirmation (AC3).",
  profile: "speech-to-text",
  source: "dictation",
  turnIndex: 0,
  segments: buildSegments(
    [{ id: "s1", seq: 1, state: "committed", text: "show the open tickets" }],
    "dictation",
  ),
  dimensions: new Set([
    "capability-gating",
    "committed-only",
    "confirmation-discipline",
    "evidence-safety",
  ]),
  oracle: {
    expectedGatingAllowed: true,
    expectsProposal: true,
    expectedEffectClass: "read-only",
    expectedRequiresConfirmation: false,
  },
};

export const voiceMutating: VoiceActionEvalFixture = {
  name: "voice-mutating",
  category: "voice",
  description:
    "Full-realtime committed mutating request (`update ...`); requires an explicit confirmation step (AC3).",
  profile: "full-realtime",
  source: "realtime",
  turnIndex: 0,
  segments: buildSegments(
    [{ id: "s1", seq: 1, state: "committed", text: "update the customer record" }],
    "realtime",
  ),
  dimensions: new Set([
    "capability-gating",
    "committed-only",
    "confirmation-discipline",
    "evidence-safety",
  ]),
  oracle: {
    expectedGatingAllowed: true,
    expectsProposal: true,
    expectedEffectClass: "mutating",
    expectedRequiresConfirmation: true,
  },
};

export const voiceUnknownFailClosed: VoiceActionEvalFixture = {
  name: "voice-unknown-fail-closed",
  category: "voice",
  description:
    "STT committed text matching no effect marker; classifies `unknown` and is forced to confirm — " +
    "the security-critical fail-closed default the taxonomy guarantees (AC3).",
  profile: "speech-to-text",
  source: "dictation",
  turnIndex: 0,
  segments: buildSegments(
    [{ id: "s1", seq: 1, state: "committed", text: "the quarterly review is scheduled" }],
    "dictation",
  ),
  dimensions: new Set([
    "capability-gating",
    "committed-only",
    "confirmation-discipline",
    "evidence-safety",
  ]),
  oracle: {
    expectedGatingAllowed: true,
    expectsProposal: true,
    expectedEffectClass: "unknown",
    expectedRequiresConfirmation: true,
  },
};

export const VOICE_FIXTURES: readonly VoiceActionEvalFixture[] = [
  voiceReadOnly,
  voiceMutating,
  voiceUnknownFailClosed,
];
