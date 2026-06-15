import { describe, expect, it } from "vitest";
import { investigateBug } from "./workflow.js";
import type { BugInvestigationDeps, BugInvestigationInput } from "./types.js";
import type { MemoryId, MemoryUsedEvent, MemoryWorkflowPort } from "@oscharko-dev/keiko-contracts";
import { memFs } from "../../../../packages/keiko-workspace/src/_memfs.js";
import { recordingSink, recordingWriter, response, scriptedModel } from "./_support.js";

const ROOT = "/repo";

function fixtureFs(): ReturnType<typeof memFs> {
  return memFs(ROOT, {
    "package.json": JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
    "src/buggy.ts": "export const half = (n: number): number => n / 3;\n",
    "tests/buggy.test.ts":
      "import { half } from '../src/buggy';\nimport { test, expect } from 'vitest';\ntest('half', () => { expect(half(10)).toBe(5); });\n",
  });
}

// A valid in-scope fix diff touching the source and adding a regression assertion.
const FIX_DIFF = [
  "```diff",
  "--- a/src/buggy.ts",
  "+++ b/src/buggy.ts",
  "@@ -1 +1 @@",
  "-export const half = (n: number): number => n / 3;",
  "+export const half = (n: number): number => n / 2;",
  "--- a/tests/buggy.test.ts",
  "+++ b/tests/buggy.test.ts",
  "@@ -1 +1,2 @@",
  " import { half } from '../src/buggy';",
  "+it('returns half of a positive number', () => expect(half(8)).toBe(4));",
  "```",
  "## Root cause",
  "The divisor was 3 instead of 2.",
  "## Regression test",
  "Assert half(10) === 5.",
  "## Confidence",
  "high",
].join("\n");

function input(overrides: Partial<BugInvestigationInput> = {}): BugInvestigationInput {
  return {
    workspaceRoot: ROOT,
    report: {
      description: "half returns wrong value",
      stackTrace: "    at half (src/buggy.ts:1:40)",
    },
    modelId: "m",
    ...overrides,
  };
}

function deps(
  model: BugInvestigationDeps["model"],
  extra: Partial<BugInvestigationDeps> = {},
): BugInvestigationDeps {
  return { model, fs: fixtureFs(), ...extra };
}

describe("investigateBug (AC #2 SDK / AC #4/#5/#7)", () => {
  it("returns a fix-proposed report with the diff and hypothesis in dry-run mode", async () => {
    const model = scriptedModel([response({ content: FIX_DIFF })]);
    const report = await investigateBug(input(), deps(model.port));
    expect(report.status).toBe("fix-proposed");
    expect(report.proposedDiff).toContain("n / 2");
    expect(report.verified.patchValidates).toBe(true);
    expect(report.verified.patchApplied).toBe(false);
    expect(report.hypothesis.rootCause).toContain("divisor was 3");
    expect(report.hypothesis.confidence).toBe("high");
    expect(report.regressionCoverage).toBeGreaterThan(0);
  });

  it("writes nothing to disk in dry-run mode (AC #5)", async () => {
    const model = scriptedModel([response({ content: FIX_DIFF })]);
    const writer = recordingWriter();
    const report = await investigateBug(input(), deps(model.port, { writer }));
    expect(writer.writes()).toHaveLength(0);
    expect(report.verificationSkipReason).toContain("dry-run");
  });

  it("records the parsed failure frame as a verified fact, separate from the hypothesis (AC #7)", async () => {
    const model = scriptedModel([response({ content: FIX_DIFF })]);
    const report = await investigateBug(input(), deps(model.port));
    expect(report.verified.failureFrames).toContainEqual({ file: "src/buggy.ts", line: 1 });
  });

  it("returns investigation-only when the model omits the diff but gives a root cause (D10)", async () => {
    const content = [
      "## Root cause",
      "Likely a race; evidence is thin.",
      "## Uncertainty",
      "Need full log.",
    ].join("\n");
    const model = scriptedModel([response({ content })]);
    const report = await investigateBug(input(), deps(model.port));
    expect(report.status).toBe("investigation-only");
    expect(report.proposedDiff).toBeUndefined();
    expect(report.hypothesis.rootCause).toContain("race");
    expect(report.changedFiles).toHaveLength(0);
  });

  it("rejects with no model call when no evidence is provided (intake precondition)", async () => {
    const model = scriptedModel([response({ content: FIX_DIFF })]);
    const report = await investigateBug(input({ report: {} }), deps(model.port));
    expect(report.status).toBe("rejected");
    expect(model.calls()).toBe(0);
  });

  it("rejects an out-of-scope patch after retries (scope guard, AC #9)", async () => {
    const evil = [
      "```diff",
      "--- a/.github/workflows/ci.yml",
      "+++ b/.github/workflows/ci.yml",
      "@@ -1 +1 @@",
      "-on: push",
      "+on: { push: {}, pull_request_target: {} }",
      "```",
      "## Root cause",
      "x",
    ].join("\n");
    const model = scriptedModel([response({ content: evil })]);
    const report = await investigateBug(input(), deps(model.port));
    expect(report.status).toBe("rejected");
    expect(report.patchRetryCount).toBeGreaterThan(0);
    expect(model.calls()).toBeGreaterThan(1);
  });

  it("emits a started and a completed event with the terminal status", async () => {
    const model = scriptedModel([response({ content: FIX_DIFF })]);
    const sink = recordingSink();
    await investigateBug(input(), deps(model.port, { sink: sink.sink }));
    const types = sink.events().map((e) => e.type);
    expect(types).toContain("bug:started");
    expect(types).toContain("bug:completed");
    expect(types).toContain("bug:failure:parsed");
  });

  it("injects retrieved workflow memory into the model prompt", async () => {
    const model = scriptedModel([response({ content: FIX_DIFF })]);
    const used: MemoryUsedEvent[] = [];
    const memoryPort: MemoryWorkflowPort = {
      getContextForWorkflow: (scopes, queryText, budgetTokens) => {
        expect(scopes).toEqual([{ kind: "project", projectId: input().workspaceRoot }]);
        expect(queryText).toBe("half returns wrong value");
        expect(budgetTokens).toBe(2_048);
        return Promise.resolve({
          text: "# Relevant memories\n- (workflow lesson) Keep half() fixes minimal.",
          includedMemoryIds: ["mem-workflow" as MemoryId],
        });
      },
      onMemoryUsed: (event) => {
        used.push(event);
      },
    };

    await investigateBug(input(), deps(model.port, { memoryPort }));

    const userMessage = model.lastMessages().find((message) => message.role === "user");
    expect(userMessage?.content).toContain(
      "Memory context (governed, scoped, non-authoritative reference):",
    );
    expect(userMessage?.content).toContain("Keep half() fixes minimal.");
    expect(used).toHaveLength(1);
    expect(used[0]?.memoryIds).toEqual(["mem-workflow" as MemoryId]);
  });
});
