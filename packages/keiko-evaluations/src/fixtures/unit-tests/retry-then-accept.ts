// Unit-test retry-then-accept fixture (ADR-0012 D3): the first model call returns a diff that edits a
// SOURCE file (src/add.ts) — rejected by the production-code guard — and the second returns a valid
// test-file diff that is accepted. The workflow records patchRetryCount === 1 and terminates `dry-run`
// (no apply), so the proposed test patch is reviewable without writing to disk.

import {
  fencedDiff,
  FIXTURE_PACKAGE_JSON,
  FIXTURE_TSCONFIG_JSON,
  scriptedResponse,
} from "../support.js";
import type { EvaluationFixture } from "../../types.js";

const SOURCE_EDIT_DIFF =
  "--- a/src/add.ts\n+++ b/src/add.ts\n@@ -1,3 +1,3 @@\n" +
  " export function add(a: number, b: number): number {\n" +
  "-  return a + b;\n" +
  "+  return a + b + 0;\n" +
  " }\n";

const TEST_DIFF =
  "--- /dev/null\n+++ b/tests/add.test.ts\n@@ -0,0 +1,5 @@\n" +
  "+import { describe, expect, it } from 'vitest';\n" +
  "+import { add } from '../src/add';\n" +
  "+describe('add', () => {\n" +
  "+  it('adds two numbers', () => expect(add(2, 3)).toBe(5));\n" +
  "+});\n";

export const unitTestsRetryThenAccept: EvaluationFixture = {
  name: "retry-then-accept",
  workflowKind: "unit-tests",
  workspaceFiles: {
    "package.json": FIXTURE_PACKAGE_JSON,
    "tsconfig.json": FIXTURE_TSCONFIG_JSON,
    "src/add.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    "tests/.gitkeep": "",
  },
  workflowInput: { target: { kind: "file", filePath: "src/add.ts" }, modelId: "eval-model" },
  mockTranscript: [
    scriptedResponse(fencedDiff(SOURCE_EDIT_DIFF)),
    scriptedResponse(fencedDiff(TEST_DIFF)),
  ],
  dimensions: new Set(["task-completion", "patch-correctness", "patch-size", "audit-completeness"]),
  oracle: {
    expectedStatuses: ["dry-run"],
    expectPatch: true,
    expectVerificationSkip: true,
    maxExpectedChangedFiles: 1,
    maxExpectedPatchBytes: 4_096,
  },
};
