import { describe, expect, it } from "vitest";
import { renderVoiceAcousticSummary } from "./render.js";
import { runVoiceAcousticEvaluation } from "./runner.js";
import { ALL_VOICE_ACOUSTIC_FIXTURES, voiceAcousticFixtureByName } from "./fixtures/index.js";
import {
  VOICE_ACOUSTIC_EVAL_SCHEMA_VERSION,
  VOICE_ACOUSTIC_SCENARIOS,
  type VoiceAcousticFixture,
} from "./types.js";

function fixture(name: string): VoiceAcousticFixture {
  const found = voiceAcousticFixtureByName(name);
  if (found === undefined) {
    throw new Error(`missing fixture ${name}`);
  }
  return found;
}

describe("voice-acoustic suite", () => {
  it("runs the default fixture registry to a GO verdict", () => {
    const scorecard = runVoiceAcousticEvaluation();
    expect(scorecard.schemaVersion).toBe(VOICE_ACOUSTIC_EVAL_SCHEMA_VERSION);
    expect(scorecard.summary.goNoGo).toBe("GO");
    expect(scorecard.summary.positiveFixtures).toBe(VOICE_ACOUSTIC_SCENARIOS.length);
    expect(scorecard.summary.positivePassed).toBe(scorecard.summary.positiveFixtures);
    expect(scorecard.summary.negativeCaught).toBe(scorecard.summary.negativeFixtures);
    expect(scorecard.summary.scenarioCoverageMet).toBe(true);
    expect(scorecard.summary.coveredScenarios).toEqual(VOICE_ACOUSTIC_SCENARIOS);
  });

  it("is deterministic across repeated runs", () => {
    expect(runVoiceAcousticEvaluation()).toEqual(runVoiceAcousticEvaluation());
  });

  it("covers exactly the requested scenario vocabulary", () => {
    const scenarios = new Set(ALL_VOICE_ACOUSTIC_FIXTURES.map((candidate) => candidate.scenario));
    expect([...scenarios].sort()).toEqual([...VOICE_ACOUSTIC_SCENARIOS].sort());
    expect(scenarios.size).toBe(VOICE_ACOUSTIC_SCENARIOS.length);
  });

  it("catches the adversarial negative fixtures requested by the gate", () => {
    const scorecard = runVoiceAcousticEvaluation();
    const negativeNames = [
      "negative-bad-transcript",
      "negative-missing-trailing-word",
      "negative-delayed-partial",
      "negative-premature-final",
      "negative-slow-duck",
      "negative-missing-identifier",
      "negative-answer-before-grounding",
    ];
    for (const name of negativeNames) {
      const result = scorecard.fixtureResults.find((candidate) => candidate.fixtureName === name);
      expect(result).toBeDefined();
      expect(result?.polarity).toBe("negative");
      expect(result?.qualityPassed).toBe(false);
      expect(result?.gatePassed).toBe(true);
    }
  });

  it("returns NO-GO when a positive fixture fails or a negative fixture escapes", () => {
    const positiveFailure = runVoiceAcousticEvaluation([
      {
        ...fixture("first-word-retained"),
        hypothesisTranscript: "completely different text",
      },
    ]);
    expect(positiveFailure.summary.goNoGo).toBe("NO-GO");

    const negativeEscape = runVoiceAcousticEvaluation([
      {
        ...fixture("negative-bad-transcript"),
        hypothesisTranscript: "Schedule checkpoint review for Monday",
      },
    ]);
    expect(negativeEscape.fixtureResults[0]?.qualityPassed).toBe(true);
    expect(negativeEscape.fixtureResults[0]?.gatePassed).toBe(false);
    expect(negativeEscape.summary.goNoGo).toBe("NO-GO");
  });

  it("renders a content-free summary without transcript text", () => {
    const output = renderVoiceAcousticSummary(runVoiceAcousticEvaluation());
    expect(output).toContain("Verdict: GO");
    expect(output).toContain("negative-slow-duck");
    expect(output).not.toContain("Start the server in safe mode");
    expect(output).not.toContain("KEIKO-497-B");
    expect(output).not.toMatch(/apiKey|credential|providerUrl|baseUrl/u);
  });
});
