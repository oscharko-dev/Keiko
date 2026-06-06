// Bug-investigation happy-path fixture (ADR-0012 D3 + C5): a valid in-scope fix diff + a root-cause
// hypothesis. Runs in APPLY mode with a recording writer + deterministic fake spawn (exit 0). The
// model returns a fenced diff correcting src/buggy.ts (divisor 3 -> 2) plus labeled prose sections,
// so the workflow validates+applies the patch and verification reports passed — exercising the
// test-pass-rate and verification-completeness dimensions for the bug workflow (C5).

import { FIXTURE_PACKAGE_JSON, scriptedResponse } from "../support.js";
import type { EvaluationFixture } from "../../types.js";

const BUGGY_SOURCE =
  "// A deliberately buggy helper: `half` divides by 3 instead of 2.\n" +
  "export const half = (n: number): number => n / 3;\n";

const REGRESSION_TEST =
  "import { describe, expect, it } from 'vitest';\n" +
  "import { half } from '../src/buggy.js';\n" +
  "describe('half', () => {\n" +
  "  it('returns half of the input', () => {\n" +
  "    expect(half(10)).toBe(5);\n" +
  "  });\n" +
  "});\n";

const FIX_DIFF = [
  "--- a/src/buggy.ts",
  "+++ b/src/buggy.ts",
  "@@ -2 +2 @@",
  "-export const half = (n: number): number => n / 3;",
  "+export const half = (n: number): number => n / 2;",
].join("\n");

const MODEL_CONTENT = [
  "```diff",
  FIX_DIFF,
  "```",
  "## Root cause",
  "The divisor was 3 instead of 2, so half returned a third of the input.",
  "## Regression test",
  "tests/buggy.test.ts already asserts half(10) === 5.",
  "## Confidence",
  "high",
].join("\n");

export const bugHappyPath: EvaluationFixture = {
  name: "happy-path",
  workflowKind: "bug-investigation",
  apply: true,
  workspaceFiles: {
    "package.json": FIXTURE_PACKAGE_JSON,
    "src/buggy.ts": BUGGY_SOURCE,
    "tests/buggy.test.ts": REGRESSION_TEST,
  },
  workflowInput: {
    report: {
      description: "half returns the wrong value",
      failingOutput: "AssertionError: expected 3.33 to be 5\n at half (src/buggy.ts:2:40)",
    },
    modelId: "eval-model",
  },
  mockTranscript: [scriptedResponse(MODEL_CONTENT)],
  dimensions: new Set([
    "task-completion",
    "patch-correctness",
    "patch-size",
    "audit-completeness",
    "test-pass-rate",
    "verification-completeness",
  ]),
  oracle: {
    expectedStatuses: ["fix-applied"],
    expectPatch: true,
    expectVerificationSkip: false,
    maxExpectedChangedFiles: 2,
    maxExpectedPatchBytes: 4_096,
  },
};
