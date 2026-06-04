import { describe, expect, it } from "vitest";
import { runBugVerification, SKIP_UNRESOLVED } from "./verify-stage.js";
import { buildBugRunState, type BugRunState } from "./internal.js";
import { computeBugFingerprint } from "./emit.js";
import { memFs } from "../../../../packages/keiko-workspace/src/_memfs.js";
import {
  detectWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import type { PatchFileChange, SpawnFn } from "@oscharko-dev/keiko-tools";
import type { BugInvestigationInput } from "./types.js";
import { recordingSpawn, scriptChildClose } from "../../../../tests/verification/_support.js";

const ROOT = "/repo";

interface StateOpts {
  readonly withTestScript?: boolean;
  readonly files?: Record<string, string>;
  readonly spawn?: SpawnFn;
}

function runState(
  framework: "vitest" | "unknown",
  opts: StateOpts = {},
): {
  state: BugRunState;
  workspace: WorkspaceInfo;
  fs: WorkspaceFs;
} {
  const pkg =
    framework === "vitest"
      ? JSON.stringify({
          name: "d",
          ...(opts.withTestScript === true ? { scripts: { test: "vitest run" } } : {}),
          devDependencies: { vitest: "^4" },
        })
      : JSON.stringify({
          name: "d",
          ...(opts.withTestScript === true ? { scripts: { test: "node test.js" } } : {}),
        });
  const fs = memFs(ROOT, { "package.json": pkg, ...(opts.files ?? {}) });
  const workspace = detectWorkspace(ROOT, fs);
  const input: BugInvestigationInput = {
    workspaceRoot: ROOT,
    report: { description: "x" },
    modelId: "m",
  };
  const state = buildBugRunState(
    input,
    {
      model: { call: () => Promise.reject(new Error("unused")) },
      fs,
      ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
    },
    computeBugFingerprint(input.report, "m"),
  );
  return { state, workspace, fs };
}

function changed(path: string): PatchFileChange {
  return { path, kind: "modify", hunks: [], addedLines: 1, removedLines: 0 };
}

describe("runBugVerification (D11)", () => {
  it("skips when the test framework is unknown and no runnable test script exists", async () => {
    const { state, workspace, fs } = runState("unknown");
    const out = await runBugVerification(state, workspace, [changed("src/buggy.ts")], fs);
    expect(out.summary).toBeUndefined();
    expect(out.skipReason).toBe(SKIP_UNRESOLVED);
  });

  it("falls back to npm test when the framework is unknown but a test script exists", async () => {
    const spawn = recordingSpawn();
    const { state, workspace, fs } = runState("unknown", {
      withTestScript: true,
      spawn: spawn.fn,
    });
    scriptChildClose(spawn.child, { stdout: "1 passed", exitCode: 0 });
    const out = await runBugVerification(state, workspace, [changed("src/buggy.ts")], fs);
    expect(out.skipReason).toBeUndefined();
    expect(out.summary?.overallStatus).toBe("passed");
    expect(spawn.calls().length).toBe(1);
  });

  it("skips when no test command resolves for the changed source", async () => {
    // vitest detected but no test script and no sibling/mirrored test for the changed file.
    const { state, workspace, fs } = runState("vitest");
    const out = await runBugVerification(state, workspace, [changed("src/orphan.ts")], fs);
    expect(out.summary).toBeUndefined();
    expect(out.skipReason).toBe(SKIP_UNRESOLVED);
  });

  it("runs the resolved targeted test and reports passed (mock spawn, no real process)", async () => {
    // A mirrored test exists for the changed source, so resolveTargetedTests yields a step; the fake
    // spawn exits 0 so the audit summary's overallStatus is `passed` — mutation-robust evidence
    // independent of the on-disk integration test.
    const spawn = recordingSpawn();
    const { state, workspace, fs } = runState("vitest", {
      withTestScript: true,
      files: { "tests/buggy.test.ts": "import { test } from 'vitest';\ntest('x', () => {});\n" },
      spawn: spawn.fn,
    });
    scriptChildClose(spawn.child, { stdout: "1 passed", exitCode: 0 });
    const out = await runBugVerification(state, workspace, [changed("src/buggy.ts")], fs);
    expect(out.skipReason).toBeUndefined();
    expect(out.summary?.overallStatus).toBe("passed");
    expect(spawn.calls().length).toBe(1);
  });

  it("runs a changed regression test file directly instead of falling back to the full suite", async () => {
    const spawn = recordingSpawn();
    const { state, workspace, fs } = runState("vitest", {
      withTestScript: true,
      files: { "tests/buggy.test.ts": "import { test } from 'vitest';\ntest('x', () => {});\n" },
      spawn: spawn.fn,
    });
    scriptChildClose(spawn.child, { stdout: "1 passed", exitCode: 0 });
    const out = await runBugVerification(state, workspace, [changed("tests/buggy.test.ts")], fs);
    expect(out.skipReason).toBeUndefined();
    expect(out.summary?.overallStatus).toBe("passed");
    expect(spawn.calls()[0]?.command).toContain("npx");
    expect(spawn.calls()[0]?.args).toEqual(["vitest", "run", "tests/buggy.test.ts"]);
  });
});
