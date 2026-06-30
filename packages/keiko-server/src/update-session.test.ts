import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "@oscharko-dev/keiko-tools";
import type { UpdateInstallMode } from "@oscharko-dev/keiko-contracts";
import {
  createUpdateSessionManager,
  UpdateSessionError,
  type UpdateSessionManagerOptions,
} from "./update-session.js";
import { detectUpdateInstallMode, type UpdateRuntimeFacts } from "./update-install-mode.js";
import {
  createFileUpdateSessionLock,
  type UpdateSessionLock,
  type UpdateSessionLockRecord,
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

  it("refuses cancellation once package mutation is running", async () => {
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

    expect(() => manager.cancel()).toThrow(UpdateSessionError);
    running.resolve();
    await waitForPhase(manager, "restart-required");
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
    const results = [commandResult({ exitCode: 1, stderr: "registry unavailable" }), commandResult()];
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
    expect(manager.verifyRestart("0.2.12").failureReason).toBe("restart-version-mismatch");

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
