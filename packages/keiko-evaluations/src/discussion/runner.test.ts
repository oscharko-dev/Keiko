// Discussion Intelligence runner unit tests (Epic #491, Issue #502). Covers the deterministic
// observation derivation and the suite summary's profile-coverage gates. Pure inputs.

import { describe, expect, it } from "vitest";
import { DISCUSSION_DIRECTIVE_TEMPLATES, discussionModePlan } from "@oscharko-dev/keiko-contracts";
import { deriveDiscussionObservation, runDiscussionEvaluation } from "./runner.js";
import { discussionFixtureByName, discussionFixturesForCategory } from "./fixtures/index.js";
import type { DiscussionEvalFixture } from "./types.js";

const baseFixture: DiscussionEvalFixture = {
  name: "runner-unit",
  category: "no-voice",
  description: "unit fixture",
  profile: "none",
  mode: "challenge",
  topicId: "runner-topic",
  dimensions: new Set(["mode-appropriateness"]),
  oracle: {
    expectedMandatedFacets: ["evidence", "assumptions", "uncertainty"],
    expectedGatingAllowed: false,
    expectedUncertaintyDisclosure: true,
    expectedDecisionRecommendation: false,
  },
};

describe("deriveDiscussionObservation", () => {
  it("renders the directive templates verbatim from the contract", () => {
    const obs = deriveDiscussionObservation(baseFixture);
    const expected = discussionModePlan("challenge").directives.map(
      (d) => DISCUSSION_DIRECTIVE_TEMPLATES[d],
    );
    expect(obs.renderedDirectives).toEqual(expected);
  });

  it("derives the voice-gating verdict from the profile", () => {
    expect(deriveDiscussionObservation(baseFixture).gatingAllowed).toBe(false);
    const voice: DiscussionEvalFixture = { ...baseFixture, profile: "speech-to-text" };
    expect(deriveDiscussionObservation(voice).gatingAllowed).toBe(true);
  });

  it("omits the recovery trajectory when the fixture declares no interruption", () => {
    expect(deriveDiscussionObservation(baseFixture).recovery).toBeUndefined();
  });

  it("derives an active -> interrupted -> recovered trajectory preserving context", () => {
    const interrupting: DiscussionEvalFixture = {
      ...baseFixture,
      profile: "full-realtime",
      interruption: true,
    };
    const recovery = deriveDiscussionObservation(interrupting).recovery;
    expect(recovery?.initial.status).toBe("active");
    expect(recovery?.interrupted.status).toBe("interrupted");
    expect(recovery?.recovered.status).toBe("recovered");
    expect(recovery?.recovered.mode).toBe("challenge");
    expect(recovery?.recovered.topicId).toBe("runner-topic");
    expect(recovery?.recovered.turnIndex).toBe(recovery?.initial.turnIndex);
  });
});

describe("runDiscussionEvaluation summary gates", () => {
  it("is NO-GO when no voice-enabled fixture is present even if every dimension passes", () => {
    const noVoiceOnly = discussionFixturesForCategory("no-voice");
    const scorecard = runDiscussionEvaluation(noVoiceOnly);
    expect(scorecard.summary.coversVoiceProfile).toBe(false);
    expect(scorecard.summary.goNoGo).toBe("NO-GO");
  });

  it("is NO-GO when no no-voice fixture is present", () => {
    const voiceOnly = discussionFixturesForCategory("voice");
    const scorecard = runDiscussionEvaluation(voiceOnly);
    expect(scorecard.summary.coversNoVoiceProfile).toBe(false);
    expect(scorecard.summary.goNoGo).toBe("NO-GO");
  });
});

describe("fixture selectors", () => {
  it("resolves a fixture by name", () => {
    expect(discussionFixtureByName("no-voice-challenge")?.mode).toBe("challenge");
    expect(discussionFixtureByName("absent")).toBeUndefined();
  });
});
