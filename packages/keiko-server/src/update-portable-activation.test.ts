import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdatePortableStagingSummary } from "@oscharko-dev/keiko-contracts";
import { createUpdateLocalStateManager } from "./update-local-state.js";
import { digestUpdateCandidate } from "./update-candidate-authority.js";
import { createPortableUpdateActivator } from "./update-portable-activation.js";
import {
  activationIdFor,
  refreshPortableRegistration,
} from "./update-portable-activation-files.js";
import {
  createPortableHandoffCoordinator,
  PortableHandoffCoordinatorError,
} from "./update-portable-handoff.js";

const TARGET_VERSION = "0.2.12";
const OLD_VERSION = "0.2.11";
const TARGET = "windows-x64" as const;
const tempRoots: string[] = [];

function setupManifest(version: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    platformTarget: TARGET,
    packageName: "@oscharko-dev/keiko",
    packageVersion: version,
    stable: true,
    primaryLauncher: "Keiko.exe",
    bootstrapUpdateEligible: false,
    runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
  });
}

function writeInstall(root: string, version: string): void {
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(join(root, ".portable"), { recursive: true });
  mkdirSync(join(root, "runtime", "native"), { recursive: true });
  copyFileSync(process.execPath, join(root, "Keiko.exe"));
  writeFileSync(join(root, "runtime", "native", "keiko-runtime-supervisor.exe"), "supervisor");
  writeFileSync(
    join(root, "app", "package.json"),
    JSON.stringify({ name: "@oscharko-dev/keiko", version }),
  );
  writeFileSync(join(root, ".portable", "setup-manifest.json"), setupManifest(version));
}

function stageSummary(): UpdatePortableStagingSummary {
  return {
    stageId: "stage-1",
    status: "staged",
    target: TARGET,
    packageVersion: TARGET_VERSION,
    assetName: "keiko-windows-x64.zip",
    assetId: 1,
    releaseId: 2,
    sizeBytes: 3,
    sha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
}

async function makeInstall(): Promise<{
  readonly home: string;
  readonly stateDir: string;
  readonly managedRoot: string;
  readonly packageRoot: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "keiko-portable-activation-"));
  tempRoots.push(home);
  const managedRoot = join(home, "AppData", "Local", "Programs", "Keiko");
  const packageRoot = join(managedRoot, "app");
  const candidateRoot = join(dirname(managedRoot), ".keiko-portable-updates", "stage-1", "Keiko");
  const stateDir = join(home, ".keiko");
  const localState = createUpdateLocalStateManager({ stateDir });
  localState.writeRuntimeState(localState.readRuntimeState());
  writeInstall(managedRoot, OLD_VERSION);
  writeInstall(candidateRoot, TARGET_VERSION);
  writeFileSync(join(managedRoot, "active.txt"), "active");
  return { home, stateDir, managedRoot, packageRoot };
}

function registerCurrentInstall(install: Awaited<ReturnType<typeof makeInstall>>): void {
  refreshPortableRegistration({
    stateDir: install.stateDir,
    layout: {
      installRoot: install.managedRoot,
      appRoot: install.packageRoot,
      packageJsonPath: join(install.packageRoot, "package.json"),
      setupManifestPath: join(install.managedRoot, ".portable", "setup-manifest.json"),
      launcherPath: join(install.managedRoot, "Keiko.exe"),
    },
    target: TARGET,
    env: { LOCALAPPDATA: join(install.home, "AppData", "Local") },
    home: install.home,
    now: 1_699_999_000_000,
  });
}

function seedCancellableSession(
  localState: ReturnType<typeof createUpdateLocalStateManager>,
): void {
  const candidate = {
    schemaVersion: "1" as const,
    candidateId: "candidate-0.2.12",
    currentVersion: OLD_VERSION,
    targetVersion: TARGET_VERSION,
    channel: "stable" as const,
    install: {
      packageName: "@oscharko-dev/keiko",
      installKind: "package-manager" as const,
      packageManager: "npm" as const,
      installIdentitySha256: "e".repeat(64),
    },
    release: { source: "github-release" as const, tag: `v${TARGET_VERSION}` },
    releaseImpactDigest: "f".repeat(64),
    issuedAt: "2026-09-05T00:00:00.000Z",
    expiresAt: "2026-09-05T01:00:00.000Z",
  };
  const current = localState.readRuntimeState();
  localState.writeRuntimeState({
    ...current,
    activeCandidate: candidate,
    activeSession: {
      schemaVersion: "1",
      sessionId: "handoff-cancelled",
      candidateId: candidate.candidateId,
      candidateDigest: digestUpdateCandidate(candidate),
      correlationId: "corr-handoff-cancelled",
      packageName: "@oscharko-dev/keiko",
      targetVersion: TARGET_VERSION,
      phase: "running",
      lifecycle: {
        phase: "staging",
        progress: { completedBytes: 1, totalBytes: 2 },
        cancellationCutoff: "not-reached",
      },
      failureReason: "none",
      packageManager: "npm",
      startedAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
      cancelable: true,
      retryable: false,
      restartRequired: false,
      message: "Preparing handoff.",
    },
  });
}

function configuredActivator(
  install: Awaited<ReturnType<typeof makeInstall>>,
  begin: Parameters<typeof createPortableUpdateActivator>[0]["handoffCoordinator"],
): ReturnType<typeof createPortableUpdateActivator> {
  return createPortableUpdateActivator({
    env: {
      KEIKO_STATE_DIR: install.stateDir,
      LOCALAPPDATA: join(install.home, "AppData", "Local"),
    },
    localState: createUpdateLocalStateManager({ stateDir: install.stateDir }),
    homedir: () => install.home,
    currentVersion: OLD_VERSION,
    currentProcess: () => ({
      pid: process.pid,
      launchId: "1".repeat(32),
      host: "127.0.0.1",
      port: 1983,
      version: OLD_VERSION,
    }),
    newLaunchId: () => "2".repeat(32),
    now: () => 1_700_000_000_000,
    ...(begin === undefined ? {} : { handoffCoordinator: begin }),
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable update activation handoff", () => {
  it("hands an immutable plan to the coordinator without promoting or reporting success", async () => {
    const install = await makeInstall();
    registerCurrentInstall(install);
    const begin = vi.fn(() =>
      Promise.resolve({ coordinatorId: "9".repeat(64), acceptedAt: "2026-09-05T00:00:00.000Z" }),
    );
    const result = await configuredActivator(install, { begin }).activate({
      sessionId: "handoff-session",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
    });

    expect(result).toMatchObject({ status: "handoff-pending", coordinatorId: "9".repeat(64) });
    expect(begin).toHaveBeenCalledOnce();
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(existsSync(join(install.managedRoot, "active.txt"))).toBe(true);
  });

  it("discards an uncommitted capsule when coordinator acceptance fails", async () => {
    const install = await makeInstall();
    registerCurrentInstall(install);
    const input = {
      sessionId: "handoff-refused",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
    };
    const activator = configuredActivator(install, {
      begin: () => Promise.reject(new Error("coordinator refused")),
    });

    await expect(activator.activate(input)).rejects.toThrow("coordinator refused");
    expect(existsSync(join(install.stateDir, "updates", "handoff", activationIdFor(input)))).toBe(
      false,
    );
  });

  it("fails closed when the native handoff capability is not composed", async () => {
    const install = await makeInstall();
    registerCurrentInstall(install);
    await expect(
      configuredActivator(install, undefined).activate({
        sessionId: "handoff-unavailable",
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toThrow("portable handoff capability is unavailable");
  });

  it("forwards cancellation authority through the coordinator ACK boundary", async () => {
    const install = await makeInstall();
    registerCurrentInstall(install);
    const controller = new AbortController();
    const begin = vi.fn(() => Promise.reject(new Error("cancelled before ACK")));
    await expect(
      configuredActivator(install, { begin }).activate({
        sessionId: "handoff-cancelled",
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled before ACK");
    expect(begin.mock.calls[0]?.[0].signal).toBe(controller.signal);
  });

  it("atomically clears prepared authority when the real coordinator is cancelled before ACK", async () => {
    const install = await makeInstall();
    registerCurrentInstall(install);
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    seedCancellableSession(localState);
    const controller = new AbortController();
    const control = new PassThrough();
    const response = new PassThrough();
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), {
      pid: 43_210,
      stdin: control,
      stdio: [control, null, null, response],
      unref: vi.fn(),
      kill,
    }) as unknown as ChildProcess;
    kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    });
    const coordinator = createPortableHandoffCoordinator({
      stateDir: install.stateDir,
      publishCoordinatorPid: () => true,
      persistPrepared: ({ activationWal }) => {
        const current = localState.readRuntimeState();
        localState.writeRuntimeState({
          ...current,
          activationWal,
          recovery: {
            status: "reconciling",
            sessionId: "handoff-cancelled",
            updatedAt: "2026-09-05T00:00:00.000Z",
          },
        });
        return Promise.resolve();
      },
      persistAccepted: () => Promise.reject(new Error("acceptance must not persist")),
      verifyNativeCopy: () => Promise.resolve(),
      spawnFn: () => {
        queueMicrotask(() => {
          controller.abort();
        });
        return child;
      },
    });
    const activator = createPortableUpdateActivator({
      env: {
        KEIKO_STATE_DIR: install.stateDir,
        LOCALAPPDATA: join(install.home, "AppData", "Local"),
      },
      localState,
      homedir: () => install.home,
      currentVersion: OLD_VERSION,
      currentProcess: () => ({
        pid: process.pid,
        launchId: "1".repeat(32),
        host: "127.0.0.1",
        port: 1983,
        version: OLD_VERSION,
      }),
      newLaunchId: () => "2".repeat(32),
      now: () => 1_700_000_000_000,
      handoffCoordinator: coordinator,
    });
    const input = {
      sessionId: "handoff-cancelled",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      signal: controller.signal,
    };

    await expect(activator.activate(input)).rejects.toThrow(/closed before acceptance/u);
    expect(localState.readRuntimeState().activationWal).toBeUndefined();
    expect(existsSync(join(install.stateDir, "updates", "handoff", activationIdFor(input)))).toBe(
      false,
    );
    expect(kill).toHaveBeenCalled();
  });

  it("retains the prepared capsule when native child teardown is unproven", async () => {
    const install = await makeInstall();
    registerCurrentInstall(install);
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    seedCancellableSession(localState);
    const input = {
      sessionId: "handoff-cancelled",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
    };
    const activationId = activationIdFor(input);
    const activator = createPortableUpdateActivator({
      env: {
        KEIKO_STATE_DIR: install.stateDir,
        LOCALAPPDATA: join(install.home, "AppData", "Local"),
      },
      localState,
      homedir: () => install.home,
      currentVersion: OLD_VERSION,
      currentProcess: () => ({
        pid: process.pid,
        launchId: "1".repeat(32),
        host: "127.0.0.1",
        port: 1983,
        version: OLD_VERSION,
      }),
      newLaunchId: () => "2".repeat(32),
      handoffCoordinator: {
        begin: () => {
          const current = localState.readRuntimeState();
          localState.writeRuntimeState({
            ...current,
            activationWal: {
              activationId,
              planSha256: "a".repeat(64),
              coordinatorSha256: "b".repeat(64),
              intentRevision: current.revision + 1,
              checkpoint: "prepared",
              receiptSequence: 0,
            },
          });
          return Promise.reject(
            new PortableHandoffCoordinatorError("portable handoff coordinator did not stop", true),
          );
        },
      },
    });

    await expect(activator.activate(input)).rejects.toMatchObject({
      nativeAuthorityMayBeLive: true,
    });
    expect(localState.readRuntimeState().activationWal?.activationId).toBe(activationId);
    expect(existsSync(join(install.stateDir, "updates", "handoff", activationId))).toBe(true);
  });
});
