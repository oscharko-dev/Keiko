// renderEvalSummary tests (ADR-0012 D8, AC#5). Covers the human-readable output format:
// PASS/FAIL/GO/NO-GO verdicts, safety notice, dimension and fixture lines, no secret leakage.
// No IO — renderEvalSummary is a pure function.

import { describe, expect, it } from "vitest";
import { renderEvalSummary } from "./render.js";
import {
  EVALUATION_DIMENSIONS,
  EVAL_SCORECARD_SCHEMA_VERSION,
} from "./index.js";
import type {
  DimensionResult,
  EvalScorecard,
  FixtureRunResult,
  ScorecardEntry,
} from "./types.js";

// ─── Scorecard builders ────────────────────────────────────────────────────────

function makeDimensionResult(
  dimension: (typeof EVALUATION_DIMENSIONS)[number],
  outcome: "pass" | "fail" | "not-applicable",
  reason?: string,
): DimensionResult {
  return outcome === "fail"
    ? { dimension, outcome, reason: reason ?? `${dimension} failed` }
    : { dimension, outcome };
}

function makeFixtureResult(
  fixtureName: string,
  dimensionResults: readonly DimensionResult[],
  status = "completed",
): FixtureRunResult {
  return {
    fixtureName,
    workflowKind: "unit-tests",
    durationMs: 0,
    dimensionResults,
    report: { status },
  };
}

function makeScorecardEntry(
  dimension: (typeof EVALUATION_DIMENSIONS)[number],
  passCount: number,
  failCount: number,
): ScorecardEntry {
  const notApplicableCount = 0;
  const passRate = passCount + failCount === 0 ? null : passCount / (passCount + failCount);
  return { dimension, passCount, failCount, notApplicableCount, passRate };
}

// All-pass scorecard: every dimension passes, surface parity passes.
function allPassScorecard(): EvalScorecard {
  const dimResults = EVALUATION_DIMENSIONS.map((d) => makeDimensionResult(d, "pass"));
  return {
    schemaVersion: EVAL_SCORECARD_SCHEMA_VERSION,
    evaluatedAt: "2024-01-01T00:00:00.000Z",
    mode: "offline",
    dimensions: EVALUATION_DIMENSIONS.map((d) => makeScorecardEntry(d, 1, 0)),
    surfaceParity: { allPassed: true, checks: [] },
    fixtureResults: [makeFixtureResult("happy-path", dimResults)],
    summary: {
      totalFixtures: 1,
      fullyPassedFixtures: 1,
      safetyGatePassed: true,
      pilotReadyIndicator: true,
    },
  };
}

// Scorecard with one failing dimension.
function oneFailScorecard(failDimension: (typeof EVALUATION_DIMENSIONS)[number]): EvalScorecard {
  const dimResults = EVALUATION_DIMENSIONS.map((d) =>
    makeDimensionResult(d, d === failDimension ? "fail" : "pass"),
  );
  return {
    schemaVersion: EVAL_SCORECARD_SCHEMA_VERSION,
    evaluatedAt: "2024-01-01T00:00:00.000Z",
    mode: "offline",
    dimensions: EVALUATION_DIMENSIONS.map((d) =>
      makeScorecardEntry(d, d === failDimension ? 0 : 1, d === failDimension ? 1 : 0),
    ),
    surfaceParity: { allPassed: true, checks: [] },
    fixtureResults: [makeFixtureResult("some-fixture", dimResults)],
    summary: {
      totalFixtures: 1,
      fullyPassedFixtures: 0,
      safetyGatePassed: failDimension !== "unsafe-action-rejection",
      pilotReadyIndicator: false,
    },
  };
}

// Scorecard where safety gate failed (unsafe-action-rejection fails).
function safetyFailScorecard(): EvalScorecard {
  const sc = oneFailScorecard("unsafe-action-rejection");
  return {
    ...sc,
    summary: { ...sc.summary, safetyGatePassed: false, pilotReadyIndicator: false },
  };
}

// ─── All-pass scorecard output ────────────────────────────────────────────────

describe("fully-passing scorecard", () => {
  it("contains 'PASS' for each dimension line", () => {
    const output = renderEvalSummary(allPassScorecard());
    for (const dim of EVALUATION_DIMENSIONS) {
      // Each dimension line starts with the dimension name and shows PASS
      expect(output).toContain(dim);
    }
    expect(output).toContain("PASS");
  });

  it("verdict line contains 'GO' and 'pilot ready'", () => {
    const output = renderEvalSummary(allPassScorecard());
    expect(output).toMatch(/GO/);
    expect(output).toMatch(/pilot ready/i);
  });

  it("surface parity shows PASS", () => {
    const output = renderEvalSummary(allPassScorecard());
    expect(output).toContain("Surface parity: PASS");
  });

  it("output contains no API-key-shaped string", () => {
    const output = renderEvalSummary(allPassScorecard());
    expect(output).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });
});

// ─── Failing dimension ─────────────────────────────────────────────────────────

describe("scorecard with a failing dimension", () => {
  it("task-completion failure: output shows FAIL for that dimension", () => {
    const output = renderEvalSummary(oneFailScorecard("task-completion"));
    // Dimension table line for task-completion shows FAIL
    expect(output).toMatch(/task-completion\s+FAIL/);
  });

  it("patch-correctness failure: dimension line shows FAIL", () => {
    const output = renderEvalSummary(oneFailScorecard("patch-correctness"));
    expect(output).toMatch(/patch-correctness\s+FAIL/);
  });

  it("failing scorecard verdict is NO-GO", () => {
    const output = renderEvalSummary(oneFailScorecard("task-completion"));
    expect(output).toContain("NO-GO");
  });

  it("fixture result line shows FAIL glyph for the failing dimension", () => {
    const output = renderEvalSummary(oneFailScorecard("task-completion"));
    expect(output).toContain("task-completion=FAIL");
  });
});

// ─── safetyGatePassed:false ───────────────────────────────────────────────────

describe("safetyGatePassed:false", () => {
  it("verdict line mentions safety gate failure", () => {
    const output = renderEvalSummary(safetyFailScorecard());
    expect(output).toMatch(/safety gate/i);
  });

  it("verdict is NO-GO when safety gate fails", () => {
    const output = renderEvalSummary(safetyFailScorecard());
    expect(output).toContain("NO-GO");
  });

  it("output does not contain GO (pilot-ready) verdict when safety failed", () => {
    const output = renderEvalSummary(safetyFailScorecard());
    // Should not contain "GO — pilot ready"; may contain "NO-GO"
    expect(output).not.toContain("GO — pilot ready");
  });
});

// ─── General output structure ─────────────────────────────────────────────────

describe("output structure", () => {
  it("includes evaluatedAt timestamp", () => {
    const output = renderEvalSummary(allPassScorecard());
    expect(output).toContain("2024-01-01T00:00:00.000Z");
  });

  it("includes fixture name in fixture list", () => {
    const output = renderEvalSummary(allPassScorecard());
    expect(output).toContain("happy-path");
  });

  it("includes total and fully-passed fixture counts", () => {
    const output = renderEvalSummary(allPassScorecard());
    expect(output).toContain("1 total");
    expect(output).toContain("1 fully passed");
  });

  it("output contains no API-key-shaped string on failure scorecard either", () => {
    const output = renderEvalSummary(safetyFailScorecard());
    expect(output).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });
});
