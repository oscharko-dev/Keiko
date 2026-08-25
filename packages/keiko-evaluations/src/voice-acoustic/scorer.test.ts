import { describe, expect, it } from "vitest";
import {
  characterErrorRate,
  deriveVoiceAcousticMetrics,
  scoreVoiceAcousticFixture,
  wordErrorRate,
} from "./scorer.js";
import { voiceAcousticFixturesForScenario } from "./fixtures/index.js";
import { fixture } from "./test-fixture-lookup.js";
import type { VoiceAcousticFixture } from "./types.js";

function check(result: ReturnType<typeof scoreVoiceAcousticFixture>, metric: string): boolean {
  const found = result.checks.find((candidate) => candidate.metric === metric);
  if (found === undefined) {
    throw new Error(`missing metric ${metric}`);
  }
  return found.passed;
}

describe("voice-acoustic scorer WER/CER", () => {
  it("handles exact, deletion, substitution, insertion, and empty references", () => {
    expect(wordErrorRate("hello world", "hello world")).toBe(0);
    expect(wordErrorRate("hello world", "hello")).toBe(0.5);
    expect(wordErrorRate("hello world", "hello there")).toBe(0.5);
    expect(wordErrorRate("hello world", "hello wide world")).toBe(0.5);
    expect(wordErrorRate("", "")).toBe(0);
    expect(wordErrorRate("", "extra")).toBe(1);
    expect(characterErrorRate("abc", "axc")).toBeCloseTo(1 / 3);
  });
});

describe("voice-acoustic scorer transcript gates", () => {
  it("requires first token, last token, and exact identifiers", () => {
    const exact = scoreVoiceAcousticFixture(fixture("exact-identifiers-preserved"));
    expect(exact.qualityPassed).toBe(true);
    expect(check(exact, "first-token-retained")).toBe(true);
    expect(check(exact, "last-token-retained")).toBe(true);
    expect(check(exact, "required-identifier-exact-match")).toBe(true);

    const missingIdentifier = scoreVoiceAcousticFixture(fixture("negative-missing-identifier"));
    expect(missingIdentifier.qualityPassed).toBe(false);
    expect(missingIdentifier.gatePassed).toBe(true);
    expect(check(missingIdentifier, "required-identifier-exact-match")).toBe(false);

    const missingTail = scoreVoiceAcousticFixture(fixture("negative-missing-trailing-word"));
    expect(check(missingTail, "last-token-retained")).toBe(false);
  });

  // ─── KEIKO-0280 — boundary-anchored identifier match rejects substrings ───
  it("rejects a required term that appears only as a substring of a longer token", () => {
    // The pre-fix `requiredTerms.every((term) => hypothesis.includes(term))` reported true for
    // "KEIKO-497-B" against "XKEIKO-497-BY" — the exact mis-segmentation failure mode the check exists
    // to detect. The fixed regex anchors the term at non-alnum-non-hyphen boundaries, so this substring
    // no longer counts as a match.
    const embedded: VoiceAcousticFixture = {
      ...fixture("exact-identifiers-preserved"),
      hypothesisTranscript: "Open issue XKEIKO-497-BY and call run abc-123-Z",
    };
    const metrics = deriveVoiceAcousticMetrics(embedded);
    expect(metrics.requiredIdentifierExactMatch).toBe(false);
  });

  it("still accepts a required term at a genuine token boundary (hyphen, whitespace, punctuation)", () => {
    // Positive control: the same required terms embedded normally continue to match. Boundary rule
    // treats hyphens as internal alnum characters, so "KEIKO-497-B" itself matches even after a comma.
    const preserved: VoiceAcousticFixture = {
      ...fixture("exact-identifiers-preserved"),
      hypothesisTranscript: "Open issue KEIKO-497-B, and call run abc-123-Z now",
    };
    const metrics = deriveVoiceAcousticMetrics(preserved);
    expect(metrics.requiredIdentifierExactMatch).toBe(true);
  });
});

describe("voice-acoustic scorer latency and barge-in gates", () => {
  it("applies relaxed noisy-room first-partial threshold but catches delayed partials", () => {
    const noisy = scoreVoiceAcousticFixture(fixture("noisy-room-tolerated"));
    expect(noisy.metrics.firstPartialLatencyMs).toBe(1650);
    expect(check(noisy, "first-partial-latency")).toBe(true);

    const delayed = scoreVoiceAcousticFixture(fixture("negative-delayed-partial"));
    expect(delayed.metrics.firstPartialLatencyMs).toBe(2300);
    expect(check(delayed, "first-partial-latency")).toBe(false);
    expect(delayed.gatePassed).toBe(true);
  });

  it("scores local duck and interrupt ack latency for fast interruptions", () => {
    const fast = scoreVoiceAcousticFixture(fixture("fast-interrupt-ducks-and-acks"));
    expect(fast.metrics.localDuckLatencyMs).toBe(50);
    expect(fast.metrics.interruptAckLatencyMs).toBe(360);
    expect(check(fast, "local-barge-in-duck-latency")).toBe(true);
    expect(check(fast, "interrupt-ack-latency")).toBe(true);

    const slowDuck = scoreVoiceAcousticFixture(fixture("negative-slow-duck"));
    expect(slowDuck.metrics.localDuckLatencyMs).toBe(140);
    expect(check(slowDuck, "local-barge-in-duck-latency")).toBe(false);
    expect(slowDuck.gatePassed).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "fails closed for a non-finite acoustic ceiling (%s)",
    (value) => {
      const source = fixture("headset-clean");
      const result = scoreVoiceAcousticFixture({
        ...source,
        budgets: { ...source.budgets, maxWer: value },
      });
      expect(check(result, "wer")).toBe(false);
      expect(result.qualityPassed).toBe(false);
    },
  );
});

describe("voice-acoustic scorer endpointing and grounded ordering", () => {
  it("passes long-pause and unfinished-utterance endpointing without premature finalization", () => {
    for (const candidate of [
      fixture("long-pause-not-premature"),
      fixture("unfinished-utterance-preserved"),
    ]) {
      const result = scoreVoiceAcousticFixture(candidate);
      expect(result.metrics.prematureFinalization).toBe(false);
      expect(check(result, "premature-finalization")).toBe(true);
      expect(result.qualityPassed).toBe(true);
    }
  });

  it("catches premature finals before speech end", () => {
    const result = scoreVoiceAcousticFixture(fixture("negative-premature-final"));
    expect(result.metrics.prematureFinalization).toBe(true);
    expect(check(result, "premature-finalization")).toBe(false);
    expect(result.gatePassed).toBe(true);
  });

  it("requires grounded tool evidence before answer audio when requested", () => {
    const grounded = scoreVoiceAcousticFixture(fixture("grounded-before-answer"));
    expect(grounded.metrics.groundedToolBeforeAnswer).toBe(true);
    expect(check(grounded, "grounded-tool-before-answer")).toBe(true);

    const bad = scoreVoiceAcousticFixture(fixture("negative-answer-before-grounding"));
    expect(bad.metrics.groundedToolBeforeAnswer).toBe(false);
    expect(check(bad, "grounded-tool-before-answer")).toBe(false);
    expect(bad.gatePassed).toBe(true);
  });

  it("covers exactly the requested positive scenarios", () => {
    const positives = voiceAcousticFixturesForScenario("headset").filter(
      (candidate) => candidate.polarity === "positive",
    );
    expect(positives.map((candidate) => candidate.name)).toEqual(["headset-clean"]);
  });
});

describe("voice-acoustic metrics are content-free", () => {
  it("derives only numeric and boolean metric fields", () => {
    const metrics = deriveVoiceAcousticMetrics(fixture("first-word-retained"));
    for (const value of Object.values(metrics)) {
      expect(value === null || typeof value === "number" || typeof value === "boolean").toBe(true);
    }
  });
});
