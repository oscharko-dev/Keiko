// What a workflow stage's `test` script step does on Windows with no step supervisor and no
// container runtime, before and after script binding. Before: `runCommand` plans the step into an
// isolation backend and, with none (`planIsolatedRun` -> fail-closed -> `CommandDeniedError`, the
// `isolatedSpawnTarget` path of exec.ts), never spawns: the step is denied. So the step did not run
// on such a host before binding either. Now: the step is refused earlier, as `windows-step-copy-missing`.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  detectWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import {
  runVerification,
  type VerificationDeps,
  type VerificationPlan,
} from "@oscharko-dev/keiko-verification";
import { recordingSpawn, scriptChildClose } from "../unit-tests/_support.js";
import {
  resolvePlannedVerification,
  runPlannedVerification,
  type PlannedVerification,
} from "./planned-verification.js";

// A Windows host with no AppContainer supervisor and no Docker or Podman runtime.
vi.mock("@oscharko-dev/keiko-verification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-verification")>();
  return {
    ...actual,
    runVerification: (
      plan: VerificationPlan,
      deps: VerificationDeps,
    ): ReturnType<typeof actual.runVerification> =>
      actual.runVerification(plan, {
        ...deps,
        sandboxAvailability: {
          bubblewrap: false,
          unshare: false,
          seatbelt: false,
          docker: false,
          podman: false,
        },
        platform: "win32",
        resolveExecutable: (command): string => `C:\\trusted-tools\\${command}.exe`,
      }),
  };
});

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "keiko-workflow-win32-")));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function fixture(): {
  readonly fs: WorkspaceFs;
  readonly workspace: WorkspaceInfo;
  readonly planned: PlannedVerification;
  readonly spawn: ReturnType<typeof recordingSpawn>;
} {
  const fs = memFs(ROOT, {
    "package.json": JSON.stringify({ name: "d", scripts: { test: "echo ok" } }),
  });
  const workspace = detectWorkspace(ROOT, fs);
  const planned = resolvePlannedVerification(workspace, fs, []);
  if (planned === undefined) throw new TypeError("expected the fallback test plan");
  const spawn = recordingSpawn();
  scriptChildClose(spawn.child, { exitCode: 0 });
  return { fs, workspace, planned, spawn };
}

describe("a workflow stage's test script step on Windows with no supervisor and no container", () => {
  it("before binding (the old call shape: no digest): the host cannot isolate it, so it is denied without a spawn", async () => {
    const { fs, workspace, planned, spawn } = fixture();
    const report = await runVerification(planned.plan, {
      workspace,
      fs,
      spawn: spawn.fn,
      networkEnforcement: "enforce-or-degrade",
      enforcedNetworkAvailable: true,
    });
    expect(spawn.calls()).toHaveLength(0);
    expect(report.results[0]?.status).toBe("denied");
    // The isolation planner refused it (exec.ts: planIsolatedRun -> fail-closed -> CommandDeniedError),
    // not the script binding.
    expect(report.results[0]?.detail).toContain("no compatible sandbox backend is available");
    expect(report.results[0]?.detail ?? "").not.toContain("windows-step-copy-missing");
  });

  it("now (bound to the plan's digest): denied through the stage, without a spawn", async () => {
    const { fs, workspace, planned, spawn } = fixture();
    const summary = await runPlannedVerification(
      {
        signal: new AbortController().signal,
        now: () => 1,
        deps: {
          spawn: spawn.fn,
          verificationNetworkEnforcement: "enforce-or-degrade",
          verificationEnforcedNetworkAvailable: true,
        },
      },
      workspace,
      fs,
      planned,
    );
    expect(spawn.calls()).toHaveLength(0);
    expect(summary.results.map((result) => result.status)).toEqual(["denied"]);
  });

  it("now, the refusal names windows-step-copy-missing", async () => {
    const { fs, workspace, planned, spawn } = fixture();
    const report = await runVerification(planned.plan, {
      workspace,
      fs,
      spawn: spawn.fn,
      networkEnforcement: "enforce-or-degrade",
      enforcedNetworkAvailable: true,
      requireApprovedScripts: true,
      ...(planned.approvedScriptsDigest === undefined
        ? {}
        : { approvedScriptsDigest: planned.approvedScriptsDigest }),
    });
    expect(spawn.calls()).toHaveLength(0);
    expect(report.results[0]?.status).toBe("denied");
    expect(report.results[0]?.detail).toContain("windows-step-copy-missing");
  });
});
