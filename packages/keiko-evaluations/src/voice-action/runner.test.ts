// Unit tests for the Voice Action Governance runner (Issue #503). These pin the derivation behaviour the
// suite relies on and cover the staleness edge where the changed projection produces no proposal (the
// seed comparison must then report no change).

import { describe, expect, it } from "vitest";
import { deriveVoiceActionObservation, runVoiceActionEvaluation } from "./runner.js";
import { buildSegments } from "./fixtures/segment.js";
import type { VoiceActionEvalFixture } from "./types.js";

describe("deriveVoiceActionObservation", () => {
  it("produces no proposal and a not-applicable audit outcome for a dormant profile", () => {
    const fx: VoiceActionEvalFixture = {
      name: "dormant",
      category: "no-voice",
      description: "dormant",
      profile: "none",
      source: "dictation",
      turnIndex: 0,
      segments: buildSegments(
        [{ id: "s1", seq: 1, state: "committed", text: "delete it" }],
        "dictation",
      ),
      dimensions: new Set(["capability-gating"]),
      oracle: { expectedGatingAllowed: false, expectsProposal: false },
    };
    const obs = deriveVoiceActionObservation(fx);
    expect(obs.proposal).toBeUndefined();
    expect(obs.audit.outcome).toBe("not-applicable");
    expect(obs.audit.committedChars).toBe(obs.committedChars);
  });

  it("reports no seed change when a correction empties the committed projection", () => {
    // The original commits text; the 'corrected' set discards the only committed segment, so the changed
    // projection has no committed text and produces no proposal -> the seed comparison reports no change.
    const fx: VoiceActionEvalFixture = {
      name: "correction-empties",
      category: "adversarial",
      description: "correction discards all committed text",
      profile: "speech-to-text",
      source: "dictation",
      turnIndex: 0,
      segments: buildSegments(
        [{ id: "s1", seq: 1, state: "committed", text: "update it" }],
        "dictation",
      ),
      correctedSegments: buildSegments(
        [{ id: "s1", seq: 1, state: "discarded", text: "" }],
        "dictation",
      ),
      dimensions: new Set(["stale-intent-prevention"]),
      oracle: { expectedGatingAllowed: true, expectsProposal: true },
    };
    const obs = deriveVoiceActionObservation(fx);
    expect(obs.staleness?.trigger).toBe("correction");
    expect(obs.staleness?.seedChanged).toBe(false);
    expect(obs.staleness?.bothSeedsPresent).toBe(false);
  });

  it("derives no staleness when the fixture declares neither a correction nor a turn advance", () => {
    const fx: VoiceActionEvalFixture = {
      name: "no-trajectory",
      category: "voice",
      description: "baseline",
      profile: "full-realtime",
      source: "realtime",
      turnIndex: 0,
      segments: buildSegments(
        [{ id: "s1", seq: 1, state: "committed", text: "show it" }],
        "realtime",
      ),
      dimensions: new Set(["committed-only"]),
      oracle: { expectedGatingAllowed: true, expectsProposal: true },
    };
    expect(deriveVoiceActionObservation(fx).staleness).toBeUndefined();
  });
});

describe("runVoiceActionEvaluation", () => {
  it("accepts an explicit fixture list and aggregates it", () => {
    const fx: VoiceActionEvalFixture = {
      name: "single",
      category: "voice",
      description: "single",
      profile: "speech-to-text",
      source: "dictation",
      turnIndex: 0,
      segments: buildSegments(
        [{ id: "s1", seq: 1, state: "committed", text: "show it" }],
        "dictation",
      ),
      dimensions: new Set(["capability-gating"]),
      oracle: { expectedGatingAllowed: true, expectsProposal: true },
    };
    const card = runVoiceActionEvaluation([fx]);
    expect(card.summary.totalFixtures).toBe(1);
    // A single voice fixture cannot satisfy the dual-profile gate, so the verdict is NO-GO.
    expect(card.summary.goNoGo).toBe("NO-GO");
    expect(card.summary.coversNoVoiceProfile).toBe(false);
  });
});
