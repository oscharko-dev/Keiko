// Surface-parity tests (ADR-0012 D7, AC#3). Verifies that the four surfaces for each workflow —
// descriptor, CLI flags, SDK exports, and the UI RunRequest shape — present consistent contracts.
// allPassed must be true on the real codebase (structural regression guard). No network or model.

import { describe, expect, it } from "vitest";
import { checkSurfaceParity } from "../../src/evaluations/surface-parity.js";
import {
  UNIT_TEST_WORKFLOW_DESCRIPTOR,
  BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR,
} from "../../src/workflows/index.js";
import { runGenTestsCli } from "../../src/cli/gen-tests.js";
import { runInvestigateCli } from "../../src/cli/investigate.js";
import type { CliIo } from "../../src/cli/runner.js";

// ─── Full checkSurfaceParity result on the real codebase ──────────────────────

describe("checkSurfaceParity (real codebase)", () => {
  it("allPassed is true — all structural invariants hold", async () => {
    const result = await checkSurfaceParity();
    const failedChecks = result.checks.filter((c) => !c.passed);
    expect(failedChecks, JSON.stringify(failedChecks)).toHaveLength(0);
    expect(result.allPassed).toBe(true);
  });

  it("returns exactly 8 checks (2 descriptor + 2 cli-flags + 2 sdk-exports + 2 run-request)", async () => {
    const result = await checkSurfaceParity();
    expect(result.checks).toHaveLength(8);
  });

  it("all checks have a non-empty check name and a workflowKind", async () => {
    const result = await checkSurfaceParity();
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
    const sdk = (await import("../../src/sdk/index.js")) as Record<string, unknown>;
    expect(typeof sdk.generateUnitTests).toBe("function");
  });

  it("exports investigateBug as a function", async () => {
    const sdk = (await import("../../src/sdk/index.js")) as Record<string, unknown>;
    expect(typeof sdk.investigateBug).toBe("function");
  });

  it("exports UNIT_TEST_WORKFLOW_DESCRIPTOR as an object", async () => {
    const sdk = (await import("../../src/sdk/index.js")) as Record<string, unknown>;
    expect(typeof sdk.UNIT_TEST_WORKFLOW_DESCRIPTOR).toBe("object");
    expect(sdk.UNIT_TEST_WORKFLOW_DESCRIPTOR).not.toBeNull();
  });

  it("exports BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR as an object", async () => {
    const sdk = (await import("../../src/sdk/index.js")) as Record<string, unknown>;
    expect(typeof sdk.BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR).toBe("object");
    expect(sdk.BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR).not.toBeNull();
  });
});

// ─── RunRequest shape ─────────────────────────────────────────────────────────

describe("RunRequest shape (UI BFF contract)", () => {
  it("parseRunRequest accepts a valid unit-tests request and returns the required fields", async () => {
    const { parseRunRequest } = await import("../../src/ui/run-request.js");
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
    const { parseRunRequest } = await import("../../src/ui/run-request.js");
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
    const { parseRunRequest } = await import("../../src/ui/run-request.js");
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
