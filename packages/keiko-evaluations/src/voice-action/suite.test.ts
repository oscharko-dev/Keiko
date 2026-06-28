// Voice Action Governance evaluation suite tests (Epic #491, Issue #503; AC1-AC5). Runs the full
// fixture set through the deterministic derivation and asserts the coverage and Go/No-Go guarantees the
// issue mandates: all six security dimensions exercised, the required fixture categories present, both
// no-voice and voice-enabled profiles covered, a reproducible result, and — the load-bearing security
// invariant — no committed transcript text ever leaks into the scorecard.

import { describe, expect, it } from "vitest";
import {
  VOICE_ACTION_DIMENSIONS,
  VOICE_ACTION_FIXTURE_CATEGORIES,
  renderVoiceActionSummary,
  runVoiceActionEvaluation,
  voiceActionFixtureByName,
  voiceActionFixturesForCategory,
} from "./index.js";

const scorecard = runVoiceActionEvaluation();

describe("Voice Action Governance evaluation suite (AC1-AC5)", () => {
  it("returns a GO verdict with every fixture fully passed", () => {
    expect(scorecard.summary.goNoGo).toBe("GO");
    expect(scorecard.summary.fullyPassedFixtures).toBe(scorecard.summary.totalFixtures);
    expect(scorecard.summary.totalFixtures).toBeGreaterThan(0);
    expect(scorecard.schemaVersion).toBe("1");
  });

  it("exercises every security dimension with no failures", () => {
    for (const dim of VOICE_ACTION_DIMENSIONS) {
      const entry = scorecard.dimensions.find((e) => e.dimension === dim);
      expect(entry, dim).toBeDefined();
      expect(entry?.failCount, dim).toBe(0);
      expect(entry?.passCount, dim).toBeGreaterThan(0);
    }
  });

  it("covers all three fixture categories", () => {
    const categories = new Set(scorecard.fixtureResults.map((f) => f.category));
    expect(categories).toEqual(new Set(VOICE_ACTION_FIXTURE_CATEGORIES));
  });

  it("covers the issue's required adversarial cases", () => {
    const required = [
      "adversarial-injection",
      "adversarial-misrecognition",
      "adversarial-partial-only",
      "adversarial-correction",
      "adversarial-interruption",
      "adversarial-denied-capability",
    ];
    for (const name of required) {
      expect(voiceActionFixtureByName(name), name).toBeDefined();
    }
  });

  it("covers both no-voice and voice-enabled profiles (GO/NO-GO gate)", () => {
    expect(scorecard.summary.coversNoVoiceProfile).toBe(true);
    expect(scorecard.summary.coversVoiceProfile).toBe(true);
    expect(scorecard.fixtureResults.some((f) => !f.observation.gatingAllowed)).toBe(true);
    expect(scorecard.fixtureResults.some((f) => f.observation.gatingAllowed)).toBe(true);
  });

  it("proves no-voice and denied profiles produce no proposal (AC1 dormancy)", () => {
    for (const name of [
      "no-voice-dormant",
      "speech-output-dormant",
      "adversarial-denied-capability",
    ]) {
      const result = scorecard.fixtureResults.find((f) => f.fixtureName === name);
      expect(result?.observation.proposal, name).toBeUndefined();
      expect(result?.observation.gatingAllowed, name).toBe(false);
    }
  });

  it("proves a partial-only transcript never proposes (AC2 committed-only)", () => {
    const result = scorecard.fixtureResults.find(
      (f) => f.fixtureName === "adversarial-partial-only",
    );
    expect(result?.observation.gatingAllowed).toBe(true);
    expect(result?.observation.proposal).toBeUndefined();
    expect(result?.observation.committedSegmentCount).toBe(0);
  });

  it("proves an injection attempt never read-only-classifies and always confirms (AC3)", () => {
    const result = scorecard.fixtureResults.find((f) => f.fixtureName === "adversarial-injection");
    const proposal = result?.observation.proposal;
    if (proposal === undefined) {
      throw new Error("expected the injection fixture to derive a proposal");
    }
    expect(proposal.effectClass).not.toBe("read-only");
    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.state).toBe("awaiting-confirmation");
  });

  it("proves correction and interruption change the confirmation seed (AC4)", () => {
    for (const name of ["adversarial-correction", "adversarial-interruption"]) {
      const result = scorecard.fixtureResults.find((f) => f.fixtureName === name);
      const staleness = result?.observation.staleness;
      if (staleness === undefined) {
        throw new Error(`expected ${name} to derive a staleness trajectory`);
      }
      expect(staleness.seedChanged, name).toBe(true);
      expect(staleness.bothSeedsPresent, name).toBe(true);
    }
  });

  it("proves every audit record is content-free (AC5)", () => {
    const forbidden = ["text", "audio", "transcript", "raw"];
    for (const result of scorecard.fixtureResults) {
      const keys = Object.keys(result.observation.audit).map((k) => k.toLowerCase());
      for (const fragment of forbidden) {
        expect(
          keys.some((k) => k.includes(fragment)),
          `${result.fixtureName} audit key contains "${fragment}"`,
        ).toBe(false);
      }
    }
  });

  it("never leaks committed transcript text into the scorecard (content-free discipline)", () => {
    // Every committed verb / noun used in a fixture's committed text. None may appear anywhere in the
    // rendered scorecard or its serialized form — the proof that the eval keeps the transcript on-host.
    const leakFragments = [
      "invoice",
      "funds",
      "tickets",
      "customer",
      "everything",
      "audit log",
      "database",
      "staging",
      "release",
      "users table",
      "quarterly",
      "scheduled",
    ];
    const serialized = JSON.stringify(scorecard).toLowerCase();
    const rendered = renderVoiceActionSummary(scorecard).toLowerCase();
    for (const fragment of leakFragments) {
      expect(serialized.includes(fragment), `serialized leaked "${fragment}"`).toBe(false);
      expect(rendered.includes(fragment), `rendered leaked "${fragment}"`).toBe(false);
    }
  });

  it("is deterministic across runs", () => {
    const again = runVoiceActionEvaluation();
    expect(JSON.stringify(again.dimensions)).toBe(JSON.stringify(scorecard.dimensions));
    expect(again.coveredEffectClasses).toEqual(scorecard.coveredEffectClasses);
    expect(JSON.stringify(again.fixtureResults)).toBe(JSON.stringify(scorecard.fixtureResults));
  });

  it("covers a spread of effect classes including the fail-closed and destructive ends", () => {
    const classes = new Set(scorecard.coveredEffectClasses);
    expect(classes.has("read-only")).toBe(true);
    expect(classes.has("mutating")).toBe(true);
    expect(classes.has("destructive")).toBe(true);
    expect(classes.has("external-effect")).toBe(true);
    // The security-critical fail-closed default: committed text matching no marker classifies `unknown`
    // and must still be exercised so the fail-closed path is proven, not merely asserted in the contract.
    expect(classes.has("unknown")).toBe(true);
  });

  it("emits the covered effect classes in a canonical sorted order", () => {
    const sorted = [...scorecard.coveredEffectClasses].sort();
    expect(scorecard.coveredEffectClasses).toEqual(sorted);
  });

  it("proves the fail-closed `unknown` fixture confirms and fully passes (AC3, GO preserved)", () => {
    const result = scorecard.fixtureResults.find(
      (f) => f.fixtureName === "voice-unknown-fail-closed",
    );
    const proposal = result?.observation.proposal;
    if (proposal === undefined) {
      throw new Error("expected the fail-closed fixture to derive a proposal");
    }
    expect(proposal.effectClass).toBe("unknown");
    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.state).toBe("awaiting-confirmation");
    expect(result?.fullyPassed).toBe(true);
    expect(scorecard.summary.goNoGo).toBe("GO");
  });

  it("resolves fixtures by category and by name", () => {
    expect(voiceActionFixturesForCategory("adversarial").length).toBeGreaterThan(0);
    expect(voiceActionFixtureByName("voice-read-only")).toBeDefined();
    expect(voiceActionFixtureByName("does-not-exist")).toBeUndefined();
  });

  it("renders a readable GO summary", () => {
    const text = renderVoiceActionSummary(scorecard);
    expect(text).toContain("Verdict: GO");
    expect(text).toContain("Effect classes covered:");
    expect(text).toContain("Profile coverage:");
  });
});
