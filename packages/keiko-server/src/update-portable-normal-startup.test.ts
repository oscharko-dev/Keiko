import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UpdateRuntimeState, UpdateSession } from "@oscharko-dev/keiko-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestUpdateCandidate } from "./update-candidate-authority.js";
import { hashPortableHandoffTree } from "./update-portable-handoff-builder.js";
import {
  createPortableHandoffPlan,
  portableHandoffRoot,
  writePortableHandoffPlan,
  type PortableHandoffPlan,
} from "./update-portable-handoff-plan.js";
import {
  appendPortableHandoffReceipt,
  type PortableHandoffReceiptKind,
} from "./update-portable-handoff-receipts.js";
import {
  reconcilePortableNormalStartup,
  runPortableNativeRecoveryProcess,
  type PortableNativeRecoveryInput,
  type PortableNativeRecoveryProcess,
} from "./update-portable-normal-startup.js";
import {
  createUpdateLocalStateManager,
  type UpdateLocalStateManager,
} from "./update-local-state.js";
import {
  createStateDirUpdateSessionLock,
  inspectStateDirUpdateSessionLockForRecovery,
  updateSessionLockPath,
  type UpdateSessionLock,
} from "./update-session-lock.js";

const roots: string[] = [];
const NOW = Date.parse("2026-09-07T10:00:00.000Z");

interface NormalStartupFixture {
  readonly activationId: string;
  readonly coordinatorSha256: string;
  readonly localState: UpdateLocalStateManager;
  readonly lock: UpdateSessionLock;
  readonly managedRoot: string;
  readonly plan: PortableHandoffPlan;
  readonly session: UpdateSession;
  readonly state: UpdateRuntimeState;
  readonly stateDir: string;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fakeNativeProcess(pid: number | "missing" = 404): {
  readonly child: PortableNativeRecoveryProcess;
  readonly destroyControl: ReturnType<typeof vi.fn>;
  readonly emitControlError: () => void;
  readonly emitError: () => void;
  readonly emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly endControl: ReturnType<typeof vi.fn>;
  readonly terminate: ReturnType<typeof vi.fn>;
} {
  let onError: ((error: Error) => void) | undefined;
  let onControlError: ((error: Error) => void) | undefined;
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const destroyControl = vi.fn();
  const endControl = vi.fn();
  const terminate = vi.fn();
  return {
    child: {
      pid: pid === "missing" ? undefined : pid,
      destroyControl,
      endControl,
      onControlError: (listener): void => {
        onControlError = listener;
      },
      onError: (listener): void => {
        onError = listener;
      },
      onExit: (listener): void => {
        onExit = listener;
      },
      terminate,
    },
    destroyControl,
    emitControlError: (): void => {
      onControlError?.(new Error("control pipe failed"));
    },
    emitError: (): void => {
      onError?.(new Error("spawn failed"));
    },
    emitExit: (code, signal): void => {
      onExit?.(code, signal);
    },
    endControl,
    terminate,
  };
}

function nativeInput(
  onSpawn: PortableNativeRecoveryInput["onSpawn"] = () => true,
): PortableNativeRecoveryInput {
  return {
    coordinator: "/fixture/coordinator",
    activationId: "a".repeat(32),
    control: Buffer.from("KUR1\n", "ascii"),
    stateDir: "/fixture/state",
    timeoutMs: 100,
    onSpawn,
  };
}

async function prepare(terminal = false): Promise<NormalStartupFixture> {
  const root = mkdtempSync(join(tmpdir(), "keiko-normal-startup-recovery-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const managedRoot = join(root, "install", "Keiko.app");
  mkdirSync(managedRoot, { recursive: true });
  writeFileSync(join(managedRoot, "installed.txt"), "old tree");
  mkdirSync(stateDir, { recursive: true });
  const localState = createUpdateLocalStateManager({ stateDir, now: () => NOW });
  const initial = localState.writeRuntimeState(localState.readRuntimeState());
  const registration = JSON.stringify({
    schemaVersion: 1,
    status: "managed",
    updateEligible: true,
    stable: true,
    platformTarget: "macos-arm64",
    packageVersion: "1.2.2",
    installRootIdentitySha256: createHash("sha256").update(realpathSync(managedRoot)).digest("hex"),
  });
  writeFileSync(join(stateDir, "portable-install-state.json"), registration);
  const currentTreeSha256 = await hashPortableHandoffTree(managedRoot, {
    deadline: Date.now() + 30_000,
  });
  const activationId = "a".repeat(32);
  const sessionId = "session-normal-startup";
  const stageRoot = join(root, "install", ".keiko-portable-updates", "stage-1");
  const candidateRoot = join(stageRoot, "Keiko", "Keiko.app");
  const plan = createPortableHandoffPlan({
    activationId,
    sessionId,
    stageId: "stage-1",
    target: "macos-arm64",
    targetVersion: "1.2.3",
    newLaunchId: "2".repeat(32),
    restoreLaunchId: "3".repeat(32),
    aggregateRevision: initial.revision + 1,
    previousRegistrationState: "present",
    oldProcess: {
      pid: 101,
      launchId: "1".repeat(32),
      host: "127.0.0.1",
      port: 1983,
      version: "1.2.2",
    },
    paths: {
      managedRoot,
      stageRoot,
      candidateRoot,
      backupRoot: join(root, "install", `.keiko-previous-${activationId}`),
      candidateLauncher: join(candidateRoot, "Contents", "MacOS", "Keiko"),
      candidateSupervisor: join(
        candidateRoot,
        "Contents",
        "Resources",
        "runtime",
        "native",
        "keiko-runtime-supervisor",
      ),
    },
    digests: {
      currentTreeSha256,
      candidateTreeSha256: "d".repeat(64),
      currentLauncherSha256: "3".repeat(64),
      currentSupervisorSha256: "4".repeat(64),
      candidateLauncherSha256: "e".repeat(64),
      candidateSupervisorSha256: "f".repeat(64),
      previousRegistrationSha256: createHash("sha256").update(registration).digest("hex"),
      preparedRegistrationSha256: "1".repeat(64),
    },
    deadlines: {
      oldExitAt: NOW - 120_000,
      startAt: NOW - 90_000,
      verifyAt: NOW - 60_000,
      cleanupAt: NOW - 30_000,
    },
  });
  const { sha256: planSha256 } = writePortableHandoffPlan({ stateDir, plan });
  const coordinator = join(portableHandoffRoot(stateDir, activationId), "coordinator");
  writeFileSync(coordinator, "native recovery fixture");
  const coordinatorSha256 = createHash("sha256").update("native recovery fixture").digest("hex");
  const candidate = {
    schemaVersion: "1" as const,
    candidateId: "candidate-1.2.3",
    currentVersion: "1.2.2",
    targetVersion: "1.2.3",
    channel: "stable" as const,
    install: {
      packageName: "@oscharko-dev/keiko",
      installKind: "package-manager" as const,
      packageManager: "npm" as const,
      installIdentitySha256: "8".repeat(64),
    },
    release: { source: "github-release" as const, tag: "v1.2.3" },
    releaseImpactDigest: "7".repeat(64),
    issuedAt: "2026-09-07T09:00:00.000Z",
    expiresAt: "2026-09-07T11:00:00.000Z",
  };
  const session: UpdateSession = {
    schemaVersion: "1",
    sessionId,
    candidateId: candidate.candidateId,
    candidateDigest: digestUpdateCandidate(candidate),
    correlationId: "corr-normal-startup",
    packageName: "@oscharko-dev/keiko",
    targetVersion: "1.2.3",
    phase: terminal ? "succeeded" : "running",
    lifecycle: {
      phase: terminal ? "succeeded" : "staging",
      progress: { completedBytes: 1, totalBytes: 1 },
      cancellationCutoff: terminal ? "handoff-committed" : "not-reached",
    },
    failureReason: "none",
    packageManager: "npm",
    startedAt: "2026-09-07T09:00:00.000Z",
    updatedAt: "2026-09-07T09:00:00.000Z",
    cancelable: !terminal,
    retryable: false,
    restartRequired: false,
    message: "Native handoff pending.",
  };
  const state = localState.writeRuntimeState({
    ...initial,
    activeSession: terminal ? undefined : session,
    activeCandidate: terminal ? undefined : candidate,
    lastSession: terminal ? session : undefined,
    activationWal: {
      activationId,
      planSha256,
      coordinatorSha256,
      intentRevision: plan.aggregateRevision,
      checkpoint: "prepared",
      receiptSequence: 0,
      ...(terminal ? { coordinatorId: coordinatorSha256 } : {}),
    },
  });
  const lock = createStateDirUpdateSessionLock(stateDir, {
    processIdentity: "old-owner",
    pidAlive: () => false,
  });
  expect(
    lock.acquire({ sessionId, targetVersion: "1.2.3", startedAt: session.startedAt, pid: 101 }),
  ).toBe(true);
  return {
    activationId,
    coordinatorSha256,
    localState,
    lock,
    managedRoot,
    plan,
    session,
    state,
    stateDir,
  };
}

function appendComplete(fixture: Awaited<ReturnType<typeof prepare>>): string {
  const entries: readonly (readonly [PortableHandoffReceiptKind, "intent" | "completed"])[] = [
    ["prepared", "completed"],
    ["old-exit", "intent"],
    ["old-exit", "completed"],
    ["promote", "intent"],
    ["promote", "completed"],
    ["register", "intent"],
    ["register", "completed"],
    ["start", "intent"],
    ["start", "completed"],
    ["verify", "intent"],
    ["verify", "completed"],
    ["cleanup", "intent"],
    ["cleanup", "completed"],
    ["complete", "completed"],
  ];
  let previousSha256: string | undefined;
  for (const [kind, outcome] of entries) {
    previousSha256 = appendPortableHandoffReceipt({
      stateDir: fixture.stateDir,
      activationId: fixture.activationId,
      planSha256: fixture.state.activationWal?.planSha256 ?? "",
      kind,
      outcome,
      at: NOW,
      ...(previousSha256 === undefined ? {} : { previousSha256 }),
    }).sha256;
  }
  return previousSha256 ?? "";
}

function prepareAcceptedRecovery(fixture: NormalStartupFixture): void {
  const preparedSha256 = appendPortableHandoffReceipt({
    stateDir: fixture.stateDir,
    activationId: fixture.activationId,
    planSha256: fixture.state.activationWal?.planSha256 ?? "",
    kind: "prepared",
    outcome: "completed",
    at: NOW,
  }).sha256;
  appendPortableHandoffReceipt({
    stateDir: fixture.stateDir,
    activationId: fixture.activationId,
    planSha256: fixture.state.activationWal?.planSha256 ?? "",
    kind: "old-exit",
    outcome: "intent",
    at: NOW,
    previousSha256: preparedSha256,
  });
  const activationWal = fixture.state.activationWal;
  if (activationWal === undefined) throw new TypeError("expected activation WAL");
  fixture.localState.writeRuntimeState({
    ...fixture.localState.readRuntimeState(),
    activationWal: { ...activationWal, coordinatorId: fixture.coordinatorSha256 },
  });
  expect(fixture.lock.updateChildPid(fixture.session.sessionId, 202)).toBe(true);
}

describe("portable normal startup recovery", () => {
  it("treats an installation with no aggregate or interrupted anchors as fresh", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-normal-startup-fresh-"));
    roots.push(stateDir);
    const runNative = vi.fn(() => Promise.resolve(true));
    await expect(
      reconcilePortableNormalStartup({
        stateDir,
        target: "macos-arm64",
        expectedManagedRoot: stateDir,
        runNative,
      }),
    ).resolves.toEqual({ status: "normal" });
    expect(runNative).not.toHaveBeenCalled();
  });

  it("settles an unaccepted prepared crash before child publication against exact old state", async () => {
    const fixture = await prepare();
    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
      }),
    ).resolves.toEqual({ status: "normal" });
    const settled = fixture.localState.readRuntimeState();
    expect(settled).toMatchObject({
      activeSession: { sessionId: fixture.session.sessionId },
      recovery: { status: "settled", sessionId: fixture.session.sessionId },
    });
    expect(settled.activationWal).toBeUndefined();
    expect(() => {
      writeFileSync(updateSessionLockPath(fixture.stateDir), "occupied", { flag: "wx" });
    }).not.toThrow();
  });

  it("settles the exact one-receipt preacceptance crash and starts normally afterward", async () => {
    const fixture = await prepare();
    appendPortableHandoffReceipt({
      stateDir: fixture.stateDir,
      activationId: fixture.activationId,
      planSha256: fixture.state.activationWal?.planSha256 ?? "",
      kind: "prepared",
      outcome: "completed",
      at: NOW,
    });
    expect(fixture.lock.updateChildPid(fixture.session.sessionId, 202)).toBe(true);
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));
    const options = {
      stateDir: fixture.stateDir,
      target: "macos-arm64" as const,
      expectedManagedRoot: fixture.managedRoot,
      currentPid: 303,
      processIdentity: "recovery-cli",
      pidAlive: (): boolean => false,
      runNative,
    };

    await expect(reconcilePortableNormalStartup(options)).resolves.toEqual({ status: "normal" });
    await expect(reconcilePortableNormalStartup(options)).resolves.toEqual({ status: "normal" });
    expect(runNative).not.toHaveBeenCalled();
    expect(fixture.localState.readRuntimeState()).toMatchObject({
      activeSession: { sessionId: fixture.session.sessionId },
      recovery: { status: "settled", sessionId: fixture.session.sessionId },
    });
  });

  it("rejects a prepared-only crash whose published child PID is missing", async () => {
    const fixture = await prepare();
    appendPortableHandoffReceipt({
      stateDir: fixture.stateDir,
      activationId: fixture.activationId,
      planSha256: fixture.state.activationWal?.planSha256 ?? "",
      kind: "prepared",
      outcome: "completed",
      at: NOW,
    });
    const beforeLock = readFileSync(updateSessionLockPath(fixture.stateDir), "utf8");
    const beforeState = fixture.localState.readRuntimeState();
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(readFileSync(updateSessionLockPath(fixture.stateDir), "utf8")).toBe(beforeLock);
    expect(fixture.localState.readRuntimeState()).toEqual(beforeState);
    expect(runNative).not.toHaveBeenCalled();
  });

  it.each(["old-tree", "previous-registration"] as const)(
    "rejects one-receipt preacceptance settlement when %s no longer attests",
    async (mismatch) => {
      const fixture = await prepare();
      appendPortableHandoffReceipt({
        stateDir: fixture.stateDir,
        activationId: fixture.activationId,
        planSha256: fixture.state.activationWal?.planSha256 ?? "",
        kind: "prepared",
        outcome: "completed",
        at: NOW,
      });
      expect(fixture.lock.updateChildPid(fixture.session.sessionId, 202)).toBe(true);
      if (mismatch === "old-tree") {
        writeFileSync(join(fixture.managedRoot, "installed.txt"), "mutated old tree");
      } else {
        writeFileSync(join(fixture.stateDir, "portable-install-state.json"), "{}\n");
      }
      const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));

      await expect(
        reconcilePortableNormalStartup({
          stateDir: fixture.stateDir,
          target: "macos-arm64",
          expectedManagedRoot: fixture.managedRoot,
          currentPid: 303,
          processIdentity: "recovery-cli",
          pidAlive: () => false,
          runNative,
        }),
      ).resolves.toEqual({ status: "recovery-required" });
      expect(runNative).not.toHaveBeenCalled();
      expect(fixture.localState.readRuntimeState().activationWal).toBeDefined();
    },
  );

  it("recovers a complete receipt chain anchored by a terminal last session", async () => {
    const fixture = await prepare(true);
    const receiptSha256 = appendComplete(fixture);
    const activationWal = fixture.state.activationWal;
    if (activationWal === undefined) throw new TypeError("expected activation WAL");
    fixture.localState.writeRuntimeState({
      ...fixture.localState.readRuntimeState(),
      activationWal: {
        ...activationWal,
        checkpoint: "complete",
        receiptSequence: 14,
        receiptSha256,
        coordinatorId: fixture.coordinatorSha256,
      },
    });
    expect(fixture.lock.updateChildPid(fixture.session.sessionId, 202)).toBe(true);
    const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
      const runtimeBytes = readFileSync(join(fixture.stateDir, "updates", "runtime-state.json"));
      expect(input.control.toString("ascii").split("\n")[0]).toBe("KUR1");
      expect(input.control.toString("ascii").split("\n")[7]).toBe(
        createHash("sha256").update(runtimeBytes).digest("hex"),
      );
      expect(input.onSpawn(404)).toBe(true);
      return Promise.resolve({ status: "succeeded" as const });
    });
    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toMatchObject({
      status: "recovered",
      descriptor: {
        sessionId: fixture.session.sessionId,
        launchId: fixture.plan.newLaunchId,
        expectedVersion: fixture.plan.targetVersion,
      },
    });
    expect(runNative).toHaveBeenCalledOnce();
  });

  it("emits a correlated body-free diagnostic when validated ownership is still live", async () => {
    const fixture = await prepare();
    const events: unknown[] = [];
    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        pidAlive: (pid) => pid === 101,
        securityLogSink: { write: (event) => events.push(event) },
      }),
    ).resolves.toEqual({ status: "recovery-required" });
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "portable.normal-startup-recovery.required",
        correlationId: fixture.session.correlationId,
        errorKind: "PortableNormalStartupRecoveryRequired",
        extra: { reason: "ownership-live-or-mismatch" },
      }),
    );
    expect(JSON.stringify(events)).not.toContain(fixture.stateDir);
    expect(JSON.stringify(events)).not.toContain("old tree");
  });

  it("rejects a recovery plan outside the managed root whose mutation lock is held", async () => {
    const fixture = await prepare();
    const otherManagedRoot = join(dirname(fixture.managedRoot), "Other.app");
    mkdirSync(otherManagedRoot, { recursive: true });
    const beforeLock = readFileSync(updateSessionLockPath(fixture.stateDir), "utf8");
    const beforeState = fixture.localState.readRuntimeState();
    const runNative = vi.fn(() => Promise.resolve(true));

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: otherManagedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(runNative).not.toHaveBeenCalled();
    expect(readFileSync(updateSessionLockPath(fixture.stateDir), "utf8")).toBe(beforeLock);
    expect(fixture.localState.readRuntimeState()).toEqual(beforeState);
  });

  it("does not settle an unaccepted handoff while its published coordinator is live", async () => {
    const fixture = await prepare();
    expect(fixture.lock.updateChildPid(fixture.session.sessionId, 202)).toBe(true);
    const beforeLock = readFileSync(updateSessionLockPath(fixture.stateDir), "utf8");
    const beforeState = fixture.localState.readRuntimeState();
    const runNative = vi.fn(() => Promise.resolve(true));

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: (pid) => pid === 202,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(runNative).not.toHaveBeenCalled();
    expect(readFileSync(updateSessionLockPath(fixture.stateDir), "utf8")).toBe(beforeLock);
    expect(fixture.localState.readRuntimeState()).toEqual(beforeState);
  });

  it("waits for a delayed exit after timeout before confirming native recovery death", async () => {
    vi.useFakeTimers();
    const fixture = fakeNativeProcess();
    const result = runPortableNativeRecoveryProcess(nativeInput(), () => fixture.child);
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.destroyControl).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    fixture.emitExit(null, "SIGKILL");

    await expect(result).resolves.toEqual({ status: "failed", process: "confirmed-dead" });
  });

  it("reports an ambiguous live process when timeout teardown has no exit", async () => {
    vi.useFakeTimers();
    const fixture = fakeNativeProcess();
    const result = runPortableNativeRecoveryProcess(nativeInput(), () => fixture.child);

    await vi.advanceTimersByTimeAsync(5_100);

    await expect(result).resolves.toEqual({ status: "failed", process: "ambiguous-live" });
    expect(fixture.destroyControl).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith("SIGKILL");
  });

  it("fails closed when native PID publication fails and process exit stays ambiguous", async () => {
    vi.useFakeTimers();
    const onSpawn = vi.fn(() => false);
    const fixture = fakeNativeProcess();
    const result = runPortableNativeRecoveryProcess(nativeInput(onSpawn), () => fixture.child);

    expect(onSpawn).toHaveBeenCalledWith(404);
    expect(fixture.destroyControl).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toEqual({ status: "failed", process: "ambiguous-live" });
  });

  it("contains asynchronous control-pipe errors through bounded native teardown", async () => {
    vi.useFakeTimers();
    const fixture = fakeNativeProcess();
    const result = runPortableNativeRecoveryProcess(nativeInput(), () => fixture.child);

    fixture.emitControlError();
    expect(fixture.destroyControl).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith("SIGKILL");
    fixture.emitExit(null, "SIGKILL");

    await expect(result).resolves.toEqual({ status: "failed", process: "confirmed-dead" });
  });

  it("does not arm an ambiguity timer when termination synchronously observes exit", async () => {
    vi.useFakeTimers();
    const fixture = fakeNativeProcess();
    fixture.terminate.mockImplementation(() => {
      fixture.emitExit(null, "SIGKILL");
    });

    await expect(
      runPortableNativeRecoveryProcess(
        nativeInput(() => false),
        () => fixture.child,
      ),
    ).resolves.toEqual({ status: "failed", process: "confirmed-dead" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a spawn failure without a PID as confirmed dead", async () => {
    const onSpawn = vi.fn(() => true);
    const fixture = fakeNativeProcess("missing");

    await expect(
      runPortableNativeRecoveryProcess(nativeInput(onSpawn), () => fixture.child),
    ).resolves.toEqual({ status: "failed", process: "confirmed-dead" });
    expect(onSpawn).not.toHaveBeenCalled();
    expect(fixture.endControl).not.toHaveBeenCalled();
  });

  it("does not reclaim while an ambiguously live native recovery PID remains published", async () => {
    const fixture = await prepare();
    prepareAcceptedRecovery(fixture);
    const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
      expect(input.onSpawn(404)).toBe(true);
      return Promise.resolve({ status: "failed" as const, process: "ambiguous-live" as const });
    });

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    const retryNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));
    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 505,
        processIdentity: "retry-cli",
        pidAlive: (pid) => pid === 404,
        runNative: retryNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });
    expect(runNative).toHaveBeenCalledOnce();
    expect(retryNative).not.toHaveBeenCalled();
  });

  it("retains a confirmed-dead native PID instead of replacing its durable sidecar", async () => {
    const fixture = await prepare();
    prepareAcceptedRecovery(fixture);
    const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
      expect(input.onSpawn(404)).toBe(true);
      return Promise.resolve({ status: "failed" as const, process: "confirmed-dead" as const });
    });

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(inspectStateDirUpdateSessionLockForRecovery(fixture.stateDir)?.childPid).toBe(404);
  });
});
