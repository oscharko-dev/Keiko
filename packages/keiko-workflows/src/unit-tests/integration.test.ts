// Apply-mode + verification integration test (ADR-0008 D11, steering note D) — the ONLY workflow
// test that touches the real filesystem and spawns a process. It copies the on-disk fixture project
// into a tmp dir created NEXT TO the real node_modules that provides vitest (derived dynamically via
// require.resolve), so `npx vitest run` resolves vitest through upward module resolution WITHOUT
// network (the sandbox blocks network; #6 injects an ephemeral HOME). When vitest cannot be
// resolved, the suite is it.skip'd with a documented reason rather than hard-failing CI.

import { createRequire } from "node:module";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// Resolve the directory that CONTAINS the node_modules providing vitest. A tmp project created here
// resolves vitest by walking up into that node_modules — no install, no network. require.resolve
// throws if vitest is not installed, in which case we skip.
function vitestHostRoot(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("vitest/package.json");
    // .../<root>/node_modules/vitest/package.json -> <root>
    const nodeModulesDir = dirname(dirname(pkg));
    return dirname(nodeModulesDir);
  } catch {
    return undefined;
  }
}

// A valid create diff adding a passing test for the fixture's add(). Placed at the mirrored
// candidate path tests/add.test.ts so resolveTargetedTests discovers it from src/add.ts.
const TEST_DIFF =
  "--- /dev/null\n+++ b/tests/add.test.ts\n@@ -0,0 +1,6 @@\n" +
  "+import { describe, expect, it } from 'vitest';\n" +
  "+import { add } from '../src/add';\n" +
  "+describe('add', () => {\n" +
  "+  it('adds two numbers', () => expect(add(1, 2)).toBe(3));\n" +
  "+  it('handles zero', () => expect(add(0, 0)).toBe(0));\n" +
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

const hostRoot = vitestHostRoot();
let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

// Skip with a documented reason when vitest cannot be resolved (mirrors #7's Linux-only /proc skip):
// the test requires a real `npx vitest` to spawn, which is unavailable in environments without the
// dependency installed. CI installs devDependencies, so this runs as a real passing test there.
const maybe = hostRoot === undefined ? describe.skip : describe;

maybe("generateUnitTests — apply + verify integration (AC #7/#8)", () => {
  it("writes the test file to disk and verification reports passed", async () => {
    dir = mkdtempSync(join(hostRoot ?? ".", ".keiko-itest-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const fenced = ["```diff", TEST_DIFF.trimEnd(), "```"].join("\n");

    const report = await generateUnitTests(
      {
        workspaceRoot: dir,
        target: { kind: "file", filePath: "src/add.ts" },
        apply: true,
        modelId: "test-model",
      },
      { model: model(fenced) },
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
