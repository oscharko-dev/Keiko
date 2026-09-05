// #2951: devLaneRuntimeProcessBackend.ts now spawns through keiko-sandbox's shared
// planIsolatedRun/selectGatewayBackend core instead of calling buildRuntimeGatewaySeatbeltCommand
// directly, so a host with no confining backend fails the launch closed rather than spawning the
// hardcoded seatbelt path unconditionally. This file is new (not an edit to the existing suite) per
// the write-scope split for this change.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeGatewayConfinement,
  type BackendAvailability,
} from "@oscharko-dev/keiko-sandbox";
import { createBufferedServerLogSink } from "../observability/index.js";

import {
  createDevLaneRuntimeProcessBackend,
  type DevLaneRuntimeChildProcess,
} from "./devLaneRuntimeProcessBackend.js";
import {
  CLOSED_RUNTIME_LAUNCH_PROFILE,
  type RuntimeSupervisorLaunchRequest,
} from "./runtimeProcessSupervisor.js";

const IDENTITY = { platform: "darwin", arch: "arm64", backend: "macos-app-sandbox" } as const;
const ALL: BackendAvailability = {
  bubblewrap: true,
  unshare: true,
  seatbelt: true,
  docker: true,
  podman: true,
};
const NONE: BackendAvailability = {
  bubblewrap: false,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  readonly runtimeRoot: string;
  readonly executable: string;
  readonly cwd: string;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-dev-lane-gateway-abstraction-"));
  roots.push(root);
  const runtimeRoot = join(root, "payload");
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true, mode: 0o700 });
  const executable = join(runtimeRoot, "bin", "opencode");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return { runtimeRoot, executable, cwd };
}

function gatewayConfinement(): ReturnType<typeof createRuntimeGatewayConfinement> {
  return createRuntimeGatewayConfinement({
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    runId: "run-2951",
    treeBindingId: "f".repeat(64),
    envelopeDigest: "a".repeat(64),
    runtimeArtifactDigest: "b".repeat(64),
    modelProfileDigest: "c".repeat(64),
  });
}

function launchRequest(paths: ReturnType<typeof fixture>): RuntimeSupervisorLaunchRequest {
  return {
    runId: "run-2951",
    recoveryHandle: "0".repeat(32),
    treeBindingId: "f".repeat(64),
    executable: paths.executable,
    args: ["serve"],
    cwd: paths.cwd,
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: "true" },
    qualification: { ...IDENTITY, releaseReceipt: `sha256:${"0".repeat(64)}` },
    launchProfile: CLOSED_RUNTIME_LAUNCH_PROFILE,
  };
}

function fakeChild(): DevLaneRuntimeChildProcess {
  return {
    pid: 4711,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    settled: (): boolean => false,
    kill: (): boolean => true,
    onExit: (): void => {
      // Never settles in these tests: the fail-closed cases assert on the throw, not on exit.
    },
    onError: (): void => {
      // Never invoked in these tests; present only to satisfy the DevLaneRuntimeChildProcess shape.
    },
  };
}

describe("dev-lane backend consumes the shared gateway plan/backend abstraction", () => {
  it("selects the seatbelt-wrapped gateway plan and spawns it when the host can enforce it", () => {
    const paths = fixture();
    let spawned: { readonly command: string; readonly args: readonly string[] } | undefined;
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => ALL,
      platform: "darwin",
      spawnRuntime: (command, args) => {
        spawned = { command, args };
        return fakeChild();
      },
    });

    backend.spawnOwnedTree(launchRequest(paths));

    expect(spawned?.command).toBe("/usr/bin/sandbox-exec");
    expect(spawned?.args[1]).toContain('(remote tcp4 "localhost:1983")');
  });

  // Failing-before: before this change, spawnConfinedTree always built the wrapper directly and
  // spawned it, with no notion of "this host cannot enforce it" at all — a missing backend would
  // only surface as an OS-level ENOENT from the child process, not a reasoned, pre-spawn refusal.
  it("fails closed and never spawns when no backend on the host can enforce the gateway policy", () => {
    const paths = fixture();
    const activityLog = createBufferedServerLogSink();
    let spawns = 0;
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => NONE,
      platform: "darwin",
      activityLog,
      spawnRuntime: () => {
        spawns += 1;
        return fakeChild();
      },
    });

    expect(() => backend.spawnOwnedTree(launchRequest(paths))).toThrow(
      "runtime-gateway-confinement-unavailable",
    );
    expect(spawns).toBe(0);
    expect(activityLog.events).toContainEqual(
      expect.objectContaining({ op: "runtime.confinement.failed" }),
    );
  });

  it("fails closed on a platform with no gateway backend at all (e.g. linux), never a weaker run", () => {
    const paths = fixture();
    let spawns = 0;
    const backend = createDevLaneRuntimeProcessBackend({
      identity: IDENTITY,
      runtimeRoot: paths.runtimeRoot,
      gatewayConfinement: gatewayConfinement(),
      probeAvailability: () => ALL,
      platform: "linux",
      spawnRuntime: () => {
        spawns += 1;
        return fakeChild();
      },
    });

    expect(() => backend.spawnOwnedTree(launchRequest(paths))).toThrow(
      "runtime-gateway-confinement-unavailable",
    );
    expect(spawns).toBe(0);
  });
});
