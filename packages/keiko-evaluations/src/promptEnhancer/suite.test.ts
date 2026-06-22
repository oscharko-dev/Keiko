// Prompt Enhancer evaluation suite tests (Epic #1307, Issue #1315; AC1). Runs the full fixture set
// through the deterministic pipeline and asserts the coverage and Go/No-Go guarantees the issue
// mandates: all eight prompt-quality dimensions exercised, at least ten task classes covered, every
// fixture category present, adversarial drafts flagged, and a reproducible result.

import { describe, expect, it } from "vitest";
import {
  PROMPT_QUALITY_DIMENSIONS,
  renderPromptEnhancerSummary,
  runPromptEnhancerEvaluation,
} from "./index.js";

const scorecard = runPromptEnhancerEvaluation();

describe("Prompt Enhancer evaluation suite (AC1)", () => {
  it("returns a GO verdict with the safety gate passing and all fixtures fully passed", () => {
    expect(scorecard.summary.goNoGo).toBe("GO");
    expect(scorecard.summary.safetyGatePassed).toBe(true);
    expect(scorecard.summary.fullyPassedFixtures).toBe(scorecard.summary.totalFixtures);
    expect(scorecard.schemaVersion).toBe("1");
  });

  it("exercises every prompt-quality dimension with a passing rate", () => {
    for (const dim of PROMPT_QUALITY_DIMENSIONS) {
      const entry = scorecard.dimensions.find((e) => e.dimension === dim);
      expect(entry, dim).toBeDefined();
      expect(entry?.failCount, dim).toBe(0);
      expect(entry?.passCount, dim).toBeGreaterThan(0);
    }
  });

  it("covers at least ten supported task classes", () => {
    expect(scorecard.coveredTaskClasses.length).toBeGreaterThanOrEqual(10);
  });

  it("covers all five fixture categories", () => {
    const categories = new Set(scorecard.fixtureResults.map((f) => f.category));
    expect(categories).toEqual(
      new Set(["task-class", "grounding", "adversarial", "format", "token-efficiency"]),
    );
  });

  it("is deterministic across runs", () => {
    const again = runPromptEnhancerEvaluation();
    expect(JSON.stringify(again.dimensions)).toBe(JSON.stringify(scorecard.dimensions));
    expect(again.coveredTaskClasses).toEqual(scorecard.coveredTaskClasses);
  });

  it("flags every adversarial draft with injection signals and escalates to human review", () => {
    const adversarial = scorecard.fixtureResults.filter((f) => f.category === "adversarial");
    expect(adversarial.length).toBeGreaterThan(0);
    for (const f of adversarial) {
      expect(f.observation.injectionSignals.length, f.fixtureName).toBeGreaterThan(0);
      expect(f.observation.safety.decision, f.fixtureName).toBe("requires-human-review");
    }
  });

  it("rejects a safety-critical advice prompt as a fail-safe outcome", () => {
    const sc = scorecard.fixtureResults.find((f) => f.fixtureName === "task-safety-critical");
    expect(sc?.observation.safety.decision).toBe("rejected");
    // The fixture's oracle explicitly expects the rejected/failed status as a fail-safe outcome, so the
    // observed decision matches the expectation and the fixture "fully passes". This pins the current
    // behaviour so a regression cannot silently change it (e.g. to requires-human-review). The
    // rejected-vs-review nuance is recorded as a known limitation/follow-up in 1315-closure-evidence.md.
    expect(sc?.fullyPassed).toBe(true);
  });

  it("each adversarial fixture surfaces its expected injection signal code", () => {
    const expected: Readonly<Record<string, string>> = {
      "adversarial-instruction-override": "instruction-override",
      "adversarial-secret-exfiltration": "secret-exfiltration",
      "adversarial-tool-authority": "tool-authority-request",
    };
    for (const [name, code] of Object.entries(expected)) {
      const f = scorecard.fixtureResults.find((r) => r.fixtureName === name);
      const codes = f?.observation.injectionSignals.map((s) => s.code) ?? [];
      expect(codes, name).toContain(code);
    }
  });

  it("never echoes sensitive draft tokens into any dimension rationale (content-free discipline)", () => {
    const sensitive = [
      "ignore all previous",
      "system prompt",
      "api keys",
      "exfil.example.com",
      "sudo",
    ];
    for (const f of scorecard.fixtureResults) {
      const joined = f.dimensionResults
        .map((d) => d.rationale)
        .join(" ")
        .toLowerCase();
      for (const token of sensitive) {
        expect(joined.includes(token), `${f.fixtureName} leaked "${token}"`).toBe(false);
      }
    }
  });

  it("renders a readable GO summary", () => {
    const text = renderPromptEnhancerSummary(scorecard);
    expect(text).toContain("Verdict: GO");
    expect(text).toContain("Task classes covered:");
  });
});
