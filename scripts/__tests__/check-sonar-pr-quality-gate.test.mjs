import { describe, expect, it } from "vitest";

import { evaluateSonarPullRequest, measuresFromPayload } from "../check-sonar-pr-quality-gate.mjs";

const passingMeasures = {
  new_coverage: 86.5,
  new_duplicated_lines_density: 1.2,
  new_lines_to_cover: 40,
  new_security_hotspots_reviewed: 100,
  new_violations: 0,
};

function evaluate(overrides = {}) {
  return evaluateSonarPullRequest({
    analysis: { commitSha: "a".repeat(40), qualityGateStatus: "OK" },
    headSha: "a".repeat(40),
    issuesTotal: 0,
    measures: passingMeasures,
    ...overrides,
  });
}

describe("SonarCloud PR quality gate", () => {
  it("parses SonarCloud's periods array without treating metrics as missing", () => {
    expect(
      measuresFromPayload({
        component: {
          measures: [{ metric: "new_violations", periods: [{ value: "0" }] }],
        },
      }),
    ).toEqual({ new_violations: 0 });
  });

  it("accepts an exact-head analysis with zero findings and sufficient coverage", () => {
    expect(evaluate()).toEqual([]);
  });

  it("fails closed on stale analyses and unresolved findings", () => {
    expect(
      evaluate({
        analysis: { commitSha: "b".repeat(40), qualityGateStatus: "OK" },
        issuesTotal: 1,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("current head"),
        expect.stringContaining("1 unresolved"),
      ]),
    );
  });

  it("rejects insufficient or missing new-code coverage", () => {
    expect(evaluate({ measures: { ...passingMeasures, new_coverage: 84.99 } })).toContain(
      "New-code coverage 84.99% is below 85%.",
    );
    expect(evaluate({ measures: { ...passingMeasures, new_coverage: undefined } })).toContain(
      "New-code coverage is missing despite coverable new lines.",
    );
  });

  it("allows absent coverage only when Sonar reports no coverable new lines", () => {
    expect(
      evaluate({
        measures: { ...passingMeasures, new_coverage: undefined, new_lines_to_cover: 0 },
      }),
    ).toEqual([]);
  });

  it("fails closed when required Sonar measures are absent", () => {
    const failures = evaluate({
      measures: {
        new_coverage: undefined,
        new_duplicated_lines_density: undefined,
        new_lines_to_cover: undefined,
        new_security_hotspots_reviewed: undefined,
        new_violations: undefined,
      },
    });
    expect(failures).toHaveLength(4);
  });

  it("rejects violations, duplication, unreviewed hotspots, and a failed native gate", () => {
    const failures = evaluate({
      analysis: { commitSha: "a".repeat(40), qualityGateStatus: "ERROR" },
      measures: {
        ...passingMeasures,
        new_duplicated_lines_density: 3.01,
        new_security_hotspots_reviewed: 99,
        new_violations: 2,
      },
    });
    expect(failures).toHaveLength(4);
  });
});
