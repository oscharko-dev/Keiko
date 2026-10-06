// F14 (#3873) — the projection of one finished verification execution onto the closed, bounded fields
// of the `editor.verification.execute` completion line. The manager-level pins
// (verificationRunner.test.ts) prove the line a run leaves; these pin the projection itself over the
// values a typed report and probe can carry without being well formed -- a fractional or enormous
// duration, a backend label this build does not know, a kind that repeats -- because one invalid field
// makes the sink drop the whole line, which is the loss this evidence exists to prevent.

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  VerificationKind,
  VerificationReport,
  VerificationResult,
  VerificationStatus,
} from "@oscharko-dev/keiko-contracts";
import {
  ACTIVITY_LOG_OPERATION_REGISTRY,
  validateActivityLogOperationFields,
  type ActivityLogOperationRegistration,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { SANDBOX_BACKENDS } from "@oscharko-dev/keiko-contracts/runtime/tools";
import { isVerificationDependencySummary } from "@oscharko-dev/keiko-contracts/runtime/verification";
import { runVerification } from "@oscharko-dev/keiko-verification";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import type { ExecuteVerificationResult } from "./verificationExecution.js";
import {
  VERIFICATION_COMPLETION_FIELD_CONTRACTS,
  VERIFICATION_DEPENDENCY_STATE_VALUES,
  VERIFICATION_STATUS_VALUES,
  verificationCompletionLogFields,
} from "./verificationExecutionLog.js";

// The command-bearing fields are sentinels the projection must never repeat.
function step(
  kind: VerificationKind,
  status: VerificationStatus,
  durationMs: number,
): VerificationResult {
  return {
    kind,
    scriptName: "SCRIPT-NAME-SENTINEL",
    command: "npm",
    args: ["run", "ARGUMENT-SENTINEL"],
    status,
    exitCode: null,
    signal: null,
    durationMs,
    truncated: false,
    redacted: true,
    outputSummary: "OUTPUT-SENTINEL",
    appliedLimits: [],
    detail: "DETAIL-SENTINEL",
  };
}

function execution(
  results: readonly VerificationResult[],
  totalMs: number,
  over: Partial<ExecuteVerificationResult> = {},
  dependencies?: VerificationReport["dependencies"],
): ExecuteVerificationResult {
  return {
    report: {
      workspaceRoot: "/ws",
      results,
      overallStatus: "failed",
      startedAtMs: 1,
      durationMs: totalMs,
      counts: {
        passed: 0,
        failed: 0,
        skipped: 0,
        denied: 0,
        "timed-out": 0,
        cancelled: 0,
        "resource-exceeded": 0,
      },
      ...(dependencies === undefined ? {} : { dependencies }),
    },
    probe: { available: true, backend: "container-docker" },
    ...over,
  };
}

const EXECUTE_OPERATION: ActivityLogOperationRegistration | undefined = (
  ACTIVITY_LOG_OPERATION_REGISTRY as readonly ActivityLogOperationRegistration[]
).find((registration) => registration.op === "editor.verification.execute");

describe("verificationCompletionLogFields", () => {
  it("projects a full execution onto closed vocabularies, booleans and whole milliseconds", () => {
    const fields = verificationCompletionLogFields(
      execution(
        [step("typecheck", "passed", 1_100), step("targeted-test", "failed", 28_490)],
        29_800,
        { probeDurationMs: 3, networkEnforcement: "enforce-or-fail-closed" },
        { state: "installed", lockfile: "created", exitCode: 0, durationMs: 120 },
      ),
    );

    expect(fields).toEqual({
      durationMs: 29_800,
      outsideStepsMs: 210,
      maxStepDurationMs: 28_490,
      typecheckStatus: "passed",
      typecheckDurationMs: 1_100,
      targetedTestStatus: "failed",
      targetedTestDurationMs: 28_490,
      isolationBackend: "container-docker",
      isolationAvailable: true,
      networkEnforcement: "enforce-or-fail-closed",
      probeDurationMs: 3,
      dependencyBootstrap: "installed",
    });
    // Nothing a step carries but its kind, status and wall time can reach the line.
    expect(JSON.stringify(fields)).not.toMatch(/SENTINEL/u);
  });

  it("sums a repeated kind's wall time and keeps its first non-passing status", () => {
    const fields = verificationCompletionLogFields(
      execution(
        [
          step("test", "passed", 100),
          step("test", "failed", 50),
          step("test", "passed", 25),
          step("lint", "skipped", 7),
          step("lint", "passed", 3),
          step("build", "passed", 9),
          step("build", "passed", 1),
        ],
        1_000,
      ),
    );

    expect(fields).toMatchObject({
      testStatus: "failed",
      testDurationMs: 175,
      lintStatus: "skipped",
      lintDurationMs: 10,
      buildStatus: "passed",
      buildDurationMs: 10,
      // The slowest single step, not the slowest kind.
      maxStepDurationMs: 100,
      // 1000 minus every one of the seven steps (195).
      outsideStepsMs: 805,
    });
  });

  it("keeps a repeated kind's usable wall time when one of its steps carries none, and never overflows the safe maximum", () => {
    const fields = verificationCompletionLogFields(
      execution(
        [
          step("test", "passed", Number.NaN),
          step("test", "failed", 40),
          step("lint", "passed", 15),
          step("lint", "passed", Number.NaN),
          step("build", "passed", Number.MAX_SAFE_INTEGER),
          step("build", "passed", 5),
        ],
        100,
      ),
    );

    expect(fields).toMatchObject({
      testStatus: "failed",
      testDurationMs: 40,
      lintStatus: "passed",
      lintDurationMs: 15,
      buildStatus: "passed",
      buildDurationMs: Number.MAX_SAFE_INTEGER,
    });
  });

  it("rounds a fraction, clamps a negative to zero and a huge value to the safe maximum", () => {
    const fields = verificationCompletionLogFields(
      execution(
        [
          step("typecheck", "passed", 12.6),
          step("lint", "passed", -5),
          step("build", "passed", 1e300),
        ],
        20.4,
        { probeDurationMs: 0.4 },
      ),
    );

    expect(fields).toMatchObject({
      durationMs: 20,
      typecheckDurationMs: 13,
      lintDurationMs: 0,
      buildDurationMs: Number.MAX_SAFE_INTEGER,
      maxStepDurationMs: Number.MAX_SAFE_INTEGER,
      // The steps outlast the report's own total, which a real run never does: no negative leaks out.
      outsideStepsMs: 0,
      probeDurationMs: 0,
    });
  });

  it("omits a duration no clock can have produced instead of inventing one", () => {
    const fields = verificationCompletionLogFields(
      execution(
        [step("typecheck", "passed", Number.NaN), step("lint", "passed", Number.POSITIVE_INFINITY)],
        Number.NaN,
        { probeDurationMs: Number.NEGATIVE_INFINITY },
      ),
    );

    // The statuses are still recorded: only the unusable numbers are absent.
    expect(fields).toEqual({
      typecheckStatus: "passed",
      lintStatus: "passed",
      isolationBackend: "container-docker",
      isolationAvailable: true,
    });
  });

  it("reports only what the execution reported", () => {
    const fields = verificationCompletionLogFields(execution([], 4));

    expect(fields).toEqual({
      durationMs: 4,
      outsideStepsMs: 4,
      isolationBackend: "container-docker",
      isolationAvailable: true,
    });
    expect(fields).not.toHaveProperty("probeDurationMs");
    expect(fields).not.toHaveProperty("networkEnforcement");
    expect(fields).not.toHaveProperty("dependencyBootstrap");
    expect(fields).not.toHaveProperty("maxStepDurationMs");
  });

  it("names a backend label this build does not know unknown, and every contract backend as itself", () => {
    const named = (backend: string): unknown =>
      verificationCompletionLogFields(execution([], 1, { probe: { available: false, backend } }))
        .isolationBackend;

    expect(named("wsl-future-backend")).toBe("unknown");
    expect(named("")).toBe("unknown");
    expect(named("bwrap")).toBe("unknown");
    for (const backend of SANDBOX_BACKENDS) expect(named(backend)).toBe(backend);
  });

  it("never produces a field the registered contract refuses, whatever the clock or the probe said", () => {
    const hostile: readonly ExecuteVerificationResult[] = [
      execution([step("test", "passed", 0.5), step("test", "denied", 0.49)], 0.2),
      execution([step("build", "timed-out", 1e21)], 1e21, { probeDurationMs: 1e21 }),
      execution([step("lint", "cancelled", -1)], -1, { probeDurationMs: -1 }),
      execution([step("typecheck", "resource-exceeded", Number.NaN)], Number.NaN),
      execution([], 0, { probe: { available: false, backend: "x".repeat(10_000) } }),
    ];

    for (const candidate of hostile) {
      expect(() => {
        validateActivityLogOperationFields("editor.verification.execute", "process", {
          completeness: "complete",
          loss: "none",
          state: "completed",
          runnerId: "unknown",
          ...verificationCompletionLogFields(candidate),
        });
      }).not.toThrow();
    }
  });
});

describe("the registered completion fields", () => {
  it("are exactly the contracts the code declares, so a stale generated registry fails here", () => {
    expect(EXECUTE_OPERATION).toBeDefined();
    for (const [name, contract] of Object.entries(VERIFICATION_COMPLETION_FIELD_CONTRACTS)) {
      expect(EXECUTE_OPERATION?.fields[name], name).toEqual(contract);
    }
  });

  it("name every sandbox backend the contract owns, plus unknown", () => {
    expect(VERIFICATION_COMPLETION_FIELD_CONTRACTS.isolationBackend.values).toEqual([
      ...SANDBOX_BACKENDS,
      "unknown",
    ]);
  });

  it("use the status vocabulary the verification report itself carries", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-completion-statuses-")));
    try {
      // The orchestrator tallies every status it can report, so an empty run's counts name them all.
      const report = await runVerification(
        { workspaceRoot: root, steps: [] },
        { workspace: detectWorkspaceAt(root) },
      );
      expect([...VERIFICATION_STATUS_VALUES].sort()).toEqual(Object.keys(report.counts).sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("use only bootstrap states the report's own guard accepts", () => {
    for (const state of VERIFICATION_DEPENDENCY_STATE_VALUES) {
      expect(
        isVerificationDependencySummary({
          state,
          lockfile: "present",
          exitCode: null,
          durationMs: 0,
        }),
        state,
      ).toBe(true);
    }
    expect(isVerificationDependencySummary({ state: "paused", lockfile: "present" })).toBe(false);
  });
});
