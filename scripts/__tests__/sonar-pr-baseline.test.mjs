import { describe, expect, it } from "vitest";

import { runSonarPullRequestGate } from "../check-sonar-pr-quality-gate.mjs";
import {
  KEIKO_GATE_CONDITIONS,
  KEIKO_GATE_ID,
  KEIKO_GATE_NAME,
} from "../sonar-quality-gate-contract.mjs";

const epic = "codex/epic-anti-slop-quality";
const base = "b".repeat(40);
const headSha = "a".repeat(40);

function fixture({
  baseRef = epic,
  reportedBase = baseRef,
  target = baseRef,
  production = false,
  coverage = 86,
  metricsOverride = {},
} = {}) {
  const execute = () => (production ? "M\tpackages/keiko-tools/src/tool.ts" : "M\tREADME.md");
  const metrics = {
    new_violations: 0,
    new_lines: 12,
    new_lines_to_cover: 12,
    new_coverage: coverage,
    new_duplicated_lines: 0,
    new_security_hotspots: 0,
    ...metricsOverride,
  };
  const load = async (path) => {
    if (path.includes("project_pull_requests"))
      return {
        pullRequests: [
          {
            key: "4007",
            base: reportedBase,
            target,
            commit: { sha: headSha },
            status: { qualityGateStatus: "OK" },
          },
        ],
      };
    if (path.includes("issues/search")) return { total: 0 };
    if (path.includes("qualitygates/show"))
      return {
        id: Number(KEIKO_GATE_ID),
        name: KEIKO_GATE_NAME,
        conditions: KEIKO_GATE_CONDITIONS,
      };
    const values = path.includes("metricKeys=security_hotspots")
      ? { security_hotspots: 0 }
      : metrics;
    return {
      component: {
        measures: Object.entries(values).map(([metric, value]) => ({
          metric,
          value: String(value),
        })),
      },
    };
  };
  return { base, baseRef, execute, headSha, load, log: () => undefined, pullRequest: "4007" };
}

describe("Sonar PR comparison baseline (#3915)", () => {
  it.each([
    ["unknown comparison branch", { reportedBase: "unaccepted" }],
    ["missing comparison branch", { reportedBase: null }],
    ["wrong target", { target: "dev" }],
    ["missing target", { target: null }],
    ["missing expected branch", { baseRef: null }],
  ])("rejects %s before a documentation-only child can skip rate checks", async (_label, input) => {
    await expect(runSonarPullRequestGate(fixture(input))).rejects.toThrow(/baseline/iu);
  });

  it.each([
    [{ new_coverage: 82 }, "New-code coverage condition failed at 82%."],
    [
      { new_duplicated_lines: 1, new_duplicated_lines_density: 3.01 },
      "New-code duplication condition failed at 3.01%.",
    ],
    [
      { new_security_hotspots: 1, new_security_hotspots_reviewed: 99 },
      "New-code security-hotspot review condition failed at 99%.",
    ],
  ])(
    "enforces failing rate %j for a documentation-only epic child compared to dev",
    async (metricsOverride, message) => {
      await expect(
        runSonarPullRequestGate(fixture({ reportedBase: "dev", metricsOverride })),
      ).rejects.toThrow(message);
      await expect(
        runSonarPullRequestGate(fixture({ reportedBase: "dev" })),
      ).resolves.toBeUndefined();
    },
  );

  it.each(["dev", epic])(
    "accepts a documentation-only change with the exact %s baseline",
    async (baseRef) => {
      await expect(runSonarPullRequestGate(fixture({ baseRef }))).resolves.toBeUndefined();
    },
  );

  it("retains the coverage floor when the correct epic baseline contains changed product code", async () => {
    await expect(
      runSonarPullRequestGate(fixture({ production: true, coverage: 82 })),
    ).rejects.toThrow("New-code coverage condition failed at 82%.");
    await expect(runSonarPullRequestGate(fixture({ production: true }))).resolves.toBeUndefined();
  });

  it("rejects missing epic applicability metrics and permits explicit zero counts", async () => {
    await expect(
      runSonarPullRequestGate(
        fixture({
          metricsOverride: {
            new_lines: undefined,
            new_lines_to_cover: undefined,
          },
        }),
      ),
    ).rejects.toThrow("New-code line count metric is missing.");
    await expect(
      runSonarPullRequestGate(
        fixture({
          metricsOverride: {
            new_lines: 0,
            new_lines_to_cover: 0,
            new_coverage: undefined,
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
