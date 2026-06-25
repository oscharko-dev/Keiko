// Focused unit tests for the voice-recap pure helpers (Epic #491, Issue #504). The suite.test.ts proves
// the aggregate GO board; these tests exercise the FAILURE and edge branches the all-pass board never hits
// — a rejected gate, the FAIL / n/a render glyphs, the empty-projection candidate verdict, and the
// candidate-model guard — so the scorer / renderer / model are regression-sensitive, not merely happy-path.

import { describe, expect, it } from "vitest";
import {
  committedTextEmbedsSecret,
  deriveCandidateOutcome,
  renderVoiceRecapSummary,
  runVoiceRecapEvaluation,
  scoreVoiceRecapQuality,
  type VoiceRecapEvalFixture,
  type VoiceRecapObservation,
  type VoiceRecapScorecard,
} from "./index.js";
import {
  buildVoiceSessionRecapAuditRecord,
  selectCommittedVoiceTranscript,
  summarizeVoiceSessionRecap,
  summarizeVoiceTranscript,
} from "@oscharko-dev/keiko-contracts";

function observationFromAudit(overrides: Partial<VoiceRecapObservation>): VoiceRecapObservation {
  const transcript = summarizeVoiceTranscript([]);
  const evidence = summarizeVoiceSessionRecap(transcript, {
    candidatesExtracted: 0,
    candidatesProposed: 0,
    candidatesRejected: 0,
  });
  const audit = buildVoiceSessionRecapAuditRecord({
    profile: "speech-to-text",
    committedSegmentCount: 0,
    committedChars: 0,
    candidatesExtracted: 0,
    candidatesRejected: 0,
    candidatesProposed: 0,
    triggeredByUser: true,
    durationMs: 0,
  });
  return {
    recapAllowed: true,
    committedSegmentCount: 0,
    committedChars: 0,
    assistantTurnCount: 0,
    candidateOutcomes: [],
    candidatesProposed: 0,
    candidatesRejected: 0,
    evidence,
    audit,
    ...overrides,
  };
}

describe("candidate-model edge branches", () => {
  it("returns undefined for an empty committed projection", () => {
    const projection = selectCommittedVoiceTranscript([]);
    expect(deriveCandidateOutcome(projection)).toBeUndefined();
  });

  it("rejects each canonical secret shape and accepts clean text", () => {
    expect(committedTextEmbedsSecret("sk-test-ABCDEF12")).toBe(true);
    expect(committedTextEmbedsSecret("Bearer abcdEFGH1234")).toBe(true);
    expect(committedTextEmbedsSecret("api_key = zzzz9999")).toBe(true);
    expect(committedTextEmbedsSecret("plain reminder text")).toBe(false);
  });
});

describe("scorer failure branches", () => {
  // A fixture that declares dormant-no-voice but whose observation contradicts the oracle: the gate must
  // FAIL, exercising the non-empty `failed` path of `gate`.
  const failingFixture: VoiceRecapEvalFixture = {
    name: "synthetic-failing",
    category: "voice",
    description: "synthetic",
    profile: "speech-to-text",
    source: "dictation",
    userSpans: [],
    assistantSpans: [],
    dimensions: new Set(["dormant-no-voice"]),
    oracle: {
      expectedRecapAllowed: false,
      expectedCandidatesProposed: 0,
      expectedCandidatesRejected: 0,
      expectedCandidateStatus: "proposed",
    },
  };

  it("flips a dimension to FAIL when the observation contradicts the oracle", () => {
    const obs = observationFromAudit({ recapAllowed: true });
    const results = scoreVoiceRecapQuality(failingFixture, obs);
    const dormant = results.find((r) => r.dimension === "dormant-no-voice");
    expect(dormant?.outcome).toBe("fail");
    expect(dormant?.rationale).toContain("failed:");
  });

  it("marks undeclared dimensions not-applicable", () => {
    const obs = observationFromAudit({});
    const results = scoreVoiceRecapQuality(failingFixture, obs);
    const notDeclared = results.find((r) => r.dimension === "content-free-audit");
    expect(notDeclared?.outcome).toBe("not-applicable");
  });

  it("yields a NO-GO scorecard when run over a single failing voice fixture", () => {
    // This synthetic fixture has a voice profile but the dormant-no-voice oracle expects a denied profile,
    // so the dimension fails; with no no-voice fixture present the coverage gate is also unmet — driving the
    // runner's NO-GO branch and the empty covered-status path.
    const scorecard = runVoiceRecapEvaluation([failingFixture]);
    expect(scorecard.summary.goNoGo).toBe("NO-GO");
    expect(scorecard.coveredCandidateStatuses).toEqual([]);
    // Rendering a board with no no-voice coverage exercises the "no" branch of the coverage line.
    const text = renderVoiceRecapSummary(scorecard);
    expect(text).toContain("no-voice=no");
  });
});

describe("renderer FAIL / n-a glyph branches", () => {
  it("renders a NO-GO scorecard with FAIL and n/a glyphs", () => {
    const scorecard: VoiceRecapScorecard = {
      schemaVersion: "1",
      fixtureResults: [
        {
          fixtureName: "f",
          category: "voice",
          observation: observationFromAudit({}),
          dimensionResults: [
            { dimension: "dormant-no-voice", outcome: "fail", rationale: "failed: x." },
            { dimension: "content-free-audit", outcome: "pass", rationale: "ok." },
          ],
          fullyPassed: false,
        },
      ],
      dimensions: [
        {
          dimension: "dormant-no-voice",
          passCount: 0,
          failCount: 1,
          notApplicableCount: 0,
          passRate: 0,
        },
        {
          dimension: "secrets-redacted",
          passCount: 0,
          failCount: 0,
          notApplicableCount: 1,
          passRate: null,
        },
      ],
      summary: {
        totalFixtures: 1,
        fullyPassedFixtures: 0,
        coversNoVoiceProfile: false,
        coversVoiceProfile: true,
        goNoGo: "NO-GO",
      },
      coveredCandidateStatuses: [],
    };
    const text = renderVoiceRecapSummary(scorecard);
    expect(text).toContain("Verdict: NO-GO");
    expect(text).toContain("dormant-no-voice=FAIL");
    expect(text).toContain("rate=n/a");
  });
});
