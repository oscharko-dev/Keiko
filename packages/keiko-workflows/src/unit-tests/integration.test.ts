// Real patch application and execution inside a self-contained workspace. The fixture uses
// Node's built-in runner so no host node_modules, native addon, network install, or wider mount
// is required by the confined process.

import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { generateUnitTests } from "./workflow.js";
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
  "unit-tests",
  "target-project",
);

// A valid create diff adding a passing test for the fixture's add(). Placed at the mirrored
// candidate path tests/add.test.ts so resolveTargetedTests discovers it from src/add.ts.
const TEST_DIFF =
  "--- /dev/null\n+++ b/tests/add.test.ts\n@@ -0,0 +1,7 @@\n" +
  "+import { describe, it } from 'node:test';\n" +
  "+import { strictEqual } from 'node:assert';\n" +
  "+import { add } from '../src/add.ts';\n" +
  "+describe('add', () => {\n" +
  "+  it('adds two numbers', () => strictEqual(add(1, 2), 3));\n" +
  "+  it('handles zero', () => strictEqual(add(0, 0), 0));\n" +
  "+});\n";

function model(content: string): ModelPort {
  const response: NormalizedResponse = {
    modelId: "m",
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
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

describe("generateUnitTests — apply + verify integration (AC #7/#8)", () => {
  it("writes the test file to disk and verification reports passed", async () => {
    dir = realpathSync(mkdtempSync(join(here, ".keiko-itest-")));
    cpSync(FIXTURE, dir, { recursive: true });
    const fenced = ["```diff", TEST_DIFF.trimEnd(), "```"].join("\n");

    const report = await generateUnitTests(
      {
        workspaceRoot: dir,
        target: { kind: "file", filePath: "src/add.ts" },
        apply: true,
        modelId: "test-model",
      },
      { model: model(fenced), verificationNetworkEnforcement: "enforce-or-degrade" },
    );

    // AC #7 — the patch was applied and the test file exists on disk.
    expect(report.status).toBe("completed");
    const written = join(dir, "tests", "add.test.ts");
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toContain("add(1, 2)");

    // AC #8 — verification ran against the just-created test and passed.
    expect(report.verificationSummary?.overallStatus).toBe("passed");
    expect(report.verificationSkipReason).toBeUndefined();
  }, 60_000);
});
