import { describe, expect, it } from "vitest";
import { generateUnitTests } from "./workflow.js";
import type { UnitTestWorkflowDeps, UnitTestWorkflowInput } from "./types.js";
import { SKIP_UNRESOLVED } from "./verify-stage.js";
import { memFs } from "../../../../packages/keiko-workspace/src/_memfs.js";
import { recordingSpawn, scriptChildClose } from "../../../../tests/verification/_support.js";
import { recordingSink, recordingWriter, response, scriptedModel } from "./_support.js";

const ROOT = "/repo";

// A valid create diff that adds a sibling-discoverable test under tests/ (mirrored convention).
const VALID_TEST_DIFF =
  "--- /dev/null\n+++ b/tests/add.test.ts\n@@ -0,0 +1,3 @@\n" +
  "+import { add } from '../src/add';\n" +
  "+test('adds', () => expect(add(1, 2)).toBe(3));\n" +
  "+test('zero', () => expect(add(0, 0)).toBe(0));\n";

// A diff that CREATES a new production source file — validates cleanly (no conflict) but must be
// rejected by the production-code guard because src/extra.ts is not a test path.
const SOURCE_DIFF =
  "--- /dev/null\n+++ b/src/extra.ts\n@@ -0,0 +1,1 @@\n+export const extra = 1;\n";

const FENCED_VALID = [
  "```diff",
  VALID_TEST_DIFF.trimEnd(),
  "```",
  "",
  "## Covered behavior",
  "happy path",
].join("\n");

function baseFs(): ReturnType<typeof memFs> {
  return memFs(ROOT, {
    "package.json": JSON.stringify({
      name: "demo",
      devDependencies: { vitest: "^4" },
      scripts: { test: "vitest run" },
    }),
    "src/add.ts": "export const add = (a: number, b: number): number => a + b;",
  });
}

function input(overrides: Partial<UnitTestWorkflowInput> = {}): UnitTestWorkflowInput {
  return {
    workspaceRoot: ROOT,
    target: { kind: "file", filePath: "src/add.ts" },
    modelId: "test-model",
    ...overrides,
  };
}

function deps(
  model: UnitTestWorkflowDeps["model"],
  overrides: Partial<UnitTestWorkflowDeps> = {},
): UnitTestWorkflowDeps {
  return { model, fs: baseFs(), now: () => 1000, idSource: () => "run-1", ...overrides };
}

describe("generateUnitTests — dry-run (AC #2/#4/#6/#8)", () => {
  it("returns a UnitTestWorkflowReport with a valid dry-run patch (AC #4)", async () => {
    const model = scriptedModel([response({ content: FENCED_VALID })]);
    const report = await generateUnitTests(input(), deps(model.port));
    expect(report.status).toBe("dry-run");
    expect(report.dryRunPreview).toContain("PATCH OK");
    expect(report.proposedDiff).toContain("tests/add.test.ts");
    expect(report.addedTestFiles[0]?.path).toBe("tests/add.test.ts");
    expect(report.addedTestFiles[0]?.estimatedTestCount).toBe(2);
    expect(report.coveredBehavior).toBe("happy path");
    expect(report.modelCallCount).toBe(1);
    expect(report.workflowId).toBe("unit-test-generation");
  });

  it("is callable as an SDK function returning a value (AC #2)", async () => {
    const model = scriptedModel([response({ content: FENCED_VALID })]);
    const report = await generateUnitTests(input(), deps(model.port));
    expect(report).toHaveProperty("status");
    expect(typeof report.durationMs).toBe("number");
  });

  it("writes no files and records the dry-run skip reason (AC #6/#8)", async () => {
    const model = scriptedModel([response({ content: FENCED_VALID })]);
    const writer = recordingWriter();
    const report = await generateUnitTests(input(), deps(model.port, { writer }));
    expect(writer.writes()).toHaveLength(0);
    expect(report.verificationSummary).toBeUndefined();
    expect(report.verificationSkipReason).toContain("dry-run");
  });

  it("treats a no-fence response as the whole diff (model-output fallback)", async () => {
    const model = scriptedModel([response({ content: VALID_TEST_DIFF })]);
    const report = await generateUnitTests(input(), deps(model.port));
    expect(report.status).toBe("dry-run");
    expect(report.proposedDiff).toContain("tests/add.test.ts");
  });

  it("rejects an empty diff instead of accepting a no-op dry-run", async () => {
    const model = scriptedModel([response({ content: "```diff\n\n```" })]);
    const report = await generateUnitTests(
      input({ limits: { maxModelCalls: 1, maxRetries: 0 } }),
      deps(model.port),
    );
    expect(report.status).toBe("rejected");
    expect(report.nextActions[0]).toContain("empty");
    expect(report.proposedDiff).toBeUndefined();
    expect(report.addedTestFiles).toHaveLength(0);
  });

  it("emits a redacted progress event stream with the shared envelope", async () => {
    const model = scriptedModel([response({ content: FENCED_VALID })]);
    const sink = recordingSink();
    await generateUnitTests(input(), deps(model.port, { sink: sink.sink }));
    const types = sink.events().map((e) => e.type);
    expect(types).toContain("workflow:started");
    expect(types).toContain("conventions:detected");
    expect(types).toContain("patch:validated");
    expect(types.at(-1)).toBe("workflow:completed");
    // Envelope: monotonic seq starting at 1, stable runId/fingerprint.
    expect(sink.events()[0]).toMatchObject({ schemaVersion: "1", runId: "run-1", seq: 1 });
    expect(sink.events()[1]?.seq).toBe(2);
  });
});

describe("generateUnitTests — production-code guard (AC #9, D6)", () => {
  it("rejects a patch that touches a source file and retries", async () => {
    const model = scriptedModel([
      response({ content: SOURCE_DIFF }),
      response({ content: SOURCE_DIFF }),
      response({ content: SOURCE_DIFF }),
    ]);
    const report = await generateUnitTests(input(), deps(model.port));
    expect(report.status).toBe("rejected");
    // T1: exact ceiling assertions (maxModelCalls=3, maxRetries=2, all-rejected).
    // Loop exits when modelCallCount reaches 3 (ceiling) after 3 calls and 3 incremented retries.
    // Mutating `<=` → `<` in model-loop.ts yields modelCallCount=2, so the ===3 assertion flips.
    expect(report.modelCallCount).toBe(3);
    expect(report.patchRetryCount).toBe(3);
    expect(report.addedTestFiles).toHaveLength(0);
    expect(report.proposedDiff).toBeUndefined();
  });

  it("emits patch:validated with the out-of-scope rejection code", async () => {
    const model = scriptedModel([response({ content: SOURCE_DIFF })]);
    const sink = recordingSink();
    await generateUnitTests(input(), deps(model.port, { sink: sink.sink }));
    const validated = sink.events().filter((e) => e.type === "patch:validated");
    expect(validated.some((e) => e.rejectionCode === "out-of-scope")).toBe(true);
  });

  it("recovers when a retry produces an in-scope patch", async () => {
    const model = scriptedModel([
      response({ content: SOURCE_DIFF }),
      response({ content: FENCED_VALID }),
    ]);
    const report = await generateUnitTests(input(), deps(model.port));
    expect(report.status).toBe("dry-run");
    expect(report.patchRetryCount).toBe(1);
    expect(report.modelCallCount).toBe(2);
  });
});

describe("generateUnitTests — limits & lifecycle", () => {
  it("stops at the maxModelCalls ceiling even when retries remain", async () => {
    const model = scriptedModel([response({ content: SOURCE_DIFF })]);
    const report = await generateUnitTests(
      input({ limits: { maxModelCalls: 2, maxRetries: 99 } }),
      deps(model.port),
    );
    expect(report.modelCallCount).toBe(2);
    expect(model.calls()).toBe(2);
    expect(report.status).toBe("rejected");
  });

  it("classifies an already-aborted run as cancelled without writing", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = scriptedModel([response({ content: FENCED_VALID })]);
    const writer = recordingWriter();
    const report = await generateUnitTests(
      input({ apply: true }),
      deps(model.port, { writer, signal: controller.signal }),
    );
    expect(report.status).toBe("cancelled");
    expect(writer.writes()).toHaveLength(0);
  });

  it("maps a model IO error to a failed report (redacted)", async () => {
    const model = scriptedModel([new Error("boom")]);
    const report = await generateUnitTests(input(), deps(model.port));
    expect(report.status).toBe("failed");
    expect(report.addedTestFiles).toHaveLength(0);
  });
});

describe("generateUnitTests — apply mode verification", () => {
  it("falls back to a runnable npm test script when testFramework is unknown (AC #8)", async () => {
    const unknownFs = memFs(ROOT, {
      "package.json": JSON.stringify({ name: "no-framework", scripts: { test: "echo ok" } }),
      "src/add.ts": "export const add = (a: number, b: number): number => a + b;",
    });
    const model = scriptedModel([response({ content: FENCED_VALID })]);
    const writer = recordingWriter();
    const spawn = recordingSpawn();
    const autoClosingSpawn: typeof spawn.fn = (command, args, options) => {
      const child = spawn.fn(command, args, options);
      scriptChildClose(spawn.child, { stdout: "ok\n", exitCode: 0 });
      return child;
    };
    const report = await generateUnitTests(input({ apply: true }), {
      model: model.port,
      fs: unknownFs,
      writer,
      spawn: autoClosingSpawn,
      now: () => 1000,
      idSource: () => "run-1",
    });
    expect(report.status).toBe("completed");
    expect(report.verificationSummary?.overallStatus).toBe("passed");
    expect(report.verificationSkipReason).toBeUndefined();
    expect(spawn.calls()[0]?.args).toEqual(["test"]);
  });

  it("skips verification when no test command resolves", async () => {
    const unknownFs = memFs(ROOT, {
      "package.json": JSON.stringify({ name: "no-framework" }),
      "src/add.ts": "export const add = (a: number, b: number): number => a + b;",
    });
    const model = scriptedModel([response({ content: FENCED_VALID })]);
    const writer = recordingWriter();
    const report = await generateUnitTests(input({ apply: true }), {
      model: model.port,
      fs: unknownFs,
      writer,
      now: () => 1000,
      idSource: () => "run-1",
    });
    expect(report.status).toBe("completed");
    expect(report.verificationSummary).toBeUndefined();
    expect(report.verificationSkipReason).toBe(SKIP_UNRESOLVED);
  });
});
