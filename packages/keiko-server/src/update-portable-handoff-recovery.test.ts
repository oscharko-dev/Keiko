import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateActivationWalState } from "@oscharko-dev/keiko-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPortableHandoffPlan,
  writePortableHandoffPlan,
} from "./update-portable-handoff-plan.js";
import {
  appendPortableHandoffReceipt,
  portableHandoffVerifiedAckMatches,
  readPortableHandoffReceipts,
  type PortableHandoffReceiptKind,
} from "./update-portable-handoff-receipts.js";
import {
  createUpdateStartupRecovery,
  type UpdateStartupRecoveryOptions,
} from "./update-portable-handoff-recovery.js";

const roots: string[] = [];

interface RecoveryFixture {
  readonly activationId: string;
  readonly planSha256: string;
  readonly sessionId: string;
  readonly stateDir: string;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function prepare(): RecoveryFixture {
  const root = mkdtempSync(join(tmpdir(), "keiko-handoff-recovery-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const parent = join(root, "install-parent");
  const stageRoot = join(parent, ".keiko-portable-updates", "stage-1");
  const activationId = "a".repeat(32);
  const sessionId = "session-1";
  const plan = createPortableHandoffPlan({
    activationId,
    sessionId,
    stageId: "stage-1",
    target: "macos-arm64",
    targetVersion: "1.2.3",
    newLaunchId: "2".repeat(32),
    restoreLaunchId: "3".repeat(32),
    aggregateRevision: 7,
    previousRegistrationState: "present",
    oldProcess: {
      pid: 123,
      launchId: "1".repeat(32),
      host: "127.0.0.1",
      port: 1983,
      version: "1.2.2",
    },
    paths: {
      managedRoot: join(parent, "Keiko.app"),
      stageRoot,
      candidateRoot: join(stageRoot, "Keiko", "Keiko.app"),
      backupRoot: join(parent, `.keiko-previous-${activationId}`),
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
      currentLauncherSha256: "3".repeat(64),
      currentSupervisorSha256: "4".repeat(64),
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
  const { sha256: planSha256 } = writePortableHandoffPlan({ stateDir, plan });
  return { activationId, planSha256, sessionId, stateDir };
}

function prepareWindows(): RecoveryFixture {
  const root = mkdtempSync(join(tmpdir(), "keiko-windows-handoff-recovery-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const parent = join(root, "install-parent");
  const managedRoot = join(parent, "Keiko");
  const stageRoot = join(parent, ".keiko-portable-updates", "stage-1");
  const candidateRoot = join(stageRoot, "Keiko");
  const activationId = "a".repeat(32);
  const sessionId = "session-windows-1";
  const plan = createPortableHandoffPlan({
    activationId,
    sessionId,
    stageId: "stage-1",
    target: "windows-x64",
    targetVersion: "1.2.3",
    newLaunchId: "2".repeat(32),
    restoreLaunchId: "3".repeat(32),
    aggregateRevision: 7,
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
      stageRoot,
      candidateRoot,
      backupRoot: join(parent, `.keiko-previous-${activationId}`),
      candidateLauncher: join(candidateRoot, "Keiko.exe"),
      candidateSupervisor: join(candidateRoot, "runtime", "native", "keiko-runtime-supervisor.exe"),
    },
    digests: {
      currentTreeSha256: "c".repeat(64),
      candidateTreeSha256: "d".repeat(64),
      currentLauncherSha256: "3".repeat(64),
      currentSupervisorSha256: "4".repeat(64),
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
    cutoverKind: "windows-generation-v1",
    currentGenerationTreeSha256: "5".repeat(64),
    candidateGenerationTreeSha256: "6".repeat(64),
    currentSetupManifestSha256: "7".repeat(64),
    candidateSetupManifestSha256: "8".repeat(64),
  });
  const { sha256: planSha256 } = writePortableHandoffPlan({ stateDir, plan });
  return { activationId, planSha256, sessionId, stateDir };
}

function appendThroughStart(fixture: RecoveryFixture): string {
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
  ];
  let previousSha256: string | undefined;
  for (const [kind, outcome] of entries) {
    previousSha256 = appendPortableHandoffReceipt({
      ...fixture,
      kind,
      outcome,
      at: 1,
      ...(previousSha256 === undefined ? {} : { previousSha256 }),
    }).sha256;
  }
  return previousSha256 ?? "";
}

function initialWal(fixture: RecoveryFixture): UpdateActivationWalState {
  return {
    activationId: fixture.activationId,
    planSha256: fixture.planSha256,
    coordinatorSha256: "9".repeat(64),
    intentRevision: 7,
    checkpoint: "prepared",
    receiptSequence: 0,
  };
}

describe("portable handoff startup recovery", () => {
  it("attests the Windows candidate generation and root setup instead of a synthetic whole root", async () => {
    const fixture = prepareWindows();
    appendThroughStart(fixture);
    let wal = initialWal(fixture);
    const attest = vi.fn(() => Promise.resolve(true));
    const recovery = createUpdateStartupRecovery({
      stateDir: fixture.stateDir,
      readActivation: () => ({ sessionId: fixture.sessionId, activationWal: wal }),
      persistActivation: ({ activationWal }) => {
        wal = activationWal;
        return Promise.resolve();
      },
      settleRestored: () => Promise.resolve(),
      attestActiveTree: attest,
    });

    await expect(
      recovery.reconcile({
        phase: "pre-listen",
        current: {
          pid: process.pid,
          launchId: "2".repeat(32),
          host: "127.0.0.1",
          port: 1983,
          version: "1.2.3",
        },
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(attest).toHaveBeenCalledWith({
      kind: "windows-generation-v1",
      activationId: fixture.activationId,
      expectedGenerationTreeSha256: "6".repeat(64),
      expectedSetupManifestSha256: "8".repeat(64),
      expectedRegistrationSha256: "1".repeat(64),
      expectedVersion: "1.2.3",
    });
  });

  it("folds native start receipts pre-listen and verifies exact replacement post-listen", async () => {
    const fixture = prepare();
    appendThroughStart(fixture);
    let wal = initialWal(fixture);
    const persist = vi.fn(
      ({ activationWal }: { readonly activationWal: UpdateActivationWalState }) => {
        wal = activationWal;
        return Promise.resolve();
      },
    );
    const recovery = createUpdateStartupRecovery({
      stateDir: fixture.stateDir,
      readActivation: () => ({ sessionId: fixture.sessionId, activationWal: wal }),
      persistActivation: persist,
      settleRestored: () => Promise.resolve(),
      attestActiveTree: () => Promise.resolve(true),
      now: () => 2,
    });
    const current = {
      pid: process.pid,
      launchId: "2".repeat(32),
      host: "127.0.0.1" as const,
      port: 1983,
      version: "1.2.3",
    };

    await expect(recovery.reconcile({ phase: "pre-listen", current })).resolves.toMatchObject({
      status: "ready",
    });
    expect(wal.checkpoint).toBe("new-started");
    await expect(recovery.reconcile({ phase: "post-listen", current })).resolves.toMatchObject({
      status: "ready",
    });
    expect(wal.checkpoint).toBe("verified");
    expect(readPortableHandoffReceipts(fixture.stateDir, fixture.activationId)).toHaveLength(11);
    expect(portableHandoffVerifiedAckMatches(fixture)).toBe(true);
  });

  it("retains a verified target across a later fresh launch without duplicate verification", async () => {
    const fixture = prepare();
    const last = appendThroughStart(fixture);
    const intent = appendPortableHandoffReceipt({
      ...fixture,
      kind: "verify",
      outcome: "intent",
      at: 2,
      previousSha256: last,
    });
    const completed = appendPortableHandoffReceipt({
      ...fixture,
      kind: "verify",
      outcome: "completed",
      at: 2,
      previousSha256: intent.sha256,
    });
    const wal: UpdateActivationWalState = {
      ...initialWal(fixture),
      checkpoint: "verified",
      receiptSequence: 11,
      receiptSha256: completed.sha256,
      coordinatorId: "9".repeat(64),
    };
    const persistedPhases: string[] = [];
    const persist = vi.fn(
      (entry: Parameters<UpdateStartupRecoveryOptions["persistActivation"]>[0]): Promise<void> => {
        persistedPhases.push(entry.phase);
        return Promise.resolve();
      },
    );
    const recovery = createUpdateStartupRecovery({
      stateDir: fixture.stateDir,
      readActivation: () => ({ sessionId: fixture.sessionId, activationWal: wal }),
      persistActivation: persist,
      settleRestored: () => Promise.resolve(),
      attestActiveTree: () => Promise.resolve(true),
    });
    const current = {
      pid: process.pid,
      launchId: "fresh-restart",
      host: "127.0.0.1" as const,
      port: 1983,
      version: "1.2.3",
    };

    await expect(recovery.reconcile({ phase: "pre-listen", current })).resolves.toMatchObject({
      status: "ready",
    });
    await expect(recovery.reconcile({ phase: "post-listen", current })).resolves.toMatchObject({
      status: "ready",
    });
    expect(readPortableHandoffReceipts(fixture.stateDir, fixture.activationId)).toHaveLength(11);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persistedPhases).toEqual(["pre-listen", "post-listen"]);
  });

  it("completes an existing target verification intent after a crash without duplicating it", async () => {
    const fixture = prepare();
    const previousSha256 = appendThroughStart(fixture);
    const intent = appendPortableHandoffReceipt({
      ...fixture,
      kind: "verify",
      outcome: "intent",
      at: 2,
      previousSha256,
    });
    let wal: UpdateActivationWalState = {
      ...initialWal(fixture),
      checkpoint: "new-started",
      receiptSequence: 10,
      receiptSha256: intent.sha256,
      coordinatorId: "9".repeat(64),
    };
    const recovery = createUpdateStartupRecovery({
      stateDir: fixture.stateDir,
      readActivation: () => ({ sessionId: fixture.sessionId, activationWal: wal }),
      persistActivation: ({ activationWal }) => {
        wal = activationWal;
        return Promise.resolve();
      },
      settleRestored: () => Promise.resolve(),
      attestActiveTree: () => Promise.resolve(true),
    });
    const current = {
      pid: process.pid,
      launchId: "2".repeat(32),
      host: "127.0.0.1" as const,
      port: 1983,
      version: "1.2.3",
    };

    await expect(recovery.reconcile({ phase: "post-listen", current })).resolves.toMatchObject({
      status: "ready",
    });
    expect(wal.checkpoint).toBe("verified");
    expect(
      readPortableHandoffReceipts(fixture.stateDir, fixture.activationId).map(
        ({ kind, outcome }) => `${kind}:${outcome}`,
      ),
    ).toEqual([
      "prepared:completed",
      "old-exit:intent",
      "old-exit:completed",
      "promote:intent",
      "promote:completed",
      "register:intent",
      "register:completed",
      "start:intent",
      "start:completed",
      "verify:intent",
      "verify:completed",
    ]);
    await expect(
      recovery.reconcile({
        phase: "post-listen",
        current: { ...current, launchId: "fresh-target-launch" },
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(readPortableHandoffReceipts(fixture.stateDir, fixture.activationId)).toHaveLength(11);
  });

  it("retains N after receipt 11 when CAS fails, then reconciles and acknowledges on restart", async () => {
    const fixture = prepare();
    appendThroughStart(fixture);
    let wal = initialWal(fixture);
    let failPostListen = true;
    const recovery = createUpdateStartupRecovery({
      stateDir: fixture.stateDir,
      readActivation: () => ({ sessionId: fixture.sessionId, activationWal: wal }),
      persistActivation: ({ activationWal, phase }) => {
        if (phase === "post-listen" && failPostListen) return Promise.reject(new Error("CAS"));
        wal = activationWal;
        return Promise.resolve();
      },
      settleRestored: () => Promise.resolve(),
      attestActiveTree: () => Promise.resolve(true),
      now: () => 2,
    });
    const current = {
      pid: process.pid,
      launchId: "2".repeat(32),
      host: "127.0.0.1" as const,
      port: 1983,
      version: "1.2.3",
    };
    await recovery.reconcile({ phase: "pre-listen", current });
    await expect(recovery.reconcile({ phase: "post-listen", current })).resolves.toMatchObject({
      status: "recovery-required",
    });
    expect(portableHandoffVerifiedAckMatches(fixture)).toBe(false);
    expect(readPortableHandoffReceipts(fixture.stateDir, fixture.activationId)).toHaveLength(11);

    failPostListen = false;
    await expect(recovery.reconcile({ phase: "pre-listen", current })).resolves.toMatchObject({
      status: "ready",
    });
    await expect(
      recovery.reconcile({
        phase: "post-listen",
        current: { ...current, launchId: "fresh-target-launch" },
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(portableHandoffVerifiedAckMatches(fixture)).toBe(true);
  });

  it("keeps recovery closed when verified acknowledgement publication fails after CAS", async () => {
    const fixture = prepare();
    appendThroughStart(fixture);
    mkdirSync(join(fixture.stateDir, "updates", "handoff", fixture.activationId, "verified.ack"));
    let wal = initialWal(fixture);
    const recovery = createUpdateStartupRecovery({
      stateDir: fixture.stateDir,
      readActivation: () => ({ sessionId: fixture.sessionId, activationWal: wal }),
      persistActivation: ({ activationWal }) => {
        wal = activationWal;
        return Promise.resolve();
      },
      settleRestored: () => Promise.resolve(),
      attestActiveTree: () => Promise.resolve(true),
    });
    const current = {
      pid: process.pid,
      launchId: "2".repeat(32),
      host: "127.0.0.1" as const,
      port: 1983,
      version: "1.2.3",
    };
    await recovery.reconcile({ phase: "pre-listen", current });
    await expect(recovery.reconcile({ phase: "post-listen", current })).resolves.toMatchObject({
      status: "recovery-required",
      reason: "persistence-failed",
    });
    expect(wal.checkpoint).toBe("verified");
  });

  it("settles a verified N-1 restore only for the plan-bound restore identity", async () => {
    const fixture = prepare();
    let previousSha256 = appendThroughStart(fixture);
    for (const [kind, outcome] of [
      ["restore", "intent"],
      ["restore", "completed"],
      ["restored-start", "intent"],
      ["restored-start", "completed"],
    ] as const) {
      previousSha256 = appendPortableHandoffReceipt({
        ...fixture,
        kind,
        outcome,
        at: 3,
        previousSha256,
      }).sha256;
    }
    appendPortableHandoffReceipt({
      ...fixture,
      kind: "restored-verify",
      outcome: "intent",
      at: 4,
      previousSha256,
    });
    let wal = initialWal(fixture);
    const settleRestored = vi.fn(
      ({ activationWal }: { readonly activationWal: UpdateActivationWalState }) => {
        wal = activationWal;
        return Promise.resolve();
      },
    );
    const attest = vi.fn(() => Promise.resolve(true));
    const recovery = createUpdateStartupRecovery({
      stateDir: fixture.stateDir,
      readActivation: () => ({ sessionId: fixture.sessionId, activationWal: wal }),
      persistActivation: ({ activationWal }) => {
        wal = activationWal;
        return Promise.resolve();
      },
      settleRestored,
      attestActiveTree: attest,
    });
    const restored = {
      pid: process.pid,
      launchId: "3".repeat(32),
      host: "127.0.0.1" as const,
      port: 1983,
      version: "1.2.2",
    };
    await expect(
      recovery.reconcile({ phase: "pre-listen", current: restored }),
    ).resolves.toMatchObject({
      status: "ready",
    });
    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedTreeSha256: "c".repeat(64),
        expectedRegistrationSha256: "0".repeat(64),
        expectedVersion: "1.2.2",
      }),
    );
    await expect(
      recovery.reconcile({ phase: "post-listen", current: { ...restored, launchId: "wrong" } }),
    ).resolves.toMatchObject({ status: "recovery-required" });
    expect(settleRestored).not.toHaveBeenCalled();
    await expect(
      recovery.reconcile({ phase: "post-listen", current: restored }),
    ).resolves.toMatchObject({
      status: "ready",
    });
    expect(settleRestored).toHaveBeenCalledOnce();
    expect(wal.checkpoint).toBe("restored-verified");
    expect(readPortableHandoffReceipts(fixture.stateDir, fixture.activationId)).toHaveLength(15);
  });

  it("completes the restored-start receipt for the exact recovered process before listen", async () => {
    const fixture = prepare();
    let previousSha256 = appendThroughStart(fixture);
    for (const [kind, outcome] of [
      ["restore", "intent"],
      ["restore", "completed"],
    ] as const) {
      previousSha256 = appendPortableHandoffReceipt({
        ...fixture,
        kind,
        outcome,
        at: 3,
        previousSha256,
      }).sha256;
    }
    let wal = initialWal(fixture);
    const recovery = createUpdateStartupRecovery({
      stateDir: fixture.stateDir,
      readActivation: () => ({ sessionId: fixture.sessionId, activationWal: wal }),
      persistActivation: ({ activationWal }) => {
        wal = activationWal;
        return Promise.resolve();
      },
      settleRestored: () => Promise.resolve(),
      attestActiveTree: () => Promise.resolve(true),
    });
    await expect(
      recovery.reconcile({
        phase: "pre-listen",
        current: {
          pid: process.pid,
          launchId: "3".repeat(32),
          host: "127.0.0.1",
          port: 1983,
          version: "1.2.2",
        },
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(wal.checkpoint).toBe("restored-started");
    expect(
      readPortableHandoffReceipts(fixture.stateDir, fixture.activationId)
        .slice(-2)
        .map(({ kind, outcome }) => `${kind}:${outcome}`),
    ).toEqual(["restored-start:intent", "restored-start:completed"]);
  });
});
