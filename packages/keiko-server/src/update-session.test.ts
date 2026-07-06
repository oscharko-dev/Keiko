import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CommandCancelledError, type CommandResult } from "@oscharko-dev/keiko-tools";
import type { UpdateInstallMode } from "@oscharko-dev/keiko-contracts";
import {
  createUpdateSessionManager,
  UpdateSessionError,
  type UpdateSessionManagerOptions,
} from "./update-session.js";
import type { PortableUpdateStager } from "./update-portable-staging.js";
import { detectUpdateInstallMode, type UpdateRuntimeFacts } from "./update-install-mode.js";
import {
  createFileUpdateSessionLock,
  createStateDirUpdateSessionLock,
  type UpdateSessionLock,
  type UpdateSessionLockRecord,
  updateSessionLockPath,
} from "./update-session-lock.js";

const ROOT = "/usr/local/lib/node_modules/@oscharko-dev/keiko";

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
  it("refuses mutation when enterprise policy disables updates", () => {
    const runCommandImpl = vi.fn<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>();
    const manager = createUpdateSessionManager({
      processEnv: { KEIKO_UPDATE_MUTATION_DISABLED: "true" },
      detector: () => supportedMode(),
      runCommandImpl,
    });

    expect(() => manager.start({ targetVersion: "0.2.12" })).toThrow(UpdateSessionError);
    expect(runCommandImpl).not.toHaveBeenCalled();
  });

  it("runs npm through the governed command boundary and waits for restart", async () => {
    const calls: Parameters<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>[0][] = [];
    const manager = createUpdateSessionManager({
      detector: () => supportedMode("npm"),
      runCommandImpl: (input) => {
        calls.push(input);
        return Promise.resolve(commandResult({ stdout: "installed token=SECRET" }));
      },
      redactor: (value) => value.replace("SECRET", "[REDACTED]"),
    });

    const started = manager.start({ targetVersion: "0.2.12" });

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
    const manager = createUpdateSessionManager({
      processEnv: {
        KEIKO_UI_PORT: "1990",
        KEIKO_UI_HOST: "127.0.0.1",
        KEIKO_STATE_DIR: "/tmp/keiko update state",
      },
      detector: () => supportedMode("npm"),
      beforeExecute: () => Promise.race([]),
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    const started = manager.start({ targetVersion: "0.2.12" });

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
    const manager = createUpdateSessionManager({
      processEnv: { KEIKO_UI_PORT: "1990" },
      detector: () => supportedMode("npm"),
      beforeExecute: () => Promise.race([]),
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    const started = manager.start({ targetVersion: "0.2.12" });

    expect(started.session.restartCommandPreview).toBeUndefined();
  });

  it("runs Yarn through equivalent governed argv", async () => {
    const calls: Parameters<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>[0][] = [];
    const manager = createUpdateSessionManager({
      detector: () => supportedMode("yarn"),
      runCommandImpl: (input) => {
        calls.push(input);
        return Promise.resolve(commandResult());
      },
    });

    manager.start({ targetVersion: "0.2.12" });
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
    const stage = vi.fn<PortableUpdateStager["stage"]>().mockResolvedValue({
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
    });
    const portableStager: PortableUpdateStager = {
      stage,
    };
    const manager = createUpdateSessionManager({
      detector: () => portableMode(),
      facts: () => facts({ packageRoot: "/Users/alice/Applications/Keiko/app" }),
      idFactory: () => "session-1",
      portableStager,
      runCommandImpl,
    });

    const started = manager.start({ targetVersion: "0.2.12" });
    await waitForPhase(manager, "succeeded");

    expect(started.session.commandPreview).toBeUndefined();
    expect(runCommandImpl).not.toHaveBeenCalled();
    const stageInput = stage.mock.calls[0]?.[0];
    expect(stageInput?.sessionId).toBe("session-1");
    expect(stageInput?.targetVersion).toBe("0.2.12");
    expect(stageInput?.installMode.installKind).toBe("portable-managed");
    expect(stageInput?.runtimeFacts?.packageRoot).toBe("/Users/alice/Applications/Keiko/app");
    expect(manager.getStatus().lastSession).toMatchObject({
      phase: "succeeded",
      restartRequired: false,
      portableStage: { stageId: "stage-1", status: "staged" },
    });
  });

  it("attaches duplicate starts and rejects conflicting concurrent starts", () => {
    const gate = deferred();
    const manager = createUpdateSessionManager({
      detector: () => supportedMode(),
      beforeExecute: () => gate.promise,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    const first = manager.start({ targetVersion: "0.2.12" });
    const duplicate = manager.start({ targetVersion: "0.2.12" });

    expect(duplicate.reused).toBe(true);
    expect(duplicate.session.sessionId).toBe(first.session.sessionId);
    expect(() => manager.start({ targetVersion: "0.2.13" })).toThrow(UpdateSessionError);
    gate.resolve();
  });

  it("allows cancellation before package-manager execution starts only", async () => {
    const gate = deferred();
    const runCommandImpl = vi.fn<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>();
    const manager = createUpdateSessionManager({
      detector: () => supportedMode(),
      beforeExecute: () => gate.promise,
      runCommandImpl,
    });

    manager.start({ targetVersion: "0.2.12" });
    const cancelled = manager.cancel();
    gate.resolve();
    await vi.waitFor(() => {
      expect(runCommandImpl).not.toHaveBeenCalled();
    });

    expect(cancelled.phase).toBe("cancelled");
    expect(manager.getStatus().lastSession?.phase).toBe("cancelled");
  });

  it("aborts cancellation requests once package mutation is running", async () => {
    const aborted = deferred();
    const manager = createUpdateSessionManager({
      detector: () => supportedMode(),
      runCommandImpl: (input) => {
        return new Promise<CommandResult>((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new CommandCancelledError("command cancelled"));
            },
            { once: true },
          );
        });
      },
    });

    manager.start({ targetVersion: "0.2.12" });
    await waitForPhase(manager, "running");

    const requested = manager.cancel();

    expect(requested.phase).toBe("running");
    expect(requested.cancelable).toBe(false);
    expect(requested.message).toBe(
      "Cancellation requested. Waiting for the update operation to stop.",
    );
    await aborted.promise;
    await waitForPhase(manager, "cancelled");
    expect(manager.getStatus().lastSession).toMatchObject({
      phase: "cancelled",
      failureReason: "cancelled",
      retryable: false,
    });
  });

  it("uses a durable lock to block overlapping package mutation across managers", async () => {
    const lock = new MemoryUpdateSessionLock();
    const running = deferred();
    const first = createUpdateSessionManager({
      detector: () => supportedMode(),
      lock,
      runCommandImpl: async () => {
        await running.promise;
        return commandResult();
      },
    });
    const second = createUpdateSessionManager({
      detector: () => supportedMode(),
      lock,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    first.start({ targetVersion: "0.2.12" });
    await waitForPhase(first, "running");

    expect(() => second.start({ targetVersion: "0.2.13" })).toThrow(UpdateSessionError);
    running.resolve();
    await waitForPhase(first, "restart-required");
    expect(second.start({ targetVersion: "0.2.13" }).session.phase).toBe("preparing");
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
      const manager = createUpdateSessionManager({
        detector: () => supportedMode(),
        lock,
        runCommandImpl: () => Promise.resolve(commandResult()),
      });

      expect(manager.start({ targetVersion: "0.2.12" }).session.phase).toBe("preparing");
      await waitForPhase(manager, "restart-required");
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
      const manager = createUpdateSessionManager({
        detector: () => supportedMode(),
        lock,
        runCommandImpl: () => Promise.resolve(commandResult()),
      });

      expect(lock.isLocked()).toBe(false);
      expect(manager.start({ targetVersion: "0.2.12" }).session.phase).toBe("preparing");
      await waitForPhase(manager, "restart-required");
      const entries = await readdir(tempDir);
      expect(entries.some((entry) => entry.startsWith("update.lock.corrupt."))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recovers a file lock from a dead process before the stale timeout", async () => {
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
      const manager = createUpdateSessionManager({
        detector: () => supportedMode(),
        lock,
        runCommandImpl: () => Promise.resolve(commandResult()),
      });

      expect(lock.isLocked()).toBe(false);
      expect(manager.start({ targetVersion: "0.2.12" }).session.phase).toBe("preparing");
      await waitForPhase(manager, "restart-required");
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
    const manager = createUpdateSessionManager({
      detector: () => supportedMode(),
      beforeExecute: () => gate.promise,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    manager.start({ targetVersion: "0.2.12" });

    expect(() => manager.verifyRestart("0.2.12")).toThrow(UpdateSessionError);
    expect(manager.getStatus().activeSession?.phase).toBe("preparing");
    expect(manager.getStatus().lastSession).toBeUndefined();
    gate.resolve();
  });

  it("rejects restart verification while package mutation is running", async () => {
    const running = deferred();
    const manager = createUpdateSessionManager({
      detector: () => supportedMode(),
      runCommandImpl: async () => {
        await running.promise;
        return commandResult();
      },
    });

    manager.start({ targetVersion: "0.2.12" });
    await waitForPhase(manager, "running");

    expect(() => manager.verifyRestart("0.2.12")).toThrow(UpdateSessionError);
    expect(manager.getStatus().activeSession?.phase).toBe("running");
    expect(manager.getStatus().lastSession).toBeUndefined();
    running.resolve();
    await waitForPhase(manager, "restart-required");
  });

  it("retries safe package-manager failures", async () => {
    const results = [
      commandResult({ exitCode: 1, stderr: "registry unavailable" }),
      commandResult(),
    ];
    const manager = createUpdateSessionManager({
      detector: () => supportedMode(),
      runCommandImpl: () => Promise.resolve(results.shift() ?? commandResult()),
    });

    manager.start({ targetVersion: "0.2.12" });
    await vi.waitFor(() => {
      expect(manager.getStatus().lastSession?.retryable).toBe(true);
    });
    manager.retry();
    await waitForPhase(manager, "restart-required");
  });

  it("does not treat install success as complete until restart verification matches", async () => {
    let currentVersion = "0.2.11";
    const manager = createUpdateSessionManager({
      detector: () => supportedMode(),
      currentVersion: () => currentVersion,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    manager.start({ targetVersion: "0.2.12" });
    await waitForPhase(manager, "restart-required");
    expect(manager.verifyRestart("0.2.12")).toMatchObject({
      phase: "restart-required",
      failureReason: "restart-version-mismatch",
      restartRequired: true,
      message: "Restart not detected yet. Run the restart command, then try Verify restart again.",
    });

    const second = createUpdateSessionManager({
      detector: () => supportedMode(),
      currentVersion: () => currentVersion,
      runCommandImpl: () => Promise.resolve(commandResult()),
    });
    second.start({ targetVersion: "0.2.12" });
    await waitForPhase(second, "restart-required");
    currentVersion = "0.2.12";
    expect(second.verifyRestart("0.2.12").phase).toBe("succeeded");
  });

  it("verifies an explicit target after a relaunch with no in-memory session", () => {
    const manager = createUpdateSessionManager({
      currentVersion: () => "0.2.12",
      runCommandImpl: () => Promise.resolve(commandResult()),
    });

    expect(manager.verifyRestart("0.2.12")).toMatchObject({
      phase: "succeeded",
      targetVersion: "0.2.12",
    });
  });
});
