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
  nodeSpawnFn,
  nodeWindowsTreeKill,
  runCommand,
  windowsTaskkillInvocation,
  type CommandTerminationEvidence,
  type HomeProvider,
  type RunCommandDeps,
} from "./exec.js";
import { WindowsSystemDirectoryError } from "./windows-shell.js";
import { CommandCancelledError, CommandDeniedError, CommandTimeoutError } from "./errors.js";
import { PathEscapeError, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  DEFAULT_COMMAND_RULES,
  DEFAULT_ENV_ALLOWLIST,
  DEFAULT_SANDBOX_POLICY,
  type CommandRule,
  type SandboxPolicy,
} from "./types.js";
import { makeWorkspace, recordingSpawn } from "./_support.js";

let root: string;
let info: WorkspaceInfo;

const NODE_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  { executable: "node" },
  ...DEFAULT_COMMAND_RULES,
]);

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
  const WIN_ENV: NodeJS.ProcessEnv = { PATH: "", SystemRoot: String.raw`C:\Windows` };

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
    expect(call?.command).toBe(String.raw`C:\Windows\System32\cmd.exe`);
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
      fn: (pid, processEnv): void => {
        calls.push({ pid, processEnv });
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
    const throwingTreeKill: RunCommandDeps["killWindowsTree"] = (): void => {
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
      expect(treeKill.calls()).toHaveLength(2);
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
      {
        reason: "timeout",
        pid: spawn.child.pid,
        windowsTreeKillAttempted: false,
        windowsTreeKillSucceeded: true,
      },
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

  it("reports windowsTreeKillAttempted:true and succeeded:true on win32 with a well-behaved tree-kill", async () => {
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
      { ...fakeDeps(spawn.fn), platform: "win32", killWindowsTree: (): void => undefined },
    );
    await new Promise((r) => setTimeout(r, 20));
    spawn.child.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(evidence.calls()).toEqual([
      {
        reason: "timeout",
        pid: spawn.child.pid,
        windowsTreeKillAttempted: true,
        windowsTreeKillSucceeded: true,
      },
    ]);
  });

  it("reports windowsTreeKillAttempted:true and succeeded:false when the injected tree-kill throws — and still never breaks termination", async () => {
    const spawn = recordingSpawn();
    const evidence = recordingEvidence();
    const throwingTreeKill: RunCommandDeps["killWindowsTree"] = (): void => {
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
      {
        reason: "timeout",
        pid: spawn.child.pid,
        windowsTreeKillAttempted: true,
        windowsTreeKillSucceeded: false,
      },
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
    const invocation = windowsTaskkillInvocation(4242, { SystemRoot: String.raw`C:\Windows` });
    expect(invocation.command).toBe(String.raw`C:\Windows\System32\taskkill.exe`);
    expect(invocation.args).toEqual(["/PID", "4242", "/T", "/F"]);
  });

  it("falls back to WINDIR when SystemRoot is absent", () => {
    const invocation = windowsTaskkillInvocation(7, { WINDIR: String.raw`D:\WinDir` });
    expect(invocation.command).toBe(String.raw`D:\WinDir\System32\taskkill.exe`);
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
});
