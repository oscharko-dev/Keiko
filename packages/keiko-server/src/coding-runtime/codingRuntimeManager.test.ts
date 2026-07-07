import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";

import {
  createCodingRuntimeManager,
  resolveCodingRuntimeSidecarLaunchTarget,
  type CodingRuntimeLaunchRequest,
  type CodingRuntimeSpawnFn,
  type CodingRuntimeSpawnHandle,
} from "./codingRuntimeManager.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function executable(root: string, name = "opencode-sidecar"): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

interface FakeChild {
  readonly handle: CodingRuntimeSpawnHandle;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kills: NodeJS.Signals[];
  exit(code?: number | null): void;
  error(error: Error): void;
}

function fakeChild(): FakeChild {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kills: NodeJS.Signals[] = [];
  let onExit: ((code: number | null) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  return {
    stdout,
    stderr,
    kills,
    handle: {
      stdout,
      stderr,
      pid: 4242,
      kill: (signal): void => {
        kills.push(signal);
      },
      onExit: (callback): void => {
        onExit = callback;
      },
      onError: (callback): void => {
        onError = callback;
      },
    },
    exit: (code = 0): void => {
      onExit?.(code);
      stdout.end();
      stderr.end();
    },
    error: (error): void => {
      onError?.(error);
    },
  };
}

function launchRequest(
  workspaceRoot: string,
  managedRoot: string,
  executablePath: string,
): CodingRuntimeLaunchRequest {
  return {
    runId: "run-1988",
    taskRef: "issue-1988",
    adapterKind: "opencode-compatible",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
    workspaceRoot,
    executablePath,
    managedRoot,
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    modelProfileId: "coding-safe-openai-compatible",
    args: ["--stdio"],
    inheritedEnvAllowlist: ["PATH"],
    shutdownTimeoutMs: 5,
    startTimeoutMs: 30_000,
  };
}

function createManagedFixture(): {
  readonly workspaceRoot: string;
  readonly managedRoot: string;
  readonly executablePath: string;
} {
  const workspaceRoot = tempDir("keiko-runtime-workspace-");
  const managedRoot = tempDir("keiko-runtime-managed-");
  return { workspaceRoot, managedRoot, executablePath: executable(managedRoot) };
}

function createSpawnHarness(): {
  readonly spawn: CodingRuntimeSpawnFn;
  readonly children: FakeChild[];
  readonly captures: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: Record<string, string>;
    readonly cwd: string;
  }[];
} {
  const children: FakeChild[] = [];
  const captures: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: Record<string, string>;
    readonly cwd: string;
  }[] = [];
  const spawn: CodingRuntimeSpawnFn = (executablePath, args, env, cwd) => {
    const child = fakeChild();
    children.push(child);
    captures.push({ executable: executablePath, args, env, cwd });
    return child.handle;
  };
  return { spawn, children, captures };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("coding runtime manager", () => {
  it("resolves launch paths from a verified portable sidecar payload", () => {
    const managedInstallRoot = tempDir("keiko-runtime-install-");
    const sidecarRoot = join(managedInstallRoot, "runtime", "sidecars", "opencode-adapter");
    const executablePath = executable(sidecarRoot);
    const sidecar: PortableSidecarRuntimeVerification = {
      payloadRootPath: "runtime/sidecars/opencode-adapter",
      executablePath: "runtime/sidecars/opencode-adapter/opencode-sidecar",
      licenseEvidencePath: "runtime/sidecars/opencode-adapter/LICENSE.evidence.json",
      licenseEvidenceSha256: "a".repeat(64),
      sbomEvidencePath: "runtime/sidecars/opencode-adapter/sbom.evidence.json",
      sbomEvidenceSha256: "b".repeat(64),
      summary: {
        name: "opencode-adapter",
        kind: "opencode-compatible",
        upstreamName: "opencode",
        upstreamVersion: "1.0.0",
        adapterName: "keiko-opencode-adapter",
        adapterVersion: "1.0.0",
        protocolVersion: "1",
        platformTarget: "macos-arm64",
        payloadSha256: "c".repeat(64),
        payloadSha256Prefix: "c".repeat(12),
        sizeBytes: 12,
        status: "verified",
      },
    };

    const result = resolveCodingRuntimeSidecarLaunchTarget(managedInstallRoot, sidecar);

    expect(result).toEqual({
      ok: true,
      target: {
        managedRoot: sidecarRoot,
        executablePath,
        runtimeName: "opencode-adapter",
        payloadSha256Prefix: "c".repeat(12),
      },
    });
  });

  it("refuses an executable that is not inside the managed sidecar root", () => {
    const fixture = createManagedFixture();
    const unmanaged = executable(tempDir("keiko-runtime-unmanaged-"));
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: { PATH: "/usr/bin", CODEX_ACCESS_TOKEN: "super-secret-token" },
    });

    const result = manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, unmanaged),
    );

    expect(result).toEqual({
      ok: false,
      failureCode: "sidecar-unmanaged",
      retryable: false,
    });
    expect(harness.children).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(fixture.managedRoot);
    expect(JSON.stringify(result)).not.toContain(unmanaged);
  });

  it("fails closed when OpenCode is paired with a Codex subscription profile", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({ spawn: harness.spawn, processEnv: {} });
    const request: CodingRuntimeLaunchRequest = {
      ...launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      modelSource: "chatgpt-codex-subscription-profile",
    };

    const result = manager.start(request);

    expect(result).toEqual({
      ok: false,
      failureCode: "adapter-profile-mismatch",
      retryable: false,
    });
    expect(harness.children).toHaveLength(0);
  });

  it("starts a managed sidecar with only allowlisted inherited env and runtime projection", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "provider-secret-key",
        CODEX_ACCESS_TOKEN: "subscription-secret-token",
      },
    });

    const result = manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );

    expect(result).toMatchObject({ ok: true, runId: "run-1988", status: "ready" });
    expect(manager.health()).toMatchObject({ status: "ready", activeRunId: "run-1988" });
    expect(harness.captures).toHaveLength(1);
    expect(harness.captures[0]?.env).toMatchObject({
      PATH: "/usr/bin",
      KEIKO_CODING_RUN_ID: "run-1988",
      KEIKO_CODING_TASK_REF: "issue-1988",
      KEIKO_CODING_ADAPTER_KIND: "opencode-compatible",
      KEIKO_CODING_RUNTIME_SOURCE: "keiko-sidecar",
      KEIKO_CODING_MODEL_SOURCE: "keiko-model-gateway",
      KEIKO_CODING_MODE: "supervised-coding",
      KEIKO_CODING_WORKSPACE_ROOT: fixture.workspaceRoot,
      KEIKO_MODEL_GATEWAY_URL: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
      KEIKO_MODEL_PROFILE_ID: "coding-safe-openai-compatible",
    });
    expect(Object.values(harness.captures[0]?.env ?? {})).not.toContain("provider-secret-key");
    expect(Object.values(harness.captures[0]?.env ?? {})).not.toContain(
      "subscription-secret-token",
    );
  });

  it("rejects non-loopback gateway URLs before spawn", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({ spawn: harness.spawn, processEnv: {} });
    const request = {
      ...launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      gatewayUrl: "https://provider.example/v1",
    };

    const result = manager.start(request);

    expect(result).toEqual({
      ok: false,
      failureCode: "gateway-non-loopback",
      retryable: false,
    });
    expect(harness.children).toHaveLength(0);
  });

  it("stops the active sidecar and allows a clean restart", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({ spawn: harness.spawn, processEnv: {} });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    const stop = manager.stop("run-1988");
    harness.children[0]?.exit(0);
    await stop;
    const restart = manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );

    expect(harness.children[0]?.kills).toEqual(["SIGTERM"]);
    expect(manager.health()).toMatchObject({ status: "ready", activeRunId: "run-1988" });
    expect(restart).toMatchObject({ ok: true, status: "ready" });
    expect(harness.children).toHaveLength(2);
  });

  it("marks crashes as restart-denied without respawning implicitly", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createCodingRuntimeManager({ spawn: harness.spawn, processEnv: {} });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.exit(1);

    expect(manager.health()).toEqual({
      status: "restart-denied",
      activeRunId: "run-1988",
      failureCode: "runtime-crashed",
      restartDenied: true,
    });
    expect(harness.children).toHaveLength(1);
  });

  it("normalizes permission requests from the sidecar stream into content-free runtime events", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      `${JSON.stringify({
        type: "permission-request",
        requestId: "perm-1988",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "command-execution",
        commandLabel: "npm",
        expiresAt: "2026-07-07T13:05:00.000Z",
      })}\n`,
    );
    await settle();

    const permissionEvent = events.find((event) => event.kind === "permission-requested");
    expect(permissionEvent).toMatchObject({
      schemaVersion: "1",
      runId: "run-1988",
      kind: "permission-requested",
      permissionRequest: {
        requestId: "perm-1988",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "command-execution",
        commandLabel: "npm",
      },
    });
    expect(validateCodingWorkbenchRuntimeEvent(permissionEvent).ok).toBe(true);
    expect(JSON.stringify(permissionEvent)).not.toContain(fixture.workspaceRoot);
  });

  it("escalates stop to SIGKILL when the sidecar misses the shutdown deadline", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const setTimer = vi.fn((callback: () => void): unknown => {
      callback();
      return undefined;
    });
    const manager = createCodingRuntimeManager({
      spawn: harness.spawn,
      processEnv: {},
      killScheduler: { setTimer },
    });

    manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    await manager.stop("run-1988");

    expect(harness.children[0]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(manager.health()).toEqual({ status: "stopped" });
  });
});
