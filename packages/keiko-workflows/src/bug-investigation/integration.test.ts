// Apply-mode + verification integration test (ADR-0009 D15) — the ONLY bug-investigation test that
// touches the real filesystem and spawns a process. It copies the on-disk fixture project into a tmp
// dir created NEXT TO the real node_modules that provides vitest (derived dynamically via
// require.resolve), so `npx vitest run` resolves vitest through upward module resolution WITHOUT
// network. The fixture's regression test FAILS against the buggy source; the workflow applies a
// corrected diff (mock model) and verification then reports PASSED — fail-before / pass-after is the
// real evidence (D11). When vitest cannot be resolved, the suite is describe.skip'd.

import { createRequire } from "node:module";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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

function vitestHostRoot(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("vitest/package.json");
    // .../<root>/node_modules/vitest/package.json -> <root>
    return dirname(dirname(dirname(pkg)));
  } catch {
    return undefined;
  }
}

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

const hostRoot = vitestHostRoot();
let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

const maybe = hostRoot === undefined ? describe.skip : describe;

maybe("investigateBug — apply + verify integration (AC #6/#8)", () => {
  it("applies the fix to disk and verification reports passed", async () => {
    dir = mkdtempSync(join(hostRoot ?? ".", ".keiko-itest-"));
    cpSync(FIXTURE, dir, { recursive: true });

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
      { model: model(MODEL_CONTENT) },
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
