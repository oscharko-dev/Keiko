// Adversarial / privacy recap fixtures (Epic #491, Issue #504). These exercise the security-critical cases
// the issue names explicitly: a committed span embedding a fake credential that must be REJECTED before any
// candidate is proposed (AC6); a provider correction whose superseded text must be EXCLUDED from the
// committed projection that feeds the recap (AC2/AC4); and a session with assistant turns whose text must
// NEVER become a user-fact candidate (AC5). Each fixture supplies REAL transcript segments so the
// committed-only boundary (`selectCommittedVoiceTranscript`) is proven structurally. Pure value modules.

import type { VoiceRecapEvalFixture } from "../types.js";
import { buildSegments } from "./segment.js";

// Secret: the committed text embeds a fake OpenAI-style credential. The candidate model must reject the
// span before it can be proposed, and the rejection is never stored as a record (AC6). The credential
// string lives only in the fixture span and is consumed by the candidate model — it never reaches the
// observation / scorecard, which the suite asserts by serializing the scorecard and scanning for it.
export const secretInTranscript: VoiceRecapEvalFixture = {
  name: "secret-in-transcript",
  category: "adversarial",
  description:
    "A committed span embeds a credential (sk-test-...); the candidate model rejects it before any vault insert (AC6).",
  profile: "speech-to-text",
  source: "dictation",
  userSpans: [
    {
      segments: buildSegments(
        [
          {
            id: "x1",
            seq: 1,
            state: "committed",
            text: "my key is sk-test-ABC123456 keep it safe",
          },
        ],
        "dictation",
      ),
      expectsSecret: true,
    },
  ],
  assistantSpans: [],
  dimensions: new Set([
    "dormant-no-voice",
    "secrets-redacted",
    "candidate-governed",
    "raw-audio-never-stored",
    "content-free-audit",
  ]),
  oracle: {
    expectedRecapAllowed: true,
    expectedCandidatesProposed: 0,
    expectedCandidatesRejected: 1,
    expectedCandidateStatus: "proposed",
  },
};

// Corrections-excluded: the first committed span is superseded by a later correction. The committed
// projection must use the corrected text only; the superseded text must never reach the recap (AC2/AC4).
export const correctionsExcluded: VoiceRecapEvalFixture = {
  name: "corrections-excluded",
  category: "adversarial",
  description:
    "A correction supersedes an earlier committed segment; the superseded text is excluded from the projection (AC2/AC4).",
  profile: "full-realtime",
  source: "realtime",
  userSpans: [
    {
      segments: buildSegments(
        [
          { id: "y1", seq: 1, state: "committed", text: "set reminder for tuesday" },
          {
            id: "y2",
            seq: 2,
            state: "corrected",
            text: "set reminder for thursday",
            supersedesId: "y1",
          },
          { id: "y3", seq: 3, state: "discarded", text: "cancel everything" },
          { id: "y4", seq: 4, state: "partial", text: "and also maybe" },
        ],
        "realtime",
      ),
      expectsSecret: false,
    },
  ],
  assistantSpans: [{ turnIndex: 0, text: "Reminder moved to Thursday." }],
  dimensions: new Set([
    "dormant-no-voice",
    "corrections-excluded",
    "raw-audio-never-stored",
    "candidate-governed",
    "content-free-audit",
  ]),
  oracle: {
    expectedRecapAllowed: true,
    // One committed span survives (the corrected segment); the superseded / discarded / partial text is
    // excluded, so exactly one governed candidate is proposed.
    expectedCandidatesProposed: 1,
    expectedCandidatesRejected: 0,
    expectedCandidateStatus: "proposed",
  },
};

// Assistant-text-excluded: the session carries several assistant turns whose text states facts ("the
// invoice total is one thousand"). Only the user's committed span feeds candidate extraction, so the
// assistant claims never become user-fact candidates (AC5).
export const assistantTextExcluded: VoiceRecapEvalFixture = {
  name: "assistant-text-excluded",
  category: "adversarial",
  description:
    "Assistant turns assert facts but only the user committed span feeds extraction; assistant claims add no candidate (AC5).",
  profile: "speech-to-text",
  source: "dictation",
  userSpans: [
    {
      segments: buildSegments(
        [{ id: "z1", seq: 1, state: "committed", text: "I work in the design team" }],
        "dictation",
      ),
      expectsSecret: false,
    },
  ],
  assistantSpans: [
    { turnIndex: 0, text: "The invoice total is one thousand euros." },
    { turnIndex: 1, text: "The release is scheduled for next quarter." },
    { turnIndex: 2, text: "Your account password should be rotated soon." },
  ],
  dimensions: new Set([
    "dormant-no-voice",
    "assistant-claims-not-user-fact",
    "candidate-governed",
    "secrets-redacted",
    "raw-audio-never-stored",
    "content-free-audit",
  ]),
  oracle: {
    expectedRecapAllowed: true,
    // Exactly one candidate from the single user span; the three assistant turns contribute nothing.
    expectedCandidatesProposed: 1,
    expectedCandidatesRejected: 0,
    expectedCandidateStatus: "proposed",
  },
};

export const ADVERSARIAL_FIXTURES: readonly VoiceRecapEvalFixture[] = [
  secretInTranscript,
  correctionsExcluded,
  assistantTextExcluded,
];
