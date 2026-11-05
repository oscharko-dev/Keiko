// Pair qualification scoring (Issue #4137): one case result per run under child 1's rule, and the
// outcome rule — qualified only with every required seed found, never on a partial run.

import { describe, expect, it } from "vitest";

import type {
  ReviewRunView,
  ReviewSeedCase,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import {
  qualificationOutcome,
  scoreQualification,
  seedCaseResult,
  seedRunResult,
} from "./scoring.js";

const DEFECT: ReviewSeedCase = {
  id: "defect",
  seedClass: "security",
  required: true,
  cleanControl: false,
  expected: { file: "src/a.ts", startLine: 4, endLine: 6 },
};
const CLEAN: ReviewSeedCase = {
  id: "clean",
  seedClass: "maintainability",
  required: false,
  cleanControl: true,
};

function view(
  kind: string,
  lines: readonly number[],
  stale = false,
  reason = kind === "incomplete" ? "files-unprocessed" : "interrupted",
): ReviewRunView {
  return {
    runId: "run",
    settlement: kind === "complete" ? { kind } : { kind, reason },
    stale,
    presentedFindings: lines.map((line) => ({
      report: { file: "src/a.ts", startLine: line, endLine: line },
    })),
  } as unknown as ReviewRunView;
}

describe("pair qualification scoring", () => {
  it("labels each case from its settled run", () => {
    const found = seedRunResult(DEFECT, view("complete", [5]));
    expect(seedCaseResult(DEFECT, found)).toBe("found");
    expect(seedCaseResult(DEFECT, seedRunResult(DEFECT, view("complete", [9])))).toBe("missed");
    expect(seedCaseResult(DEFECT, seedRunResult(DEFECT, view("complete", [5], true)))).toBe(
      "stale",
    );
    expect(seedCaseResult(DEFECT, seedRunResult(DEFECT, view("abandoned", [5])))).toBe(
      "not-scored",
    );
    expect(seedCaseResult(DEFECT, undefined)).toBe("not-scored");
    expect(seedCaseResult(CLEAN, seedRunResult(CLEAN, view("complete", [])))).toBe("clean");
    expect(seedCaseResult(CLEAN, seedRunResult(CLEAN, view("complete", [1])))).toBe("false-alarm");
  });

  // R4130-012 (ADR-0182 D8): a Reviewer that started and then failed (`model-failed`) or ran out of
  // time (`deadline-exceeded`) without presenting anything reviewed nothing. Scoring that run read a
  // gateway failure as a measured "found nothing": a clean control that no model reviewed scored
  // `clean`, and a defect case scored `missed`, which recorded `seed-failed` for the pair. Such a
  // case is not scored, so the qualification ends `incomplete` and records no status.
  // R4130-034: the settlement names only the most consequential reason, so a Reviewer that timed out
  // while a counter-check exhausted the budget settles `budget-exhausted`, and an unchecked or failed
  // counter-check can hide the seed's own candidate. No incomplete reason proves an absence.
  it("does not score an incomplete run that presented nothing", () => {
    for (const reason of [
      "model-failed",
      "deadline-exceeded",
      "budget-exhausted",
      "files-unprocessed",
    ]) {
      const cleanRun = seedRunResult(CLEAN, view("incomplete", [], false, reason));
      const defectRun = seedRunResult(DEFECT, view("incomplete", [], false, reason));
      expect(cleanRun).toBeUndefined();
      expect(seedCaseResult(CLEAN, cleanRun)).toBe("not-scored");
      expect(seedCaseResult(DEFECT, defectRun)).toBe("not-scored");
      const scored = scoreQualification([
        { seed: DEFECT, result: defectRun },
        { seed: CLEAN, result: cleanRun },
      ]);
      expect(scored.unscored).toBe(2);
      expect(scored.score.falseAlarms).toBe(0);
      expect(scored.missedSeedClasses).toEqual([]);
      expect(qualificationOutcome(scored, "none")).toBe("incomplete");
    }
  });

  // R4130-034: a Reviewer that failed after presenting an unrelated finding did not review the
  // rest of the diff, so the seed's absence is not a measured miss either.
  it("does not score a defect missing from an incomplete run that presented something else", () => {
    for (const reason of [
      "model-failed",
      "deadline-exceeded",
      "budget-exhausted",
      "files-unprocessed",
    ]) {
      const run = seedRunResult(DEFECT, view("incomplete", [9], false, reason));
      expect(run).toBeUndefined();
      expect(seedCaseResult(DEFECT, run)).toBe("not-scored");
      const scored = scoreQualification([{ seed: DEFECT, result: run }]);
      expect(scored.missedSeedClasses).toEqual([]);
      expect(qualificationOutcome(scored, "none")).toBe("incomplete");
    }
  });

  it("still scores what a failed Reviewer run presented before it failed", () => {
    const found = seedRunResult(DEFECT, view("incomplete", [5], false, "model-failed"));
    expect(seedCaseResult(DEFECT, found)).toBe("found");
    const alarm = seedRunResult(CLEAN, view("incomplete", [1], false, "deadline-exceeded"));
    expect(seedCaseResult(CLEAN, alarm)).toBe("false-alarm");
  });

  it("qualifies only a complete score with every required seed found", () => {
    const all = scoreQualification([
      { seed: DEFECT, result: seedRunResult(DEFECT, view("complete", [4])) },
      { seed: CLEAN, result: seedRunResult(CLEAN, view("complete", [2])) },
    ]);
    expect(all.score).toMatchObject({ requiredFound: 1, falseAlarms: 1 });
    expect(qualificationOutcome(all, "none")).toBe("seed-qualified");
    expect(qualificationOutcome(all, "cancelled")).toBe("cancelled");
    expect(qualificationOutcome(all, "deadline")).toBe("incomplete");

    const missed = scoreQualification([
      { seed: DEFECT, result: seedRunResult(DEFECT, view("complete", [])) },
    ]);
    expect(missed.missedSeedClasses).toEqual(["security"]);
    expect(qualificationOutcome(missed, "none")).toBe("seed-failed");

    const partial = scoreQualification([{ seed: DEFECT, result: undefined }]);
    expect(partial.unscored).toBe(1);
    expect(partial.missedSeedClasses).toEqual([]);
    expect(qualificationOutcome(partial, "none")).toBe("incomplete");
  });
});
