// Discussion Intelligence renderer unit tests (Epic #491, Issue #502). The suite test renders the
// all-GO scorecard; these tests exercise the FAIL / not-applicable glyph branches and the NO-GO verdict
// line by feeding synthetic scorecards, so the renderer's failure formatting cannot regress silently.

import { describe, expect, it } from "vitest";
import { renderDiscussionSummary } from "./render.js";
import type {
  DiscussionFixtureResult,
  DiscussionScorecard,
  DiscussionScorecardEntry,
} from "./types.js";

const failingFixture: DiscussionFixtureResult = {
  fixtureName: "synthetic-fail",
  category: "no-voice",
  observation: {
    plan: {
      mode: "challenge",
      challengesAssumptions: true,
      requiresExplicitAssumptions: true,
      requiresUncertaintyDisclosure: true,
      citationDiscipline: "require-citations-or-state-no-evidence",
      contradictionPolicy: "disclose-and-defer",
      groundingDirectives: [],
      producesDecisionRecommendation: false,
      mandatedFacets: ["evidence", "assumptions", "uncertainty"],
      directives: ["state-position-then-evidence"],
    },
    renderedDirectives: ["rendered"],
    gatingAllowed: false,
  },
  dimensionResults: [
    { dimension: "mode-appropriateness", outcome: "fail", rationale: "failed: synthetic." },
    { dimension: "capability-gating", outcome: "not-applicable", rationale: "not exercised." },
  ],
  fullyPassed: false,
};

const failingEntry: DiscussionScorecardEntry = {
  dimension: "mode-appropriateness",
  passCount: 0,
  failCount: 1,
  notApplicableCount: 0,
  passRate: 0,
};

const notExercisedEntry: DiscussionScorecardEntry = {
  dimension: "interruption-recovery",
  passCount: 0,
  failCount: 0,
  notApplicableCount: 1,
  passRate: null,
};

const noGoScorecard: DiscussionScorecard = {
  schemaVersion: "1",
  fixtureResults: [failingFixture],
  dimensions: [failingEntry, notExercisedEntry],
  summary: {
    totalFixtures: 1,
    fullyPassedFixtures: 0,
    coversNoVoiceProfile: true,
    coversVoiceProfile: false,
    goNoGo: "NO-GO",
  },
  coveredModes: ["challenge"],
};

describe("renderDiscussionSummary - failure formatting", () => {
  const text = renderDiscussionSummary(noGoScorecard);

  it("renders the NO-GO verdict line", () => {
    expect(text).toContain("Verdict: NO-GO");
  });

  it("renders the FAIL fixture verdict and the FAIL dimension glyph", () => {
    expect(text).toContain("- synthetic-fail [no-voice] FAIL");
    expect(text).toContain("mode-appropriateness=FAIL");
  });

  it("renders an n/a rate for a dimension no fixture exercised", () => {
    expect(text).toContain("rate=n/a");
  });

  it("reports the AC6 profile coverage line with a missing voice profile", () => {
    expect(text).toContain("Profile coverage: no-voice=yes voice=no");
  });
});
