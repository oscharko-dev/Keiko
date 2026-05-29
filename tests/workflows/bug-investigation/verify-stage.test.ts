import { describe, expect, it } from "vitest";
import {
  runBugVerification,
  SKIP_UNRESOLVED,
} from "../../../src/workflows/bug-investigation/verify-stage.js";
import {
  buildBugRunState,
  type BugRunState,
} from "../../../src/workflows/bug-investigation/internal.js";
import { computeBugFingerprint } from "../../../src/workflows/bug-investigation/emit.js";
import { memFs } from "../../workspace/_memfs.js";
import {
  detectWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "../../../src/workspace/index.js";
import type { PatchFileChange } from "../../../src/tools/index.js";
import type { BugInvestigationInput } from "../../../src/workflows/bug-investigation/types.js";

const ROOT = "/repo";

function runState(framework: "vitest" | "unknown"): {
  state: BugRunState;
  workspace: WorkspaceInfo;
  fs: WorkspaceFs;
} {
  const files: Record<string, string> =
    framework === "vitest"
      ? { "package.json": JSON.stringify({ name: "d", devDependencies: { vitest: "^4" } }) }
      : { "package.json": JSON.stringify({ name: "d" }) };
  const fs = memFs(ROOT, files);
  const workspace = detectWorkspace(ROOT, fs);
  const input: BugInvestigationInput = {
    workspaceRoot: ROOT,
    report: { description: "x" },
    modelId: "m",
  };
  const state = buildBugRunState(
    input,
    { model: { call: () => Promise.reject(new Error("unused")) }, fs },
    computeBugFingerprint(input.report, "m"),
  );
  return { state, workspace, fs };
}

function changed(path: string): PatchFileChange {
  return { path, kind: "modify", hunks: [], addedLines: 1, removedLines: 0 };
}

describe("runBugVerification (D11)", () => {
  it("skips when the test framework is unknown", async () => {
    const { state, workspace, fs } = runState("unknown");
    const out = await runBugVerification(state, workspace, [changed("src/buggy.ts")], fs);
    expect(out.summary).toBeUndefined();
    expect(out.skipReason).toBe(SKIP_UNRESOLVED);
  });

  it("skips when no test command resolves for the changed source", async () => {
    // vitest detected but no test script and no sibling/mirrored test for the changed file.
    const { state, workspace, fs } = runState("vitest");
    const out = await runBugVerification(state, workspace, [changed("src/orphan.ts")], fs);
    expect(out.summary).toBeUndefined();
    expect(out.skipReason).toBe(SKIP_UNRESOLVED);
  });
});
