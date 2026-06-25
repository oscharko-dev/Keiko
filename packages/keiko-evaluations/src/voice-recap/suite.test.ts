// Voice Session Recap evaluation suite tests (Epic #491, Issue #504; AC1-AC6). Runs the full fixture set
// through the deterministic derivation and asserts the coverage and Go/No-Go guarantees the issue mandates:
// all seven recap dimensions exercised, the required fixture categories present, both no-voice and
// voice-enabled profiles covered, a reproducible result, and — the load-bearing privacy invariant — no
// committed transcript text, assistant text, or embedded secret ever leaks into the scorecard.

import { describe, expect, it } from "vitest";
import {
  VOICE_RECAP_DIMENSIONS,
  VOICE_RECAP_FIXTURE_CATEGORIES,
  committedTextEmbedsSecret,
  renderVoiceRecapSummary,
  runVoiceRecapEvaluation,
  voiceRecapFixtureByName,
  voiceRecapFixturesForCategory,
} from "./index.js";

const scorecard = runVoiceRecapEvaluation();

describe("Voice Session Recap evaluation suite (AC1-AC6)", () => {
  it("returns a GO verdict with every fixture fully passed", () => {
    expect(scorecard.summary.goNoGo).toBe("GO");
    expect(scorecard.summary.fullyPassedFixtures).toBe(scorecard.summary.totalFixtures);
    expect(scorecard.summary.totalFixtures).toBeGreaterThan(0);
    expect(scorecard.schemaVersion).toBe("1");
  });

  it("exercises every recap dimension with no failures", () => {
    for (const dim of VOICE_RECAP_DIMENSIONS) {
      const entry = scorecard.dimensions.find((e) => e.dimension === dim);
      expect(entry, dim).toBeDefined();
      expect(entry?.failCount, dim).toBe(0);
      expect(entry?.passCount, dim).toBeGreaterThan(0);
    }
  });

  it("covers all three fixture categories", () => {
    const categories = new Set(scorecard.fixtureResults.map((f) => f.category));
    expect(categories).toEqual(new Set(VOICE_RECAP_FIXTURE_CATEGORIES));
  });

  it("covers the issue's required fixtures", () => {
    const required = [
      "no-voice-capable",
      "speech-output-dormant",
      "stt-dictation-recap",
      "realtime-full-recap",
      "secret-in-transcript",
      "corrections-excluded",
      "assistant-text-excluded",
    ];
    for (const name of required) {
      expect(voiceRecapFixtureByName(name), name).toBeDefined();
    }
  });

  it("covers both no-voice and voice-enabled profiles (GO/NO-GO gate)", () => {
    expect(scorecard.summary.coversNoVoiceProfile).toBe(true);
    expect(scorecard.summary.coversVoiceProfile).toBe(true);
    expect(scorecard.fixtureResults.some((f) => !f.observation.recapAllowed)).toBe(true);
    expect(scorecard.fixtureResults.some((f) => f.observation.recapAllowed)).toBe(true);
  });

  it("proves no-voice and speech-output profiles produce no candidate (AC1 dormancy)", () => {
    for (const name of ["no-voice-capable", "speech-output-dormant"]) {
      const result = scorecard.fixtureResults.find((f) => f.fixtureName === name);
      expect(result?.observation.recapAllowed, name).toBe(false);
      expect(result?.observation.candidateOutcomes.length, name).toBe(0);
      expect(result?.observation.committedSegmentCount, name).toBe(0);
      expect(result?.observation.committedChars, name).toBe(0);
    }
  });

  it("proves a corrected/superseded segment is excluded from the recap projection (AC2/AC4)", () => {
    const result = scorecard.fixtureResults.find((f) => f.fixtureName === "corrections-excluded");
    const obs = result?.observation;
    if (obs === undefined) {
      throw new Error("expected the corrections-excluded fixture to derive an observation");
    }
    // The fixture has 4 segments (committed/corrected/discarded/partial) but only the corrected segment
    // survives the committed-only projection, so exactly one committed segment feeds the recap.
    expect(obs.committedSegmentCount).toBe(1);
    expect(obs.candidatesProposed).toBe(1);
    expect(obs.candidatesRejected).toBe(0);
  });

  it("proves a credential-bearing span is rejected before any vault insert (AC6)", () => {
    const result = scorecard.fixtureResults.find((f) => f.fixtureName === "secret-in-transcript");
    const obs = result?.observation;
    if (obs === undefined) {
      throw new Error("expected the secret-in-transcript fixture to derive an observation");
    }
    expect(obs.candidatesRejected).toBe(1);
    expect(obs.candidatesProposed).toBe(0);
    // A rejected span is never stored as a record: it carries no lifecycle status.
    const rejected = obs.candidateOutcomes.filter((o) => o.verdict === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status).toBeUndefined();
  });

  it("proves assistant turns never become user-fact candidates (AC5)", () => {
    const result = scorecard.fixtureResults.find(
      (f) => f.fixtureName === "assistant-text-excluded",
    );
    const obs = result?.observation;
    if (obs === undefined) {
      throw new Error("expected the assistant-text-excluded fixture to derive an observation");
    }
    expect(obs.assistantTurnCount).toBe(3);
    // Only the single user span produced a candidate; the three assistant turns added nothing.
    expect(obs.candidateOutcomes.length).toBe(1);
    expect(obs.candidatesProposed).toBe(1);
    expect(obs.evidence.candidatesExtracted).toBe(1);
  });

  it("proves every proposed candidate enters the governed 'proposed' status (AC3)", () => {
    const proposed = scorecard.fixtureResults
      .flatMap((f) => f.observation.candidateOutcomes)
      .filter((o) => o.verdict === "proposed");
    expect(proposed.length).toBeGreaterThan(0);
    for (const outcome of proposed) {
      expect(outcome.status).toBe("proposed");
    }
  });

  it("proves every audit record is content-free (AC4)", () => {
    const forbidden = ["text", "audio", "transcript", "raw"];
    for (const result of scorecard.fixtureResults) {
      const keys = Object.keys(result.observation.audit).map((k) => k.toLowerCase());
      for (const fragment of forbidden) {
        expect(
          keys.some((k) => k.includes(fragment)),
          `${result.fixtureName} audit key contains "${fragment}"`,
        ).toBe(false);
      }
      // Every audit's candidate partition is exhaustive: proposed + rejected === extracted.
      expect(
        result.observation.audit.candidatesProposed + result.observation.audit.candidatesRejected,
      ).toBe(result.observation.evidence.candidatesExtracted);
    }
  });

  it("never leaks committed text, assistant text, or the secret into the scorecard (content-free)", () => {
    // Every committed verb / noun, every assistant-turn fragment, and the embedded credential used in a
    // fixture. None may appear anywhere in the rendered scorecard or its serialized form — the proof that
    // the eval keeps the transcript and the secret on-host.
    const leakFragments = [
      "standup",
      "friday",
      "dark mode",
      "timezone",
      "central european",
      "monday",
      "tuesday",
      "thursday",
      "archive",
      "design team",
      "invoice",
      "release",
      "quarter",
      "password",
      "sk-test-abc123456",
    ];
    const serialized = JSON.stringify(scorecard).toLowerCase();
    const rendered = renderVoiceRecapSummary(scorecard).toLowerCase();
    for (const fragment of leakFragments) {
      expect(serialized.includes(fragment), `serialized leaked "${fragment}"`).toBe(false);
      expect(rendered.includes(fragment), `rendered leaked "${fragment}"`).toBe(false);
    }
  });

  it("is deterministic across runs", () => {
    const again = runVoiceRecapEvaluation();
    expect(JSON.stringify(again.dimensions)).toBe(JSON.stringify(scorecard.dimensions));
    expect(again.coveredCandidateStatuses).toEqual(scorecard.coveredCandidateStatuses);
    expect(JSON.stringify(again.fixtureResults)).toBe(JSON.stringify(scorecard.fixtureResults));
  });

  it("emits the covered candidate statuses in a canonical sorted order", () => {
    const sorted = [...scorecard.coveredCandidateStatuses].sort();
    expect(scorecard.coveredCandidateStatuses).toEqual(sorted);
    expect(scorecard.coveredCandidateStatuses).toContain("proposed");
  });

  it("detects the canonical secret shapes the candidate model rejects", () => {
    expect(committedTextEmbedsSecret("my key is sk-test-ABC123456")).toBe(true);
    expect(committedTextEmbedsSecret("authorization bearer abcd1234ef")).toBe(true);
    expect(committedTextEmbedsSecret("password: hunter2value")).toBe(true);
    expect(committedTextEmbedsSecret("I prefer dark mode in the editor")).toBe(false);
  });

  it("resolves fixtures by category and by name", () => {
    expect(voiceRecapFixturesForCategory("adversarial").length).toBeGreaterThan(0);
    expect(voiceRecapFixtureByName("stt-dictation-recap")).toBeDefined();
    expect(voiceRecapFixtureByName("does-not-exist")).toBeUndefined();
  });

  it("renders a readable GO summary", () => {
    const text = renderVoiceRecapSummary(scorecard);
    expect(text).toContain("Verdict: GO");
    expect(text).toContain("Candidate statuses covered:");
    expect(text).toContain("Profile coverage:");
  });
});
