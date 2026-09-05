import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWindowsTerminationCapacity,
  createWindowsTaskkillBudget,
  nodeSpawnFn,
  nodeWindowsTreeKill,
  nodeWindowsTreeKillWith,
  runCommand,
  windowsTaskkillInvocation,
  type CommandTerminationEvidence,
  type HomeProvider,
  type RunCommandDeps,
  type WindowsTaskkillBudget,
  type WindowsTreeKillResult,
} from "./exec.js";
import { WindowsSystemBinaryMissingError, WindowsSystemDirectoryError } from "./windows-shell.js";
import { CommandCancelledError, CommandDeniedError, CommandTimeoutError } from "./errors.js";
import { PathEscapeError, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  DEFAULT_COMMAND_RULES,
  DEFAULT_ENV_ALLOWLIST,
  DEFAULT_SANDBOX_POLICY,
  type CommandRule,
  type SandboxPolicy,
} from "./types.js";
import { makeFakeChild, makeWorkspace, recordingSpawn } from "./_support.js";

let root: string;
let info: WorkspaceInfo;

const NODE_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  { executable: "node" },
  ...DEFAULT_COMMAND_RULES,
]);
function windowsSystemRootFixture(offHostRoot: string): string {
  if (process.platform !== "win32") return offHostRoot;
  return process.env.SystemRoot ?? process.env.WINDIR ?? String.raw`C:\Windows`;
}

function expectedWindowsSystemBinary(selectedRoot: string, binaryName: string): string {
  return `${selectedRoot}\\System32\\${binaryName}`;
}

beforeEach(() => {
  ({ root, info } = makeWorkspace());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeDeps(
  spawnFn: RunCommandDeps["spawn"],
  processEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" },
): RunCommandDeps {
  return {
    workspace: info,
    policy: DEFAULT_SANDBOX_POLICY,
    commandRules: NODE_COMMAND_RULES,
    spawn: spawnFn,
    processEnv,
    now: () => 0,
  };
}

function realDeps(processEnv: NodeJS.ProcessEnv): RunCommandDeps {
  return {
    workspace: info,
    policy: { ...DEFAULT_SANDBOX_POLICY, defaultTimeoutMs: 10_000 },
    commandRules: NODE_COMMAND_RULES,
    spawn: nodeSpawnFn,
    processEnv,
    now: () => Date.now(),
  };
}

function controller(): AbortController {
  return new AbortController();
}

interface HomeRecorder {
  readonly provider: HomeProvider;
  readonly made: () => readonly string[];
  readonly cleaned: () => readonly string[];
}

// A HomeProvider that creates REAL empty temp dirs (so the env.HOME assertions check a real,
// existing, empty directory) and records every make()/cleanup(dir) so a test can assert the
// ephemeral home was created exactly once and removed on every settle path.
function recordingHome(): HomeRecorder {
  const made: string[] = [];
  const cleaned: string[] = [];
  return {
    made: () => made,
    cleaned: () => cleaned,
    provider: {
      make: (): string => {
        const dir = mkdtempSync(join(tmpdir(), "keiko-home-test-"));
        made.push(dir);
        return dir;
      },
      cleanup: (dir): void => {
        cleaned.push(dir);
        rmSync(dir, { recursive: true, force: true });
      },
    },
  };
}

interface KillRecorder {
  readonly groupSignals: { pid: number; signal: string | number | undefined }[];
  restore: () => void;
}

// Stubs process.kill so a fake pid does not raise ESRCH against an unrelated real process, and
// records every (pid, signal) so a test can assert the process GROUP was signalled on POSIX.
function captureKills(): KillRecorder {
  const groupSignals: { pid: number; signal: string | number | undefined }[] = [];
  const original = process.kill.bind(process);
  process.kill = (pid: number, signal?: string | number): true => {
    groupSignals.push({ pid, signal });
    return true;
  };
  return {
    groupSignals,
    restore: (): void => {
      process.kill = original;
    },
  };
}

// Asserts the child was terminated, regardless of platform: POSIX kills the process GROUP via
// process.kill(-pid, …); Windows falls back to child.kill().
function expectTerminated(kills: KillRecorder, child: { killed: string[] }): void {
  const groupKilled = kills.groupSignals.some((c) => c.pid < 0 && c.signal === "SIGTERM");
  expect(groupKilled || child.killed.includes("SIGTERM")).toBe(true);
}

describe("runCommand — allowlist guard (before spawn)", () => {
  it("reports the live child pid immediately after spawn", async () => {
    const spawn = recordingSpawn();
    const seen: number[] = [];
    const pending = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
        onSpawn: (pid): void => {
          seen.push(pid);
        },
      },
      fakeDeps(spawn.fn),
    );

    expect(seen).toEqual([spawn.child.pid]);
    spawn.child.emit("close", 0, null);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
  });

  it("continues safely when the spawned child does not expose a pid", async () => {
    const spawn = recordingSpawn();
    spawn.child.pid = undefined;
    const onSpawn = vi.fn();
    const pending = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
        onSpawn,
      },
      fakeDeps(spawn.fn),
    );

    spawn.child.emit("close", 0, null);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("retains ownership until a child is terminated when the spawn callback fails", async () => {
    vi.useFakeTimers();
    const spawn = recordingSpawn();
    const home = recordingHome();
    const kills = captureKills();
    try {
      const pending = runCommand(
        {
          command: "node",
          args: ["-e", "1"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
          onSpawn: (): void => {
            throw new Error("lock write failed");
          },
        },
        { ...fakeDeps(spawn.fn), home: home.provider },
      );

      expectTerminated(kills, spawn.child);
      expect(home.cleaned()).toEqual([]);
      await vi.advanceTimersByTimeAsync(DEFAULT_SANDBOX_POLICY.terminationGraceMs);
      await vi.runOnlyPendingTimersAsync();
      const groupKilled = kills.groupSignals.some(
        (call) => call.pid < 0 && call.signal === "SIGKILL",
      );
      expect(groupKilled || spawn.child.killed.includes("SIGKILL")).toBe(true);
      expect(home.cleaned()).toEqual([]);

      spawn.child.emit("close", null, "SIGKILL");
      await expect(pending).rejects.toThrow("lock write failed");
      expect(home.cleaned()).toHaveLength(1);
    } finally {
      kills.restore();
      vi.useRealTimers();
    }
  });

  it("rejects a denied command WITHOUT spawning", async () => {
    const spawn = recordingSpawn();
    await expect(
      runCommand(
        {
          command: "rm",
          args: ["-rf", "/"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        fakeDeps(spawn.fn),
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
    expect(spawn.calls()).toHaveLength(0);
  });

  it("rejects git push without spawning", async () => {
    const spawn = recordingSpawn();
    await expect(
      runCommand(
        {
          command: "git",
          args: ["push"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        fakeDeps(spawn.fn),
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
    expect(spawn.calls()).toHaveLength(0);
  });

  it("surfaces a workspace-escape cwd as PathEscapeError (no spawn)", async () => {
    const spawn = recordingSpawn();
    await expect(
      runCommand(
        {
          command: "node",
          args: ["-e", "1"],
          cwd: "../../etc",
          timeoutMs: undefined,
          signal: controller().signal,
        },
        fakeDeps(spawn.fn),
      ),
    ).rejects.toBeInstanceOf(PathEscapeError);
    expect(spawn.calls()).toHaveLength(0);
  });

  it("rejects a PATH-resolved executable inside the workspace without spawning", async () => {
    const bin = join(root, "bin");
    const fakeNode = join(bin, "node");
    mkdirSync(bin, { recursive: true });
    writeFileSync(fakeNode, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(fakeNode, 0o755);
    const spawn = recordingSpawn();
    await expect(
      runCommand(
        {
          command: "node",
          args: ["-e", "1"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        fakeDeps(spawn.fn, { PATH: bin }),
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
    expect(spawn.calls()).toHaveLength(0);
  });

  it("rejects a workspace PATH symlink to an outside executable without spawning", async () => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "node"));
    const spawn = recordingSpawn();
    await expect(
      runCommand(
        {
          command: "node",
          args: ["-e", "1"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        fakeDeps(spawn.fn, { PATH: bin }),
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
    expect(spawn.calls()).toHaveLength(0);
  });
});

describe("runCommand — spawn options (no shell, clean env, detached)", () => {
  it("always spawns with shell:false and a name-allowlisted env (+ ephemeral HOME)", async () => {
    const spawn = recordingSpawn();
    const home = recordingHome();
    const path = process.env.PATH ?? "";
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      {
        ...fakeDeps(spawn.fn, { PATH: path, SECRET_TOKEN: "leak-me-please" }),
        home: home.provider,
      },
    );
    spawn.child.emit("close", 0, null);
    await promise;
    const call = spawn.calls()[0];
    const made = home.made()[0] ?? "";
    expect(call?.options.shell).toBe(false);
    expect(call?.command).not.toBe("node");
    expect(isAbsolute(call?.command ?? "")).toBe(true);
    // PATH is name-copied; the planted secret never reaches the child; HOME/USERPROFILE are the
    // ephemeral dir (C5), so the env is exactly {PATH, HOME, USERPROFILE} — no parent spread.
    expect(call?.options.env).toEqual({ PATH: path, HOME: made, USERPROFILE: made });
    expect("SECRET_TOKEN" in (call?.options.env ?? {})).toBe(false);
  });

  it("passes args verbatim as an array (no interpolation)", async () => {
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["$HOME", "`id`"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      fakeDeps(spawn.fn),
    );
    spawn.child.emit("close", 0, null);
    await promise;
    expect(spawn.calls()[0]?.args).toEqual(["$HOME", "`id`"]);
  });
});

describe("runCommand — timeout & cancellation (fake child)", () => {
  it("refuses a Windows spawn before HOME creation when tree-kill capacity is exhausted", async () => {
    const spawn = recordingSpawn();
    const home = recordingHome();
    const capacity = createWindowsTerminationCapacity(1, () => "succeeded");
    const windowsEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? String.raw`C:\Windows`,
    };
    const held = capacity.reserve(windowsEnv);
    expect(held).toBeDefined();

    await expect(
      runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        {
          ...fakeDeps(spawn.fn, windowsEnv),
          home: home.provider,
          platform: "win32",
          windowsTerminationCapacity: capacity,
        },
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
    expect(spawn.calls()).toEqual([]);
    expect(home.made()).toEqual([]);

    held?.release();
    const admitted = runCommand(
      {
        command: "node",
        args: ["-e", "ok"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      {
        ...fakeDeps(spawn.fn, windowsEnv),
        home: home.provider,
        platform: "win32",
        windowsTerminationCapacity: capacity,
      },
    );
    spawn.child.emit("close", 0, null);
    await expect(admitted).resolves.toMatchObject({ exitCode: 0 });
  });

  it("refuses a Windows spawn when authoritative taskkill is unavailable", async () => {
    const spawn = recordingSpawn();
    const home = recordingHome();
    const capacity = createWindowsTerminationCapacity(
      1,
      () => "succeeded",
      () => {
        throw new WindowsSystemBinaryMissingError();
      },
    );

    await expect(
      runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        {
          ...fakeDeps(spawn.fn),
          home: home.provider,
          platform: "win32",
          windowsTerminationCapacity: capacity,
        },
      ),
    ).rejects.toBeInstanceOf(WindowsSystemBinaryMissingError);
    expect(spawn.calls()).toEqual([]);
    expect(home.made()).toEqual([]);
  });

  it("times out and rejects with CommandTimeoutError", async () => {
    const kills = captureKills();
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: 5,
        signal: controller().signal,
      },
      fakeDeps(spawn.fn),
    );
    // The timer fires terminate() → SIGTERM; emulate the child dying afterwards.
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    expectTerminated(kills, spawn.child);
    kills.restore();
  });

  it("rejects with CommandCancelledError when the signal aborts", async () => {
    const kills = captureKills();
    const ctrl = controller();
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: ctrl.signal,
      },
      fakeDeps(spawn.fn),
    );
    ctrl.abort();
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandCancelledError);
    expectTerminated(kills, spawn.child);
    kills.restore();
  });

  it("rejects when already aborted before spawn settles", async () => {
    const ctrl = controller();
    ctrl.abort();
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: ctrl.signal,
      },
      fakeDeps(spawn.fn),
    );
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandCancelledError);
    expect(spawn.calls()).toHaveLength(0);
  });

  it("rechecks cancellation after preparation and cleans the reserved home without spawning", async () => {
    const ctrl = controller();
    const spawn = recordingSpawn();
    const home = recordingHome();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: ctrl.signal,
      },
      {
        ...fakeDeps(spawn.fn),
        home: {
          make: (): string => {
            const path = home.provider.make();
            ctrl.abort();
            return path;
          },
          cleanup: home.provider.cleanup,
        },
      },
    );
    await expect(promise).rejects.toBeInstanceOf(CommandCancelledError);
    expect(spawn.calls()).toHaveLength(0);
    expect(home.cleaned()).toEqual(home.made());
  });
});

// Reported from a customer's Windows machine: Keiko starts, prints "listening on 127.0.0.1:1983",
// dies with NO error in the log, and a fresh pid repeats the cycle. With the process guards
// installed, a silent death is not an exception — it is an external kill, and taskkill is the one
// the product issues. Windows recycles pids aggressively, so a `taskkill /PID <pid> /T /F` aimed at
// an already-exited child can land on whatever now holds that number, and `/T` takes the whole TREE.
// If that number has come back around to this server or its launcher, the product kills itself, and
// the loop looks exactly like the report.
describe("runCommand — never signals its own or its parent's pid (customer crash loop)", () => {
  it.each([
    ["its own pid", (): number => process.pid],
    ["its parent's pid", (): number => process.ppid],
  ])("refuses to signal %s, and records the near-miss", async (_label, pidOf) => {
    const kills = captureKills();
    const spawn = recordingSpawn(makeFakeChild(pidOf()));
    const evidence: CommandTerminationEvidence[] = [];
    try {
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "flood"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
          onTerminated: (line) => evidence.push(line),
        },
        {
          ...fakeDeps(spawn.fn),
          policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 4 },
        },
      );
      spawn.child.stdout.emit("data", Buffer.from("0123456789", "utf8"));

      // Nothing signalled, by any route: not the POSIX group kill, not the immediate child.
      expect(kills.groupSignals).toEqual([]);
      expect(spawn.child.killed).toEqual([]);
      // The near-miss is RECORDED rather than silent — a stale pid reaching the kill path is a fact
      // an operator needs, and it is the one disposition that is not an environment property.
      expect(evidence[0]?.windowsTreeKill).toBe("refused-self-pid");

      spawn.child.emit("close", 0, null);
      await expect(promise).resolves.toMatchObject({ truncated: true });
    } finally {
      kills.restore();
    }
  });
});

describe("runCommand — no raw-pid signal after the child has exited (reused-pid hazard)", () => {
  // The window this pins: Node releases the child handle at 'exit', but `state.settled` is only set
  // at 'close', and 'data' events keep arriving between the two. An output-cap trigger firing in
  // that gap used to reach `killGroup` with a pid the OS no longer holds reserved — on Windows a
  // `taskkill /PID <pid> /T /F` that can land on an unrelated, reused pid. ADR-0006 D5 declared that
  // hazard unreachable because Node "holds an open handle for the lifetime of the ChildProcess";
  // that is true only until 'exit', which is why the SIGKILL escalation already carried this guard
  // and this path did not.
  it("does not signal when output overflows AFTER the child has exited but before close", async () => {
    const kills = captureKills();
    const spawn = recordingSpawn();
    try {
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "flood"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        {
          ...fakeDeps(spawn.fn),
          policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 4 },
        },
      );
      // The child has exited — Node has released the handle and the pid is no longer reserved —
      // but 'close' has not fired yet, so the run has NOT settled.
      spawn.child.exitCode = 0;
      spawn.child.emit("exit", 0, null);
      // A late chunk overflows the cap and drives terminate() into exactly that window.
      spawn.child.stdout.emit("data", Buffer.from("0123456789", "utf8"));

      expect(kills.groupSignals).toEqual([]);
      expect(spawn.child.killed).toEqual([]);

      spawn.child.emit("close", 0, null);
      await expect(promise).resolves.toMatchObject({ truncated: true });
    } finally {
      kills.restore();
    }
  });
});

describe("runCommand — output flood protection (F12)", () => {
  it("kills the child and flags truncated:true when output exceeds maxOutputBytes", async () => {
    const kills = captureKills();
    const spawn = recordingSpawn();
    // A 4-byte cap so a single chunk overflows it.
    const deps: RunCommandDeps = {
      ...fakeDeps(spawn.fn),
      policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 4 },
    };
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "flood"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      deps,
    );
    // Emit more than the cap → appendCapped signals a flood → terminate() kills the group.
    spawn.child.stdout.emit("data", Buffer.from("0123456789", "utf8"));
    expectTerminated(kills, spawn.child);
    // The child then dies; the result must carry truncated:true and a capped stdout.
    spawn.child.emit("close", null, "SIGTERM");
    const result = await promise;
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe("[TRUNCATED OUTPUT REDACTED]");
    expect(result.stderr).toBe("[TRUNCATED OUTPUT REDACTED]");
    kills.restore();
  });
});

describe("runCommand — omittedByteCount capture (ADR-0054 D5)", () => {
  it("sets a positive omittedByteCount on truncation, bounded by total emitted", async () => {
    const kills = captureKills();
    const spawn = recordingSpawn();
    const deps: RunCommandDeps = {
      ...fakeDeps(spawn.fn),
      policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 4 },
    };
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "flood"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      deps,
    );
    // 6 stdout bytes + 5 stderr bytes = 11 emitted total against a 4-byte cap → 7 dropped.
    spawn.child.stdout.emit("data", Buffer.from("123456", "utf8"));
    spawn.child.stderr.emit("data", Buffer.from("abcde", "utf8"));
    spawn.child.emit("close", null, "SIGTERM");
    const result = await promise;
    expect(result.truncated).toBe(true);
    const totalEmitted = 11;
    // Lower-bound semantics: at least one byte omitted, never more than what arrived.
    expect(result.omittedByteCount).toBeGreaterThanOrEqual(1);
    expect(result.omittedByteCount).toBeLessThanOrEqual(totalEmitted);
    // Exact for a pre-kill arrival: attempted(11) - cap(4) = 7.
    expect(result.omittedByteCount).toBe(7);
    kills.restore();
  });

  it("omits omittedByteCount entirely when the run is not truncated", async () => {
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "ok"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      fakeDeps(spawn.fn),
    );
    spawn.child.stdout.emit("data", Buffer.from("hello", "utf8"));
    spawn.child.emit("close", 0, null);
    const result = await promise;
    expect(result.truncated).toBe(false);
    expect(result.omittedByteCount).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, "omittedByteCount")).toBe(false);
  });

  it("is deterministic: identical fake input yields identical omittedByteCount", async () => {
    const run = async (): Promise<number | undefined> => {
      const kills = captureKills();
      const spawn = recordingSpawn();
      const deps: RunCommandDeps = {
        ...fakeDeps(spawn.fn),
        policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 4 },
      };
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "flood"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        deps,
      );
      spawn.child.stdout.emit("data", Buffer.from("0123456789", "utf8"));
      spawn.child.emit("close", null, "SIGTERM");
      const result = await promise;
      kills.restore();
      return result.omittedByteCount;
    };
    expect(await run()).toBe(await run());
  });
});

describe("runCommand — real node integration", () => {
  it("runs an allowed command and captures stdout with exitCode 0", async () => {
    const result = await runCommand(
      {
        command: "node",
        args: ["-e", "process.stdout.write('hello')"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      realDeps({ PATH: process.env.PATH ?? "" }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.timedOut).toBe(false);
  });

  it("isolates env: a planted secret is ABSENT and PATH is PRESENT in the child", async () => {
    const result = await runCommand(
      {
        command: "node",
        args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      realDeps({ PATH: process.env.PATH ?? "", AWS_SECRET_ACCESS_KEY: "planted-secret-xyz" }),
    );
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(childEnv.PATH).toBeDefined();
  });

  it("C5: the child HOME is a real, existing, EMPTY dir that is NOT the parent's real home", async () => {
    // A real on-disk parent home with a planted credential file, to prove the child does NOT
    // see it. The child reports its own HOME plus whether that dir exists, how many entries it
    // has, and whether the parent's planted ~/.npmrc is reachable from the child HOME.
    const parentHome = mkdtempSync(join(tmpdir(), "keiko-parent-home-"));
    writeFileSync(join(parentHome, ".npmrc"), "//registry/:_authToken=plantedtoken");
    const home = recordingHome();
    try {
      const result = await runCommand(
        {
          command: "node",
          args: [
            "-e",
            "const fs=require('node:fs');const h=process.env.HOME;process.stdout.write(JSON.stringify({h,u:process.env.USERPROFILE,exists:fs.existsSync(h),entries:fs.readdirSync(h).length,npmrc:fs.existsSync(require('node:path').join(h,'.npmrc'))}))",
          ],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        { ...realDeps({ PATH: process.env.PATH ?? "", HOME: parentHome }), home: home.provider },
      );
      const env = JSON.parse(result.stdout) as {
        h: string;
        u?: string;
        exists: boolean;
        entries: number;
        npmrc: boolean;
      };
      // HOME is set (so node/npm work), exists, is empty, and is NOT the parent's real home.
      expect(env.h).not.toBe(parentHome);
      expect(env.h).toBe(home.made()[0]);
      expect(env.exists).toBe(true);
      expect(env.entries).toBe(0);
      // The parent's planted ~/.npmrc credential is NOT reachable from the child HOME.
      expect(env.npmrc).toBe(false);
      // USERPROFILE is redirected to the same ephemeral dir (Windows home lookups also miss).
      expect(env.u).toBe(env.h);
      // The ephemeral home was created exactly once and cleaned up after the command settled.
      expect(home.made()).toHaveLength(1);
      expect(home.cleaned()).toEqual(home.made());
      expect(existsSync(home.made()[0] ?? "")).toBe(false);
    } finally {
      rmSync(parentHome, { recursive: true, force: true });
    }
  });

  it("C5 (unit): the built spawn env.HOME/USERPROFILE point at a real empty dir, never the parent", async () => {
    const home = recordingHome();
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      {
        ...fakeDeps(spawn.fn, {
          PATH: process.env.PATH ?? "",
          HOME: "/Users/parent",
          USERPROFILE: "/Users/parent",
        }),
        home: home.provider,
      },
    );
    spawn.child.emit("close", 0, null);
    await promise;
    const env = spawn.calls()[0]?.options.env ?? {};
    const made = home.made()[0] ?? "";
    expect(env.HOME).toBe(made);
    expect(env.USERPROFILE).toBe(made);
    expect(env.HOME).not.toBe("/Users/parent");
    // The dir was a real empty dir while the command ran, then removed.
    expect(home.cleaned()).toEqual([made]);
    expect(existsSync(made)).toBe(false);
  });

  it("C5: the ephemeral home is cleaned up on the timeout path", async () => {
    const kills = captureKills();
    const home = recordingHome();
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: 5,
        signal: controller().signal,
      },
      { ...fakeDeps(spawn.fn), home: home.provider },
    );
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(home.cleaned()).toEqual(home.made());
    expect(home.made()).toHaveLength(1);
    kills.restore();
  });

  it("C5: the ephemeral home is cleaned up on the cancellation path", async () => {
    const kills = captureKills();
    const ctrl = controller();
    const home = recordingHome();
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: ctrl.signal,
      },
      { ...fakeDeps(spawn.fn), home: home.provider },
    );
    ctrl.abort();
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandCancelledError);
    expect(home.cleaned()).toEqual(home.made());
    kills.restore();
  });

  it("C5: the ephemeral home is cleaned up on the spawn-error path", async () => {
    const home = recordingHome();
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      { ...fakeDeps(spawn.fn), home: home.provider },
    );
    spawn.child.emit("error", new Error("spawn ENOENT"));
    await expect(promise).rejects.toThrow();
    expect(home.cleaned()).toEqual(home.made());
  });

  it("retains the child and HOME after a post-spawn error until close confirms exit", async () => {
    vi.useFakeTimers();
    const home = recordingHome();
    const spawn = recordingSpawn();
    const kills = captureKills();
    const evidence: CommandTerminationEvidence[] = [];
    try {
      const pending = runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
          onTerminated: (event): void => {
            evidence.push(event);
          },
        },
        { ...fakeDeps(spawn.fn), home: home.provider },
      );
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      spawn.child.emit("spawn");
      const runtimeError = new Error("post-spawn transport failure");
      spawn.child.emit("error", runtimeError);
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(home.cleaned()).toEqual([]);
      expect(existsSync(home.made()[0] ?? "")).toBe(true);
      expectTerminated(kills, spawn.child);
      expect(evidence[0]?.reason).toBe("child-process-error");

      await vi.advanceTimersByTimeAsync(DEFAULT_SANDBOX_POLICY.terminationGraceMs);
      await vi.runOnlyPendingTimersAsync();
      const escalated = kills.groupSignals.some(
        (call) => call.pid < 0 && call.signal === "SIGKILL",
      );
      expect(escalated || spawn.child.killed.includes("SIGKILL")).toBe(true);
      expect(settled).toBe(false);
      expect(home.cleaned()).toEqual([]);

      spawn.child.emit("close", null, "SIGKILL");
      await expect(pending).rejects.toBe(runtimeError);
      expect(home.cleaned()).toEqual(home.made());
    } finally {
      kills.restore();
      vi.useRealTimers();
    }
  });

  it("C5: a denied command creates NO ephemeral home (nothing to clean)", async () => {
    const home = recordingHome();
    const spawn = recordingSpawn();
    await expect(
      runCommand(
        {
          command: "rm",
          args: ["-rf", "/"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        { ...fakeDeps(spawn.fn), home: home.provider },
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
    expect(home.made()).toHaveLength(0);
    expect(home.cleaned()).toHaveLength(0);
  });

  it("no-shell: a shell metachar arg is passed literally, not expanded", async () => {
    const result = await runCommand(
      {
        command: "node",
        args: ["-e", "process.stdout.write(process.argv[1] ?? '')", "$HOME"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      realDeps({ PATH: process.env.PATH ?? "", HOME: "/should/not/appear" }),
    );
    expect(result.stdout).toBe("$HOME");
    expect(result.stdout).not.toContain("/should/not/appear");
  });

  it("real cancellation: aborting a long-running child terminates it within the grace bound", async () => {
    const ctrl = controller();
    const started = Date.now();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "setInterval(()=>{}, 1e9)"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: ctrl.signal,
      },
      realDeps({ PATH: process.env.PATH ?? "" }),
    );
    setTimeout(() => {
      ctrl.abort();
    }, 50);
    await expect(promise).rejects.toBeInstanceOf(CommandCancelledError);
    // Terminated well within defaultTimeoutMs; proves no zombie / hang.
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("redacts a planted secret printed to stdout by the child", async () => {
    const result = await runCommand(
      {
        command: "node",
        args: [
          "-e",
          `process.stdout.write(${JSON.stringify("tok=" + ("ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"))})`,
        ],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      realDeps({ PATH: process.env.PATH ?? "" }),
    );
    const ghToken = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"; // split so the literal is not contiguous
    expect(result.stdout).not.toContain(ghToken);
    expect(result.stdout).toContain("[REDACTED]");
  });
});

// `outputScrub: "credentials-only"` narrows the scrub set for the one read whose stdout IS the value
// the caller needs (a configured remote URL). Both halves are pinned end to end through the real
// spawn boundary: a context value the parent carries survives, a credential value still does not.
describe("runCommand — outputScrub: credentials-only", () => {
  function echoDeps(processEnv: NodeJS.ProcessEnv, credentialsOnly: boolean): RunCommandDeps {
    return {
      ...realDeps(processEnv),
      policy: {
        ...DEFAULT_SANDBOX_POLICY,
        defaultTimeoutMs: 10_000,
        ...(credentialsOnly ? { outputScrub: "credentials-only" as const } : {}),
      },
    };
  }

  const echo = (text: string): string => `process.stdout.write(${JSON.stringify(text)})`;

  it("keeps a context value the parent carries in the output", async () => {
    const result = await runCommand(
      {
        command: "node",
        args: ["-e", echo("https://github.com/alicedev-team/App.git")],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      echoDeps(
        { PATH: process.env.PATH ?? "", GITHUB_REPOSITORY: "alicedev-team/App", USER: "alicedev" },
        true,
      ),
    );

    expect(result.stdout).toBe("https://github.com/alicedev-team/App.git");
  });

  it("marks changed output even when secret replacement preserves byte length", async () => {
    const secret = "1234567890";
    const result = await runCommand(
      {
        command: "node",
        args: ["-e", echo(secret)],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      echoDeps({ PATH: process.env.PATH ?? "", API_TOKEN: secret }, true),
    );
    expect(result.stdout.length).toBe(secret.length);
    expect(result.stdout).toBe("[REDACTED]");
    expect(result.outputRedacted).toBe(true);
  });

  it("still redacts a credential value the parent carries", async () => {
    const token = "deploy-tok3n-value-9";
    const result = await runCommand(
      {
        command: "node",
        args: ["-e", echo(`https://github.com/alicedev-team/${token}.git`)],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      echoDeps({ PATH: process.env.PATH ?? "", MY_DEPLOY_TOKEN: token }, true),
    );

    expect(result.stdout).not.toContain(token);
    expect(result.stdout).toContain("[REDACTED]");
  });

  // The contrast that makes the mode necessary: the default policy scrubs the context value too.
  it("is the only mode that lets the context value through", async () => {
    const result = await runCommand(
      {
        command: "node",
        args: ["-e", echo("https://github.com/alicedev-team/App.git")],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      echoDeps({ PATH: process.env.PATH ?? "", GITHUB_REPOSITORY: "alicedev-team/App" }, false),
    );

    expect(result.stdout).toContain("[REDACTED]");
  });
});

describe("runCommand — enforced network egress (ADR-0043, network:'none')", () => {
  const NO_BACKENDS = {
    bubblewrap: false,
    unshare: false,
    seatbelt: false,
    docker: false,
    podman: false,
  } as const;

  // Inject a deterministic resolver so the inner executable AND the isolation wrapper resolve to
  // stable absolute paths regardless of which backend binaries the test host happens to have.
  const absResolver: RunCommandDeps["resolveExecutable"] = (command) => `/abs/${command}`;

  it("wraps the spawn in the enforcing backend and attests enforcement", async () => {
    const spawn = recordingSpawn();
    const deps: RunCommandDeps = {
      ...fakeDeps(spawn.fn),
      policy: { ...DEFAULT_SANDBOX_POLICY, network: "none" },
      resolveExecutable: absResolver,
      sandboxAvailability: { ...NO_BACKENDS, bubblewrap: true },
      platform: "linux",
    };
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      deps,
    );
    spawn.child.emit("close", 0, null);
    const result = await promise;
    const call = spawn.calls()[0];
    expect(call?.command).toBe("/abs/bwrap");
    expect(call?.args).toContain("--unshare-net");
    // The inner executable (absolute) is nested inside the wrapper argv after the `--` separator.
    expect(call?.args).toContain("/abs/node");
    expect(result.attestation).toEqual({
      backend: "bubblewrap",
      networkEnforced: true,
      filesystemEnforced: false,
      platform: "linux",
    });
  });

  it("requests execution-root isolation when the policy requires filesystem containment", async () => {
    const spawn = recordingSpawn();
    const deps: RunCommandDeps = {
      ...fakeDeps(spawn.fn),
      policy: { ...DEFAULT_SANDBOX_POLICY, network: "none", filesystem: "execution-root" },
      resolveExecutable: absResolver,
      sandboxAvailability: { ...NO_BACKENDS, bubblewrap: true },
      platform: "linux",
    };
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      deps,
    );
    spawn.child.emit("close", 0, null);
    const result = await promise;
    const call = spawn.calls()[0];
    expect(call?.args).toEqual(
      expect.arrayContaining(["--bind", realpathSync(root), "/keiko-execution-root"]),
    );
    expect(call?.args).not.toEqual(expect.arrayContaining(["--dev-bind", "/", "/"]));
    expect(result.attestation).toMatchObject({
      networkEnforced: true,
      filesystemEnforced: true,
    });
  });

  it("fails closed (never spawns) when no enforcing backend is available", async () => {
    const spawn = recordingSpawn();
    const deps: RunCommandDeps = {
      ...fakeDeps(spawn.fn),
      policy: { ...DEFAULT_SANDBOX_POLICY, network: "none" },
      resolveExecutable: absResolver,
      sandboxAvailability: NO_BACKENDS,
      platform: "linux",
    };
    await expect(
      runCommand(
        {
          command: "node",
          args: [],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
    expect(spawn.calls()).toHaveLength(0);
  });

  it("leaves an inherited-network run unwrapped and unattested", async () => {
    const spawn = recordingSpawn();
    const deps: RunCommandDeps = {
      ...fakeDeps(spawn.fn),
      resolveExecutable: absResolver,
      sandboxAvailability: { ...NO_BACKENDS, bubblewrap: true },
      platform: "linux",
    };
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      deps,
    );
    spawn.child.emit("close", 0, null);
    const result = await promise;
    expect(spawn.calls()[0]?.command).toBe("/abs/node");
    expect(result.attestation).toBeUndefined();
  });

  // #2951 residual finding: `SandboxPolicy.network` is `NetworkPolicy` ("inherit" | "none"), a
  // narrower type than the long-lived coding-sidecar `NetworkGatewayPolicy` — the two are
  // deliberately NOT unioned (see keiko-contracts/tools.ts). The old `!== "none"` check could not
  // tell a misrouted gateway-shaped object from "inherit": ANY non-"none" value fell onto the
  // fully unconfined path. `as unknown as NetworkPolicy` simulates a value TypeScript would never
  // let a caller construct honestly but that could still reach this boundary at runtime (a stale
  // cast, an `any`-typed adapter, a deserialized policy). Failing-before: with the old
  // `!== "none"` check this ran the command directly on the inherited path and never rejected.
  it("fails closed when a gateway-shaped policy value reaches the general network switch", async () => {
    const spawn = recordingSpawn();
    const misroutedGatewayPolicy = {
      mode: "gateway",
      host: "127.0.0.1",
      port: 1983,
    } as unknown as SandboxPolicy["network"];
    const deps: RunCommandDeps = {
      ...fakeDeps(spawn.fn),
      policy: { ...DEFAULT_SANDBOX_POLICY, network: misroutedGatewayPolicy },
      resolveExecutable: absResolver,
    };
    await expect(
      runCommand(
        {
          command: "node",
          args: ["-e", "1"],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
    expect(spawn.calls()).toHaveLength(0);
  });
});

// ─── The governed credential lane (homeIsolation "inherit" + credentialEnvAllowlist) ───────────
// C5 above stays the default and is unchanged. These cover the SECOND, explicitly declared profile
// the governed git lanes use: without it `git push` / `gh api` cannot authenticate and `git commit`
// cannot see the user's identity or signing configuration.

const CREDENTIAL_LANE_POLICY: SandboxPolicy = {
  ...DEFAULT_SANDBOX_POLICY,
  envAllowlist: [...DEFAULT_ENV_ALLOWLIST, "HOME", "USERPROFILE"],
  credentialEnvAllowlist: ["GH_TOKEN"],
  pinnedEnv: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  homeIsolation: "inherit",
  defaultTimeoutMs: 10_000,
};

function credentialLaneDeps(
  processEnv: NodeJS.ProcessEnv,
  spawnFn: RunCommandDeps["spawn"],
): RunCommandDeps {
  return {
    workspace: info,
    policy: CREDENTIAL_LANE_POLICY,
    commandRules: NODE_COMMAND_RULES,
    spawn: spawnFn,
    processEnv,
    now: () => Date.now(),
  };
}

describe("runCommand — the governed credential lane", () => {
  it("inherits the parent HOME and forwards the declared credential, pins beating inherited", async () => {
    const home = recordingHome();
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      {
        ...credentialLaneDeps(
          {
            PATH: process.env.PATH ?? "",
            HOME: "/Users/parent",
            LC_ALL: "de_DE.UTF-8",
            GH_TOKEN: "gho_lane_token_value",
            AWS_SECRET_ACCESS_KEY: "aws-must-never-be-forwarded",
          },
          spawn.fn,
        ),
        home: home.provider,
      },
    );
    spawn.child.emit("close", 0, null);
    await promise;
    const env = spawn.calls()[0]?.options.env ?? {};
    expect(env.HOME).toBe("/Users/parent");
    expect(env.USERPROFILE).toBe("/Users/parent");
    expect(env.GH_TOKEN).toBe("gho_lane_token_value");
    expect(env.LC_ALL).toBe("C");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // No ephemeral home is created at all when the parent's own home is inherited.
    expect(home.made()).toHaveLength(0);
  });

  it("falls back to the ephemeral empty home when the parent carries no usable HOME", async () => {
    const home = recordingHome();
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      {
        ...credentialLaneDeps({ PATH: process.env.PATH ?? "", HOME: "" }, spawn.fn),
        home: home.provider,
      },
    );
    spawn.child.emit("close", 0, null);
    await promise;
    const env = spawn.calls()[0]?.options.env ?? {};
    expect(home.made()).toHaveLength(1);
    expect(env.HOME).toBe(home.made()[0]);
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(home.cleaned()).toEqual(home.made());
  });

  it("inherits USERPROFILE when HOME is present but empty (Windows-shaped parent)", async () => {
    const home = recordingHome();
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      {
        ...credentialLaneDeps(
          { PATH: process.env.PATH ?? "", HOME: "", USERPROFILE: "C:\\Users\\dev" },
          spawn.fn,
        ),
        home: home.provider,
      },
    );
    spawn.child.emit("close", 0, null);
    await promise;
    const env = spawn.calls()[0]?.options.env ?? {};
    expect(env.HOME).toBe("C:\\Users\\dev");
    expect(env.USERPROFILE).toBe("C:\\Users\\dev");
    expect(home.made()).toHaveLength(0);
  });

  it("scrubs a FORWARDED credential out of the captured output", async () => {
    const token = "gho_forwarded_but_never_reported";
    const result = await runCommand(
      {
        command: "node",
        args: ["-e", "process.stdout.write(process.env.GH_TOKEN ?? 'absent')"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      credentialLaneDeps(
        { PATH: process.env.PATH ?? "", HOME: realpathSync(tmpdir()), GH_TOKEN: token },
        nodeSpawnFn,
      ),
    );
    // The child really received it (so gh/git can authenticate) …
    expect(result.exitCode).toBe(0);
    // … and it still never crosses the boundary into a classifier, an error, or an evidence record.
    expect(result.stdout).not.toContain(token);
    expect(result.stdout).toContain("[REDACTED]");
  });
});

// ─── Windows .cmd/.bat spawn hardening (issue #3350, Node CVE-2024-27980) ──────────────────────
// Since Node's CVE-2024-27980 fix, spawning a `.cmd`/`.bat` path with `shell:false` raises EINVAL
// on Windows. exec.ts's allowlisted-command resolver honours PATHEXT, so a bare `npm` regularly
// resolves to an absolute `...\npm.CMD` — every such run failed closed before this wiring existed.
// The escaping algorithm itself is exhaustively golden-vector tested in windows-shell.test.ts;
// these tests prove only that runCommand's win32 branch actually DELEGATES to it and threads the
// result into deps.spawn — an integration/wiring proof, not a second copy of the escaping proof.
describe("runCommand — Windows .cmd/.bat spawn hardening (issue #3350)", () => {
  const selectedSystemRoot = windowsSystemRootFixture(String.raw`C:\Windows`);
  const WIN_ENV: NodeJS.ProcessEnv = { PATH: "", SystemRoot: selectedSystemRoot };

  // Removal-fails: if the win32 branch in resolveInheritedSpawnTarget/resolveSpawnTarget is ever
  // reverted (or short-circuited back to `{ command: executable, args: input.args, ... }`
  // unconditionally), `call?.command` reverts to the raw `...\npm.cmd` path instead of cmd.exe,
  // `call?.args` reverts to `["ping"]`, and `windowsVerbatimArguments` disappears from the spawn
  // options — every assertion below goes red together.
  it("routes a resolved .cmd executable through the hardened cmd.exe invocation on win32", async () => {
    const spawn = recordingSpawn();
    const npmCmdPath = String.raw`C:\Users\test\AppData\Roaming\npm\npm.cmd`;
    const deps: RunCommandDeps = {
      ...fakeDeps(spawn.fn, WIN_ENV),
      resolveExecutable: () => npmCmdPath,
      platform: "win32",
    };
    const promise = runCommand(
      {
        command: "npm",
        args: ["ping"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      deps,
    );
    spawn.child.emit("close", 0, null);
    await promise;
    const call = spawn.calls()[0];
    expect(call?.command).toBe(expectedWindowsSystemBinary(selectedSystemRoot, "cmd.exe"));
    expect(call?.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"ping^""',
    ]);
    expect(call?.options.windowsVerbatimArguments).toBe(true);
    // The hardened wrapper never flips the shell:false posture — cmd.exe is spawned as a
    // deterministic, fully-escaped argv, never as an interpreter of untrusted shell syntax.
    expect(call?.options.shell).toBe(false);
  });

  it("leaves a resolved .exe executable unwrapped on win32 (git.exe pass-through)", async () => {
    const spawn = recordingSpawn();
    const gitExePath = String.raw`C:\Program Files\Git\cmd\git.exe`;
    const deps: RunCommandDeps = {
      ...fakeDeps(spawn.fn, WIN_ENV),
      resolveExecutable: () => gitExePath,
      platform: "win32",
    };
    const promise = runCommand(
      {
        command: "git",
        args: ["status"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      deps,
    );
    spawn.child.emit("close", 0, null);
    await promise;
    const call = spawn.calls()[0];
    expect(call?.command).toBe(gitExePath);
    expect(call?.args).toEqual(["status"]);
    expect(call?.options.windowsVerbatimArguments).toBeUndefined();
    expect(call?.options.shell).toBe(false);
  });

  it("leaves a resolved .cmd executable unwrapped on a non-win32 platform", async () => {
    const spawn = recordingSpawn();
    const npmCmdPath = String.raw`C:\Users\test\AppData\Roaming\npm\npm.cmd`;
    const deps: RunCommandDeps = {
      ...fakeDeps(spawn.fn, WIN_ENV),
      resolveExecutable: () => npmCmdPath,
      platform: "linux",
    };
    const promise = runCommand(
      {
        command: "npm",
        args: ["ping"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      deps,
    );
    spawn.child.emit("close", 0, null);
    await promise;
    const call = spawn.calls()[0];
    expect(call?.command).toBe(npmCmdPath);
    expect(call?.args).toEqual(["ping"]);
    expect(call?.options.windowsVerbatimArguments).toBeUndefined();
  });

  it("does not disturb the network:'none' sandbox-wrapper branch on win32", async () => {
    const spawn = recordingSpawn();
    const absResolver: RunCommandDeps["resolveExecutable"] = (command) => `/abs/${command}`;
    const deps: RunCommandDeps = {
      ...fakeDeps(spawn.fn, WIN_ENV),
      policy: { ...DEFAULT_SANDBOX_POLICY, network: "none" },
      resolveExecutable: absResolver,
      sandboxAvailability: {
        bubblewrap: false,
        unshare: false,
        seatbelt: false,
        docker: false,
        podman: false,
      },
      platform: "win32",
    };
    await expect(
      runCommand(
        {
          command: "node",
          args: [],
          cwd: undefined,
          timeoutMs: undefined,
          signal: controller().signal,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
    // Fails closed before ever reaching spawn — the Windows cmd-wrapping branch belongs solely to
    // the inherited-network path and must never be consulted here.
    expect(spawn.calls()).toHaveLength(0);
  });
});

// ─── Windows process-tree termination (taskkill /T /F, ADR-0006 D5, PR #3354 review) ───────────
// Before issue #3350's cmd.exe hardening, a `.cmd` target never spawned on win32 at all (EINVAL),
// so the immediate child that killGroup's child.kill() reaches WAS the resolved target. Now the
// immediate child is always cmd.exe and the real work (e.g. node.exe running npm) is a grandchild
// that child.kill() cannot reach — every Windows timeout/abort left it running, holding sockets
// and node_modules locks. These tests force the win32 branch via the existing `platform` seam and
// inject a fake `killWindowsTree` so the tree-kill DECISION is asserted deterministically, without
// spawning a real process tree on this (non-Windows) test host.
describe("runCommand — Windows process-tree termination (taskkill /T /F, ADR-0006 D5)", () => {
  interface TreeKillRecorder {
    readonly calls: () => readonly { pid: number; processEnv: NodeJS.ProcessEnv }[];
    readonly fn: NonNullable<RunCommandDeps["killWindowsTree"]>;
  }

  function recordingTreeKill(): TreeKillRecorder {
    const calls: { pid: number; processEnv: NodeJS.ProcessEnv }[] = [];
    return {
      calls: () => calls,
      fn: (pid, processEnv): WindowsTreeKillResult => {
        calls.push({ pid, processEnv });
        return "succeeded";
      },
    };
  }

  it("bounds the whole process tree on timeout, in addition to killing the immediate child", async () => {
    const spawn = recordingSpawn();
    const treeKill = recordingTreeKill();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: 5,
        signal: controller().signal,
      },
      { ...fakeDeps(spawn.fn), platform: "win32", killWindowsTree: treeKill.fn },
    );
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    // Prompt settlement: the new tree-kill machinery must not stall runCommand's promise.
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(treeKill.calls()).toHaveLength(1);
    expect(treeKill.calls()[0]?.pid).toBe(spawn.child.pid);
    // The immediate-child kill this PR shipped before is preserved, not replaced.
    expect(spawn.child.killed).toContain("SIGTERM");
  });

  // ORDERING PIN. `child.kill()` is TerminateProcess and takes effect immediately, while
  // `taskkill /PID <pid> /T` resolves the descendant set from the LIVE process table when it runs.
  // If the immediate child were signalled first, taskkill would find no such pid, terminate no
  // descendant, and — Windows does not reparent orphans — the node.exe grandchild would survive the
  // very timeout this exists to bound. Asserting only "tree kill was called" cannot catch that.
  it("kills the Windows tree BEFORE signalling the immediate child", async () => {
    const spawn = recordingSpawn();
    const order: string[] = [];
    const originalKill = spawn.child.kill.bind(spawn.child);
    spawn.child.kill = (signal?: NodeJS.Signals): boolean => {
      order.push("child.kill");
      return originalKill(signal);
    };
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: 5,
        signal: controller().signal,
      },
      {
        ...fakeDeps(spawn.fn),
        platform: "win32",
        killWindowsTree: () => {
          order.push("treeKill");
          return "succeeded";
        },
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);

    expect(order.indexOf("treeKill")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("child.kill")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("treeKill")).toBeLessThan(order.indexOf("child.kill"));
  });

  it("bounds the whole process tree on abort, in addition to killing the immediate child", async () => {
    const ctrl = controller();
    const spawn = recordingSpawn();
    const treeKill = recordingTreeKill();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: ctrl.signal,
      },
      { ...fakeDeps(spawn.fn), platform: "win32", killWindowsTree: treeKill.fn },
    );
    ctrl.abort();
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandCancelledError);
    expect(treeKill.calls()).toHaveLength(1);
    expect(treeKill.calls()[0]?.pid).toBe(spawn.child.pid);
  });

  it("never invokes the Windows tree-kill on POSIX", async () => {
    const kills = captureKills();
    const spawn = recordingSpawn();
    const treeKill = recordingTreeKill();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: 5,
        signal: controller().signal,
      },
      { ...fakeDeps(spawn.fn), platform: "linux", killWindowsTree: treeKill.fn },
    );
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(treeKill.calls()).toHaveLength(0);
    expectTerminated(kills, spawn.child);
    kills.restore();
  });

  it("stays idempotent and settles the promise even when the injected tree-kill throws", async () => {
    const spawn = recordingSpawn();
    const throwingTreeKill: RunCommandDeps["killWindowsTree"] = () => {
      throw new Error("taskkill exploded");
    };
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: 5,
        signal: controller().signal,
      },
      { ...fakeDeps(spawn.fn), platform: "win32", killWindowsTree: throwingTreeKill },
    );
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    // The seam's own throw must never propagate out of runCommand — the promise settles exactly
    // as it would with a well-behaved tree-kill (termination stays idempotent, per killGroup).
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
  });

  it("bounds the tree again on the SIGKILL grace escalation, not only the initial SIGTERM step", async () => {
    vi.useFakeTimers();
    const spawn = recordingSpawn();
    const treeKill = recordingTreeKill();
    try {
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: 5,
          signal: controller().signal,
        },
        { ...fakeDeps(spawn.fn), platform: "win32", killWindowsTree: treeKill.fn },
      );
      await vi.advanceTimersByTimeAsync(5); // fires the timeout -> terminate() SIGTERM step
      expect(treeKill.calls()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(DEFAULT_SANDBOX_POLICY.terminationGraceMs); // SIGKILL step
      await vi.runOnlyPendingTimersAsync(); // check-phase ownership recheck
      expect(treeKill.calls()).toHaveLength(2);
      spawn.child.emit("close", null, "SIGKILL");
      await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms the SIGKILL grace deadline before the synchronous Windows tree-kill begins", async () => {
    vi.useFakeTimers();
    const spawn = recordingSpawn();
    let graceTimerWasArmed = false;
    try {
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: 5,
          signal: controller().signal,
        },
        {
          ...fakeDeps(spawn.fn),
          platform: "win32",
          killWindowsTree: () => {
            graceTimerWasArmed = vi.getTimerCount() > 0;
            return "succeeded";
          },
        },
      );
      await vi.advanceTimersByTimeAsync(5);
      expect(graceTimerWasArmed).toBe(true);
      spawn.child.emit("close", null, "SIGTERM");
      await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes an exit queued during synchronous taskkill before escalating a raw pid", async () => {
    vi.useFakeTimers();
    const spawn = recordingSpawn();
    const treeKill = recordingTreeKill();
    try {
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: 5,
          signal: controller().signal,
        },
        {
          ...fakeDeps(spawn.fn),
          platform: "win32",
          policy: { ...DEFAULT_SANDBOX_POLICY, terminationGraceMs: 0 },
          killWindowsTree: (pid, env) => {
            const disposition = treeKill.fn(pid, env);
            if (treeKill.calls().length === 1) {
              setImmediate(() => {
                spawn.child.exitCode = 0;
                spawn.child.emit("exit", 0, null);
              });
            }
            return disposition;
          },
        },
      );

      await vi.advanceTimersByTimeAsync(5);
      expect(treeKill.calls()).toHaveLength(1);
      expect(spawn.child.killed).toEqual(["SIGTERM"]);

      spawn.child.emit("close", 0, null);
      await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  // AGENTS.md §8: the escalation must be reconstructible from the log. It runs ONLY when the child
  // ignored SIGTERM — the case where a failed tree-kill matters most — and it previously discarded
  // its own disposition, so the log recorded nothing about the step that mattered.
  it("emits a second evidence line for the SIGKILL escalation, carrying its own disposition", async () => {
    vi.useFakeTimers();
    const spawn = recordingSpawn();
    const evidence: CommandTerminationEvidence[] = [];
    try {
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: 5,
          signal: controller().signal,
          onTerminated: (line) => evidence.push(line),
        },
        {
          ...fakeDeps(spawn.fn),
          platform: "win32",
          // The escalation's tree-kill FAILS while the first one succeeds, so the two lines cannot
          // be confused for each other and a copied-through value would be visible.
          killWindowsTree: (() => {
            let call = 0;
            return (): WindowsTreeKillResult => (++call === 1 ? "succeeded" : "failed");
          })(),
        },
      );
      await vi.advanceTimersByTimeAsync(5);
      expect(evidence).toHaveLength(1);
      // The SIGTERM line must carry NO escalation key at all, not an undefined one.
      expect(Object.hasOwn(evidence[0] ?? {}, "escalation")).toBe(false);
      expect(evidence[0]?.windowsTreeKill).toBe("succeeded");

      await vi.advanceTimersByTimeAsync(DEFAULT_SANDBOX_POLICY.terminationGraceMs);
      await vi.runOnlyPendingTimersAsync();
      expect(evidence).toHaveLength(2);
      expect(evidence[1]?.escalation).toBe("failed");
      expect(evidence[1]?.reason).toBe(evidence[0]?.reason);

      spawn.child.emit("close", null, "SIGKILL");
      await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── onTerminated — body-free termination evidence seam ─────────────────────────────────────────
// A PR reviewer finding (AGENTS.md §8 Rule 1): the win32 taskkill.exe tree-kill decision above
// shipped with NO activity-log evidence anywhere, so a support bundle could never answer whether
// it engaged. `onTerminated` mirrors the existing `onSpawn` seam so a caller with a log port
// (keiko-server) can record the decision; keiko-tools itself stays logging-agnostic.
// Review 5058544058/5058571583 on PR #3354: competing termination triggers each re-signalled the
// tree and re-armed the grace timer, overwriting the tracked handle — cleanup() then cleared only
// the LAST timer, and the ORPHANED earlier one fired `taskkill /T /F` against a raw pid AFTER the
// run had settled (reproduced upstream at t+405 against a settle at t+263). terminate() is now
// single-flight: the first trigger wins, competing triggers are disarmed, exactly one grace timer
// exists, and the escalation is guarded on the child still being alive.
describe("runCommand — single-flight termination (first trigger wins)", () => {
  interface TreeKillCallRecord {
    readonly pid: number;
  }

  function recordingTree(): {
    calls: () => readonly TreeKillCallRecord[];
    fn: NonNullable<RunCommandDeps["killWindowsTree"]>;
  } {
    const calls: TreeKillCallRecord[] = [];
    return {
      calls: () => calls,
      fn: (pid): WindowsTreeKillResult => {
        calls.push({ pid });
        return "succeeded";
      },
    };
  }

  it("abort after timeout neither re-kills nor re-reports — and the rejection stays CommandTimeoutError", async () => {
    vi.useFakeTimers();
    try {
      const spawn = recordingSpawn();
      const tree = recordingTree();
      const ctrl = controller();
      const seen: CommandTerminationEvidence[] = [];
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: 100,
          signal: ctrl.signal,
          onTerminated: (e): void => {
            seen.push(e);
          },
        },
        {
          ...fakeDeps(spawn.fn),
          platform: "win32",
          killWindowsTree: tree.fn,
          policy: { ...DEFAULT_SANDBOX_POLICY, terminationGraceMs: 300 },
        },
      );
      await vi.advanceTimersByTimeAsync(100); // timeout wins
      ctrl.abort(); // competing trigger — must be a no-op
      await vi.advanceTimersByTimeAsync(60);
      spawn.child.emit("close", null, "SIGTERM"); // settles
      // Attach the rejection handler BEFORE advancing further: leaving the just-rejected `promise`
      // unhandled across another `await` lets Node's unhandled-rejection detector fire before this
      // test's own `.rejects` attaches, which fails the run despite every assertion passing.
      await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
      // Run PAST the original grace deadline: an orphaned timer would tree-kill here.
      await vi.advanceTimersByTimeAsync(400);
      expect(tree.calls()).toHaveLength(1);
      expect(seen.map((e) => e.reason)).toEqual(["timeout"]);
      expect(spawn.child.killed).toEqual(["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a timeout firing after an abort cannot rewrite the rejection into CommandTimeoutError", async () => {
    vi.useFakeTimers();
    try {
      const spawn = recordingSpawn();
      const tree = recordingTree();
      const ctrl = controller();
      const seen: CommandTerminationEvidence[] = [];
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: 100,
          signal: ctrl.signal,
          onTerminated: (e): void => {
            seen.push(e);
          },
        },
        { ...fakeDeps(spawn.fn), platform: "win32", killWindowsTree: tree.fn },
      );
      ctrl.abort(); // abort wins first
      await vi.advanceTimersByTimeAsync(150); // the timeout timer must have been disarmed
      spawn.child.emit("close", null, "SIGTERM");
      await expect(promise).rejects.toBeInstanceOf(CommandCancelledError);
      expect(tree.calls()).toHaveLength(1);
      expect(seen.map((e) => e.reason)).toEqual(["abort"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("output-cap followed by the timeout stays a single termination with reason output-cap", async () => {
    vi.useFakeTimers();
    try {
      const spawn = recordingSpawn();
      const tree = recordingTree();
      const seen: CommandTerminationEvidence[] = [];
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "flood"],
          cwd: undefined,
          timeoutMs: 100,
          signal: controller().signal,
          onTerminated: (e): void => {
            seen.push(e);
          },
        },
        {
          ...fakeDeps(spawn.fn),
          platform: "win32",
          killWindowsTree: tree.fn,
          policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 4 },
        },
      );
      spawn.child.stdout.emit("data", Buffer.from("0123456789", "utf8")); // cap trips first
      await vi.advanceTimersByTimeAsync(150); // the disarmed timeout must not re-enter
      spawn.child.emit("close", null, "SIGTERM");
      const result = await promise; // output-cap resolves with a truncated result, never a timeout
      expect(result.truncated).toBe(true);
      expect(tree.calls()).toHaveLength(1);
      expect(seen.map((e) => e.reason)).toEqual(["output-cap"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a spawn-callback termination is exclusive — no timer is ever armed to race against it", async () => {
    // NOT a competing-trigger race: runSpawnedChild's onSpawn try/catch calls terminate() and
    // RETURNS before armTimersAndAbort ever runs, so neither the timeout timer nor the abort
    // listener is armed when onSpawn throws — there is structurally nothing left that COULD fire
    // a second trigger through those two paths. This pins that exclusivity itself (advancing past
    // the nominal timeoutMs proves no timer was scheduled); the guard's actual cross-trigger proof
    // for spawn-callback-error is the output-cap test right below, since wireStreams' data
    // listeners — unlike the timer/abort — are wired unconditionally and so remain a real,
    // reachable competing trigger.
    vi.useFakeTimers();
    try {
      const spawn = recordingSpawn();
      const tree = recordingTree();
      const seen: CommandTerminationEvidence[] = [];
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "1"],
          cwd: undefined,
          timeoutMs: 50,
          signal: controller().signal,
          onSpawn: (): void => {
            throw new Error("lock write failed");
          },
          onTerminated: (e): void => {
            seen.push(e);
          },
        },
        { ...fakeDeps(spawn.fn), platform: "win32", killWindowsTree: tree.fn },
      );
      await vi.advanceTimersByTimeAsync(120); // past timeoutMs: nothing fires, because nothing was armed
      spawn.child.emit("close", null, "SIGTERM");
      await expect(promise).rejects.toThrow("lock write failed");
      expect(tree.calls()).toHaveLength(1);
      expect(seen.map((e) => e.reason)).toEqual(["spawn-callback-error"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("output-cap arriving AFTER a spawn-callback termination cannot re-enter (the single-flight guard itself)", async () => {
    // The REAL competing trigger against spawn-callback-error: wireStreams attaches the
    // stdout/stderr data listeners before the onSpawn try/catch runs, so — unlike the timeout
    // timer and the abort listener, which the test above shows are never armed on this path — a
    // late output flood still reaches terminate() after the spawn callback already set the
    // terminal cause. Reverting terminate() to the pre-fix shape (no guard, no disarm) turns this
    // red: the flood would re-signal the tree and re-report a second (wrong) evidence line.
    const spawn = recordingSpawn();
    const tree = recordingTree();
    const seen: CommandTerminationEvidence[] = [];
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: 50,
        signal: controller().signal,
        onSpawn: (): void => {
          throw new Error("lock write failed");
        },
        onTerminated: (e): void => {
          seen.push(e);
        },
      },
      {
        ...fakeDeps(spawn.fn),
        platform: "win32",
        killWindowsTree: tree.fn,
        policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 4 },
      },
    );
    spawn.child.stdout.emit("data", Buffer.from("0123456789", "utf8")); // must not re-enter terminate()
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toThrow("lock write failed");
    expect(tree.calls()).toHaveLength(1);
    expect(seen.map((e) => e.reason)).toEqual(["spawn-callback-error"]);
  });

  it("the grace escalation is a no-op when the child has EXITED but the run has not settled yet", async () => {
    // exit precedes close while stdio drains; SIGKILL/taskkill against that raw pid is the
    // reused-pid hazard the escalation guard exists for.
    vi.useFakeTimers();
    try {
      const spawn = recordingSpawn();
      const tree = recordingTree();
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: 50,
          signal: controller().signal,
        },
        {
          ...fakeDeps(spawn.fn),
          platform: "win32",
          killWindowsTree: tree.fn,
          policy: { ...DEFAULT_SANDBOX_POLICY, terminationGraceMs: 100 },
        },
      );
      await vi.advanceTimersByTimeAsync(50); // timeout → SIGTERM + tree kill
      (spawn.child as unknown as { exitCode: number | null }).exitCode = 1; // exited, close pending
      await vi.advanceTimersByTimeAsync(200); // grace deadline passes before close
      expect(tree.calls()).toHaveLength(1); // no escalation against the exited pid
      expect(spawn.child.killed).toEqual(["SIGTERM"]);
      spawn.child.emit("close", 1, null);
      await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the grace-timer escalation is a no-op once the run has settled (no raw-pid kill after settle)", async () => {
    vi.useFakeTimers();
    try {
      const spawn = recordingSpawn();
      const tree = recordingTree();
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: 50,
          signal: controller().signal,
        },
        {
          ...fakeDeps(spawn.fn),
          platform: "win32",
          killWindowsTree: tree.fn,
          policy: { ...DEFAULT_SANDBOX_POLICY, terminationGraceMs: 200 },
        },
      );
      await vi.advanceTimersByTimeAsync(50); // timeout → SIGTERM + tree kill
      spawn.child.emit("close", null, "SIGTERM"); // child exits well inside the grace window
      await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
      await vi.advanceTimersByTimeAsync(500); // grace deadline passes AFTER settle
      expect(tree.calls()).toHaveLength(1); // no second, post-settle tree kill
      expect(spawn.child.killed).toEqual(["SIGTERM"]); // and no SIGKILL against a gone child
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runCommand — onTerminated evidence seam (AGENTS.md §8 Rule 1)", () => {
  interface EvidenceRecorder {
    readonly calls: () => readonly CommandTerminationEvidence[];
    readonly onTerminated: (evidence: CommandTerminationEvidence) => void;
  }

  function recordingEvidence(): EvidenceRecorder {
    const calls: CommandTerminationEvidence[] = [];
    return {
      calls: () => calls,
      onTerminated: (evidence): void => {
        calls.push(evidence);
      },
    };
  }

  it("reports reason:'timeout' with no Windows tree-kill attempted on POSIX", async () => {
    const spawn = recordingSpawn();
    const evidence = recordingEvidence();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: 5,
        signal: controller().signal,
        onTerminated: evidence.onTerminated,
      },
      { ...fakeDeps(spawn.fn), platform: "linux" },
    );
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(evidence.calls()).toEqual([
      { reason: "timeout", childPid: spawn.child.pid, windowsTreeKill: "not-attempted" },
    ]);
  });

  it("reports reason:'abort'", async () => {
    const ctrl = controller();
    const spawn = recordingSpawn();
    const evidence = recordingEvidence();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: ctrl.signal,
        onTerminated: evidence.onTerminated,
      },
      { ...fakeDeps(spawn.fn), platform: "linux" },
    );
    ctrl.abort();
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandCancelledError);
    expect(evidence.calls()).toHaveLength(1);
    expect(evidence.calls()[0]?.reason).toBe("abort");
  });

  it("reports reason:'output-cap' when the flood cap kills the child", async () => {
    const spawn = recordingSpawn();
    const evidence = recordingEvidence();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "flood"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
        onTerminated: evidence.onTerminated,
      },
      {
        ...fakeDeps(spawn.fn),
        platform: "linux",
        policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 4 },
      },
    );
    spawn.child.stdout.emit("data", Buffer.from("0123456789", "utf8"));
    spawn.child.emit("close", null, "SIGTERM");
    await promise;
    expect(evidence.calls()).toHaveLength(1);
    expect(evidence.calls()[0]?.reason).toBe("output-cap");
  });

  it("reports reason:'spawn-callback-error' when the onSpawn seam throws", async () => {
    const spawn = recordingSpawn();
    const evidence = recordingEvidence();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
        onSpawn: (): void => {
          throw new Error("lock write failed");
        },
        onTerminated: evidence.onTerminated,
      },
      { ...fakeDeps(spawn.fn), platform: "linux" },
    );
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toThrow("lock write failed");
    expect(evidence.calls()).toHaveLength(1);
    expect(evidence.calls()[0]?.reason).toBe("spawn-callback-error");
  });

  it("reports the tree-kill's VERIFIED result on win32 — succeeded means taskkill said so", async () => {
    const spawn = recordingSpawn();
    const evidence = recordingEvidence();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: 5,
        signal: controller().signal,
        onTerminated: evidence.onTerminated,
      },
      { ...fakeDeps(spawn.fn), platform: "win32", killWindowsTree: () => "succeeded" },
    );
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(evidence.calls()).toEqual([
      { reason: "timeout", childPid: spawn.child.pid, windowsTreeKill: "succeeded" },
    ]);
  });

  // A real taskkill failure must be reported as one — the tautology the review pinned was that the
  // default implementation could never produce anything but success.
  it.each(["failed", "unknown"] as const)(
    "reports the tree-kill's VERIFIED result on win32 — %s passes through unchanged",
    async (result) => {
      const spawn = recordingSpawn();
      const evidence = recordingEvidence();
      const promise = runCommand(
        {
          command: "node",
          args: ["-e", "wait"],
          cwd: undefined,
          timeoutMs: 5,
          signal: controller().signal,
          onTerminated: evidence.onTerminated,
        },
        { ...fakeDeps(spawn.fn), platform: "win32", killWindowsTree: () => result },
      );
      await new Promise((r) => setTimeout(r, 20));
      spawn.child.emit("close", null, "SIGTERM");
      await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
      expect(evidence.calls()).toEqual([
        { reason: "timeout", childPid: spawn.child.pid, windowsTreeKill: result },
      ]);
    },
  );

  it("reports windowsTreeKill:'failed' when the injected tree-kill throws — and still never breaks termination", async () => {
    const spawn = recordingSpawn();
    const evidence = recordingEvidence();
    const throwingTreeKill: RunCommandDeps["killWindowsTree"] = () => {
      throw new Error("taskkill exploded");
    };
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: 5,
        signal: controller().signal,
        onTerminated: evidence.onTerminated,
      },
      { ...fakeDeps(spawn.fn), platform: "win32", killWindowsTree: throwingTreeKill },
    );
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(evidence.calls()).toEqual([
      { reason: "timeout", childPid: spawn.child.pid, windowsTreeKill: "failed" },
    ]);
  });

  it("never breaks termination when the onTerminated callback itself throws", async () => {
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: 5,
        signal: controller().signal,
        onTerminated: (): void => {
          throw new Error("evidence sink exploded");
        },
      },
      { ...fakeDeps(spawn.fn), platform: "linux" },
    );
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    // The seam's own throw must never propagate out of runCommand — same idempotent-termination
    // contract the tree-kill seam itself already holds.
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
  });

  it("terminates normally with no onTerminated callback wired at all", async () => {
    const spawn = recordingSpawn();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "wait"],
        cwd: undefined,
        timeoutMs: 5,
        signal: controller().signal,
      },
      { ...fakeDeps(spawn.fn), platform: "linux" },
    );
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
  });
});

// ─── windowsTaskkillInvocation — validated taskkill.exe resolution (never PATH) ─────────────────
// A workspace- or PATH-planted `taskkill.exe`, or an attacker-controlled SystemRoot/WINDIR (a UNC
// share, a relative value), must never become the binary an allowlisted command's process tree is
// torn down through — mirrors how windows-shell.ts resolves cmd.exe.
describe("windowsTaskkillInvocation — validated system-directory resolution", () => {
  it("resolves taskkill.exe under a trusted, drive-absolute SystemRoot", () => {
    const systemRoot = windowsSystemRootFixture(String.raw`C:\Windows`);
    const invocation = windowsTaskkillInvocation(4242, { SystemRoot: systemRoot });
    expect(invocation.command).toBe(expectedWindowsSystemBinary(systemRoot, "taskkill.exe"));
    expect(invocation.args).toEqual(["/PID", "4242", "/T", "/F"]);
  });

  it("falls back to WINDIR when SystemRoot is absent", () => {
    const windir =
      process.platform === "win32"
        ? (process.env.WINDIR ?? process.env.SystemRoot ?? String.raw`C:\Windows`)
        : String.raw`D:\WinDir`;
    const invocation = windowsTaskkillInvocation(7, { WINDIR: windir });
    expect(invocation.command).toBe(expectedWindowsSystemBinary(windir, "taskkill.exe"));
  });

  // Fails CLOSED rather than substituting a default: an invalid override says the environment is
  // misconfigured or hostile, and quietly falling back would let that same environment defeat the
  // check on a machine where the default itself was tampered with. nodeWindowsTreeKill (below) is
  // what turns this into a best-effort no-op, so termination stays idempotent.
  it.each([
    ["a UNC value (planted-share defence)", String.raw`\\attacker\share`],
    ["a device path", String.raw`\\?\C:\Windows`],
    ["a root-relative value", String.raw`\Windows`],
    ["a bare relative value", "Windows"],
    ["an empty value", ""],
    ["a traversal segment", String.raw`C:\Windows\..\Users\pub`],
    ["an embedded cmd metacharacter", String.raw`C:\Win&dows`],
  ])("refuses to resolve taskkill.exe under %s", (_label, systemRoot) => {
    expect(() => windowsTaskkillInvocation(7, { SystemRoot: systemRoot })).toThrow(
      WindowsSystemDirectoryError,
    );
  });

  it("keeps the tree-kill best-effort when the system directory cannot be trusted", () => {
    // The throw above must never escape termination — killGroup's contract is that it never throws.
    expect(() => {
      nodeWindowsTreeKill(7, { SystemRoot: String.raw`\\attacker\share` });
    }).not.toThrow();
  });

  // AGENTS.md §8: the activity log must let an operator reconstruct the defect without the machine.
  // A hostile/malformed SystemRoot and an ordinary taskkill failure are different facts about that
  // machine — one is a tampered environment, the other a stripped image — so they must not arrive as
  // the same value. Reported as a distinct member, never as free text and never carrying the
  // rejected value.
  // taskkill's exit STATUS decides what a customer's log says about a termination, and until this
  // seam existed the branching was untestable off Windows — `nodeSpawnSync` was imported directly.
  // 128 is "the specified process was not found" for the requested root. It is common when the
  // child exits between the guard and taskkill, but proves nothing about an already-orphaned child.
  it.each([
    [0, "succeeded"],
    [128, "root-not-found"],
    [1, "failed"],
    [255, "failed"],
  ])("maps taskkill exit %s to %s", (status, expected) => {
    const treeKill = nodeWindowsTreeKillWith(() => ({ status }));
    expect(treeKill(4242, { SystemRoot: String.raw`C:\Windows` })).toBe(expected);
  });

  it("keeps exit 128 factual when the root is absent but a descendant fixture remains alive", () => {
    const liveDescendantPids = new Set([4243]);
    const treeKill = nodeWindowsTreeKillWith(() => ({
      status: liveDescendantPids.has(4243) ? 128 : 0,
    }));
    expect(treeKill(4242, { SystemRoot: String.raw`C:\Windows` })).toBe("root-not-found");
    expect(liveDescendantPids.has(4243)).toBe(true);
  });

  it("maps a taskkill that never completed within the bound to unknown, not failed", () => {
    const timedOut = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const treeKill = nodeWindowsTreeKillWith(() => ({ status: null, error: timedOut }));
    expect(treeKill(4242, { SystemRoot: String.raw`C:\Windows` })).toBe("unknown");
  });

  it("maps a taskkill that could not be launched at all to failed", () => {
    const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
    const treeKill = nodeWindowsTreeKillWith(() => ({ status: null, error: missing }));
    expect(treeKill(4242, { SystemRoot: String.raw`C:\Windows` })).toBe("failed");
  });

  it("reports an untrusted system root as its own disposition, distinct from a plain failure", () => {
    expect(nodeWindowsTreeKill(7, { SystemRoot: String.raw`\\attacker\share` })).toBe(
      "blocked-untrusted-system-root",
    );
  });

  it("still reports an ordinary spawn failure as failed, not as an untrusted root", () => {
    // A VALID system root, so the resolver returns cleanly and any failure comes from the spawn
    // itself — the narrow catch must not let this borrow the security-relevant member.
    const treeKill = nodeWindowsTreeKillWith(() => ({ status: null, error: new Error("failed") }));
    expect(treeKill(4242, { SystemRoot: String.raw`C:\Windows` })).toBe("failed");
  });
});

// ─── nodeWindowsTreeKill — a missing taskkill.exe is "failed", not "blocked-untrusted-system-root" ─
// resolveWindowsSystemBinary uses a dedicated missing-binary error for a resolved System32 path
// that does not exist (e.g. taskkill.exe absent on a stripped-down image), keeping that operational
// fact distinct from a hostile/malformed SystemRoot/WINDIR security refusal.
describe("nodeWindowsTreeKill — distinguishing a missing taskkill.exe from a hostile system root", () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  afterEach(() => {
    if (platformDescriptor !== undefined) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  it("classifies a shaped but non-system root as untrusted before binary lookup", () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    const neverExistsRoot = String.raw`C:\keiko-test-bcd065b8-9543-42fe-a860-a2006984e2fb`;
    expect(() => windowsTaskkillInvocation(4242, { SystemRoot: neverExistsRoot })).toThrow(
      WindowsSystemDirectoryError,
    );
    expect(nodeWindowsTreeKill(4242, { SystemRoot: neverExistsRoot })).toBe(
      "blocked-untrusted-system-root",
    );
  });

  it("maps an absent binary under an already-trusted root to failed", () => {
    const budget: WindowsTaskkillBudget = { tryConsume: () => true, refund: vi.fn() };
    const runTaskkill = vi.fn(() => ({ status: 0 }));
    const treeKill = nodeWindowsTreeKillWith(
      runTaskkill,
      budget,
      () => 0,
      () => {
        throw new WindowsSystemBinaryMissingError();
      },
    );

    expect(treeKill(4242, { SystemRoot: String.raw`C:\Windows` })).toBe("failed");
    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("still maps a hostile/malformed system root to blocked-untrusted-system-root under the same win32 stub", () => {
    // Proves the two branches stay apart even on the platform where BOTH throw sites are reachable —
    // not only via the "runs on any host" shape check exercised elsewhere in this file.
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    expect(nodeWindowsTreeKill(7, { SystemRoot: String.raw`\\attacker\share` })).toBe(
      "blocked-untrusted-system-root",
    );
  });
});

// ─── WindowsTaskkillBudget — bounding the AGGREGATE stall across concurrent terminations ───────────
// TASKKILL_WAIT_MS only ever bounds ONE spawnSync call; this budget bounds what N of them, cancelled
// in the same tick, can cost the event loop in total. Node is single-threaded, so a synchronous
// decrement is race-free — these tests pin the counting and reset semantics, not concurrency safety.
describe("createWindowsTaskkillBudget — aggregate stall budget", () => {
  it("allows exactly six consumes before denying the seventh, within one window", () => {
    const budget = createWindowsTaskkillBudget(() => 0);
    for (let i = 0; i < 6; i += 1) {
      expect(budget.tryConsume()).toBe(true);
    }
    expect(budget.tryConsume()).toBe(false);
  });

  it("refills the WHOLE budget once the window elapses, not per call", () => {
    let now = 0;
    const budget = createWindowsTaskkillBudget(() => now);
    for (let i = 0; i < 6; i += 1) {
      expect(budget.tryConsume()).toBe(true);
      budget.refund(0);
    }
    expect(budget.tryConsume()).toBe(false);
    // One ms short of the window: still exhausted — the reset is a hard boundary, not a leak.
    now = 59_999;
    expect(budget.tryConsume()).toBe(false);
    // The window has elapsed: the FULL budget is back, not a partial trickle.
    now = 60_000;
    for (let i = 0; i < 6; i += 1) {
      expect(budget.tryConsume()).toBe(true);
    }
    expect(budget.tryConsume()).toBe(false);
  });

  it("keeps pre-spawn kill reservations charged across a window reset", () => {
    let now = 0;
    const budget = createWindowsTaskkillBudget(() => now);
    const reservation = budget.reserve(2);
    expect(reservation).toBeDefined();

    now = 60_000;
    for (let index = 0; index < 4; index += 1) {
      expect(budget.tryConsume()).toBe(true);
      budget.refund(0);
    }
    expect(budget.tryConsume()).toBe(false);

    reservation?.release();
    expect(budget.tryConsume()).toBe(true);
  });

  it("gives every factory call its own private counter — no shared state across instances", () => {
    const first = createWindowsTaskkillBudget(() => 0);
    const second = createWindowsTaskkillBudget(() => 0);
    for (let i = 0; i < 6; i += 1) {
      expect(first.tryConsume()).toBe(true);
    }
    expect(first.tryConsume()).toBe(false);
    // `second` was never touched — it must still have its full budget.
    expect(second.tryConsume()).toBe(true);
  });

  it("does not refill when the wall clock jumps forward", () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const budget = createWindowsTaskkillBudget();
      for (let index = 0; index < 6; index += 1) {
        expect(budget.tryConsume()).toBe(true);
      }
      expect(budget.tryConsume()).toBe(false);

      dateNow.mockReturnValue(24 * 60 * 60 * 1_000);
      expect(budget.tryConsume()).toBe(false);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("requires a full timeout reservation even after a partial refund", () => {
    const budget = createWindowsTaskkillBudget(() => 0);
    for (let index = 0; index < 6; index += 1) {
      expect(budget.tryConsume()).toBe(true);
    }
    budget.refund(4_999);
    expect(budget.tryConsume()).toBe(false);
    budget.refund(1);
    expect(budget.tryConsume()).toBe(true);
  });
});

describe("nodeWindowsTreeKillWith — the budget gates the spawn, not just the report", () => {
  it.each([process.pid, process.ppid])(
    "refuses protected pid %s before spending budget or spawning taskkill",
    (pid) => {
      const budget: WindowsTaskkillBudget = {
        tryConsume: vi.fn(() => true),
        refund: vi.fn(),
      };
      const runTaskkill = vi.fn(() => ({ status: 0 }));
      const treeKill = nodeWindowsTreeKillWith(runTaskkill, budget);
      expect(treeKill(pid, { SystemRoot: String.raw`C:\Windows` })).toBe("refused-self-pid");
      expect(budget.tryConsume).not.toHaveBeenCalled();
      expect(runTaskkill).not.toHaveBeenCalled();
    },
  );

  it("reports budget-exhausted and never calls taskkill once the injected budget is spent", () => {
    const exhausted: WindowsTaskkillBudget = { tryConsume: () => false, refund: vi.fn() };
    const runTaskkill = vi.fn(() => ({ status: 0 }));
    const treeKill = nodeWindowsTreeKillWith(runTaskkill, exhausted);
    expect(treeKill(4242, { SystemRoot: String.raw`C:\Windows` })).toBe("budget-exhausted");
    // The whole point of the budget is to avoid PAYING the blocking wait — a spawn here would defeat
    // it even if the reported disposition happened to be right.
    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("still runs taskkill normally while the injected budget keeps granting", () => {
    const alwaysGranting: WindowsTaskkillBudget = { tryConsume: () => true, refund: vi.fn() };
    const runTaskkill = vi.fn(() => ({ status: 0 }));
    const treeKill = nodeWindowsTreeKillWith(runTaskkill, alwaysGranting);
    expect(treeKill(4242, { SystemRoot: String.raw`C:\Windows` })).toBe("succeeded");
    expect(runTaskkill).toHaveBeenCalledTimes(1);
  });

  it("refunds unused reservations so fast terminations do not disable tree-kill", () => {
    let now = 0;
    const budget = createWindowsTaskkillBudget(() => now);
    const runTaskkill = vi.fn(() => {
      now += 20;
      return { status: 0 };
    });
    const treeKill = nodeWindowsTreeKillWith(runTaskkill, budget, () => now);
    const results: WindowsTreeKillResult[] = Array.from({ length: 7 }, () =>
      treeKill(4242, { SystemRoot: String.raw`C:\Windows` }),
    );
    expect(results).toEqual(Array.from({ length: 7 }, () => "succeeded"));
    expect(runTaskkill).toHaveBeenCalledTimes(7);
  });

  it("still denies the seventh full-timeout attempt, then refills at the window boundary", () => {
    let now = 0;
    const budget = createWindowsTaskkillBudget(() => now);
    const runTaskkill = vi.fn(() => {
      now += 5_000;
      return { status: 0 };
    });
    const treeKill = nodeWindowsTreeKillWith(runTaskkill, budget, () => now);
    const results: WindowsTreeKillResult[] = Array.from({ length: 7 }, () =>
      treeKill(4242, { SystemRoot: String.raw`C:\Windows` }),
    );
    expect(results.filter((result) => result === "succeeded")).toHaveLength(6);
    expect(results.filter((result) => result === "budget-exhausted")).toHaveLength(1);
    expect(runTaskkill).toHaveBeenCalledTimes(6);
    now = 60_000;
    expect(treeKill(4242, { SystemRoot: String.raw`C:\Windows` })).toBe("succeeded");
    expect(runTaskkill).toHaveBeenCalledTimes(7);
  });
});

describe("Windows pre-spawn termination capacity", () => {
  it("shares one rolling stall budget with direct LSP-style tree kills", () => {
    let now = 0;
    const budget = createWindowsTaskkillBudget(() => now);
    const runTaskkill = vi.fn(() => {
      now += 5_000;
      return { status: 0 };
    });
    const resolveInvocation = (pid: number): ReturnType<typeof windowsTaskkillInvocation> => ({
      command: String.raw`D:\Windows\System32\taskkill.exe`,
      args: ["/PID", String(pid), "/T", "/F"],
    });
    const capacity = createWindowsTerminationCapacity(
      1,
      undefined,
      resolveInvocation,
      runTaskkill,
      budget,
      () => now,
    );
    const directTreeKill = nodeWindowsTreeKillWith(
      runTaskkill,
      budget,
      () => now,
      resolveInvocation,
    );
    const reservation = capacity.reserve({ SystemRoot: String.raw`D:\Windows` });

    expect(reservation?.kill(4242, {})).toBe("succeeded");
    expect(reservation?.kill(4242, {})).toBe("succeeded");
    reservation?.release();
    for (let index = 0; index < 4; index += 1) {
      expect(directTreeKill(4242, {})).toBe("succeeded");
    }

    const nextBatch = capacity.reserve({ SystemRoot: String.raw`D:\Windows` });
    expect(nextBatch).toBeUndefined();
    expect(runTaskkill).toHaveBeenCalledTimes(6);
  });

  it("binds the authenticated taskkill path across later environment mutation", () => {
    const seenRoots: (string | undefined)[] = [];
    const seenCommands: string[] = [];
    const capacity = createWindowsTerminationCapacity(
      1,
      undefined,
      (_pid, env) => {
        seenRoots.push(env.SystemRoot);
        return { command: String.raw`D:\Windows\System32\taskkill.exe`, args: [] };
      },
      (command) => {
        seenCommands.push(command);
        return { status: 0 };
      },
    );
    const mutableEnv = { SystemRoot: String.raw`D:\Windows` };
    const reservation = capacity.reserve(mutableEnv);
    expect(reservation).toBeDefined();

    mutableEnv.SystemRoot = String.raw`C:\workspace\fake-windows`;
    expect(reservation?.kill(4242, mutableEnv)).toBe("succeeded");
    expect(seenRoots).toEqual([String.raw`D:\Windows`]);
    expect(seenCommands).toEqual([String.raw`D:\Windows\System32\taskkill.exe`]);
    reservation?.release();
  });
});
