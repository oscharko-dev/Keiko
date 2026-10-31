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

function view(kind: string, lines: readonly number[], stale = false): ReviewRunView {
  return {
    runId: "run",
    settlement: kind === "complete" ? { kind } : { kind, reason: "interrupted" },
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
    expect(seedCaseResult(DEFECT, seedRunResult(DEFECT, view("incomplete", [])))).toBe("missed");
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
