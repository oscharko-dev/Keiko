// KEIKO-0096: the verify stage used to request "enforce-or-degrade" whenever a spawn dependency was
// injected, as shorthand for "a test harness is driving this". Injecting a spawn is also how the
// production budget wrapper reaches a GOVERNED run (run-engine's governedWorkflowPorts), so the
// heuristic disabled the deny-by-default egress boundary (ADR-0043 D8) on exactly the two workflows
// that execute model-authored code. These pin that the enforcement mode comes from an explicit
// dependency only, so a governed-shaped deps object never degrades a network:"none" step to
// inherited network.

import { describe, expect, it } from "vitest";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import {
  detectWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import { buildRunState, type RunState } from "./internal.js";
import { runWorkflowVerification } from "./verify-stage.js";
import type { UnitTestWorkflowDeps, UnitTestWorkflowInput } from "./types.js";
import { recordingSpawn, scriptChildClose } from "./_support.js";

const ROOT = "/repo";

function runState(deps: Partial<UnitTestWorkflowDeps>): {
  state: RunState;
  workspace: WorkspaceInfo;
  fs: WorkspaceFs;
} {
  const fs = memFs(ROOT, {
    "package.json": JSON.stringify({
      name: "d",
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^4" },
    }),
    "src/add.ts": "export const add = (a: number, b: number): number => a + b;",
    "tests/add.test.ts": "import { test } from 'vitest';\ntest('x', () => {});\n",
  });
  const input: UnitTestWorkflowInput = {
    workspaceRoot: ROOT,
    target: { kind: "file", filePath: "src/add.ts" },
    modelId: "m",
  };
  const state = buildRunState(
    input,
    { model: { call: () => Promise.reject(new Error("unused")) }, fs, ...deps },
    "fp",
  );
  return { state, workspace: detectWorkspace(ROOT, fs), fs };
}

// The production governed shape: the budget wrapper injects a spawn, and no caller anywhere sets an
// explicit verification egress policy.
function governedSpawn(): { fn: SpawnFn; calls: () => readonly unknown[] } {
  const spawn = recordingSpawn();
  return {
    calls: spawn.calls,
    fn: (command, args, options): ReturnType<SpawnFn> => {
      const child = spawn.fn(command, args, options);
      scriptChildClose(spawn.child, { stdout: "1 passed", exitCode: 0 });
      return child;
    },
  };
}

describe("verification egress enforcement (ADR-0043 D8)", () => {
  it("does not inherit network for a governed run that sets no explicit enforcement", async () => {
    const spawn = governedSpawn();
    const { state, workspace, fs } = runState({ spawn: spawn.fn });

    const outcome = await runWorkflowVerification(state, workspace, fs);

    // With no enforcing sandbox backend declared available, the orchestrator's own fail-closed
    // default denies the step BEFORE spawning. What must never happen is the third outcome:
    // running model-authored code with the parent process's inherited network.
    expect(outcome.summary?.results.map((result) => result.status)).toEqual(["denied"]);
    expect(spawn.calls()).toHaveLength(0);
  });

  it("enforces rather than denies when an enforcing backend is available", async () => {
    const spawn = governedSpawn();
    const { state, workspace, fs } = runState({
      spawn: spawn.fn,
      verificationEnforcedNetworkAvailable: true,
    });

    const outcome = await runWorkflowVerification(state, workspace, fs);

    expect(outcome.summary?.overallStatus).toBe("passed");
    expect(spawn.calls()).toHaveLength(1);
  });

  it("still honours an explicitly requested degrade mode", async () => {
    // The escape hatch stays available to callers that ask for it by name — a test harness with a
    // fake spawn keeps working, it just has to say so instead of being inferred.
    const spawn = governedSpawn();
    const { state, workspace, fs } = runState({
      spawn: spawn.fn,
      verificationNetworkEnforcement: "enforce-or-degrade",
    });

    const outcome = await runWorkflowVerification(state, workspace, fs);

    expect(outcome.summary?.overallStatus).toBe("passed");
    expect(spawn.calls()).toHaveLength(1);
  });
});
