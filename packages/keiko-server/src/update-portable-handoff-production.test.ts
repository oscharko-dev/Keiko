import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  UpdateActivationWalCheckpoint,
  UpdateRuntimeState,
  UpdateSession,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { digestUpdateCandidate } from "./update-candidate-authority.js";
import { transitionUpdateSession } from "./update-lifecycle.js";
import {
  createUpdateLocalStateManager,
  type UpdateLocalStateManager,
} from "./update-local-state.js";
import { hashPortableHandoffTree } from "./update-portable-handoff-builder.js";
import {
  createPortableHandoffPlan,
  writePortableHandoffPlan,
  type PortableHandoffPlan,
} from "./update-portable-handoff-plan.js";
import {
  createPortableHandoffCurrentProcessResolver,
  createProductionPortableHandoffRuntime,
  ProductionPortableHandoffError,
} from "./update-portable-handoff-production.js";
import {
  appendPortableHandoffReceipt,
  type PortableHandoffReceiptKind,
} from "./update-portable-handoff-receipts.js";
import type { UpdateSessionLock } from "./update-session-lock.js";

const roots: string[] = [];
const NOW = Date.parse("2026-09-05T00:00:00.000Z");
const sessionLock: UpdateSessionLock = {
  isLocked: (): boolean => true,
  acquire: (): boolean => false,
  updateChildPid: (): boolean => true,
  release: (): void => undefined,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface ProductionFixture {
  readonly activationId: string;
  readonly localState: UpdateLocalStateManager;
  readonly plan: PortableHandoffPlan;
  readonly sessionId: string;
  readonly stateDir: string;
}

type FixtureOutcome = "restored" | "complete";

function fixtureDigests(
  outcome: FixtureOutcome,
  tree: string,
  registration: string,
): PortableHandoffPlan["digests"] {
  const registrationSha256 = createHash("sha256").update(registration).digest("hex");
  return {
    currentTreeSha256: outcome === "restored" ? tree : "c".repeat(64),
    candidateTreeSha256: outcome === "complete" ? tree : "d".repeat(64),
    currentLauncherSha256: "3".repeat(64),
    currentSupervisorSha256: "4".repeat(64),
    candidateLauncherSha256: "e".repeat(64),
    candidateSupervisorSha256: "f".repeat(64),
    previousRegistrationSha256: outcome === "restored" ? registrationSha256 : "0".repeat(64),
    preparedRegistrationSha256: outcome === "complete" ? registrationSha256 : "1".repeat(64),
  };
}

function fixtureReceipts(
  outcome: FixtureOutcome,
): readonly (readonly [PortableHandoffReceiptKind, "intent" | "completed"])[] {
  const forward = [
    ["prepared", "completed"],
    ["old-exit", "intent"],
    ["old-exit", "completed"],
    ["promote", "intent"],
    ["promote", "completed"],
    ["register", "intent"],
    ["register", "completed"],
    ["start", "intent"],
    ["start", "completed"],
  ] as const;
  return outcome === "restored"
    ? [
        ...forward,
        ["restore", "intent"],
        ["restore", "completed"],
        ["restored-start", "intent"],
        ["restored-start", "completed"],
      ]
    : [
        ...forward,
        ["verify", "intent"],
        ["verify", "completed"],
        ["cleanup", "intent"],
        ["cleanup", "completed"],
        ["complete", "completed"],
      ];
}

function fixtureCheckpoints(
  outcome: FixtureOutcome,
): readonly (readonly [UpdateActivationWalCheckpoint, number])[] {
  return outcome === "restored"
    ? ([
        ["old-exited", 3],
        ["promoted", 5],
        ["registered", 7],
        ["new-started", 9],
        ["restoring", 10],
        ["restored-started", 13],
      ] as const)
    : ([
        ["old-exited", 3],
        ["promoted", 5],
        ["registered", 7],
        ["new-started", 9],
        ["verified", 11],
        ["cleanup-pending", 12],
        ["complete", 14],
      ] as const);
}

async function productionFixture(outcome: FixtureOutcome = "restored"): Promise<ProductionFixture> {
  const root = mkdtempSync(join(tmpdir(), "keiko-handoff-production-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const managedRoot = join(root, "install", "Keiko.app");
  mkdirSync(managedRoot, { recursive: true });
  writeFileSync(join(managedRoot, "installed.txt"), `verified ${outcome}`);
  mkdirSync(stateDir, { recursive: true });
  const localState = createUpdateLocalStateManager({ stateDir, now: () => NOW });
  const initialized = localState.writeRuntimeState(localState.readRuntimeState());
  const registration = JSON.stringify({
    schemaVersion: 1,
    status: "managed",
    updateEligible: true,
    stable: true,
    platformTarget: "macos-arm64",
    packageVersion: outcome === "restored" ? "1.2.2" : "1.2.3",
    installRootIdentitySha256: createHash("sha256").update(realpathSync(managedRoot)).digest("hex"),
  });
  writeFileSync(join(stateDir, "portable-install-state.json"), registration);
  const currentTreeSha256 = await hashPortableHandoffTree(managedRoot, {
    deadline: Date.now() + 30_000,
  });
  const activationId = "a".repeat(32);
  const sessionId = "session-restored";
  const plan = createPortableHandoffPlan({
    activationId,
    sessionId,
    stageId: "stage-1",
    target: "macos-arm64",
    targetVersion: "1.2.3",
    newLaunchId: "2".repeat(32),
    restoreLaunchId: "3".repeat(32),
    aggregateRevision: initialized.revision + 1,
    previousRegistrationState: "present",
    oldProcess: {
      pid: 123,
      launchId: "1".repeat(32),
      host: "127.0.0.1",
      port: 1983,
      version: "1.2.2",
    },
    paths: {
      managedRoot,
      stageRoot: join(root, "install", ".keiko-portable-updates", "stage-1"),
      candidateRoot: join(root, "install", ".keiko-portable-updates", "stage-1", "Keiko.app"),
      backupRoot: join(root, "install", `.keiko-previous-${activationId}`),
      candidateLauncher: join(
        root,
        "install",
        ".keiko-portable-updates",
        "stage-1",
        "Keiko.app",
        "Contents",
        "MacOS",
        "Keiko",
      ),
      candidateSupervisor: join(
        root,
        "install",
        ".keiko-portable-updates",
        "stage-1",
        "Keiko.app",
        "Contents",
        "Resources",
        "runtime",
        "native",
        "keiko-runtime-supervisor",
      ),
    },
    digests: fixtureDigests(outcome, currentTreeSha256, registration),
    deadlines: {
      oldExitAt: NOW + 30_000,
      startAt: NOW + 60_000,
      verifyAt: NOW + 90_000,
      cleanupAt: NOW + 120_000,
    },
  });
  const { sha256: planSha256 } = writePortableHandoffPlan({ stateDir, plan });
  const receipts = fixtureReceipts(outcome);
  const receiptDigests: string[] = [];
  let previousSha256: string | undefined;
  for (const [kind, outcome] of receipts) {
    const appended = appendPortableHandoffReceipt({
      stateDir,
      activationId,
      planSha256,
      kind,
      outcome,
      at: NOW,
      ...(previousSha256 === undefined ? {} : { previousSha256 }),
    });
    receiptDigests.push(appended.sha256);
    previousSha256 = appended.sha256;
  }
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
    issuedAt: "2026-09-04T23:00:00.000Z",
    expiresAt: "2026-09-05T01:00:00.000Z",
  };
  const activeSession: UpdateSession = {
    schemaVersion: "1",
    sessionId,
    candidateId: candidate.candidateId,
    candidateDigest: digestUpdateCandidate(candidate),
    correlationId: "corr-restored",
    packageName: "@oscharko-dev/keiko",
    targetVersion: "1.2.3",
    phase: "restart-required",
    lifecycle: {
      phase: "handoff-pending",
      progress: { completedBytes: 1, totalBytes: 1 },
      cancellationCutoff: "handoff-committed",
    },
    failureReason: "none",
    packageManager: "npm",
    startedAt: "2026-09-04T23:00:00.000Z",
    updatedAt: "2026-09-04T23:00:00.000Z",
    cancelable: false,
    retryable: false,
    restartRequired: true,
    message: "Native handoff pending.",
  };
  let state = localState.writeRuntimeState({
    ...initialized,
    activeSession,
    activeCandidate: candidate,
    activationWal: {
      activationId,
      planSha256,
      coordinatorSha256: "9".repeat(64),
      intentRevision: plan.aggregateRevision,
      checkpoint: "prepared",
      receiptSequence: 0,
    },
  });
  const checkpoints = fixtureCheckpoints(outcome);
  for (const [checkpoint, sequence] of checkpoints) {
    const activationWal = state.activationWal;
    if (activationWal === undefined) throw new TypeError("expected activation WAL");
    state = localState.writeRuntimeState({
      ...state,
      activationWal: {
        ...activationWal,
        checkpoint,
        receiptSequence: sequence,
        receiptSha256: receiptDigests[sequence - 1],
        coordinatorId: "9".repeat(64),
      },
    });
  }
  return { activationId, localState, plan, sessionId, stateDir };
}

describe("production portable handoff process identity", () => {
  const validEnv = {
    KEIKO_UI_HOST: "127.0.0.1",
    KEIKO_UI_LAUNCH_ID: "a".repeat(32),
    KEIKO_UI_PORT: "1983",
  };

  it("resolves an exact loopback launch identity", () => {
    const resolveCurrent = createPortableHandoffCurrentProcessResolver({
      env: validEnv,
      currentVersion: "1.2.3",
      pid: 42,
    });

    expect(resolveCurrent()).toEqual({
      pid: 42,
      launchId: "a".repeat(32),
      host: "127.0.0.1",
      port: 1983,
      version: "1.2.3",
    });
    expect(
      createPortableHandoffCurrentProcessResolver({
        env: validEnv,
        currentVersion: "1.2.3",
      })().pid,
    ).toBe(process.pid);
  });

  it("rejects spoofable or out-of-range launch identities", () => {
    const invalid = [
      { env: { ...validEnv, KEIKO_UI_HOST: "0.0.0.0" }, currentVersion: "1.2.3", pid: 42 },
      {
        env: { ...validEnv, KEIKO_UI_LAUNCH_ID: "not-a-launch" },
        currentVersion: "1.2.3",
        pid: 42,
      },
      { env: { ...validEnv, KEIKO_UI_PORT: "01983" }, currentVersion: "1.2.3", pid: 42 },
      { env: { ...validEnv, KEIKO_UI_PORT: "65536" }, currentVersion: "1.2.3", pid: 42 },
      { env: validEnv, currentVersion: "invalid version", pid: 42 },
      { env: validEnv, currentVersion: "1.2.3", pid: 0 },
      { env: validEnv, currentVersion: "1.2.3", pid: 2_147_483_648 },
      { env: {}, currentVersion: "1.2.3", pid: 42 },
    ];

    for (const options of invalid) {
      expect(() => createPortableHandoffCurrentProcessResolver(options)()).toThrow(
        ProductionPortableHandoffError,
      );
    }
  });
});

describe("production portable handoff recovery", () => {
  it("persists restored proof before atomic failure settlement and stays settled on restart", async () => {
    const fixture = await productionFixture();
    let rejectSettlement = true;
    const guardedLocalState = {
      ...fixture.localState,
      writeRuntimeState: (
        state: Parameters<typeof fixture.localState.writeRuntimeState>[0],
      ): UpdateRuntimeState => {
        if (rejectSettlement && state.activationWal === undefined) {
          throw new Error("injected settlement persistence failure");
        }
        return fixture.localState.writeRuntimeState(state);
      },
    };
    const current = {
      pid: process.pid,
      launchId: fixture.plan.restoreLaunchId,
      host: "127.0.0.1" as const,
      port: fixture.plan.oldProcess.port,
      version: fixture.plan.oldProcess.version,
    };
    const firstRuntime = createProductionPortableHandoffRuntime({
      sessionLock,
      env: {},
      stateDir: fixture.stateDir,
      currentVersion: fixture.plan.oldProcess.version,
      localState: guardedLocalState,
      now: () => NOW,
    });

    await expect(
      firstRuntime.recovery.reconcile({ phase: "pre-listen", current }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      firstRuntime.recovery.reconcile({ phase: "post-listen", current }),
    ).resolves.toMatchObject({ status: "recovery-required", reason: "persistence-failed" });
    expect(fixture.localState.readRuntimeState().activationWal?.checkpoint).toBe(
      "restored-verified",
    );

    rejectSettlement = false;
    const restartedRuntime = createProductionPortableHandoffRuntime({
      sessionLock,
      env: {},
      stateDir: fixture.stateDir,
      currentVersion: fixture.plan.oldProcess.version,
      localState: fixture.localState,
      now: () => NOW,
    });
    await expect(
      restartedRuntime.recovery.reconcile({ phase: "post-listen", current }),
    ).resolves.toMatchObject({ status: "ready" });
    const settled = fixture.localState.readRuntimeState();
    expect(settled.activeSession).toBeUndefined();
    expect(settled.activeCandidate).toBeUndefined();
    expect(settled.activationWal).toBeUndefined();
    expect(settled).toMatchObject({
      lastSession: {
        sessionId: fixture.sessionId,
        phase: "failed",
        failureReason: "portable-relaunch-failed",
        retryable: false,
        restartRequired: false,
      },
      recovery: { status: "settled", sessionId: fixture.sessionId },
    });

    const secondRestart = createProductionPortableHandoffRuntime({
      sessionLock,
      env: {},
      stateDir: fixture.stateDir,
      currentVersion: fixture.plan.oldProcess.version,
      localState: fixture.localState,
      now: () => NOW,
    });
    await expect(
      secondRestart.recovery.reconcile({ phase: "pre-listen", current }),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("settles complete activation as remediation-required with its exact candidate retained", async () => {
    const fixture = await productionFixture("complete");
    const candidate = fixture.localState.readRuntimeState().activeCandidate;
    const runtime = createProductionPortableHandoffRuntime({
      sessionLock,
      env: {},
      stateDir: fixture.stateDir,
      currentVersion: fixture.plan.targetVersion,
      localState: fixture.localState,
      now: () => NOW,
      canComplete: () => false,
    });
    const current = {
      pid: process.pid,
      launchId: "fresh-target-restart",
      host: "127.0.0.1" as const,
      port: fixture.plan.oldProcess.port,
      version: fixture.plan.targetVersion,
    };

    await expect(
      runtime.recovery.reconcile({ phase: "pre-listen", current }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      runtime.recovery.reconcile({ phase: "post-listen", current }),
    ).resolves.toMatchObject({ status: "ready" });
    const settled = fixture.localState.readRuntimeState();
    expect(settled.activationWal).toBeUndefined();
    expect(settled.activeCandidate).toEqual(candidate);
    expect(settled.activeSession).toMatchObject({
      sessionId: fixture.sessionId,
      lifecycle: { phase: "remediation-required" },
    });
    expect(settled.recovery).toMatchObject({ status: "settled", sessionId: fixture.sessionId });
  });

  it("atomically settles a complete activation as succeeded and remains ready", async () => {
    const fixture = await productionFixture("complete");
    const runtime = createProductionPortableHandoffRuntime({
      sessionLock,
      env: {},
      stateDir: fixture.stateDir,
      currentVersion: fixture.plan.targetVersion,
      localState: fixture.localState,
      now: () => NOW,
    });
    const current = {
      pid: process.pid,
      launchId: "fresh-target-restart",
      host: "127.0.0.1" as const,
      port: fixture.plan.oldProcess.port,
      version: fixture.plan.targetVersion,
    };

    await expect(
      runtime.recovery.reconcile({ phase: "pre-listen", current }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      runtime.recovery.reconcile({ phase: "post-listen", current }),
    ).resolves.toMatchObject({ status: "ready" });
    const settled = fixture.localState.readRuntimeState();
    expect(settled.activeSession).toBeUndefined();
    expect(settled.activeCandidate).toBeUndefined();
    expect(settled.activationWal).toBeUndefined();
    expect(settled.lastSession).toMatchObject({
      sessionId: fixture.sessionId,
      lifecycle: { phase: "succeeded" },
    });

    const restarted = createProductionPortableHandoffRuntime({
      sessionLock,
      env: {},
      stateDir: fixture.stateDir,
      currentVersion: fixture.plan.targetVersion,
      localState: fixture.localState,
      now: () => NOW,
    });
    await expect(
      restarted.recovery.reconcile({ phase: "pre-listen", current }),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("settles a terminal session whose completed WAL survived the prior process", async () => {
    const fixture = await productionFixture("complete");
    const interrupted = fixture.localState.readRuntimeState();
    const activeSession = interrupted.activeSession;
    if (activeSession === undefined) throw new TypeError("expected active session fixture");
    const verifyingSession = {
      ...activeSession,
      ...transitionUpdateSession(activeSession, { phase: "verifying-relaunch" }),
    };
    const terminalSession = {
      ...verifyingSession,
      ...transitionUpdateSession(verifyingSession, { phase: "succeeded" }),
    };
    fixture.localState.writeRuntimeState({
      ...interrupted,
      activeSession: undefined,
      activeCandidate: undefined,
      lastSession: terminalSession,
    });
    const runtime = createProductionPortableHandoffRuntime({
      sessionLock,
      env: {},
      stateDir: fixture.stateDir,
      currentVersion: fixture.plan.targetVersion,
      localState: fixture.localState,
      now: () => NOW,
    });
    const current = {
      pid: process.pid,
      launchId: fixture.plan.newLaunchId,
      host: "127.0.0.1" as const,
      port: fixture.plan.oldProcess.port,
      version: fixture.plan.targetVersion,
    };

    await expect(
      runtime.recovery.reconcile({ phase: "pre-listen", current }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(fixture.localState.readRuntimeState()).toMatchObject({
      activationWal: { checkpoint: "complete" },
      lastSession: { sessionId: fixture.sessionId },
      recovery: { status: "reconciling", sessionId: fixture.sessionId },
    });

    await expect(runtime.recovery.reconcile({ phase: "post-listen", current })).resolves.toEqual({
      status: "ready",
      sessionId: fixture.sessionId,
    });
    const settled = fixture.localState.readRuntimeState();
    expect(settled.activationWal).toBeUndefined();
    expect(settled).toMatchObject({
      lastSession: { sessionId: fixture.sessionId },
      recovery: { status: "settled", sessionId: fixture.sessionId },
    });

    const restarted = createProductionPortableHandoffRuntime({
      sessionLock,
      env: {},
      stateDir: fixture.stateDir,
      currentVersion: fixture.plan.targetVersion,
      localState: fixture.localState,
      now: () => NOW,
    });
    await expect(restarted.recovery.reconcile({ phase: "pre-listen", current })).resolves.toEqual({
      status: "ready",
    });
    expect(fixture.localState.readRuntimeState().lastSession).toEqual(settled.lastSession);
  });
});
