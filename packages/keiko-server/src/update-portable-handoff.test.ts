import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPortableHandoffCoordinator,
  PortableHandoffCoordinatorError,
  type PortableHandoffAcceptedIntent,
  type PortableHandoffPreparedIntent,
} from "./update-portable-handoff.js";
import {
  createPortableHandoffPlan,
  writePortableHandoffPlan,
  type PortableHandoffPlan,
} from "./update-portable-handoff-plan.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

interface HandoffFixture {
  readonly coordinator: string;
  readonly plan: PortableHandoffPlan;
  readonly stateDir: string;
  readonly supervisor: string;
}

function prepare(root: string): HandoffFixture {
  const stateDir = join(root, "state");
  const parent = join(root, "install-parent");
  const managedRoot = join(parent, "Keiko.app");
  const stageRoot = join(parent, ".keiko-portable-updates", "stage-1");
  mkdirSync(managedRoot, { recursive: true });
  mkdirSync(stageRoot, { recursive: true });
  const coordinator = join(managedRoot, "Contents", "MacOS", "Keiko");
  const supervisor = join(
    managedRoot,
    "Contents",
    "Resources",
    "runtime",
    "native",
    "keiko-runtime-supervisor",
  );
  mkdirSync(join(managedRoot, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(managedRoot, "Contents", "Resources", "runtime", "native"), {
    recursive: true,
  });
  writeFileSync(coordinator, "coordinator");
  writeFileSync(supervisor, "supervisor");
  const plan = createPortableHandoffPlan({
    activationId: "a".repeat(32),
    sessionId: "session-1",
    stageId: "stage-1",
    target: "macos-arm64",
    targetVersion: "1.2.3",
    newLaunchId: "2".repeat(32),
    restoreLaunchId: "3".repeat(32),
    aggregateRevision: 7,
    previousRegistrationState: "present",
    oldProcess: {
      pid: 123,
      launchId: "b".repeat(32),
      host: "127.0.0.1",
      port: 1983,
      version: "1.2.2",
    },
    paths: {
      managedRoot,
      stageRoot,
      candidateRoot: join(stageRoot, "Keiko", "Keiko.app"),
      backupRoot: join(parent, `.keiko-previous-${"a".repeat(32)}`),
      candidateLauncher: join(stageRoot, "Keiko", "Keiko.app", "Contents", "MacOS", "Keiko"),
      candidateSupervisor: join(
        stageRoot,
        "Keiko",
        "Keiko.app",
        "Contents",
        "Resources",
        "runtime",
        "native",
        "keiko-runtime-supervisor",
      ),
    },
    digests: {
      currentTreeSha256: "c".repeat(64),
      candidateTreeSha256: "d".repeat(64),
      currentLauncherSha256: createHash("sha256").update("coordinator").digest("hex"),
      currentSupervisorSha256: createHash("sha256").update("supervisor").digest("hex"),
      candidateLauncherSha256: "e".repeat(64),
      candidateSupervisorSha256: "f".repeat(64),
      previousRegistrationSha256: "0".repeat(64),
      preparedRegistrationSha256: "1".repeat(64),
    },
    deadlines: {
      oldExitAt: 1_800_000_000_000,
      startAt: 1_800_000_030_000,
      verifyAt: 1_800_000_060_000,
      cleanupAt: 1_800_000_090_000,
    },
  });
  writePortableHandoffPlan({ stateDir, plan });
  return { coordinator, plan, stateDir, supervisor };
}

function prepareWindows(root: string): HandoffFixture {
  const stateDir = join(root, "state");
  const parent = join(root, "install-parent");
  const managedRoot = join(parent, "Keiko");
  const stageRoot = join(parent, ".keiko-portable-updates", "stage-1");
  const candidateRoot = join(stageRoot, "Keiko");
  const activationId = "a".repeat(32);
  const currentGenerationTreeSha256 = "6".repeat(64);
  const candidateGenerationTreeSha256 = "7".repeat(64);
  const coordinator = join(managedRoot, "Keiko.exe");
  const supervisor = join(
    managedRoot,
    ".portable",
    "generations",
    currentGenerationTreeSha256,
    "runtime",
    "native",
    "keiko-runtime-supervisor.exe",
  );
  const candidateLauncher = join(candidateRoot, "Keiko.exe");
  const candidateSupervisor = join(
    candidateRoot,
    ".portable",
    "generations",
    candidateGenerationTreeSha256,
    "runtime",
    "native",
    "keiko-runtime-supervisor.exe",
  );
  const currentSetup = join(managedRoot, ".portable", "setup-manifest.json");
  const candidateSetup = join(candidateRoot, ".portable", "setup-manifest.json");
  for (const path of [coordinator, supervisor, candidateLauncher, candidateSupervisor]) {
    mkdirSync(join(path, ".."), { recursive: true });
  }
  writeFileSync(coordinator, "coordinator");
  writeFileSync(supervisor, "supervisor");
  writeFileSync(candidateLauncher, "candidate-launcher");
  writeFileSync(candidateSupervisor, "candidate-supervisor");
  writeFileSync(currentSetup, "current-setup");
  writeFileSync(candidateSetup, "candidate-setup");
  const registrationPrevious = "registration-previous";
  const registrationNext = "registration-next";
  const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
  const plan = createPortableHandoffPlan({
    activationId,
    sessionId: "session-1",
    stageId: "stage-1",
    target: "windows-x64",
    targetVersion: "1.2.3",
    newLaunchId: "2".repeat(32),
    restoreLaunchId: "3".repeat(32),
    aggregateRevision: 7,
    previousRegistrationState: "present",
    oldProcess: {
      pid: 123,
      launchId: "b".repeat(32),
      host: "127.0.0.1",
      port: 1983,
      version: "1.2.2",
    },
    paths: {
      managedRoot,
      stageRoot,
      candidateRoot,
      backupRoot: join(parent, `.keiko-previous-${activationId}`),
      candidateLauncher,
      candidateSupervisor,
    },
    digests: {
      currentTreeSha256: "c".repeat(64),
      candidateTreeSha256: "d".repeat(64),
      currentLauncherSha256: digest("coordinator"),
      currentSupervisorSha256: digest("supervisor"),
      candidateLauncherSha256: digest("candidate-launcher"),
      candidateSupervisorSha256: digest("candidate-supervisor"),
      previousRegistrationSha256: digest(registrationPrevious),
      preparedRegistrationSha256: digest(registrationNext),
    },
    deadlines: {
      oldExitAt: 1_800_000_000_000,
      startAt: 1_800_000_030_000,
      verifyAt: 1_800_000_060_000,
      cleanupAt: 1_800_000_090_000,
    },
    cutoverKind: "windows-generation-v1",
    currentGenerationTreeSha256,
    candidateGenerationTreeSha256,
    currentSetupManifestSha256: digest("current-setup"),
    candidateSetupManifestSha256: digest("candidate-setup"),
  });
  writePortableHandoffPlan({ stateDir, plan });
  const capsule = join(stateDir, "updates", "handoff", activationId);
  writeFileSync(join(capsule, "registration.previous"), registrationPrevious);
  writeFileSync(join(capsule, "registration.next"), registrationNext);
  return { coordinator, plan, stateDir, supervisor };
}

describe("portable handoff coordinator", () => {
  it("durably validates every Windows capsule prerequisite before prepared intent", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-windows-"));
    roots.push(root);
    const fixture = prepareWindows(root);
    const control = new PassThrough();
    const response = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 43_210,
      stdin: control,
      stdio: [control, null, null, response],
      unref: vi.fn(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    let planSha256 = "";
    const persistPrepared = vi.fn(({ activationWal }: PortableHandoffPreparedIntent) => {
      planSha256 = activationWal.planSha256;
      const capsule = join(fixture.stateDir, "updates", "handoff", fixture.plan.activationId);
      expect(readFileSync(join(capsule, "coordinator.exe"), "utf8")).toBe("coordinator");
      expect(readFileSync(join(capsule, "runtime-supervisor.exe"), "utf8")).toBe("supervisor");
      expect(readFileSync(join(capsule, "launcher.next"), "utf8")).toBe("candidate-launcher");
      expect(readFileSync(join(capsule, "setup-manifest.previous"), "utf8")).toBe("current-setup");
      expect(readFileSync(join(capsule, "setup-manifest.next"), "utf8")).toBe("candidate-setup");
      expect(readFileSync(join(capsule, "registration.previous"), "utf8")).toBe(
        "registration-previous",
      );
      expect(readFileSync(join(capsule, "registration.next"), "utf8")).toBe("registration-next");
      return Promise.resolve();
    });
    const spawnFn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
      queueMicrotask(() => response.end(`KHA1${planSha256}\n`));
      return child;
    });
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      persistPrepared,
      persistAccepted: () => Promise.resolve(),
      verifyNativeCopy: () => Promise.resolve(),
      publishCoordinatorPid: () => true,
      spawnFn,
    });

    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: fixture.plan.activationId }),
    ).resolves.toBeDefined();
    expect(persistPrepared).toHaveBeenCalledOnce();
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(spawnFn.mock.calls[0]?.[0]).toMatch(/coordinator\.exe$/u);
  });

  it("rejects a stale Windows registration capsule before prepared intent", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-windows-stale-"));
    roots.push(root);
    const fixture = prepareWindows(root);
    writeFileSync(
      join(fixture.stateDir, "updates", "handoff", fixture.plan.activationId, "registration.next"),
      "replaced-registration",
    );
    const persistPrepared = vi.fn(() => Promise.resolve());
    const spawnFn = vi.fn();
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      persistPrepared,
      persistAccepted: () => Promise.resolve(),
      verifyNativeCopy: () => Promise.resolve(),
      publishCoordinatorPid: () => true,
      spawnFn,
    });

    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: fixture.plan.activationId }),
    ).rejects.toThrow(/registration snapshot changed/u);
    expect(persistPrepared).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("rejects stale Windows setup bytes before prepared intent", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-windows-stale-setup-"));
    roots.push(root);
    const fixture = prepareWindows(root);
    writeFileSync(
      join(fixture.plan.paths.candidateRoot, ".portable", "setup-manifest.json"),
      "replaced-setup",
    );
    const persistPrepared = vi.fn(() => Promise.resolve());
    const spawnFn = vi.fn();
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      persistPrepared,
      persistAccepted: () => Promise.resolve(),
      verifyNativeCopy: () => Promise.resolve(),
      publishCoordinatorPid: () => true,
      spawnFn,
    });

    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: fixture.plan.activationId }),
    ).rejects.toThrow(/capsule identity changed/u);
    expect(persistPrepared).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("rejects a hard-linked Windows capsule source before prepared intent", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-windows-hardlink-"));
    roots.push(root);
    const fixture = prepareWindows(root);
    const source = join(root, "linked-launcher.exe");
    writeFileSync(source, "candidate-launcher");
    rmSync(fixture.plan.paths.candidateLauncher);
    linkSync(source, fixture.plan.paths.candidateLauncher);
    const persistPrepared = vi.fn(() => Promise.resolve());
    const spawnFn = vi.fn();
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      persistPrepared,
      persistAccepted: () => Promise.resolve(),
      verifyNativeCopy: () => Promise.resolve(),
      publishCoordinatorPid: () => true,
      spawnFn,
    });

    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: fixture.plan.activationId }),
    ).rejects.toThrow(/source is unsafe/u);
    expect(persistPrepared).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("preserves preparation and cleanup failures without spawning", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-cleanup-failure-"));
    roots.push(root);
    const fixture = prepare(root);
    const preparationError = new Error("native verification failed");
    const spawnFn = vi.fn();
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      persistPrepared: () => Promise.resolve(),
      persistAccepted: () => Promise.resolve(),
      verifyNativeCopy: ({ kind, copiedPath }): Promise<void> => {
        if (kind !== "coordinator") return Promise.resolve();
        rmSync(copiedPath);
        mkdirSync(copiedPath);
        writeFileSync(join(copiedPath, "retained"), "retained");
        return Promise.reject(preparationError);
      },
      publishCoordinatorPid: () => true,
      spawnFn,
    });

    const error = await coordinator
      .begin({ sessionId: "session-1", activationId: fixture.plan.activationId })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PortableHandoffCoordinatorError);
    expect((error as Error).message).toBe("portable handoff preparation cleanup failed");
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors[0]).toBe(preparationError);
    expect((cause as AggregateError).errors[1]).toBeInstanceOf(AggregateError);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("persists prepared intent before a fixed-argv spawn and keeps the parent pipe open", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-"));
    roots.push(root);
    const fixture = prepare(root);
    const control = new PassThrough();
    const response = new PassThrough();
    let controlText = "";
    control.on("data", (chunk: Buffer) => {
      controlText += chunk.toString("utf8");
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 43_210,
      stdin: control,
      stdio: [control, null, null, response],
      unref: vi.fn(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const order: string[] = [];
    let expectedPlanSha256 = "";
    const spawnFn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
      order.push("spawn");
      queueMicrotask(() => response.end(`KHA1${expectedPlanSha256}\n`));
      expect(command).toMatch(/coordinator$/u);
      expect(args).toStrictEqual(["--coordinate-update", fixture.plan.activationId]);
      expect(options.env).toStrictEqual({ KEIKO_STATE_DIR: fixture.stateDir });
      return child;
    });
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      publishCoordinatorPid: (_sessionId, pid) => {
        expect(pid).toBe(43_210);
        order.push("publish");
        return true;
      },
      persistPrepared: vi.fn(({ activationWal }: PortableHandoffPreparedIntent) => {
        order.push("persist");
        expect(activationWal.checkpoint).toBe("prepared");
        expect(activationWal.coordinatorSha256).toMatch(/^[a-f0-9]{64}$/u);
        expectedPlanSha256 = activationWal.planSha256;
        return Promise.resolve();
      }),
      persistAccepted: vi.fn(({ activationWal }: PortableHandoffAcceptedIntent) => {
        order.push("accept");
        expect(activationWal.coordinatorId).toBe(activationWal.coordinatorSha256);
        return Promise.resolve();
      }),
      verifyNativeCopy: vi.fn(() => Promise.resolve()),
      spawnFn,
      now: () => 1_700_000_000_000,
    });

    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: fixture.plan.activationId }),
    ).resolves.toMatchObject({ acceptedAt: "2023-11-14T22:13:20.000Z" });
    expect(order).toStrictEqual(["persist", "spawn", "publish", "accept"]);
    expect(controlText).toMatch(/^[a-f0-9]{64}\n$/u);
    expect(control.writableEnded).toBe(false);
  });

  it("does not spawn when the aggregate CAS fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-"));
    roots.push(root);
    const fixture = prepare(root);
    const spawnFn = vi.fn();
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      publishCoordinatorPid: () => true,
      persistPrepared: () => Promise.reject(new Error("stale revision")),
      persistAccepted: () => Promise.resolve(),
      verifyNativeCopy: () => Promise.resolve(),
      spawnFn,
    });
    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: fixture.plan.activationId }),
    ).rejects.toThrow("stale revision");
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("stops the owned coordinator when its control pipe rejects the plan digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-"));
    roots.push(root);
    const fixture = prepare(root);
    const response = new PassThrough();
    const control = Object.assign(new EventEmitter(), {
      write: vi.fn((_content: string, done: (error?: Error) => void) => {
        queueMicrotask(() => {
          done(new Error("pipe closed"));
        });
        return false;
      }),
      destroy: vi.fn(),
    });
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
      stateDir: fixture.stateDir,
      publishCoordinatorPid: () => true,
      persistPrepared: () => Promise.resolve(),
      persistAccepted: () => Promise.resolve(),
      verifyNativeCopy: () => Promise.resolve(),
      spawnFn: () => child,
      acceptanceTimeoutMs: 10,
    });

    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: fixture.plan.activationId }),
    ).rejects.toThrow(/pipe failed/u);
    expect(kill).toHaveBeenCalled();
    expect(control.destroy).toHaveBeenCalled();
  });

  it("sends no mutation control when coordinator ownership publication fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-"));
    roots.push(root);
    const fixture = prepare(root);
    const response = new PassThrough();
    const control = new PassThrough();
    const write = vi.spyOn(control, "write");
    const childEmitter = new EventEmitter();
    const kill = vi.fn(() => {
      queueMicrotask(() => childEmitter.emit("exit", null, "SIGKILL"));
      return true;
    });
    const child = Object.assign(childEmitter, {
      pid: 43_210,
      stdin: control,
      stdio: [control, null, null, response],
      unref: vi.fn(),
      kill,
    }) as unknown as ChildProcess;
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      publishCoordinatorPid: () => false,
      persistPrepared: () => Promise.resolve(),
      persistAccepted: () => Promise.resolve(),
      verifyNativeCopy: () => Promise.resolve(),
      spawnFn: () => child,
    });

    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: fixture.plan.activationId }),
    ).rejects.toThrow(/ownership could not be published/u);
    expect(write.mock.calls).toHaveLength(0);
    expect(kill).toHaveBeenCalledOnce();
  });

  it("stops the accepted coordinator when the accepted checkpoint CAS fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-"));
    roots.push(root);
    const fixture = prepare(root);
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
    let planSha256 = "";
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      publishCoordinatorPid: () => true,
      persistPrepared: ({ activationWal }) => {
        planSha256 = activationWal.planSha256;
        return Promise.resolve();
      },
      persistAccepted: () => Promise.reject(new Error("accepted CAS failed")),
      verifyNativeCopy: () => Promise.resolve(),
      spawnFn: () => {
        queueMicrotask(() => response.end(`KHA1${planSha256}\n`));
        return child;
      },
    });

    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: fixture.plan.activationId }),
    ).rejects.toThrow("accepted CAS failed");
    expect(kill).toHaveBeenCalled();
  });

  it("rejects a high-bit-masked native acceptance digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-"));
    roots.push(root);
    const fixture = prepare(root);
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
    let planSha256 = "";
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      publishCoordinatorPid: () => true,
      persistPrepared: ({ activationWal }) => {
        planSha256 = activationWal.planSha256;
        return Promise.resolve();
      },
      persistAccepted: () => Promise.resolve(),
      verifyNativeCopy: () => Promise.resolve(),
      spawnFn: () => {
        queueMicrotask(() => {
          const acceptance = Buffer.from(`KHA1${planSha256}\n`, "latin1");
          acceptance[4] = (acceptance[4] ?? 0) | 0x80;
          response.end(acceptance);
        });
        return child;
      },
    });

    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: fixture.plan.activationId }),
    ).rejects.toThrow(/closed before acceptance/u);
    expect(kill).toHaveBeenCalled();
  });

  it("cancels the owned coordinator before an ACK can commit handoff", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-"));
    roots.push(root);
    const fixture = prepare(root);
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
    const accepted = vi.fn(() => Promise.resolve());
    const controller = new AbortController();
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      publishCoordinatorPid: () => true,
      persistPrepared: () => Promise.resolve(),
      persistAccepted: accepted,
      verifyNativeCopy: () => Promise.resolve(),
      spawnFn: () => {
        queueMicrotask(() => {
          controller.abort();
        });
        return child;
      },
    });
    const pending = coordinator.begin({
      sessionId: "session-1",
      activationId: fixture.plan.activationId,
      signal: controller.signal,
    });
    await expect(pending).rejects.toThrow(/closed before acceptance/u);
    expect(accepted).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalled();
  });

  it("reports retained native authority when an owned coordinator cannot be reaped", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-"));
    roots.push(root);
    const fixture = prepare(root);
    const control = new PassThrough();
    const response = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 43_210,
      stdin: control,
      stdio: [control, null, null, response],
      exitCode: null,
      unref: vi.fn(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const coordinator = createPortableHandoffCoordinator({
      stateDir: fixture.stateDir,
      publishCoordinatorPid: () => true,
      persistPrepared: () => Promise.resolve(),
      persistAccepted: () => Promise.resolve(),
      verifyNativeCopy: () => Promise.resolve(),
      spawnFn: () => child,
      acceptanceTimeoutMs: 1,
      teardownTimeoutMs: 1,
    });

    const error = await coordinator
      .begin({ sessionId: "session-1", activationId: fixture.plan.activationId })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PortableHandoffCoordinatorError);
    expect((error as PortableHandoffCoordinatorError).nativeAuthorityMayBeLive).toBe(true);
    const cause = (error as PortableHandoffCoordinatorError).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toHaveLength(2);
    expect((cause as AggregateError).errors[0]).toBeInstanceOf(PortableHandoffCoordinatorError);
    expect((cause as AggregateError).errors[1]).toMatchObject({
      message: "portable handoff coordinator did not stop",
      nativeAuthorityMayBeLive: true,
    });
  });
});
