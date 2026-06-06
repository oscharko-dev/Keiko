// Unit-test happy-path fixture (ADR-0012 D3 + C5): a valid, in-scope test-file diff. Runs in APPLY
// mode with a recording writer + deterministic fake spawn (exit 0) so the test-pass-rate and
// verification-completeness dimensions score a real pass offline. The model returns a fenced diff
// creating tests/add.test.ts (mirrored convention), which the production-code guard accepts.

import {
  fencedDiff,
  FIXTURE_PACKAGE_JSON,
  FIXTURE_TSCONFIG_JSON,
  scriptedResponse,
} from "../support.js";
import type { EvaluationFixture } from "../../types.js";

const TEST_DIFF =
  "--- /dev/null\n+++ b/tests/add.test.ts\n@@ -0,0 +1,6 @@\n" +
  "+import { describe, expect, it } from 'vitest';\n" +
  "+import { add } from '../src/add';\n" +
  "+describe('add', () => {\n" +
  "+  it('adds two numbers', () => expect(add(1, 2)).toBe(3));\n" +
  "+  it('handles zero', () => expect(add(0, 0)).toBe(0));\n" +
  "+});\n";

export const unitTestsHappyPath: EvaluationFixture = {
  name: "happy-path",
  workflowKind: "unit-tests",
  apply: true,
  workspaceFiles: {
    "package.json": FIXTURE_PACKAGE_JSON,
    "tsconfig.json": FIXTURE_TSCONFIG_JSON,
    "src/add.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    "tests/.gitkeep": "",
  },
  workflowInput: { target: { kind: "file", filePath: "src/add.ts" }, modelId: "eval-model" },
  mockTranscript: [scriptedResponse(fencedDiff(TEST_DIFF))],
  dimensions: new Set([
    "task-completion",
    "patch-correctness",
    "patch-size",
    "audit-completeness",
    "test-pass-rate",
    "verification-completeness",
  ]),
  oracle: {
    expectedStatuses: ["completed"],
    expectPatch: true,
    expectVerificationSkip: false,
    maxExpectedChangedFiles: 1,
    maxExpectedPatchBytes: 4_096,
  },
};
