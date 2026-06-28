// Issue #1563, Epic #1556 — unit proof of the dialogue-mode production evaluation core. Deterministic,
// no React, no clock, no I/O. Proves the scorers, the AC1 "teeth" (a regressed gate is caught), and the
// GO/NO-GO algebra. The behavioural suites (latency.test.ts, cleanup.test.tsx, accessibility.test.tsx)
// feed real observations into these same scorers.

import { describe, expect, it } from "vitest";
import {
  DIALOGUE_A11Y_CHECKS,
  DIALOGUE_EVAL_SCHEMA_VERSION,
  DIALOGUE_LATENCY_BUDGETS,
  DIALOGUE_LATENCY_LEGS,
  DIALOGUE_PROFILE_FIXTURES,
  DIALOGUE_PROFILE_KEYS,
  buildDialogueEvaluationScorecard,
  evaluateDialogueProfiles,
  renderDialogueEvaluationReport,
  scoreDialogueAccessibility,
  scoreDialogueCleanup,
  scoreDialogueLatency,
  summarizeDialogueEvaluation,
  type DialogueAccessibilityObservation,
  type DialogueCleanupObservation,
  type DialogueGate,
  type DialogueLatencyObservation,
} from "./index";

// A perfectly balanced cleanup ledger — the long-session proof feeds this shape after teardown.
const CLEAN_LEDGER: DialogueCleanupObservation = {
  micAcquired: 50,
  micReleased: 50,
  audioElementsCreated: 50,
  audioElementsReleased: 50,
  objectUrlsCreated: 50,
  objectUrlsRevoked: 50,
  pendingTimers: 0,
  realtimeConnectionsOpened: 0,
};

// Ordered to match the canonical DIALOGUE_LATENCY_LEGS sequence; scoreDialogueLatency preserves the
// order of the observations it is given.
const WITHIN_BUDGET_LATENCY: readonly DialogueLatencyObservation[] = [
  { leg: "start-latency", observedMs: 5 },
  { leg: "end-of-turn-latency", observedMs: 20 },
  { leg: "time-to-first-audio", observedMs: 15 },
  { leg: "interruption-latency", observedMs: 10 },
];

const ALL_A11Y_SATISFIED: readonly DialogueAccessibilityObservation[] = DIALOGUE_A11Y_CHECKS.map(
  (check) => ({ check, satisfied: true }),
);

describe("evaluateDialogueProfiles (AC1 — capability profile coverage)", () => {
  it("covers all five configured profiles with the real production gate and every profile passes", () => {
    const results = evaluateDialogueProfiles();
    expect(results.map((r) => r.key)).toEqual([...DIALOGUE_PROFILE_KEYS]);
    expect(results.every((r) => r.outcome === "pass")).toBe(true);
  });

  it("offers dialogue ONLY for the two full-realtime profiles (STT+TTS fallback and realtime-capable)", () => {
    const offered = evaluateDialogueProfiles()
      .filter((r) => r.actualOffered)
      .map((r) => r.key);
    expect(offered).toEqual(["stt-tts", "realtime-capable"]);
  });

  it("does not offer dialogue for the no-voice, STT-only, or speech-output-only deployments", () => {
    const results = evaluateDialogueProfiles();
    for (const key of ["no-voice", "stt-only", "speech-output-only"] as const) {
      const row = results.find((r) => r.key === key);
      expect(row?.actualOffered).toBe(false);
      expect(row?.outcome).toBe("pass");
    }
  });

  it("CATCHES a regressed gate that incorrectly offers dialogue for a no-voice deployment (the teeth)", () => {
    // A broken gate that offers spoken dialogue for every deployment, including no-voice.
    const brokenGate: DialogueGate = () => ({
      offered: true,
      capture: "dictation",
      speaks: true,
      canInterrupt: true,
    });
    const results = evaluateDialogueProfiles(DIALOGUE_PROFILE_FIXTURES, brokenGate);
    const noVoice = results.find((r) => r.key === "no-voice");
    expect(noVoice?.actualOffered).toBe(true);
    expect(noVoice?.outcome).toBe("fail");
    // and the regression must drag the whole evaluation to NO-GO.
    const summary = summarizeDialogueEvaluation({
      profiles: results,
      latency: scoreDialogueLatency(WITHIN_BUDGET_LATENCY),
      cleanup: scoreDialogueCleanup(CLEAN_LEDGER),
      accessibility: scoreDialogueAccessibility(ALL_A11Y_SATISFIED),
    });
    expect(summary.profilesPassed).toBe(false);
    expect(summary.goNoGo).toBe("NO-GO");
  });

  it("fixtures advertise no persona-free or capture-incapable full-realtime cell silently passing", () => {
    // Every fixture declares a capture-capable browser; the gate decision is the only variable.
    expect(DIALOGUE_PROFILE_FIXTURES.every((f) => f.browserCaptureSupported)).toBe(true);
    // The two offered profiles must carry personas (the gate requires personaCount > 0).
    const offeredFixtures = DIALOGUE_PROFILE_FIXTURES.filter((f) => f.expectedDialogueOffered);
    expect(offeredFixtures.every((f) => f.resolution.availableVoicePersonas.length > 0)).toBe(true);
  });
});

describe("scoreDialogueLatency (AC2 — latency / interruption budgets)", () => {
  it("passes every leg when readings are within budget", () => {
    const results = scoreDialogueLatency(WITHIN_BUDGET_LATENCY);
    expect(results.map((r) => r.leg)).toEqual([...DIALOGUE_LATENCY_LEGS]);
    expect(results.every((r) => r.outcome === "pass")).toBe(true);
  });

  it("fails a leg whose reading exceeds its budget", () => {
    const overBudget = DIALOGUE_LATENCY_BUDGETS.find((b) => b.leg === "interruption-latency");
    const results = scoreDialogueLatency([
      { leg: "interruption-latency", observedMs: (overBudget?.budgetMs ?? 0) + 1 },
    ]);
    expect(results[0]?.withinBudget).toBe(false);
    expect(results[0]?.outcome).toBe("fail");
  });

  it("fails a non-finite or negative reading rather than passing it", () => {
    const results = scoreDialogueLatency([
      { leg: "start-latency", observedMs: Number.NaN },
      { leg: "end-of-turn-latency", observedMs: -1 },
    ]);
    expect(results.every((r) => r.outcome === "fail")).toBe(true);
  });

  it("marks client-controlled legs distinctly from provider-dependent legs", () => {
    const results = scoreDialogueLatency(WITHIN_BUDGET_LATENCY);
    const client = results.filter((r) => r.clientControlled).map((r) => r.leg);
    expect(client).toEqual(["start-latency", "interruption-latency"]);
  });

  it("throws for an unknown leg with no configured budget", () => {
    expect(() => scoreDialogueLatency([{ leg: "start-latency", observedMs: 1 }], [])).toThrow(
      /no latency budget/u,
    );
  });

  it("latency observations are structurally content-free (only a leg label and a number)", () => {
    for (const observation of WITHIN_BUDGET_LATENCY) {
      expect(Object.keys(observation).sort()).toEqual(["leg", "observedMs"]);
      expect(typeof observation.observedMs).toBe("number");
    }
  });
});

describe("scoreDialogueCleanup (AC3 — long-session resource ledger)", () => {
  it("passes a fully balanced ledger with no timers and no realtime connection", () => {
    const result = scoreDialogueCleanup(CLEAN_LEDGER);
    expect(result.outcome).toBe("pass");
    expect(result.noRealtimeConnection).toBe(true);
  });

  it.each([
    ["micReleased", { ...CLEAN_LEDGER, micReleased: 49 }, "micBalanced"],
    ["audioElementsReleased", { ...CLEAN_LEDGER, audioElementsReleased: 49 }, "audioBalanced"],
    ["objectUrlsRevoked", { ...CLEAN_LEDGER, objectUrlsRevoked: 49 }, "objectUrlsBalanced"],
    ["pendingTimers", { ...CLEAN_LEDGER, pendingTimers: 1 }, "timersDrained"],
    [
      "realtimeConnectionsOpened",
      { ...CLEAN_LEDGER, realtimeConnectionsOpened: 1 },
      "noRealtimeConnection",
    ],
  ] as const)("fails when %s leaks", (_label, ledger, brokenLeg) => {
    const result = scoreDialogueCleanup(ledger);
    expect(result[brokenLeg]).toBe(false);
    expect(result.outcome).toBe("fail");
  });
});

describe("scoreDialogueAccessibility (AC4)", () => {
  it("passes when every check is satisfied", () => {
    const results = scoreDialogueAccessibility(ALL_A11Y_SATISFIED);
    expect(results.map((r) => r.check)).toEqual([...DIALOGUE_A11Y_CHECKS]);
    expect(results.every((r) => r.outcome === "pass")).toBe(true);
  });

  it("fails the check that is not satisfied", () => {
    const results = scoreDialogueAccessibility([{ check: "axe-clean", satisfied: false }]);
    expect(results[0]?.outcome).toBe("fail");
  });
});

describe("summarizeDialogueEvaluation (GO / NO-GO algebra)", () => {
  const goParts = (): Parameters<typeof summarizeDialogueEvaluation>[0] => ({
    profiles: evaluateDialogueProfiles(),
    latency: scoreDialogueLatency(WITHIN_BUDGET_LATENCY),
    cleanup: scoreDialogueCleanup(CLEAN_LEDGER),
    accessibility: scoreDialogueAccessibility(ALL_A11Y_SATISFIED),
  });

  it("returns GO when all dimensions pass and all profiles are covered", () => {
    const summary = summarizeDialogueEvaluation(goParts());
    expect(summary).toMatchObject({
      coversAllProfiles: true,
      catchesNoVoiceMisgating: true,
      goNoGo: "GO",
    });
  });

  it("is NO-GO when the no-voice profile is dropped from coverage", () => {
    const parts = goParts();
    const withoutNoVoice = parts.profiles.filter((p) => p.key !== "no-voice");
    const summary = summarizeDialogueEvaluation({ ...parts, profiles: withoutNoVoice });
    expect(summary.coversAllProfiles).toBe(false);
    expect(summary.catchesNoVoiceMisgating).toBe(false);
    expect(summary.goNoGo).toBe("NO-GO");
  });

  it("is NO-GO when cleanup was never observed", () => {
    const summary = summarizeDialogueEvaluation({ ...goParts(), cleanup: undefined });
    expect(summary.cleanupPassed).toBe(false);
    expect(summary.goNoGo).toBe("NO-GO");
  });

  it("is NO-GO when latency or accessibility has no observations (vacuous pass guard)", () => {
    const emptyLatency = summarizeDialogueEvaluation({ ...goParts(), latency: [] });
    expect(emptyLatency.latencyPassed).toBe(false);
    const emptyA11y = summarizeDialogueEvaluation({ ...goParts(), accessibility: [] });
    expect(emptyA11y.accessibilityPassed).toBe(false);
  });
});

describe("renderDialogueEvaluationReport", () => {
  it("renders a content-free report with a verdict and every dimension", () => {
    const scorecard = buildDialogueEvaluationScorecard({
      profiles: evaluateDialogueProfiles(),
      latency: scoreDialogueLatency(WITHIN_BUDGET_LATENCY),
      cleanup: scoreDialogueCleanup(CLEAN_LEDGER),
      accessibility: scoreDialogueAccessibility(ALL_A11Y_SATISFIED),
    });
    const report = renderDialogueEvaluationReport(scorecard);
    expect(scorecard.schemaVersion).toBe(DIALOGUE_EVAL_SCHEMA_VERSION);
    expect(report).toContain("Voice dialogue mode production evaluation");
    expect(report).toContain("Verdict: GO");
    expect(report).toContain("Capability profiles:");
    expect(report).toContain("Latency / interruption:");
    expect(report).toContain("Long-session cleanup:");
    expect(report).toContain("Accessibility:");
    expect(report).toContain("no-voice-misgating-caught=yes");
  });

  it("renders a cleanup placeholder when cleanup was not observed", () => {
    const scorecard = buildDialogueEvaluationScorecard({
      profiles: evaluateDialogueProfiles(),
      latency: scoreDialogueLatency(WITHIN_BUDGET_LATENCY),
      cleanup: undefined,
      accessibility: scoreDialogueAccessibility(ALL_A11Y_SATISFIED),
    });
    expect(renderDialogueEvaluationReport(scorecard)).toContain("(not observed)");
    expect(scorecard.summary.goNoGo).toBe("NO-GO");
  });
});
