import { describe, expect, it } from "vitest";
import { runBugModelLoop } from "../../../src/workflows/bug-investigation/model-loop.js";
import { buildBugRunState } from "../../../src/workflows/bug-investigation/internal.js";
import { computeBugFingerprint } from "../../../src/workflows/bug-investigation/emit.js";
import { parseFailureEvidence } from "../../../src/workflows/bug-investigation/failure-parse.js";
import type {
  BugInvestigationDeps,
  BugInvestigationInput,
} from "../../../src/workflows/bug-investigation/types.js";
import { memFs } from "../../../packages/keiko-workspace/src/_memfs.js";
import {
  detectWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "../../../src/workspace/index.js";
import { makePack, response, scriptedModel } from "./_support.js";
import type { NormalizedResponse } from "../../../src/gateway/types.js";
import type { BugRunState } from "../../../src/workflows/bug-investigation/internal.js";

const ROOT = "/repo";

function ws(): { fs: WorkspaceFs; workspace: WorkspaceInfo } {
  const fs = memFs(ROOT, {
    "package.json": JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
    "src/buggy.ts": "export const half = (n: number): number => n / 3;\n",
  });
  return { fs, workspace: detectWorkspace(ROOT, fs) };
}

const FIX = [
  "```diff",
  "--- a/src/buggy.ts",
  "+++ b/src/buggy.ts",
  "@@ -1 +1 @@",
  "-export const half = (n: number): number => n / 3;",
  "+export const half = (n: number): number => n / 2;",
  "```",
  "## Root cause",
  "wrong divisor",
].join("\n");

// A well-formed CREATE diff for a .github workflow: #6 validatePatch accepts the structure (it does
// not block .github/), so the workflow-level scope guard (D6 bound 2) is what rejects it as
// out-of-scope — exactly the barrier under test.
const SENSITIVE = [
  "```diff",
  "--- /dev/null",
  "+++ b/.github/workflows/evil.yml",
  "@@ -0,0 +1,2 @@",
  "+on: pull_request_target",
  "+jobs: { x: { runs-on: ubuntu-latest } }",
  "```",
  "## Root cause",
  "x",
].join("\n");

function state(
  model: BugInvestigationDeps["model"],
  fs: BugInvestigationDeps["fs"],
  limits?: BugInvestigationInput["limits"],
): BugRunState {
  const input: BugInvestigationInput = {
    workspaceRoot: ROOT,
    report: { description: "bug" },
    modelId: "m",
    ...(limits === undefined ? {} : { limits }),
  };
  return buildBugRunState(input, { model, fs }, computeBugFingerprint(input.report, input.modelId));
}

const evidence = parseFailureEvidence({ description: "bug" });

describe("runBugModelLoop (D6/D10)", () => {
  it("accepts a valid in-scope patch on the first attempt", async () => {
    const { fs, workspace } = ws();
    const model = scriptedModel([response({ content: FIX })]);
    const result = await runBugModelLoop(
      state(model.port, fs),
      workspace,
      { description: "bug" },
      evidence,
      makePack([]),
    );
    expect(result.accepted?.diff).toContain("n / 2");
    expect(result.investigationOnly).toBeUndefined();
    expect(result.modelCallCount).toBe(1);
  });

  it("returns investigation-only for an empty diff with a hypothesis (NOT a retry)", async () => {
    const { fs, workspace } = ws();
    const content = "## Root cause\nthin evidence\n## Uncertainty\nneed logs";
    const model = scriptedModel([response({ content })]);
    const result = await runBugModelLoop(
      state(model.port, fs),
      workspace,
      { description: "bug" },
      evidence,
      makePack([]),
    );
    expect(result.investigationOnly?.rootCause).toContain("thin evidence");
    expect(result.accepted).toBeUndefined();
    expect(model.calls()).toBe(1);
  });

  it("retries an out-of-scope (sensitive-path) patch then gives up via maxRetries", async () => {
    const { fs, workspace } = ws();
    const model = scriptedModel([response({ content: SENSITIVE })]);
    // maxModelCalls is high so maxRetries (2) is the binding constraint: the loop permits attempts
    // while patchRetryCount is 0,1,2 (3 attempts), then exits when it would become 3 (> maxRetries).
    const result = await runBugModelLoop(
      state(model.port, fs, { maxRetries: 2, maxModelCalls: 5 }),
      workspace,
      { description: "bug" },
      evidence,
      makePack([]),
    );
    expect(result.accepted).toBeUndefined();
    expect(result.investigationOnly).toBeUndefined();
    expect(result.lastRejectionCode).toBe("out-of-scope");
    expect(result.modelCallCount).toBe(3);
    expect(result.patchRetryCount).toBe(3);
  });

  it("retries an empty-and-bare response once then accepts a later valid patch", async () => {
    const { fs, workspace } = ws();
    const empty: NormalizedResponse = response({ content: "" });
    const model = scriptedModel([empty, response({ content: FIX })]);
    const result = await runBugModelLoop(
      state(model.port, fs),
      workspace,
      { description: "bug" },
      evidence,
      makePack([]),
    );
    expect(result.accepted?.diff).toContain("n / 2");
    expect(result.patchRetryCount).toBe(1);
    expect(result.modelCallCount).toBe(2);
  });

  it("does not accept non-diff prose as a proposed fix", async () => {
    const { fs, workspace } = ws();
    const model = scriptedModel([
      response({
        content: [
          "```diff",
          "// `detail` is SENSITIVE and must be redacted before persistence.",
          "```",
          "## Root cause",
          "Sensitive details may leak into persisted evidence.",
        ].join("\n"),
      }),
    ]);
    const result = await runBugModelLoop(
      state(model.port, fs, { maxModelCalls: 1, maxRetries: 0 }),
      workspace,
      { description: "bug" },
      evidence,
      makePack([]),
    );
    expect(result.accepted).toBeUndefined();
    expect(result.investigationOnly).toBeUndefined();
    expect(result.lastRejectionCode).toBe("malformed");
  });

  it("accepts a later valid diff candidate from the same model response", async () => {
    const { fs, workspace } = ws();
    const invalid = [
      "```diff",
      "--- a/src/buggy.ts",
      "+++ b/src/buggy.ts",
      "@@ -1 +1 @@",
      "-export const missing = true;",
      "+export const missing = false;",
      "```",
    ].join("\n");
    const model = scriptedModel([response({ content: `${invalid}\n\n${FIX}` })]);
    const result = await runBugModelLoop(
      state(model.port, fs),
      workspace,
      { description: "bug" },
      evidence,
      makePack([]),
    );
    expect(result.accepted?.diff).toContain("n / 2");
    expect(result.modelCallCount).toBe(1);
    expect(result.patchRetryCount).toBe(0);
  });

  it("rejects a test-only patch for a source-file bug", async () => {
    const { fs, workspace } = ws();
    const testOnly = [
      "```diff",
      "--- /dev/null",
      "+++ b/tests/buggy-extra.test.ts",
      "@@ -0,0 +1,2 @@",
      "+import { test } from 'vitest';",
      "+test('documents the bug', () => {});",
      "```",
      "## Root cause",
      "source bug",
    ].join("\n");
    const model = scriptedModel([response({ content: testOnly })]);
    const result = await runBugModelLoop(
      state(model.port, fs, { maxModelCalls: 1, maxRetries: 0 }),
      workspace,
      { description: "bug", targetFiles: ["src/buggy.ts"] },
      evidence,
      makePack([]),
    );
    expect(result.accepted).toBeUndefined();
    expect(result.lastRejectionCode).toBe("test-only");
  });

  it("rejects an oversized patch via the tighter change budget", async () => {
    const { fs, workspace } = ws();
    const bigBody = Array.from({ length: 400 }, (_, i) => `+line${String(i)}`).join("\n");
    const huge = [
      "```diff",
      "--- /dev/null",
      "+++ b/src/extra.ts",
      "@@ -0,0 +1,400 @@",
      bigBody,
      "```",
      "## Root cause",
      "x",
    ].join("\n");
    const model = scriptedModel([response({ content: huge })]);
    const result = await runBugModelLoop(
      state(model.port, fs, { maxChangedLines: 300, maxRetries: 1, maxModelCalls: 2 }),
      workspace,
      { description: "bug" },
      evidence,
      makePack([]),
    );
    expect(result.accepted).toBeUndefined();
    expect(result.lastRejectionCode).toBe("line-limit");
  });

  it("stops at the maxModelCalls ceiling", async () => {
    const { fs, workspace } = ws();
    const model = scriptedModel([response({ content: SENSITIVE })]);
    const result = await runBugModelLoop(
      state(model.port, fs, { maxModelCalls: 2, maxRetries: 5 }),
      workspace,
      { description: "bug" },
      evidence,
      makePack([]),
    );
    expect(model.calls()).toBe(2);
    expect(result.modelCallCount).toBe(2);
  });
});
