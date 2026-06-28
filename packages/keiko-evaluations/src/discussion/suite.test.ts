// Discussion Intelligence evaluation suite tests (Epic #491, Issue #502; AC1/AC6). Runs the full
// fixture set through the deterministic derivation and asserts the coverage and Go/No-Go guarantees the
// issue mandates: all seven discussion-quality dimensions exercised, every mode covered, both no-voice
// and voice-enabled profiles present, and a reproducible result.

import { describe, expect, it } from "vitest";
import { DISCUSSION_MODES } from "@oscharko-dev/keiko-contracts";
import {
  DISCUSSION_FIXTURE_CATEGORIES,
  DISCUSSION_QUALITY_DIMENSIONS,
  renderDiscussionSummary,
  runDiscussionEvaluation,
} from "./index.js";

const scorecard = runDiscussionEvaluation();

describe("Discussion Intelligence evaluation suite (AC1/AC6)", () => {
  it("returns a GO verdict with every fixture fully passed", () => {
    expect(scorecard.summary.goNoGo).toBe("GO");
    expect(scorecard.summary.fullyPassedFixtures).toBe(scorecard.summary.totalFixtures);
    expect(scorecard.summary.totalFixtures).toBeGreaterThan(0);
    expect(scorecard.schemaVersion).toBe("1");
  });

  it("exercises every discussion-quality dimension with no failures", () => {
    for (const dim of DISCUSSION_QUALITY_DIMENSIONS) {
      const entry = scorecard.dimensions.find((e) => e.dimension === dim);
      expect(entry, dim).toBeDefined();
      expect(entry?.failCount, dim).toBe(0);
      expect(entry?.passCount, dim).toBeGreaterThan(0);
    }
  });

  it("covers all five discussion modes", () => {
    expect(new Set(scorecard.coveredModes)).toEqual(new Set(DISCUSSION_MODES));
  });

  it("covers all three fixture categories", () => {
    const categories = new Set(scorecard.fixtureResults.map((f) => f.category));
    expect(categories).toEqual(new Set(DISCUSSION_FIXTURE_CATEGORIES));
  });

  it("covers both no-voice and voice-enabled profiles (AC6)", () => {
    expect(scorecard.summary.coversNoVoiceProfile).toBe(true);
    expect(scorecard.summary.coversVoiceProfile).toBe(true);
    // At least one fixture has gating denied (a `none` profile) and at least one has gating allowed.
    expect(scorecard.fixtureResults.some((f) => !f.observation.gatingAllowed)).toBe(true);
    expect(scorecard.fixtureResults.some((f) => f.observation.gatingAllowed)).toBe(true);
  });

  it("proves the voice barge-in fixture recovers context without loss (AC4)", () => {
    const f = scorecard.fixtureResults.find(
      (r) => r.fixtureName === "voice-realtime-barge-in-recovery",
    );
    const recovery = f?.observation.recovery;
    if (recovery === undefined) {
      throw new Error("expected the barge-in fixture to derive a recovery trajectory");
    }
    expect(recovery.recovered.status).toBe("recovered");
    expect(recovery.recovered.mode).toBe(recovery.initial.mode);
    expect(recovery.recovered.topicId).toBe(recovery.initial.topicId);
    expect(recovery.recovered.turnIndex).toBe(recovery.initial.turnIndex);
    const recoveryDim = f?.dimensionResults.find((d) => d.dimension === "interruption-recovery");
    expect(recoveryDim?.outcome).toBe("pass");
  });

  it("is deterministic across runs", () => {
    const again = runDiscussionEvaluation();
    expect(JSON.stringify(again.dimensions)).toBe(JSON.stringify(scorecard.dimensions));
    expect(again.coveredModes).toEqual(scorecard.coveredModes);
  });

  it("never echoes any fixture topicId into a dimension rationale (content-free discipline)", () => {
    const topicFragments = ["topic-", "challenge-text", "decide-realtime", "evidence-check"];
    for (const f of scorecard.fixtureResults) {
      const joined = f.dimensionResults
        .map((d) => d.rationale)
        .join(" ")
        .toLowerCase();
      for (const fragment of topicFragments) {
        expect(joined.includes(fragment), `${f.fixtureName} leaked "${fragment}"`).toBe(false);
      }
    }
  });

  it("renders a readable GO summary", () => {
    const text = renderDiscussionSummary(scorecard);
    expect(text).toContain("Verdict: GO");
    expect(text).toContain("Modes covered:");
    expect(text).toContain("Profile coverage:");
  });
});
