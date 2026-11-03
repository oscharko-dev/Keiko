// Execute the buggy regression in a confined, self-contained workspace, then apply the real
// workflow patch and execute it again. Node's built-in runner needs no sibling dependencies or
// platform-specific host binaries in the container.

import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "@oscharko-dev/keiko-workspace";
import {
  DEFAULT_VERIFICATION_LIMITS,
  resolveTargetedTests,
  runVerification,
} from "@oscharko-dev/keiko-verification";
import { investigateBug } from "./workflow.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "bug-investigation",
  "target-project",
);

// A valid fix diff: change the divisor from 3 to 2 in src/buggy.ts. The context line must match the
// fixture exactly so #6 validatePatch finds no conflict.
const FIX_DIFF = [
  "--- a/src/buggy.ts",
  "+++ b/src/buggy.ts",
  "@@ -5 +5 @@",
  "-export const half = (n: number): number => n / 3;",
  "+export const half = (n: number): number => n / 2;",
].join("\n");

const MODEL_CONTENT = [
  "```diff",
  FIX_DIFF,
  "```",
  "## Root cause",
  "The divisor was 3 instead of 2.",
  "## Regression test",
  "tests/buggy.test.ts already asserts half(10) === 5.",
  "## Confidence",
  "high",
].join("\n");

function model(content: string): ModelPort {
  const response: NormalizedResponse = {
    modelId: "m",
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "r",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "high",
    },
  };
  return { call: (): Promise<NormalizedResponse> => Promise.resolve(response) };
}

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("investigateBug — apply + verify integration (AC #6/#8)", () => {
  it("applies the fix to disk and verification reports passed", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-bug-integration-")));
    cpSync(FIXTURE, dir, { recursive: true });
    const workspace = detectWorkspace(dir);
    const failureOutput: string[] = [];
    const before = await runVerification(
      {
        workspaceRoot: workspace.root,
        steps: resolveTargetedTests(
          workspace,
          ["src/buggy.ts"],
          undefined,
          DEFAULT_VERIFICATION_LIMITS,
        ),
      },
      {
        workspace,
        networkEnforcement: "enforce-or-degrade",
        onStepOutput: (output): void => {
          failureOutput.push(output.excerpt);
        },
      },
    );
    expect(before.results).toHaveLength(1);
    expect(before.results[0]?.status).toBe("failed");
    expect(failureOutput.join("\n")).toContain("3.333");
    expect(before.results[0]?.exitCode).toBe(1);

    const report = await investigateBug(
      {
        workspaceRoot: dir,
        report: {
          description: "half returns the wrong value",
          failingOutput: "AssertionError: expected 3.33 to be 5\n at half (src/buggy.ts:5:40)",
        },
        apply: true,
        modelId: "test-model",
      },
      { model: model(MODEL_CONTENT), verificationNetworkEnforcement: "enforce-or-degrade" },
    );

    // AC #6 — the patch was applied and the source file is fixed on disk.
    expect(report.status).toBe("fix-applied");
    expect(report.verified.patchApplied).toBe(true);
    const fixed = readFileSync(join(dir, "src", "buggy.ts"), "utf8");
    expect(fixed).toContain("n / 2");
    expect(fixed).not.toContain("n / 3");
    expect(existsSync(join(dir, "tests", "buggy.test.ts"))).toBe(true);

    // AC #8 — verification ran against the regression test and passed (fail-before / pass-after).
    expect(report.verified.verification?.overallStatus).toBe("passed");
    expect(report.verificationSkipReason).toBeUndefined();
  }, 60_000);
});

// #4025 AC4: the apply writes the fix the human reviewed. The model is never asked, so a different
// answer it would now give cannot reach the workspace.
describe("investigateBug — apply of a reviewed fix (#4025 AC4)", () => {
  const unusedModel: ModelPort = {
    call: (): Promise<NormalizedResponse> => Promise.reject(new Error("the apply asks no model")),
  };
  const reviewedInput = (root: string, diff: string): Parameters<typeof investigateBug>[0] => ({
    workspaceRoot: root,
    report: {
      description: "half returns the wrong value",
      failingOutput: "AssertionError: expected 3.33 to be 5\n at half (src/buggy.ts:5:40)",
    },
    apply: true,
    modelId: "test-model",
    reviewedPatch: { diff, hypothesis: { rootCause: "The divisor was 3 instead of 2." } },
  });

  it("writes exactly the reviewed fix without a model call", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-bug-reviewed-")));
    cpSync(FIXTURE, dir, { recursive: true });

    const report = await investigateBug(reviewedInput(dir, FIX_DIFF), {
      model: unusedModel,
      verificationNetworkEnforcement: "enforce-or-degrade",
    });

    expect(report.status).toBe("fix-applied");
    expect(report.modelCallCount).toBe(0);
    expect(readFileSync(join(dir, "src", "buggy.ts"), "utf8")).toContain("n / 2");
  }, 60_000);

  it("rejects a reviewed fix the workspace no longer accepts and writes nothing", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-bug-reviewed-stale-")));
    cpSync(FIXTURE, dir, { recursive: true });
    const stale = FIX_DIFF.replace("n / 3", "n / 4");

    const report = await investigateBug(reviewedInput(dir, stale), {
      model: unusedModel,
      verificationNetworkEnforcement: "enforce-or-degrade",
    });

    expect(report.status).not.toBe("fix-applied");
    expect(report.modelCallCount).toBe(0);
    expect(readFileSync(join(dir, "src", "buggy.ts"), "utf8")).toContain("n / 3");
  });

  it("ignores a reviewed fix in a dry run, which asks the model as before", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-bug-reviewed-dry-")));
    cpSync(FIXTURE, dir, { recursive: true });

    const report = await investigateBug(
      { ...reviewedInput(dir, FIX_DIFF), apply: false },
      { model: model(MODEL_CONTENT) },
    );

    expect(report.status).toBe("fix-proposed");
    expect(report.modelCallCount).toBe(1);
    expect(readFileSync(join(dir, "src", "buggy.ts"), "utf8")).toContain("n / 3");
  });
});
