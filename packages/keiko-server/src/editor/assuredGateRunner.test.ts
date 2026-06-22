import { describe, it, expect } from "vitest";
import {
  coveredDelta,
  createSandboxedGateRunner,
  strykerKilled,
  type ReportReader,
  type SandboxedCommand,
  type SandboxedRunResult,
  type SandboxedGateRunnerSpec,
} from "./assuredGateRunner.js";

const TARGET = "src/widget.ts";
const ENFORCED_RUN: SandboxedRunResult = {
  exitCode: 0,
  networkEnforced: true,
  filesystemEnforced: true,
};

describe("coveredDelta", () => {
  it("computes the strict increase in covered lines/branches for the target", () => {
    const baseline = { [TARGET]: { lines: { covered: 10 }, branches: { covered: 4 } } };
    const patched = { [TARGET]: { lines: { covered: 14 }, branches: { covered: 5 } } };
    expect(coveredDelta(baseline, patched, [TARGET])).toEqual({ lineDelta: 4, branchDelta: 1 });
  });

  it("treats an absent baseline file as zero covered", () => {
    const patched = { [TARGET]: { lines: { covered: 6 }, branches: { covered: 2 } } };
    expect(coveredDelta({}, patched, [TARGET])).toEqual({ lineDelta: 6, branchDelta: 2 });
  });

  it("returns zero deltas for malformed summaries", () => {
    expect(coveredDelta(undefined, null, [TARGET])).toEqual({ lineDelta: 0, branchDelta: 0 });
  });

  it("ignores files outside the target key set", () => {
    const baseline = { "src/other.ts": { lines: { covered: 1 } } };
    const patched = { "src/other.ts": { lines: { covered: 99 } } };
    expect(coveredDelta(baseline, patched, [TARGET])).toEqual({ lineDelta: 0, branchDelta: 0 });
  });
});

describe("strykerKilled", () => {
  it("counts Killed and Timeout as detected, excluding Ignored/NoCoverage from the total", () => {
    const report = {
      files: {
        "src/widget.ts": {
          mutants: [
            { status: "Killed" },
            { status: "Timeout" },
            { status: "Survived" },
            { status: "Ignored" },
            { status: "NoCoverage" },
          ],
        },
      },
    };
    expect(strykerKilled(report)).toEqual({ killed: 2, total: 3 });
  });

  it("returns zero counts for a malformed report", () => {
    expect(strykerKilled(undefined)).toEqual({ killed: 0, total: 0 });
    expect(strykerKilled({ files: 7 })).toEqual({ killed: 0, total: 0 });
  });
});

describe("createSandboxedGateRunner", () => {
  function spec(overrides: Partial<SandboxedGateRunnerSpec>): SandboxedGateRunnerSpec {
    const reports: Record<string, unknown> = {
      "coverage/baseline.json": { [TARGET]: { lines: { covered: 5 }, branches: { covered: 1 } } },
      "coverage/patched.json": { [TARGET]: { lines: { covered: 9 }, branches: { covered: 2 } } },
      "reports/mutation.json": {
        files: { [TARGET]: { mutants: [{ status: "Killed" }, { status: "Survived" }] } },
      },
    };
    const readReport: ReportReader = (path) => reports[path];
    const cmd = (command: string): SandboxedCommand => ({ command, args: [] });
    return {
      enforced: true,
      run: () => Promise.resolve(ENFORCED_RUN),
      readReport,
      buildCommand: cmd("build"),
      testCommand: cmd("test"),
      coverageCommand: cmd("coverage"),
      mutationCommand: cmd("mutation"),
      baselineCoverageReportPath: "coverage/baseline.json",
      patchedCoverageReportPath: "coverage/patched.json",
      mutationReportPath: "reports/mutation.json",
      targetCoverageKeys: [TARGET],
      minMutantsKilled: 1,
      ...overrides,
    };
  }

  it("passes build/test gates when the command exits zero", async () => {
    const runner = createSandboxedGateRunner(spec({}));
    expect(await runner.build()).toEqual({ ok: true });
    expect(await runner.runTests()).toEqual({ ok: true });
  });

  it("fails build/test gates on a non-zero exit", async () => {
    const runner = createSandboxedGateRunner(
      spec({ run: () => Promise.resolve({ ...ENFORCED_RUN, exitCode: 1 }) }),
    );
    expect(await runner.build()).toEqual({ ok: false });
  });

  it("fails gates when the command exits zero without sandbox enforcement attestation", async () => {
    const runner = createSandboxedGateRunner(
      spec({
        run: () =>
          Promise.resolve({
            exitCode: 0,
            networkEnforced: true,
            filesystemEnforced: false,
          }),
      }),
    );
    expect(await runner.build()).toEqual({ ok: false });
  });

  it("passes the coverage gate on a strict increase and reports the delta", async () => {
    const runner = createSandboxedGateRunner(spec({}));
    expect(await runner.coverage()).toEqual({ ok: true, lineDelta: 4, branchDelta: 1 });
  });

  it("fails the coverage gate when the coverage command errors", async () => {
    const runner = createSandboxedGateRunner(
      spec({ run: () => Promise.resolve({ ...ENFORCED_RUN, exitCode: 2 }) }),
    );
    expect(await runner.coverage()).toEqual({ ok: false, lineDelta: 0, branchDelta: 0 });
  });

  it("passes the mutation gate when enough mutants are killed", async () => {
    const runner = createSandboxedGateRunner(spec({}));
    expect(await runner.mutation()).toEqual({ ok: true, killed: 1, total: 2 });
  });

  it("fails the mutation gate below the kill threshold", async () => {
    const runner = createSandboxedGateRunner(spec({ minMutantsKilled: 2 }));
    expect(await runner.mutation()).toEqual({ ok: false, killed: 1, total: 2 });
  });

  it("propagates the enforced flag", () => {
    expect(createSandboxedGateRunner(spec({ enforced: false })).enforced).toBe(false);
  });
});
