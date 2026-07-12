import { describe, expect, it, vi } from "vitest";

import {
  evaluateSonarPullRequest,
  executeSonarPullRequestGateCli,
  measuresFromPayload,
  runSonarPullRequestGate,
  runSonarPullRequestGateCli,
  sonarJson,
} from "../check-sonar-pr-quality-gate.mjs";

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

function jsonResponse(payload) {
  return { json: async () => payload, ok: true, status: 200 };
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
    expect(
      measuresFromPayload({
        component: {
          measures: [
            { metric: "period", period: { value: "1" } },
            { metric: "value", value: "2" },
            { metric: "invalid", value: "not-a-number" },
          ],
        },
      }),
    ).toEqual({ invalid: undefined, period: 1, value: 2 });
    expect(measuresFromPayload({})).toEqual({});
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
    expect(evaluate({ analysis: undefined })).toEqual(
      expect.arrayContaining([
        "SonarCloud has no analysis for this pull request.",
        "SonarCloud analysis is not bound to the current head commit.",
        "SonarCloud native quality gate is missing.",
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
    expect(failures).toContain("New-code violation metric is missing.");
    expect(failures).not.toContain(expect.stringContaining("undefined"));
  });

  it("reports a missing issue total explicitly", () => {
    const failures = evaluate({ issuesTotal: undefined });
    expect(failures).toContain("SonarCloud issue total is missing.");
    expect(failures).not.toContain(expect.stringContaining("undefined"));
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

  it("loads and validates live-shaped Sonar API evidence", async () => {
    const headSha = "a".repeat(40);
    const logs = [];
    const load = async (path) => {
      if (path.includes("project_pull_requests"))
        return {
          pullRequests: [
            { commit: { sha: headSha }, key: "2316", status: { qualityGateStatus: "OK" } },
          ],
        };
      if (path.includes("issues/search")) return { total: 0 };
      return {
        component: {
          measures: Object.entries(passingMeasures).map(([metric, measure]) => ({
            metric,
            periods: [{ value: String(measure) }],
          })),
        },
      };
    };
    await expect(
      runSonarPullRequestGate({
        headSha,
        load,
        log: (message) => logs.push(message),
        pullRequest: "2316",
        token: "redacted",
      }),
    ).resolves.toBeUndefined();
    expect(logs).toEqual([`sonar-pr-quality-gate: PASS - PR #2316 is clean at ${headSha}.`]);
  });

  it("sends a bearer token and fails closed on Sonar API errors", async () => {
    const calls = [];
    await expect(
      sonarJson("/api/test", "secret", async (url, init) => {
        calls.push([url, init]);
        return jsonResponse({ ok: true });
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      ["https://sonarcloud.io/api/test", { headers: { Authorization: "Bearer secret" } }],
    ]);
    await expect(
      sonarJson("/api/test", "", async () => ({ ok: false, status: 503 })),
    ).rejects.toThrow("SonarCloud API returned 503");
    await expect(
      sonarJson("/api/test", undefined, async (_url, init) => {
        expect(init).toEqual({ headers: {} });
        return jsonResponse({ anonymous: true });
      }),
    ).resolves.toEqual({ anonymous: true });
  });

  it("adapts exact-head runtime variables and reports missing variables", async () => {
    const runs = [];
    await runSonarPullRequestGateCli({
      env: { SONAR_HEAD_SHA: "head", SONAR_PULL_REQUEST: "2316", SONAR_TOKEN: "token" },
      run: async (input) => runs.push(input),
    });
    expect(runs).toEqual([{ headSha: "head", pullRequest: "2316", token: "token" }]);

    const errors = [];
    const exitCodes = [];
    await executeSonarPullRequestGateCli({
      env: {},
      error: (message) => errors.push(message),
      setExitCode: (value) => exitCodes.push(value),
    });
    expect(errors).toEqual([
      "sonar-pr-quality-gate: FAIL - SONAR_PULL_REQUEST and SONAR_HEAD_SHA are required.",
    ]);
    expect(exitCodes).toEqual([1]);
  });

  it("fails the live-shaped gate when the PR analysis is absent", async () => {
    const load = async (path) => {
      if (path.includes("project_pull_requests")) return { pullRequests: [] };
      if (path.includes("issues/search")) return { total: 0 };
      return { component: { measures: [] } };
    };
    await expect(
      runSonarPullRequestGate({ headSha: "head", load, pullRequest: "2316" }),
    ).rejects.toThrow("SonarCloud has no analysis");
  });

  it("uses process runtime variables and default CLI error reporting", async () => {
    const previous = {
      head: process.env.SONAR_HEAD_SHA,
      pullRequest: process.env.SONAR_PULL_REQUEST,
      token: process.env.SONAR_TOKEN,
    };
    const runs = [];
    process.env.SONAR_HEAD_SHA = "head";
    process.env.SONAR_PULL_REQUEST = "2316";
    delete process.env.SONAR_TOKEN;
    try {
      await runSonarPullRequestGateCli({ run: async (input) => runs.push(input) });
      expect(runs).toEqual([{ headSha: "head", pullRequest: "2316", token: undefined }]);
    } finally {
      restoreEnvironment(previous);
    }

    const env = {};
    const exitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await executeSonarPullRequestGateCli({ env });
      expect(error).toHaveBeenCalledWith(
        "sonar-pr-quality-gate: FAIL - SONAR_PULL_REQUEST and SONAR_HEAD_SHA are required.",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      error.mockRestore();
    }
  });
});

function restoreEnvironment(previous) {
  if (previous.head === undefined) delete process.env.SONAR_HEAD_SHA;
  else process.env.SONAR_HEAD_SHA = previous.head;
  if (previous.pullRequest === undefined) delete process.env.SONAR_PULL_REQUEST;
  else process.env.SONAR_PULL_REQUEST = previous.pullRequest;
  if (previous.token === undefined) delete process.env.SONAR_TOKEN;
  else process.env.SONAR_TOKEN = previous.token;
}
