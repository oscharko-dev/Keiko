// Surface-parity tests (ADR-0012 D7, AC#3). Verifies that the four surfaces for each workflow —
// descriptor, CLI flags, SDK exports, and the UI RunRequest shape — present consistent contracts.
// allPassed must be true on the real codebase (structural regression guard). No network or model.

import { describe, expect, it } from "vitest";
import {
  checkSurfaceParity,
  type SurfaceParityCliIo,
  type SurfaceParityCliRunner,
  type SurfaceParityDeps,
} from "./surface-parity.js";
import {
  UNIT_TEST_WORKFLOW_DESCRIPTOR,
  BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR,
} from "@oscharko-dev/keiko-workflows";
import { runGenTestsCli, runInvestigateCli, type CliIo } from "@oscharko-dev/keiko-cli";
import { parseRunRequest } from "@oscharko-dev/keiko-server";

const SURFACE_PARITY_DEPS: SurfaceParityDeps = {
  runGenTestsCli,
  runInvestigateCli,
  parseRunRequest,
};

// ─── Full checkSurfaceParity result on the real codebase ──────────────────────

describe("checkSurfaceParity (real codebase)", () => {
  it("allPassed is true — all structural invariants hold", async () => {
    const result = await checkSurfaceParity(SURFACE_PARITY_DEPS);
    const failedChecks = result.checks.filter((c) => !c.passed);
    expect(failedChecks, JSON.stringify(failedChecks)).toHaveLength(0);
    expect(result.allPassed).toBe(true);
  });

  it("returns exactly 8 checks (2 descriptor + 2 cli-flags + 2 sdk-exports + 2 run-request)", async () => {
    const result = await checkSurfaceParity(SURFACE_PARITY_DEPS);
    expect(result.checks).toHaveLength(8);
  });

  it("all checks have a non-empty check name and a workflowKind", async () => {
    const result = await checkSurfaceParity(SURFACE_PARITY_DEPS);
    for (const check of result.checks) {
      expect(check.check.length).toBeGreaterThan(0);
      expect(["unit-tests", "bug-investigation"]).toContain(check.workflowKind);
    }
  });
});

// ─── Descriptor required inputs ───────────────────────────────────────────────

describe("UNIT_TEST_WORKFLOW_DESCRIPTOR required inputs", () => {
  it("declares 'target' as a required input", () => {
    const target = UNIT_TEST_WORKFLOW_DESCRIPTOR.inputs.find((i) => i.name === "target");
    expect(target).toBeDefined();
    expect(target?.required).toBe(true);
  });

  it("declares 'modelId' as a required input", () => {
    const modelId = UNIT_TEST_WORKFLOW_DESCRIPTOR.inputs.find((i) => i.name === "modelId");
    expect(modelId).toBeDefined();
    expect(modelId?.required).toBe(true);
  });

  it("has supportsDryRun=true and supportsApply=true", () => {
    expect(UNIT_TEST_WORKFLOW_DESCRIPTOR.supportsDryRun).toBe(true);
    expect(UNIT_TEST_WORKFLOW_DESCRIPTOR.supportsApply).toBe(true);
  });

  it("exposes optional limits input and non-empty defaultLimits", () => {
    const limits = UNIT_TEST_WORKFLOW_DESCRIPTOR.inputs.find((i) => i.name === "limits");
    expect(limits?.required).toBe(false);
    expect(Object.keys(UNIT_TEST_WORKFLOW_DESCRIPTOR.defaultLimits)).not.toHaveLength(0);
  });
});

describe("BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR required inputs", () => {
  it("declares 'report' as a required input", () => {
    const report = BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.inputs.find((i) => i.name === "report");
    expect(report).toBeDefined();
    expect(report?.required).toBe(true);
  });

  it("declares 'modelId' as a required input", () => {
    const modelId = BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.inputs.find((i) => i.name === "modelId");
    expect(modelId).toBeDefined();
    expect(modelId?.required).toBe(true);
  });

  it("has supportsDryRun=true and supportsApply=true", () => {
    expect(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.supportsDryRun).toBe(true);
    expect(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.supportsApply).toBe(true);
  });

  it("exposes optional limits input and non-empty defaultLimits", () => {
    const limits = BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.inputs.find((i) => i.name === "limits");
    expect(limits?.required).toBe(false);
    expect(Object.keys(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.defaultLimits)).not.toHaveLength(0);
  });
});

// ─── CLI flag presence in --help output ───────────────────────────────────────

function captureHelp(
  run: (args: readonly string[], io: CliIo, env: Record<string, string | undefined>) => unknown,
): string {
  const chunks: string[] = [];
  const io: CliIo = {
    out: (text: string): void => void chunks.push(text),
    err: (text: string): void => void chunks.push(text),
  };
  void run(["--help"], io, {});
  return chunks.join("");
}

describe("gen-tests CLI --help", () => {
  it("includes --file flag", () => {
    const help = captureHelp((args, io, env) => runGenTestsCli(args, io, env, {}));
    expect(help).toContain("--file");
  });

  it("includes --apply flag", () => {
    const help = captureHelp((args, io, env) => runGenTestsCli(args, io, env, {}));
    expect(help).toContain("--apply");
  });

  it("includes model, target, and dry-run surface text", () => {
    const help = captureHelp((args, io, env) => runGenTestsCli(args, io, env, {}));
    expect(help).toContain("--model");
    expect(help).toContain("--dir");
    expect(help).toContain("--changed");
    expect(help).toMatch(/dry-run by default/i);
  });
});

describe("investigate CLI --help", () => {
  it("includes --apply flag", () => {
    const help = captureHelp((args, io, env) => runInvestigateCli(args, io, env, {}));
    expect(help).toContain("--apply");
  });

  it("includes model, evidence-input, and dry-run surface text", () => {
    const help = captureHelp((args, io, env) => runInvestigateCli(args, io, env, {}));
    expect(help).toContain("--model");
    expect(help).toContain("--description");
    expect(help).toContain("--output");
    expect(help).toContain("--output-file");
    expect(help).toContain("--stack");
    expect(help).toContain("--stack-file");
    expect(help).toContain("--file");
    expect(help).toMatch(/dry-run by default/i);
  });
});

// ─── SDK named exports ─────────────────────────────────────────────────────────

describe("SDK exports", () => {
  it("exports generateUnitTests as a function", async () => {
    const sdk = (await import("@oscharko-dev/keiko-workflows")) as Record<string, unknown>;
    expect(typeof sdk.generateUnitTests).toBe("function");
  });

  it("exports investigateBug as a function", async () => {
    const sdk = (await import("@oscharko-dev/keiko-workflows")) as Record<string, unknown>;
    expect(typeof sdk.investigateBug).toBe("function");
  });

  it("exports UNIT_TEST_WORKFLOW_DESCRIPTOR as an object", async () => {
    const sdk = (await import("@oscharko-dev/keiko-workflows")) as Record<string, unknown>;
    expect(typeof sdk.UNIT_TEST_WORKFLOW_DESCRIPTOR).toBe("object");
    expect(sdk.UNIT_TEST_WORKFLOW_DESCRIPTOR).not.toBeNull();
  });

  it("exports BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR as an object", async () => {
    const sdk = (await import("@oscharko-dev/keiko-workflows")) as Record<string, unknown>;
    expect(typeof sdk.BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR).toBe("object");
    expect(sdk.BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR).not.toBeNull();
  });
});

// ─── RunRequest shape ─────────────────────────────────────────────────────────

// ─── KEIKO-0241: synthetic broken-input tests for the FAIL branches ────────────
//
// The real-codebase happy path proves the checker's PASS branch. Without exercising the FAIL
// branches on synthetic broken inputs, the checker's own diagnostic correctness is unproven — a
// mutation that inverts a `missing.length > 0` guard would leave the entire suite green. These
// tests inject fakes through SurfaceParityDeps so the FAIL branches for cli-flags and
// run-request-shape are covered. sdk-exports is not reachable via SurfaceParityDeps (it imports
// @oscharko-dev/keiko-sdk directly, by design), so that branch is not covered here.

function fakeCli(help: string): SurfaceParityCliRunner {
  return (args, io, _env, _opts) => {
    if (args.includes("--help")) {
      io.out(help);
    }
    return undefined;
  };
}

function labelFor(passed: boolean): string {
  return passed ? "passed" : "failed";
}

function findFailedChecks(
  checks: readonly {
    readonly check: string;
    readonly passed: boolean;
    readonly reason?: string | undefined;
  }[],
): readonly {
  readonly check: string;
  readonly passed: boolean;
  readonly reason?: string | undefined;
}[] {
  return checks.filter((c) => !c.passed);
}

describe("KEIKO-0241 checkSurfaceParity FAIL branches (synthetic broken inputs)", () => {
  // Full-help strings that satisfy each CLI's requiredTokens on their own. Dropping one token from
  // one of the two CLIs should flip only that CLI's cli-flags check to failed.
  const GEN_TESTS_FULL_HELP =
    "usage: gen-tests --file --dir --changed --model --apply (dry-run by default)";
  const INVESTIGATE_FULL_HELP =
    "usage: investigate --description --output --output-file --stack --stack-file --file --model --apply (dry-run by default)";

  it("cli-flags FAILS on gen-tests when --help output omits --file (only the affected check flips)", async () => {
    const deps: SurfaceParityDeps = {
      ...SURFACE_PARITY_DEPS,
      runGenTestsCli: fakeCli(GEN_TESTS_FULL_HELP.replace(" --file", "")),
      runInvestigateCli: fakeCli(INVESTIGATE_FULL_HELP),
    };
    const result = await checkSurfaceParity(deps);
    expect(result.allPassed).toBe(false);
    const cliFlags = result.checks.filter((c) => c.check === "cli-flags");
    expect(cliFlags).toHaveLength(2);
    const utFlags = cliFlags.find((c) => c.workflowKind === "unit-tests");
    const bugFlags = cliFlags.find((c) => c.workflowKind === "bug-investigation");
    expect(utFlags?.passed).toBe(false);
    expect(utFlags?.reason).toContain("--file");
    // Only the affected CLI check flips; the other stays green.
    expect(bugFlags?.passed).toBe(true);
  });

  it("cli-flags FAILS on both CLIs when --help does not state 'dry-run by default'", async () => {
    const deps: SurfaceParityDeps = {
      ...SURFACE_PARITY_DEPS,
      runGenTestsCli: fakeCli(GEN_TESTS_FULL_HELP.replace(" (dry-run by default)", "")),
      runInvestigateCli: fakeCli(INVESTIGATE_FULL_HELP.replace(" (dry-run by default)", "")),
    };
    const result = await checkSurfaceParity(deps);
    expect(result.allPassed).toBe(false);
    const failedCli = result.checks.filter((c) => c.check === "cli-flags" && !c.passed);
    expect(failedCli).toHaveLength(2);
    for (const check of failedCli) {
      expect(check.reason).toContain("dry-run");
    }
  });

  it("run-request-shape FAILS when parseRunRequest returns an error envelope (code/message)", async () => {
    const deps: SurfaceParityDeps = {
      ...SURFACE_PARITY_DEPS,
      parseRunRequest: (_input: string) => ({
        code: "INVALID_RUN_REQUEST",
        message: "synthetic parse error",
      }),
    };
    const result = await checkSurfaceParity(deps);
    expect(result.allPassed).toBe(false);
    const shape = result.checks.filter((c) => c.check === "run-request-shape");
    expect(shape).toHaveLength(2);
    // Both workflow kinds go through the same faked parser, so both must fail with the error message.
    for (const check of shape) {
      expect(check.passed).toBe(false);
      expect(check.reason).toBe("synthetic parse error");
    }
  });

  it("run-request-shape FAILS when parseRunRequest returns a payload missing required fields", async () => {
    const deps: SurfaceParityDeps = {
      ...SURFACE_PARITY_DEPS,
      // Missing `limits` and `input`.
      parseRunRequest: (_input: string) => ({
        kind: "unit-tests",
        modelId: "m",
        apply: false,
      }),
    };
    const result = await checkSurfaceParity(deps);
    expect(result.allPassed).toBe(false);
    const shape = result.checks.filter((c) => c.check === "run-request-shape");
    for (const check of shape) {
      expect(check.passed).toBe(false);
      expect(check.reason).toContain("missing fields");
    }
  });

  it("run-request-shape FAILS when parseRunRequest returns wrong field types", async () => {
    const deps: SurfaceParityDeps = {
      ...SURFACE_PARITY_DEPS,
      // All required fields present but modelId is a number instead of a string.
      parseRunRequest: (_input: string) => ({
        kind: "unit-tests",
        modelId: 42,
        apply: false,
        input: { workspaceRoot: "/tmp" },
        limits: { maxPromptBytes: 1 },
      }),
    };
    const result = await checkSurfaceParity(deps);
    expect(result.allPassed).toBe(false);
    const shape = result.checks.filter((c) => c.check === "run-request-shape");
    for (const check of shape) {
      expect(check.passed).toBe(false);
      expect(check.reason).toBe("RunRequest field types mismatch");
    }
  });

  it("smoke: labelFor / findFailedChecks helpers behave as documented", () => {
    // Local helpers stay covered so a future refactor doesn't drop them silently.
    expect(labelFor(true)).toBe("passed");
    expect(labelFor(false)).toBe("failed");
    expect(findFailedChecks([{ check: "x", passed: true }])).toHaveLength(0);
    expect(
      findFailedChecks([
        { check: "x", passed: false, reason: "r" },
        { check: "y", passed: true },
      ]),
    ).toHaveLength(1);
  });

  it("smoke: the SurfaceParityCliIo alias covers a chunked-string capture", () => {
    // The alias is imported for readability of injected fakes; keep a use so the import stays needed.
    const chunks: string[] = [];
    const io: SurfaceParityCliIo = {
      out: (t) => void chunks.push(t),
      err: (t) => void chunks.push(t),
    };
    io.out("a");
    io.err("b");
    expect(chunks.join("")).toBe("ab");
  });
});

describe("RunRequest shape (UI BFF contract)", () => {
  it("parseRunRequest accepts a valid unit-tests request and returns the required fields", async () => {
    const { parseRunRequest } = await import("@oscharko-dev/keiko-server");
    const result = parseRunRequest(
      JSON.stringify({
        workflowId: "unit-test-generation",
        modelId: "m",
        input: {
          workspaceRoot: "/tmp/keiko-surface-parity",
          target: { kind: "file", filePath: "src/example.ts" },
        },
      }),
    );
    if ("code" in result) throw new Error(`Unexpected error: ${result.message}`);
    expect(result.kind).toBe("unit-tests");
    expect(typeof result.modelId).toBe("string");
    expect(result.apply).toBe(false);
    expect(typeof result.input).toBe("object");
    // limits is present in the shape (may be undefined)
    expect("limits" in result).toBe(true);
  });

  it("parseRunRequest accepts a valid bug-investigation request", async () => {
    const { parseRunRequest } = await import("@oscharko-dev/keiko-server");
    const result = parseRunRequest(
      JSON.stringify({
        workflowId: "bug-investigation",
        modelId: "m",
        input: {
          workspaceRoot: "/tmp/keiko-surface-parity",
          report: { description: "example failure" },
        },
      }),
    );
    if ("code" in result) throw new Error(`Unexpected error: ${result.message}`);
    expect(result.kind).toBe("bug-investigation");
  });

  it("parseRunRequest carries limits for both workflow request shapes", async () => {
    const { parseRunRequest } = await import("@oscharko-dev/keiko-server");
    for (const body of [
      {
        workflowId: "unit-test-generation",
        input: {
          workspaceRoot: "/tmp/keiko-surface-parity",
          target: { kind: "file", filePath: "src/example.ts" },
        },
      },
      {
        workflowId: "bug-investigation",
        input: {
          workspaceRoot: "/tmp/keiko-surface-parity",
          report: { description: "example failure" },
        },
      },
    ]) {
      const result = parseRunRequest(
        JSON.stringify({
          workflowId: body.workflowId,
          modelId: "m",
          input: body.input,
          limits: { maxPromptBytes: 1 },
        }),
      );
      if ("code" in result) throw new Error(`Unexpected error: ${result.message}`);
      expect(result.limits).toEqual({ maxPromptBytes: 1 });
    }
  });
});
