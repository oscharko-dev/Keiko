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
    // KEIKO-0462: also pin qualityPassed=false on the corrupted positive itself. Without this, the
    // NO-GO could equally come from the unrelated scenario-coverage gate (a single-fixture run cannot
    // cover every scenario), so a scorer regression that let a corrupted positive fixture spuriously
    // report qualityPassed=true would not be caught here — the negative-escape branch below already
    // pins its qualityPassed assertion; this restores parity for the positive-failure branch.
    expect(positiveFailure.fixtureResults[0]?.qualityPassed).toBe(false);

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

  // ─── KEIKO-0171 — every scenario must have adversarial (negative-polarity) coverage ───
  it("every VoiceAcousticScenario has at least one negative-polarity fixture", () => {
    const negativeScenarios = new Set(
      ALL_VOICE_ACOUSTIC_FIXTURES.filter((f) => f.polarity === "negative").map(
        (candidate) => candidate.scenario,
      ),
    );
    // Structural pin: previously laptop-echo, headset, and unfinished-utterance were absent from
    // NEGATIVE_FIXTURES entirely, so `negativeScenarioCoverageMet` did not exist and a scorer regression
    // that let a corrupted laptop-echo/headset/unfinished-utterance fixture pass would have shipped GO.
    expect([...negativeScenarios].sort()).toEqual([...VOICE_ACOUSTIC_SCENARIOS].sort());
  });

  it("full default run reports negativeScenarioCoverageMet=true", () => {
    const scorecard = runVoiceAcousticEvaluation();
    expect(scorecard.summary.negativeScenarioCoverageMet).toBe(true);
    expect([...scorecard.summary.negativeCoveredScenarios].sort()).toEqual(
      [...VOICE_ACOUSTIC_SCENARIOS].sort(),
    );
  });

  it("returns NO-GO when negativeScenarioCoverageMet is false", () => {
    // Only two negative-polarity fixtures (both for noisy-room) — every other scenario lacks negative
    // coverage. Even though the ones we DO run pass the gate, the run must still be NO-GO because the
    // structural adversarial-coverage invariant is unmet.
    const partial = runVoiceAcousticEvaluation([
      fixture("negative-bad-transcript"),
      fixture("negative-bad-transcript"),
    ]);
    expect(partial.summary.negativeScenarioCoverageMet).toBe(false);
    expect(partial.summary.goNoGo).toBe("NO-GO");
    // Sibling assertion: the positive-side coverage flag is also false here (no positive fixtures), so
    // the negative pin isn't the only NO-GO source — pair it with a case where positives cover everything
    // to isolate the negative contribution.
  });

  it("returns NO-GO when only positive-side coverage is complete (isolates negative gate)", () => {
    const positivesOnly = ALL_VOICE_ACOUSTIC_FIXTURES.filter((f) => f.polarity === "positive");
    const scorecard = runVoiceAcousticEvaluation(positivesOnly);
    // Positive coverage is complete and all positives pass, so scenarioCoverageMet is true and there
    // are no negatives to escape. The ONLY reason for NO-GO must be the negative-coverage gate.
    expect(scorecard.summary.scenarioCoverageMet).toBe(true);
    expect(scorecard.summary.positivePassed).toBe(scorecard.summary.positiveFixtures);
    expect(scorecard.summary.negativeCaught).toBe(0);
    expect(scorecard.summary.negativeFixtures).toBe(0);
    expect(scorecard.summary.negativeScenarioCoverageMet).toBe(false);
    expect(scorecard.summary.goNoGo).toBe("NO-GO");
  });
});
