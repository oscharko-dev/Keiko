import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sandbox from "@oscharko-dev/keiko-sandbox";
import type { VerificationPlan } from "@oscharko-dev/keiko-contracts";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

const notExercised = vi.hoisted(() => (): never => {
  throw new Error("no step runs in this test");
});

const resolution = vi.hoisted(() => ({ calls: [] as (string | undefined)[] }));

vi.mock("./windowsStepSupervisor.js", () => ({
  resolveWindowsStepSupervisor: (input: { correlationId?: string | undefined }): unknown => {
    resolution.calls.push(input.correlationId);
    return { acquire: (): never => notExercised() };
  },
}));

import {
  executeVerificationEnforced,
  timedNetworkIsolationProbe,
} from "./verificationExecution.js";

// #4491: a verification execution resolves its Windows step supervisor ONCE, for the isolation probe
// and for the run, and remembers nothing for the next execution.

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-step-resolution-")));
  resolution.calls = [];
  vi.spyOn(sandbox, "currentPlatform").mockReturnValue("win32");
  // Neither container runtime is installed, so the supervisor's step backend takes the run.
  vi.spyOn(sandbox, "probeBackends").mockReturnValue({
    bubblewrap: false,
    unshare: false,
    seatbelt: false,
    docker: false,
    podman: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function emptyPlan(): VerificationPlan {
  return { workspaceRoot: root, steps: [] };
}

function workspace(): WorkspaceInfo {
  return { root } as WorkspaceInfo;
}

describe("the Windows step supervisor of one verification execution (#4491)", () => {
  it("is resolved once when the run probes for itself", async () => {
    await executeVerificationEnforced({
      plan: emptyPlan(),
      workspace: workspace(),
      signal: new AbortController().signal,
      correlationId: "run-1",
    });
    expect(resolution.calls).toEqual(["run-1"]);
  });

  it("is resolved once for a probe taken first and the run that executes under it", async () => {
    const isolation = await timedNetworkIsolationProbe(root, undefined, "run-2");
    await executeVerificationEnforced({
      plan: emptyPlan(),
      workspace: workspace(),
      signal: new AbortController().signal,
      correlationId: "run-2",
      isolation,
    });
    expect(resolution.calls).toEqual(["run-2"]);
  });

  it("is resolved again by the next execution that reuses the same correlation id", async () => {
    for (let execution = 0; execution < 2; execution += 1) {
      await executeVerificationEnforced({
        plan: emptyPlan(),
        workspace: workspace(),
        signal: new AbortController().signal,
        correlationId: "coding-run-7",
      });
    }
    expect(resolution.calls).toEqual(["coding-run-7", "coding-run-7"]);
  });

  it("is resolved once by the run for a probe handed in without one", async () => {
    await executeVerificationEnforced({
      plan: emptyPlan(),
      workspace: workspace(),
      signal: new AbortController().signal,
      correlationId: "run-3",
      isolation: { probe: { available: true, backend: "windows-appcontainer" }, durationMs: 1 },
    });
    expect(resolution.calls).toEqual(["run-3"]);
  });
});
