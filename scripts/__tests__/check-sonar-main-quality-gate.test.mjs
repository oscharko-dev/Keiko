import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  executeSonarMainGateCli,
  runSonarMainGate,
  runSonarMainGateCli,
} from "../check-sonar-main-quality-gate.mjs";
import {
  KEIKO_GATE_CONDITIONS,
  KEIKO_GATE_ID,
  KEIKO_GATE_NAME,
} from "../sonar-quality-gate-contract.mjs";

const scriptPath = resolve(import.meta.dirname, "..", "check-sonar-main-quality-gate.mjs");

const headSha = "a".repeat(40);
const newMeasures = {
  new_coverage: 90,
  new_duplicated_lines: 0,
  new_duplicated_lines_density: 0,
  new_lines: 100,
  new_lines_to_cover: 50,
  new_security_hotspots: 0,
  new_security_hotspots_reviewed: 100,
  new_violations: 0,
};
const overallMeasures = { security_hotspots: 0, security_hotspots_reviewed: 100 };
const customGate = {
  conditions: KEIKO_GATE_CONDITIONS,
  id: Number(KEIKO_GATE_ID),
  name: KEIKO_GATE_NAME,
};

function measurePayload(measures, period = true) {
  return {
    component: {
      measures: Object.entries(measures).map(([metric, value]) =>
        period ? { metric, periods: [{ value: String(value) }] } : { metric, value: String(value) },
      ),
    },
  };
}

function passingLoad(path) {
  if (path.includes("project_analyses")) return { analyses: [{ revision: headSha }] };
  if (path.includes("project_status")) return { projectStatus: { status: "OK" } };
  if (path.includes("issues/search")) return { total: 0 };
  if (path.includes("qualitygates/show")) return customGate;
  if (path.includes("metricKeys=security_hotspots")) return measurePayload(overallMeasures, false);
  return measurePayload(newMeasures);
}

describe("Sonar main-branch quality gate", () => {
  it("accepts exact clean dev evidence and emits a commit-bound receipt", async () => {
    const logs = [];
    await expect(
      runSonarMainGate({
        headSha,
        load: async (path) => passingLoad(path),
        log: (m) => logs.push(m),
      }),
    ).resolves.toBeUndefined();
    expect(logs).toEqual([`sonar-main-quality-gate: PASS - dev is clean at ${headSha}.`]);
  });

  it("rejects stale main analyses and a failed native quality gate", async () => {
    const load = async (path) => {
      if (path.includes("project_analyses")) return { analyses: [{ revision: "b".repeat(40) }] };
      if (path.includes("project_status")) return { projectStatus: { status: "ERROR" } };
      return passingLoad(path);
    };
    await expect(runSonarMainGate({ headSha, load })).rejects.toThrow("current head");
    await expect(runSonarMainGate({ headSha, load })).rejects.toThrow(
      "native quality gate is ERROR",
    );
  });

  it("fails closed when Sonar has no main analysis", async () => {
    const load = async (path) =>
      path.includes("project_analyses") ? { analyses: [] } : passingLoad(path);
    await expect(runSonarMainGate({ headSha, load })).rejects.toThrow("no analysis");
  });

  it("fails closed when the issue count is not numeric", async () => {
    const load = async (path) =>
      path.includes("issues/search") ? { total: "not-a-number" } : passingLoad(path);
    await expect(runSonarMainGate({ headSha, load })).rejects.toThrow(
      "SonarCloud issue total is missing",
    );
  });

  it("does not reinterpret a null issue count as zero", async () => {
    const load = async (path) =>
      path.includes("issues/search") ? { total: null } : passingLoad(path);
    await expect(runSonarMainGate({ headSha, load })).rejects.toThrow(
      "SonarCloud issue total is missing",
    );
  });

  it("adapts CLI environment and reports missing revision input", async () => {
    const calls = [];
    await runSonarMainGateCli({
      env: { SONAR_HEAD_SHA: headSha, SONAR_TOKEN: "token" },
      run: async (input) => calls.push(input),
    });
    expect(calls).toEqual([{ headSha, token: "token" }]);
    await expect(runSonarMainGateCli({ env: {} })).rejects.toThrow("SONAR_HEAD_SHA is required");

    const errors = [];
    const exitCodes = [];
    await executeSonarMainGateCli({
      env: {},
      error: (message) => errors.push(message),
      setExitCode: (value) => exitCodes.push(value),
    });
    expect(errors).toEqual(["sonar-main-quality-gate: FAIL - SONAR_HEAD_SHA is required."]);
    expect(exitCodes).toEqual([1]);
  });

  it("uses default CLI error reporting without leaking a stack", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitCode = process.exitCode;
    try {
      await executeSonarMainGateCli({ env: {} });
      expect(error).toHaveBeenCalledWith(
        "sonar-main-quality-gate: FAIL - SONAR_HEAD_SHA is required.",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      error.mockRestore();
      process.exitCode = exitCode;
    }
  });

  it("uses process runtime variables and formats non-Error failures", async () => {
    const previousHead = process.env.SONAR_HEAD_SHA;
    const calls = [];
    process.env.SONAR_HEAD_SHA = headSha;
    try {
      await runSonarMainGateCli({ run: async (input) => calls.push(input) });
      expect(calls).toEqual([{ headSha, token: process.env.SONAR_TOKEN }]);
    } finally {
      if (previousHead === undefined) delete process.env.SONAR_HEAD_SHA;
      else process.env.SONAR_HEAD_SHA = previousHead;
    }

    const errors = [];
    await executeSonarMainGateCli({
      env: { SONAR_HEAD_SHA: headSha },
      error: (message) => errors.push(message),
      run: async () => {
        throw "redacted";
      },
      setExitCode: () => undefined,
    });
    expect(errors).toEqual(["sonar-main-quality-gate: FAIL - redacted"]);
  });

  it("executes the real CLI and fails closed without a revision", () => {
    const env = { ...process.env };
    delete env.SONAR_HEAD_SHA;
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SONAR_HEAD_SHA is required");
  });
});
