import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CommandCancelledError, type CommandResult } from "@oscharko-dev/keiko-tools";
import type {
  UpdateCandidateSnapshot,
  UpdateInstallMode,
  UpdatePortableActivationSummary,
  UpdatePortableStagingSummary,
  UpdateSessionStartRequest,
} from "@oscharko-dev/keiko-contracts";
import {
  createUpdateSessionManager,
  UpdateSessionError,
  type UpdateSessionManagerOptions,
} from "./update-session.js";
import type { PortableUpdateStager } from "./update-portable-staging.js";
import {
  PortableUpdateActivationError,
  type PortableUpdateActivator,
} from "./update-portable-activation.js";
import { transitionUpdateSession } from "./update-lifecycle.js";
import { detectUpdateInstallMode, type UpdateRuntimeFacts } from "./update-install-mode.js";
import {
  updateCandidateInstallIdentity,
  type UpdateCandidateAuthority,
} from "./update-candidate-authority.js";
import { createUpdateLocalStateManager } from "./update-local-state.js";
import {
  createFileUpdateSessionLock,
  createStateDirUpdateSessionLock,
  type UpdateSessionLock,
  type UpdateSessionLockRecord,
  updateSessionLockPath,
} from "./update-session-lock.js";

const ROOT = "/usr/local/lib/node_modules/@oscharko-dev/keiko";
const CONFIRMATION_DIGEST = "a".repeat(64);
const EXECUTION_TOKEN = "b".repeat(64);

function claim(targetVersion: string): UpdateSessionStartRequest {
  return {
    candidateId: `candidate-${targetVersion}`,
    confirmationDigest: CONFIRMATION_DIGEST,
    executionToken: EXECUTION_TOKEN,
  };
}

function candidateSnapshot(
  targetVersion: string,
  currentVersion: string,
  installMode: UpdateInstallMode,
): UpdateCandidateSnapshot {
  const install = updateCandidateInstallIdentity(installMode);
  if (install === undefined) throw new Error("Test candidate requires a supported install mode.");
  const portable =
    installMode.status === "supported" && installMode.installKind === "portable-managed"
      ? {
          target: "windows-x64" as const,
          releaseId: 456,
          assetId: 123,
          assetName: "keiko-windows-x64.zip",
          sizeBytes: 789,
          uncompressedSizeBytes: 1_024,
          sha256: "a".repeat(64),
          manifestAssetName: "release-manifest.json",
          manifestAssetId: 124,
          manifestSizeBytes: 456,
          manifestSha256: "b".repeat(64),
          checksumAssetName: "SHA256SUMS",
          checksumAssetId: 125,
          checksumSizeBytes: 457,
          checksumSha256: "c".repeat(64),
          checksumVerified: true,
        }
      : undefined;
  return {
    schemaVersion: "1",
    candidateId: `candidate-${targetVersion}`,
    currentVersion,
    targetVersion,
    channel: "stable",
    install,
    release: { source: "github-release", tag: `v${targetVersion}` },
    releaseImpactDigest: "f".repeat(64),
    issuedAt: "2026-06-30T00:00:00.000Z",
    expiresAt: "2026-06-30T00:10:00.000Z",
    ...(portable === undefined ? {} : { portable }),
  };
}

const testCandidateAuthority: UpdateCandidateAuthority = {
  issue: () => undefined,
  consume(input, currentVersion, installMode) {
    const targetVersion = input.candidateId.replace(/^candidate-/u, "");
    return {
      ok: true,
      snapshot: candidateSnapshot(targetVersion, currentVersion, installMode),
      installMode,
      impact: {
        affectedStateStores: [],
        stateImpact: [],
        userActionRequired: false,
      },
    };
  },
};

function createTestUpdateSessionManager(
  options: UpdateSessionManagerOptions = {},
): ReturnType<typeof createUpdateSessionManager> {
  return createUpdateSessionManager({ candidateAuthority: testCandidateAuthority, ...options });
}

function facts(overrides: Partial<UpdateRuntimeFacts> = {}): UpdateRuntimeFacts {
  return {
    packageRoot: ROOT,
    packageName: "@oscharko-dev/keiko",
    packageManagerHint: "npm",
    installScope: "global",
    ...overrides,
  };
}

function supportedMode(packageManager: "npm" | "yarn" = "npm"): UpdateInstallMode {
  return detectUpdateInstallMode(facts({ packageManagerHint: packageManager }));
}

function portableMode(): UpdateInstallMode {
  return {
    schemaVersion: "1",
    status: "supported",
    packageName: "@oscharko-dev/keiko",
    installKind: "portable-managed",
    portable: {
      status: "managed",
      target: "windows-x64",
      updateEligible: true,
      packageVersion: "0.2.11",
      stable: true,
    },
    recommendedAction: "portable-managed-update",
  };
}

function portableStageSummary(): UpdatePortableStagingSummary {
  return {
    stageId: "stage-1",
    status: "staged",
    target: "windows-x64",
    packageVersion: "0.2.12",
    assetName: "keiko-windows-x64.zip",
    assetId: 123,
    releaseId: 456,
    sizeBytes: 789,
    sha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
}

function portableActivationSummary(): UpdatePortableActivationSummary {
  return {
    activationId: "activation-1",
    status: "activated",
    stageId: "stage-1",
    target: "windows-x64",
    packageVersion: "0.2.12",
    registrationRefreshed: true,
    shortcutRefreshed: true,
    relaunchRequested: true,
    versionVerified: true,
  };
}

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "npm",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 5,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

function expectPortableStageInput(
  stage: ReturnType<typeof vi.fn<PortableUpdateStager["stage"]>>,
): void {
  const stageInput = stage.mock.calls[0]?.[0];
  expect(stageInput?.sessionId).toBe("session-1");
  expect(stageInput?.targetVersion).toBe("0.2.12");
  expect(stageInput?.installMode.installKind).toBe("portable-managed");
  expect(stageInput?.runtimeFacts?.packageRoot).toBe("/Users/alice/Applications/Keiko/app");
}

function expectPortableActivationInput(input: {
  readonly activate: ReturnType<typeof vi.fn<PortableUpdateActivator["activate"]>>;
  readonly stageSummary: UpdatePortableStagingSummary;
}): void {
  const activationInput = input.activate.mock.calls[0]?.[0];
  expect(activationInput?.sessionId).toBe("session-1");
  expect(activationInput?.targetVersion).toBe("0.2.12");
  expect(activationInput?.stage).toEqual(input.stageSummary);
  expect(activationInput?.runtimeFacts?.packageRoot).toBe("/Users/alice/Applications/Keiko/app");
  expect(activationInput?.signal).toBeInstanceOf(AbortSignal);
}

function lockRecord(sessionId: string): UpdateSessionLockRecord {
  return {
    sessionId,
    targetVersion: "0.2.12",
    startedAt: "2026-06-30T00:00:00.000Z",
    pid: 1234,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MemoryUpdateSessionLock implements UpdateSessionLock {
  private record: UpdateSessionLockRecord | undefined;

  public readonly isLocked = (): boolean => this.record !== undefined;

  public readonly acquire = (record: UpdateSessionLockRecord): boolean => {
    if (this.record !== undefined) return false;
    this.record = record;
    return true;
  };

  public readonly updateChildPid = (sessionId: string, childPid: number): boolean => {
    if (this.record?.sessionId !== sessionId) return false;
    this.record = { ...this.record, childPid };
    return true;
  };

  public readonly release = (sessionId: string): void => {
    if (this.record?.sessionId === sessionId) this.record = undefined;
  };
}

async function waitForPhase(
  manager: ReturnType<typeof createUpdateSessionManager>,
  phase: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(manager.getStatus().activeSession?.phase ?? manager.getStatus().lastSession?.phase).toBe(
      phase,
    );
  });
}

describe("UpdateSessionManager", () => {
  it("evaluates the candidate gate before acquiring mutation authority", () => {
    const runCommandImpl = vi.fn<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>();
    const lock = new MemoryUpdateSessionLock();
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      lock,
      runCommandImpl,
      candidateGate: () => {
        throw new UpdateSessionError(
          "UPDATE_REMEDIATION_REQUIRED",
          "Required remediation must be reviewed before update execution.",
          409,
        );
      },
    });

    expect(() => manager.start(claim("0.2.12"))).toThrow(
      expect.objectContaining({ code: "UPDATE_REMEDIATION_REQUIRED", status: 409 }),
    );
    expect(lock.isLocked()).toBe(false);
    expect(runCommandImpl).not.toHaveBeenCalled();
  });

  it("refuses mutation when enterprise policy disables updates", () => {
    const runCommandImpl = vi.fn<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>();
    const manager = createTestUpdateSessionManager({
      processEnv: { KEIKO_UPDATE_MUTATION_DISABLED: "true" },
      detector: () => supportedMode(),
      runCommandImpl,
    });

    expect(() => manager.start(claim("0.2.12"))).toThrow(UpdateSessionError);
    expect(runCommandImpl).not.toHaveBeenCalled();
  });

  it("runs npm through the governed command boundary and waits for restart", async () => {
    const calls: Parameters<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>[0][] = [];
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode("npm"),
      runCommandImpl: (input) => {
        calls.push(input);
        return Promise.resolve(commandResult({ stdout: "installed token=SECRET" }));
      },
      redactor: (value) => value.replace("SECRET", "[REDACTED]"),
    });

    const started = manager.start(claim("0.2.12"));

    expect(started.session.phase).toBe("preparing");
    await waitForPhase(manager, "restart-required");
    expect(calls[0]?.command).toBe("npm");
    expect(calls[0]?.args).toEqual([
      "install",
      "--global",
      "--ignore-scripts",
      "@oscharko-dev/keiko@0.2.12",
    ]);
    expect(manager.getStatus().activeSession?.logs?.stdoutPreview).toContain("[REDACTED]");
  });

  it("surfaces a restart command that targets the running port and state directory", () => {
    const manager = createTestUpdateSessionManager({
      processEnv: {
        KEIKO_UI_PORT: "1990",
        KEIKO_UI_HOST: "127.0.0.1",
        KEIKO_STATE_DIR: "/tmp/keiko update state",
      },
      detector: () => supportedMode("npm"),
      beforeExecute: () => Promise.race([]),
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    const started = manager.start(claim("0.2.12"));

    expect(started.session.restartCommandPreview).toEqual({
      executable: "keiko",
      args: [
        "restart",
        "--port",
        "1990",
        "--host",
        "127.0.0.1",
        "--state-dir",
        "/tmp/keiko update state",
      ],
      label: "keiko restart --port 1990 --host 127.0.0.1 --state-dir '/tmp/keiko update state'",
    });
  });

  it("omits the restart command preview when runtime targeting data is incomplete", () => {
    const manager = createTestUpdateSessionManager({
      processEnv: { KEIKO_UI_PORT: "1990" },
      detector: () => supportedMode("npm"),
      beforeExecute: () => Promise.race([]),
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    const started = manager.start(claim("0.2.12"));

    expect(started.session.restartCommandPreview).toBeUndefined();
  });

  it("runs Yarn through equivalent governed argv", async () => {
    const calls: Parameters<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>[0][] = [];
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode("yarn"),
      runCommandImpl: (input) => {
        calls.push(input);
        return Promise.resolve(commandResult());
      },
    });

    manager.start(claim("0.2.12"));
    await waitForPhase(manager, "restart-required");

    expect(calls[0]?.command).toBe("yarn");
    expect(calls[0]?.args).toEqual([
      "global",
      "add",
      "--ignore-scripts",
      "@oscharko-dev/keiko@0.2.12",
    ]);
  });

  it("stages portable-managed updates without invoking package-manager commands", async () => {
    const runCommandImpl = vi.fn<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>();
    const stageSummary = portableStageSummary();
    const activationSummary = portableActivationSummary();
    const stage = vi.fn<PortableUpdateStager["stage"]>().mockResolvedValue({
      ...stageSummary,
    });
    const activate = vi.fn<PortableUpdateActivator["activate"]>().mockResolvedValue({
      ...activationSummary,
    });
    const portableStager: PortableUpdateStager = {
      stage,
    };
    const portableActivator: PortableUpdateActivator = {
      activate,
    };
    const manager = createTestUpdateSessionManager({
      detector: () => portableMode(),
      facts: () => facts({ packageRoot: "/Users/alice/Applications/Keiko/app" }),
      idFactory: () => "session-1",
      portableStager,
      portableActivator,
      runCommandImpl,
    });

    const started = manager.start(claim("0.2.12"));
    await waitForPhase(manager, "succeeded");

    expect(started.session.commandPreview).toBeUndefined();
    expect(runCommandImpl).not.toHaveBeenCalled();
    expectPortableStageInput(stage);
    expectPortableActivationInput({ activate, stageSummary });
    expect(manager.getStatus().lastSession).toMatchObject({
      phase: "succeeded",
      message: "Portable update 0.2.12 is active and verified.",
      restartRequired: false,
      portableStage: { stageId: "stage-1", status: "staged" },
      portableActivation: { activationId: "activation-1", status: "activated" },
    });
  });

  it("requests identity-bound orderly shutdown only after native handoff acceptance is durable", async () => {
    const requestShutdown = vi.fn().mockResolvedValue(undefined);
    const activationId = "c".repeat(32);
    const launchId = "d".repeat(32);
    const manager = createTestUpdateSessionManager({
      detector: () => portableMode(),
      facts: () => facts({ packageRoot: "/Users/alice/Applications/Keiko/app" }),
      idFactory: () => "session-1",
      processEnv: { KEIKO_UI_LAUNCH_ID: launchId },
      portableStager: { stage: vi.fn().mockResolvedValue(portableStageSummary()) },
      portableActivator: {
        activate: vi.fn().mockResolvedValue({
          activationId,
          status: "handoff-pending",
          coordinatorId: "e".repeat(64),
          acceptedAt: "2026-09-05T00:00:00.000Z",
        }),
      },
      onPortableHandoffAccepted: requestShutdown,
    });

    manager.start(claim("0.2.12"));
    await vi.waitFor(() => {
      expect(manager.getStatus().activeSession?.lifecycle.phase).toBe("handoff-pending");
    });

    expect(requestShutdown).toHaveBeenCalledWith({
      sessionId: "session-1",
      activationId,
      pid: process.pid,
      launchId,
    });
    expect(manager.getStatus().activeSession).toMatchObject({
      phase: "restart-required",
      lifecycle: { phase: "handoff-pending" },
    });
  });

  it("requires recovery when an accepted handoff cannot request orderly shutdown", async () => {
    const manager = createTestUpdateSessionManager({
      detector: () => portableMode(),
      facts: () => facts({ packageRoot: "/Users/alice/Applications/Keiko/app" }),
      idFactory: () => "session-1",
      processEnv: { KEIKO_UI_LAUNCH_ID: "d".repeat(32) },
      portableStager: { stage: vi.fn().mockResolvedValue(portableStageSummary()) },
      portableActivator: {
        activate: vi.fn().mockResolvedValue({
          activationId: "c".repeat(32),
          status: "handoff-pending",
          coordinatorId: "e".repeat(64),
          acceptedAt: "2026-09-05T00:00:00.000Z",
        }),
      },
      onPortableHandoffAccepted: () => Promise.reject(new Error("state directory unavailable")),
    });

    manager.start(claim("0.2.12"));
    await vi.waitFor(() => {
      expect(manager.getStatus().activeSession?.lifecycle.phase).toBe("recovery-required");
    });

    expect(manager.getStatus().activeSession).toMatchObject({
      phase: "restart-required",
      lifecycle: { phase: "recovery-required" },
      message: "The update handoff was accepted, but orderly shutdown could not be requested.",
    });
  });

  it("keeps cancellation available while the portable handoff builder is still preparing", async () => {
    let activationSignal: AbortSignal | undefined;
    const activate = vi.fn<PortableUpdateActivator["activate"]>((input) => {
      activationSignal = input.signal;
      return new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => {
            reject(
              new PortableUpdateActivationError(
                "cancelled",
                "portable handoff preparation was cancelled",
              ),
            );
          },
          { once: true },
        );
      });
    });
    const requestShutdown = vi.fn().mockResolvedValue(undefined);
    const manager = createTestUpdateSessionManager({
      detector: () => portableMode(),
      facts: () => facts({ packageRoot: "/Users/alice/Applications/Keiko/app" }),
      idFactory: () => "session-1",
      processEnv: { KEIKO_UI_LAUNCH_ID: "d".repeat(32) },
      portableStager: { stage: vi.fn().mockResolvedValue(portableStageSummary()) },
      portableActivator: { activate },
      onPortableHandoffAccepted: requestShutdown,
    });

    manager.start(claim("0.2.12"));
    await vi.waitFor(() => {
      expect(activate).toHaveBeenCalledOnce();
      expect(manager.getStatus().activeSession?.lifecycle).toMatchObject({
        phase: "staging",
        cancellationCutoff: "not-reached",
      });
    });
    manager.cancel();

    await waitForPhase(manager, "cancelled");
    expect(activationSignal?.aborted).toBe(true);
    expect(requestShutdown).not.toHaveBeenCalled();
    expect(manager.getStatus().lastSession?.lifecycle.cancellationCutoff).toBe("not-reached");
  });

  it("does not let a stale shutdown failure regress an already verified handoff", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "keiko-stale-shutdown-"));
    const localState = createUpdateLocalStateManager({ stateDir });
    let rejectShutdown!: (error: Error) => void;
    const shutdown = new Promise<void>((_resolve, reject) => {
      rejectShutdown = reject;
    });
    const manager = createTestUpdateSessionManager({
      detector: () => portableMode(),
      facts: () => facts({ packageRoot: "/Users/alice/Applications/Keiko/app" }),
      currentVersion: () => "0.2.12",
      idFactory: () => "session-1",
      processEnv: { KEIKO_UI_LAUNCH_ID: "d".repeat(32) },
      portableStager: { stage: vi.fn().mockResolvedValue(portableStageSummary()) },
      portableActivator: {
        activate: vi.fn().mockResolvedValue({
          activationId: "c".repeat(32),
          status: "handoff-pending",
          coordinatorId: "e".repeat(64),
          acceptedAt: "2026-09-05T00:00:00.000Z",
        }),
      },
      onPortableHandoffAccepted: () => shutdown,
      localState,
    });
    try {
      manager.start(claim("0.2.12"));
      await vi.waitFor(() => {
        expect(manager.getStatus().activeSession?.lifecycle.phase).toBe("handoff-pending");
      });
      const durable = localState.readRuntimeState();
      const pending = durable.activeSession;
      if (pending === undefined) throw new TypeError("expected durable handoff session");
      const verifying = {
        ...pending,
        ...transitionUpdateSession(pending, { phase: "verifying-relaunch" }),
      };
      const succeeded = {
        ...verifying,
        ...transitionUpdateSession(verifying, { phase: "succeeded" }),
        message: "Native startup recovery verified the portable handoff.",
      };
      localState.writeRuntimeState({
        ...durable,
        activeSession: undefined,
        activeCandidate: undefined,
        lastSession: succeeded,
        recovery: {
          status: "settled",
          sessionId: succeeded.sessionId,
          updatedAt: "2026-09-05T00:01:00.000Z",
        },
      });
      manager.refreshDurableProjection?.();
      rejectShutdown(new Error("late shutdown failure"));

      await vi.waitFor(() => {
        expect(manager.getStatus().lastSession?.lifecycle.phase).toBe("succeeded");
      });
      expect(manager.getStatus().activeSession).toBeUndefined();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("retains recovery ownership and the session lock when accepted-handoff persistence fails", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "keiko-handoff-persistence-"));
    const delegate = createUpdateLocalStateManager({ stateDir });
    let failWrites = false;
    const lock = new MemoryUpdateSessionLock();
    const localState = {
      ...delegate,
      writeRuntimeState: (
        state: Parameters<typeof delegate.writeRuntimeState>[0],
      ): ReturnType<typeof delegate.writeRuntimeState> => {
        if (failWrites) throw new Error("runtime state unavailable");
        return delegate.writeRuntimeState(state);
      },
    };
    const manager = createTestUpdateSessionManager({
      detector: () => portableMode(),
      facts: () => facts({ packageRoot: "/Users/alice/Applications/Keiko/app" }),
      idFactory: () => "session-1",
      processEnv: { KEIKO_UI_LAUNCH_ID: "d".repeat(32) },
      localState,
      lock,
      portableStager: { stage: vi.fn().mockResolvedValue(portableStageSummary()) },
      portableActivator: {
        activate: vi.fn().mockImplementation(() => {
          failWrites = true;
          return Promise.resolve({
            activationId: "c".repeat(32),
            status: "handoff-pending" as const,
            coordinatorId: "e".repeat(64),
            acceptedAt: "2026-09-05T00:00:00.000Z",
          });
        }),
      },
      onPortableHandoffAccepted: vi.fn().mockResolvedValue(undefined),
    });

    try {
      manager.start(claim("0.2.12"));
      await vi.waitFor(() => {
        expect(manager.getStatus()).toMatchObject({
          persistence: "unwritable",
          activeSession: {
            lifecycle: {
              phase: "recovery-required",
              cancellationCutoff: "handoff-committed",
            },
          },
        });
      });
      expect(lock.isLocked()).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("finishes verified portable activation while remediation remains pending", async () => {
    const completedTargets: string[] = [];
    let phaseDuringCompletionGate: string | undefined;
    const manager = createTestUpdateSessionManager({
      detector: () => portableMode(),
      facts: () => facts({ packageRoot: "/Users/alice/Applications/Keiko/app" }),
      idFactory: () => "session-1",
      portableStager: { stage: vi.fn().mockResolvedValue(portableStageSummary()) },
      portableActivator: { activate: vi.fn().mockResolvedValue(portableActivationSummary()) },
      portableCompletionGate: (session) => {
        completedTargets.push(session.targetVersion);
        phaseDuringCompletionGate = manager.getStatus().activeSession?.phase;
        return false;
      },
    });

    manager.start(claim("0.2.12"));
    await waitForPhase(manager, "succeeded");

    expect(completedTargets).toEqual(["0.2.12"]);
    expect(phaseDuringCompletionGate).toBe("running");
    expect(manager.getStatus().activeSession).toBeUndefined();
    expect(manager.getStatus().lastSession).toMatchObject({
      phase: "succeeded",
      restartRequired: false,
      portableActivation: { activationId: "activation-1", status: "activated" },
      message:
        "Keiko is now running 0.2.12. Complete remaining follow-up action before affected workflows are fully ready.",
    });
  });

  it("rejects portable success without exact target-version activation proof", async () => {
    const manager = createTestUpdateSessionManager({
      detector: portableMode,
      facts: () => facts({ packageRoot: "/Users/alice/Applications/Keiko/app" }),
      portableStager: { stage: vi.fn().mockResolvedValue(portableStageSummary()) },
      portableActivator: {
        activate: vi.fn().mockResolvedValue({
          ...portableActivationSummary(),
          versionVerified: false,
        }),
      },
    });

    manager.start(claim("0.2.12"));
    await waitForPhase(manager, "failed");
    expect(manager.getStatus().lastSession).toMatchObject({
      phase: "failed",
      failureReason: "portable-version-verification-failed",
    });
  });

  it("enforces monotonic same-phase progress and terminal transition finality", () => {
    const gate = deferred();
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      beforeExecute: () => gate.promise,
    });
    const base = manager.start(claim("0.2.12")).session;
    const advanced = {
      ...base,
      ...transitionUpdateSession(base, {
        phase: "preparing",
        progress: { completedBytes: 10, totalBytes: 100 },
      }),
    };

    expect(() =>
      transitionUpdateSession(advanced, {
        phase: "preparing",
        progress: { completedBytes: 9, totalBytes: 100 },
      }),
    ).toThrow("cannot regress");
    expect(() => transitionUpdateSession(base, { phase: "succeeded" })).toThrow(
      "Invalid update lifecycle transition",
    );
    expect(() =>
      transitionUpdateSession(
        {
          ...base,
          phase: "succeeded",
          lifecycle: { ...base.lifecycle, phase: "succeeded" },
        },
        { phase: "succeeded", progress: { completedBytes: 10 } },
      ),
    ).toThrow("cannot be repeated");
    gate.resolve();
  });

  it("rejects stale restart verification after a completed portable activation", async () => {
    const manager = createTestUpdateSessionManager({
      detector: () => portableMode(),
      currentVersion: () => "0.2.12",
      facts: () => facts({ packageRoot: "/Users/alice/Applications/Keiko/app" }),
      idFactory: () => "session-1",
      portableStager: { stage: vi.fn().mockResolvedValue(portableStageSummary()) },
      portableActivator: { activate: vi.fn().mockResolvedValue(portableActivationSummary()) },
    });

    manager.start(claim("0.2.12"));
    await waitForPhase(manager, "succeeded");

    expect(() => manager.verifyRestart("0.2.12")).toThrow(UpdateSessionError);
    expect(manager.getStatus().lastSession).toMatchObject({
      targetVersion: "0.2.12",
      phase: "succeeded",
      restartRequired: false,
    });
  });

  it("rejects duplicate and conflicting concurrent starts", () => {
    const gate = deferred();
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      beforeExecute: () => gate.promise,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    manager.start(claim("0.2.12"));
    expect(() => manager.start(claim("0.2.12"))).toThrow(UpdateSessionError);
    expect(() => manager.start(claim("0.2.13"))).toThrow(UpdateSessionError);
    gate.resolve();
  });

  it("reuses the start-time install projection for repeated active status polls", async () => {
    const gate = deferred();
    const detector = vi.fn(() => supportedMode("npm"));
    const manager = createTestUpdateSessionManager({
      detector,
      beforeExecute: () => gate.promise,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    manager.start(claim("0.2.12"));
    expect(detector).toHaveBeenCalledOnce();
    expect(manager.getStatus().installMode.packageManager).toBe("npm");
    expect(manager.getStatus().installMode.packageManager).toBe("npm");
    expect(detector).toHaveBeenCalledOnce();

    gate.resolve();
    await waitForPhase(manager, "restart-required");
    expect(detector).toHaveBeenCalledTimes(2);
  });

  it("keeps idle detection fresh and seeds a new session from the latest mode", () => {
    const gate = deferred();
    let mode = supportedMode("npm");
    const detector = vi.fn(() => mode);
    const manager = createTestUpdateSessionManager({
      detector,
      beforeExecute: () => gate.promise,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    expect(manager.getStatus().installMode.packageManager).toBe("npm");
    mode = supportedMode("yarn");
    expect(manager.getStatus().installMode.packageManager).toBe("yarn");
    manager.start(claim("0.2.12"));
    expect(manager.getStatus().installMode.packageManager).toBe("yarn");
    expect(detector).toHaveBeenCalledTimes(3);
    gate.resolve();
  });

  it("lazily snapshots restored active-session status once", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "keiko-restored-status-mode-"));
    const localState = createUpdateLocalStateManager({ stateDir });
    const first = createTestUpdateSessionManager({
      detector: () => portableMode(),
      facts: () => facts({ packageRoot: "/Users/alice/Applications/Keiko/app" }),
      idFactory: () => "restored-session",
      processEnv: { KEIKO_UI_LAUNCH_ID: "d".repeat(32) },
      portableStager: { stage: vi.fn().mockResolvedValue(portableStageSummary()) },
      portableActivator: {
        activate: vi.fn().mockResolvedValue({
          activationId: "c".repeat(32),
          status: "handoff-pending" as const,
          coordinatorId: "e".repeat(64),
          acceptedAt: "2026-09-05T00:00:00.000Z",
        }),
      },
      onPortableHandoffAccepted: vi.fn().mockResolvedValue(undefined),
      localState,
    });
    try {
      first.start(claim("0.2.12"));
      await vi.waitFor(() => {
        expect(first.getStatus().activeSession?.lifecycle.phase).toBe("handoff-pending");
      });
      const detector = vi.fn(() => portableMode());
      const restored = createTestUpdateSessionManager({ detector, localState });

      expect(detector).not.toHaveBeenCalled();
      expect(restored.getStatus().activeSession?.sessionId).toBe("restored-session");
      expect(restored.getStatus().installMode.installKind).toBe("portable-managed");
      expect(detector).toHaveBeenCalledOnce();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("re-detects install drift at execution even while active status uses its snapshot", async () => {
    const gate = deferred();
    let mode = supportedMode("npm");
    const detector = vi.fn(() => mode);
    const runCommandImpl = vi.fn<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>();
    const manager = createTestUpdateSessionManager({
      detector,
      beforeExecute: () => gate.promise,
      runCommandImpl,
    });

    manager.start(claim("0.2.12"));
    expect(manager.getStatus().installMode.packageManager).toBe("npm");
    expect(detector).toHaveBeenCalledOnce();
    mode = supportedMode("yarn");
    gate.resolve();
    await vi.waitFor(() => {
      expect(detector).toHaveBeenCalledTimes(2);
    });

    expect(runCommandImpl).not.toHaveBeenCalled();
    expect(manager.getStatus().lastSession).toMatchObject({
      phase: "failed",
      failureReason: "unsupported-install-mode",
    });
  });

  it.each([
    ["package manager", (): UpdateInstallMode => supportedMode("yarn"), false],
    [
      "global install root",
      (): UpdateInstallMode =>
        detectUpdateInstallMode(
          facts({ packageRoot: "/opt/lib/node_modules/@oscharko-dev/keiko" }),
        ),
      false,
    ],
    ["portable installation", (): UpdateInstallMode => portableMode(), false],
    ["running version", (): UpdateInstallMode => supportedMode(), true],
  ] as const)(
    "settles the accepted candidate without mutation when the %s changes behind the execution gate",
    async (_label, changedMode, changeVersion) => {
      const stateDir = await mkdtemp(join(tmpdir(), "keiko-candidate-revalidation-"));
      const gate = deferred();
      let mode = supportedMode();
      let currentVersion = "0.2.11";
      const runCommandImpl = vi.fn<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>();
      const stage = vi.fn<PortableUpdateStager["stage"]>();
      const activate = vi.fn<PortableUpdateActivator["activate"]>();
      const lock = new MemoryUpdateSessionLock();
      const localState = createUpdateLocalStateManager({ stateDir });
      const manager = createTestUpdateSessionManager({
        detector: () => mode,
        currentVersion: () => currentVersion,
        beforeExecute: () => gate.promise,
        runCommandImpl,
        portableStager: { stage },
        portableActivator: { activate },
        lock,
        localState,
      });

      manager.start(claim("0.2.12"));
      mode = changedMode();
      if (changeVersion) currentVersion = "0.2.10";
      gate.resolve();
      await waitForPhase(manager, "failed");

      expect(runCommandImpl).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
      expect(lock.isLocked()).toBe(false);
      const status = manager.getStatus();
      expect(status.activeSession).toBeUndefined();
      expect(status).toMatchObject({
        lastSession: {
          phase: "failed",
          failureReason: "unsupported-install-mode",
          retryable: false,
          restartRequired: false,
        },
      });
      expect(status.lastSession?.message).toMatch(/changed after review/u);
      expect(localState.readRuntimeState()).toMatchObject({
        lastSession: {
          sessionId: status.lastSession?.sessionId,
          phase: "failed",
          failureReason: "unsupported-install-mode",
        },
      });
      await rm(stateDir, { recursive: true, force: true });
    },
  );

  it("revalidates a portable candidate's hashed install facts before staging", async () => {
    const gate = deferred();
    let mode = portableMode();
    const runCommandImpl = vi.fn<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>();
    const stage = vi.fn<PortableUpdateStager["stage"]>();
    const activate = vi.fn<PortableUpdateActivator["activate"]>();
    const manager = createTestUpdateSessionManager({
      detector: () => mode,
      currentVersion: () => "0.2.11",
      beforeExecute: () => gate.promise,
      runCommandImpl,
      portableStager: { stage },
      portableActivator: { activate },
    });

    manager.start(claim("0.2.12"));
    mode = {
      ...mode,
      portable: mode.portable === undefined ? undefined : { ...mode.portable, stable: false },
    };
    gate.resolve();
    await waitForPhase(manager, "failed");

    expect(runCommandImpl).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(manager.getStatus().lastSession).toMatchObject({
      phase: "failed",
      failureReason: "portable-preflight-ineligible",
      retryable: false,
    });
  });

  it("allows cancellation before package-manager execution starts only", async () => {
    const gate = deferred();
    const runCommandImpl = vi.fn<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>();
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      beforeExecute: () => gate.promise,
      runCommandImpl,
    });

    manager.start(claim("0.2.12"));
    const cancelled = manager.cancel();
    gate.resolve();
    await vi.waitFor(() => {
      expect(runCommandImpl).not.toHaveBeenCalled();
    });

    expect(cancelled.phase).toBe("cancelled");
    expect(manager.getStatus().lastSession?.phase).toBe("cancelled");
  });

  it("rejects cancellation once package mutation is running", async () => {
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      runCommandImpl: (input) => {
        return new Promise<CommandResult>((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => {
              reject(new CommandCancelledError("command cancelled"));
            },
            {
              once: true,
            },
          );
        });
      },
    });

    manager.start(claim("0.2.12"));
    await waitForPhase(manager, "running");

    expect(() => manager.cancel()).toThrow(UpdateSessionError);
    expect(manager.getStatus().activeSession).toMatchObject({
      phase: "running",
      cancelable: false,
    });
  });

  it("does not misrepresent a committed update as cancelled while restart is pending", async () => {
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      runCommandImpl: () => Promise.resolve(commandResult()),
    });
    manager.start(claim("0.2.12"));
    await waitForPhase(manager, "restart-required");
    expect(manager.getStatus().activeSession?.phase).toBe("restart-required");

    expect(() => manager.cancel()).toThrow(UpdateSessionError);
    expect(manager.getStatus().activeSession).toMatchObject({
      phase: "restart-required",
      restartRequired: true,
      cancelable: false,
    });
  });

  it("uses a durable lock to block overlapping package mutation across managers", async () => {
    const lock = new MemoryUpdateSessionLock();
    const running = deferred();
    const first = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      lock,
      runCommandImpl: async () => {
        await running.promise;
        return commandResult();
      },
    });
    const second = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      lock,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    first.start(claim("0.2.12"));
    await waitForPhase(first, "running");

    expect(() => second.start(claim("0.2.13"))).toThrow(UpdateSessionError);
    running.resolve();
    await waitForPhase(first, "restart-required");
    expect(second.start(claim("0.2.13")).session.phase).toBe("preparing");
  });

  it("recovers a stale file lock left by a dead process", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-update-lock-"));
    try {
      const now = Date.parse("2026-06-30T00:10:00.000Z");
      const lockPath = join(tempDir, "update.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          sessionId: "stale",
          targetVersion: "0.2.10",
          startedAt: "2026-06-30T00:00:00.000Z",
          pid: 999_999,
        })}\n`,
        { mode: 0o600 },
      );
      const lock = createFileUpdateSessionLock(lockPath, {
        staleMs: 1_000,
        now: () => now,
        pidAlive: () => false,
      });
      const manager = createTestUpdateSessionManager({
        detector: () => supportedMode(),
        lock,
        runCommandImpl: () => Promise.resolve(commandResult()),
      });

      expect(manager.start(claim("0.2.12")).session.phase).toBe("preparing");
      await waitForPhase(manager, "restart-required");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recovers a stale lock from a prior process instance that reused the same pid", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-update-lock-reused-parent-pid-"));
    try {
      const lockPath = join(tempDir, "update.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          sessionId: "stale-container-session",
          targetVersion: "0.2.10",
          startedAt: "2026-06-30T00:00:00.000Z",
          pid: process.pid,
          processIdentity: "prior-container-process",
        })}\n`,
        { mode: 0o600 },
      );
      const lock = createFileUpdateSessionLock(lockPath, {
        staleMs: 1_000,
        now: () => Date.parse("2026-06-30T00:00:02.000Z"),
        pidAlive: (pid) => pid === process.pid,
        processIdentity: "replacement-container-process",
      });

      expect(lock.isLocked()).toBe(false);
      expect(lock.acquire(lockRecord("replacement-session"))).toBe(true);
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
        processIdentity: "replacement-container-process",
      });
      lock.release("replacement-session");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("quarantines a corrupt file lock and starts a new update", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-update-lock-corrupt-"));
    try {
      const now = Date.parse("2026-06-30T00:10:00.000Z");
      const lockPath = join(tempDir, "update.lock");
      await writeFile(lockPath, "{not-json", { mode: 0o600 });
      const lock = createFileUpdateSessionLock(lockPath, {
        staleMs: 10_000,
        now: () => now,
        pidAlive: () => true,
      });
      const manager = createTestUpdateSessionManager({
        detector: () => supportedMode(),
        lock,
        runCommandImpl: () => Promise.resolve(commandResult()),
      });

      expect(lock.isLocked()).toBe(false);
      expect(manager.start(claim("0.2.12")).session.phase).toBe("preparing");
      await waitForPhase(manager, "restart-required");
      const entries = await readdir(tempDir);
      expect(entries.some((entry) => entry.startsWith("update.lock.corrupt."))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a fresh file lock after its owner dies so child metadata can be published", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-update-lock-dead-"));
    try {
      const now = Date.parse("2026-06-30T00:00:01.000Z");
      const lockPath = join(tempDir, "update.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          sessionId: "dead",
          targetVersion: "0.2.10",
          startedAt: "2026-06-30T00:00:00.000Z",
          pid: 999_999,
        })}\n`,
        { mode: 0o600 },
      );
      const lock = createFileUpdateSessionLock(lockPath, {
        staleMs: 10 * 60_000,
        now: () => now,
        pidAlive: () => false,
      });
      const manager = createTestUpdateSessionManager({
        detector: () => supportedMode(),
        lock,
        runCommandImpl: () => Promise.resolve(commandResult()),
      });

      expect(lock.isLocked()).toBe(true);
      expect(() => manager.start(claim("0.2.12"))).toThrow(
        expect.objectContaining({ code: "UPDATE_SESSION_ACTIVE" }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses a restarted server while the detached mutation child is still alive", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-update-lock-child-"));
    try {
      const lockPath = join(tempDir, "update.lock");
      const childPid = 43_210;
      const lockOptions = {
        staleMs: 10 * 60_000,
        now: (): number => Date.parse("2026-06-30T01:00:00.000Z"),
        pidAlive: (pid: number): boolean => pid === childPid,
      };
      const firstLock = createFileUpdateSessionLock(lockPath, lockOptions);
      const spawned = deferred();
      let settle!: (result: CommandResult) => void;
      const running = new Promise<CommandResult>((resolve) => {
        settle = resolve;
      });
      const first = createTestUpdateSessionManager({
        detector: () => supportedMode(),
        lock: firstLock,
        runCommandImpl: (input) => {
          input.onSpawn?.(childPid);
          spawned.resolve();
          return running;
        },
      });
      first.start(claim("0.2.12"));
      await spawned.promise;
      const authority = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      expect(authority).not.toHaveProperty("childPid");
      const childSidecar = (await readdir(tempDir)).find((entry) => entry.endsWith(".child"));
      expect(childSidecar).toBeDefined();
      const childAuthority = JSON.parse(
        await readFile(join(tempDir, childSidecar ?? "missing-child-sidecar"), "utf8"),
      ) as Record<string, unknown>;
      expect(childAuthority).toMatchObject({
        sessionId: authority.sessionId,
        childPid,
      });
      expect(childAuthority.lockIdentity).toEqual(expect.any(String));

      const restarted = createTestUpdateSessionManager({
        detector: () => supportedMode(),
        lock: createFileUpdateSessionLock(lockPath, lockOptions),
        runCommandImpl: () => Promise.resolve(commandResult()),
      });
      expect(() => restarted.start(claim("0.2.13"))).toThrow(
        expect.objectContaining({ code: "UPDATE_SESSION_ACTIVE" }),
      );

      settle(commandResult());
      await waitForPhase(first, "restart-required");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not attach a child sidecar to a reused session id with different lock ownership", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-update-lock-identity-"));
    try {
      const lockPath = join(tempDir, "update.lock");
      const lock = createFileUpdateSessionLock(lockPath, {
        pidAlive: (pid) => pid === 43_210,
      });
      expect(lock.acquire(lockRecord("reused-session"))).toBe(true);
      expect(lock.updateChildPid("reused-session", 43_210)).toBe(true);
      await writeFile(
        lockPath,
        `${JSON.stringify({
          ...lockRecord("reused-session"),
          targetVersion: "0.2.13",
          startedAt: "2026-07-01T00:00:00.000Z",
          pid: 999_999,
        })}\n`,
        { mode: 0o600 },
      );

      expect(lock.isLocked()).toBe(false);
      expect(lock.acquire(lockRecord("replacement-session"))).toBe(true);
      expect((await readdir(tempDir)).filter((name) => name.endsWith(".child"))).toEqual([]);
      lock.release("replacement-session");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes the session child sidecar when the authoritative lock is already absent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-update-lock-orphaned-sidecar-"));
    try {
      const lockPath = join(tempDir, "update.lock");
      const lock = createFileUpdateSessionLock(lockPath);
      expect(lock.acquire(lockRecord("released-session"))).toBe(true);
      expect(lock.updateChildPid("released-session", 43_210)).toBe(true);
      await unlink(lockPath);

      lock.release("released-session");

      expect((await readdir(tempDir)).filter((name) => name.endsWith(".child"))).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when child-PID metadata cannot be published", async () => {
    const authority = new MemoryUpdateSessionLock();
    const lock: UpdateSessionLock = {
      isLocked: authority.isLocked,
      acquire: authority.acquire,
      updateChildPid: () => false,
      release: authority.release,
    };
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      lock,
      runCommandImpl: (input) => {
        input.onSpawn?.(43_210);
        return Promise.resolve(commandResult());
      },
    });

    manager.start(claim("0.2.12"));

    await waitForPhase(manager, "failed");
  });

  it("keeps child-PID-only lock ownership after the parent disappears", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-update-lock-reused-child-pid-"));
    try {
      const lockPath = join(tempDir, "update.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          sessionId: "abandoned",
          targetVersion: "0.2.10",
          startedAt: "2026-06-30T00:00:00.000Z",
          pid: 111,
          childPid: 222,
        })}\n`,
        { mode: 0o600 },
      );
      const lock = createFileUpdateSessionLock(lockPath, {
        staleMs: 1_000,
        now: () => Date.parse("2026-06-30T00:00:02.000Z"),
        pidAlive: (pid) => pid === 222,
      });

      expect(lock.isLocked()).toBe(true);
      expect(lock.acquire(lockRecord("replacement"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a stale pre-spawn lock while its server parent remains alive", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-update-lock-live-parent-"));
    try {
      const lockPath = join(tempDir, "update.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          sessionId: "live-parent",
          targetVersion: "0.2.10",
          startedAt: "2026-06-30T00:00:00.000Z",
          pid: 111,
        })}\n`,
        { mode: 0o600 },
      );
      const lock = createFileUpdateSessionLock(lockPath, {
        staleMs: 1_000,
        now: () => Date.parse("2026-06-30T00:00:02.001Z"),
        pidAlive: (pid) => pid === 111,
      });

      expect(lock.isLocked()).toBe(true);
      expect(lock.acquire(lockRecord("replacement"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recovers a stale pre-spawn lock after its server parent dies", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-update-lock-dead-parent-"));
    try {
      const lockPath = join(tempDir, "update.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          sessionId: "dead-parent",
          targetVersion: "0.2.10",
          startedAt: "2026-06-30T00:00:00.000Z",
          pid: 111,
        })}\n`,
        { mode: 0o600 },
      );
      const lock = createFileUpdateSessionLock(lockPath, {
        staleMs: 1_000,
        now: () => Date.parse("2026-06-30T00:00:02.001Z"),
        pidAlive: () => false,
      });

      expect(lock.isLocked()).toBe(false);
      expect(lock.acquire(lockRecord("replacement"))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a live installer child non-reclaimable beyond two stale windows", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-update-lock-expired-child-pid-"));
    try {
      const lockPath = join(tempDir, "update.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          sessionId: "abandoned",
          targetVersion: "0.2.10",
          startedAt: "2026-06-30T00:00:00.000Z",
          pid: 111,
          childPid: 222,
        })}\n`,
        { mode: 0o600 },
      );
      const lock = createFileUpdateSessionLock(lockPath, {
        staleMs: 1_000,
        now: () => Date.parse("2026-06-30T00:10:00.000Z"),
        pidAlive: (pid) => pid === 222,
      });

      expect(lock.isLocked()).toBe(true);
      expect(lock.acquire(lockRecord("replacement"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("namespaces file locks under the Keiko state directory", async () => {
    const firstStateDir = await mkdtemp(join(tmpdir(), "keiko-update-state-a-"));
    const secondStateDir = await mkdtemp(join(tmpdir(), "keiko-update-state-b-"));
    try {
      const liveLockOptions = {
        now: (): number => Date.parse("2026-06-30T00:00:01.000Z"),
        pidAlive: (): boolean => true,
      };
      const first = createStateDirUpdateSessionLock(firstStateDir, liveLockOptions);
      const second = createStateDirUpdateSessionLock(secondStateDir, liveLockOptions);

      expect(updateSessionLockPath(firstStateDir)).toBe(
        join(firstStateDir, "updates", "update-session.lock"),
      );
      expect(first.acquire(lockRecord("first"))).toBe(true);
      expect(first.isLocked()).toBe(true);
      expect(second.acquire(lockRecord("second"))).toBe(true);
      expect(second.isLocked()).toBe(true);
    } finally {
      await Promise.all([
        rm(firstStateDir, { recursive: true, force: true }),
        rm(secondStateDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects restart verification while an update is still preparing", () => {
    const gate = deferred();
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      beforeExecute: () => gate.promise,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    manager.start(claim("0.2.12"));

    expect(() => manager.verifyRestart("0.2.12")).toThrow(UpdateSessionError);
    expect(manager.getStatus().activeSession?.phase).toBe("preparing");
    expect(manager.getStatus().lastSession).toBeUndefined();
    gate.resolve();
  });

  it("rejects restart verification while package mutation is running", async () => {
    const running = deferred();
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      runCommandImpl: async () => {
        await running.promise;
        return commandResult();
      },
    });

    manager.start(claim("0.2.12"));
    await waitForPhase(manager, "running");

    expect(() => manager.verifyRestart("0.2.12")).toThrow(UpdateSessionError);
    expect(manager.getStatus().activeSession?.phase).toBe("running");
    expect(manager.getStatus().lastSession).toBeUndefined();
    running.resolve();
    await waitForPhase(manager, "restart-required");
  });

  it("requires a fresh preflight claim before retrying a package-manager failure", async () => {
    const results = [
      commandResult({ exitCode: 1, stderr: "registry unavailable" }),
      commandResult(),
    ];
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      runCommandImpl: () => Promise.resolve(results.shift() ?? commandResult()),
    });

    manager.start(claim("0.2.12"));
    await vi.waitFor(() => {
      expect(manager.getStatus().lastSession?.retryable).toBe(true);
    });
    expect(() => manager.retry()).toThrow(UpdateSessionError);
  });

  it("does not treat install success as complete until restart verification matches", async () => {
    let currentVersion = "0.2.11";
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      currentVersion: () => currentVersion,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    manager.start(claim("0.2.12"));
    await waitForPhase(manager, "restart-required");
    expect(manager.verifyRestart("0.2.12")).toMatchObject({
      phase: "restart-required",
      failureReason: "restart-version-mismatch",
      restartRequired: true,
      message: "Restart not detected yet. Run the restart command, then try Verify restart again.",
    });

    const second = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      currentVersion: () => currentVersion,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });
    second.start(claim("0.2.12"));
    await waitForPhase(second, "restart-required");
    currentVersion = "0.2.12";
    expect(second.verifyRestart("0.2.12").phase).toBe("succeeded");
  });

  it("does not fabricate restart success without a durable or in-memory session", () => {
    const manager = createTestUpdateSessionManager({
      currentVersion: () => "0.2.12",
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    expect(() => manager.verifyRestart("0.2.12")).toThrow(UpdateSessionError);
  });

  it("reports lifecycle activity sink failures through bounded diagnostics", async () => {
    const record = vi.fn();
    const manager = createTestUpdateSessionManager({
      detector: () => supportedMode(),
      runCommandImpl: () => Promise.resolve(commandResult()),
      activityLog: {
        write(): void {
          throw new Error("activity unavailable");
        },
      },
      diagnostics: { record },
    });

    manager.start({ ...claim("0.2.12"), requestId: "request-3405-0123456789abcdef" });
    await waitForPhase(manager, "restart-required");

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "request-3405-0123456789abcdef",
        operation: "update.session.activity-log",
        source: "update-session",
      }),
    );
  });
});
