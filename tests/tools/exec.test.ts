import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  nodeSpawnFn,
  runCommand,
  type HomeProvider,
  type RunCommandDeps,
} from "../../src/tools/exec.js";
import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
} from "../../src/tools/errors.js";
import { PathEscapeError } from "../../src/workspace/errors.js";
import { DEFAULT_COMMAND_RULES, DEFAULT_SANDBOX_POLICY } from "../../src/tools/types.js";
import { makeWorkspace, recordingSpawn } from "./_support.js";
import type { WorkspaceInfo } from "../../src/workspace/types.js";

let root: string;
let info: WorkspaceInfo;

beforeEach(() => {
  ({ root, info } = makeWorkspace());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeDeps(
  spawnFn: RunCommandDeps["spawn"],
  processEnv: NodeJS.ProcessEnv = {},
): RunCommandDeps {
  return {
    workspace: info,
    policy: DEFAULT_SANDBOX_POLICY,
    commandRules: DEFAULT_COMMAND_RULES,
    spawn: spawnFn,
    processEnv,
    now: () => 0,
  };
}

function realDeps(processEnv: NodeJS.ProcessEnv): RunCommandDeps {
  return {
    workspace: info,
    policy: { ...DEFAULT_SANDBOX_POLICY, defaultTimeoutMs: 10_000 },
    commandRules: DEFAULT_COMMAND_RULES,
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
});

describe("runCommand — spawn options (no shell, clean env, detached)", () => {
  it("always spawns with shell:false and a name-allowlisted env (+ ephemeral HOME)", async () => {
    const spawn = recordingSpawn();
    const home = recordingHome();
    const promise = runCommand(
      {
        command: "node",
        args: ["-e", "1"],
        cwd: undefined,
        timeoutMs: undefined,
        signal: controller().signal,
      },
      {
        ...fakeDeps(spawn.fn, { PATH: "/bin", SECRET_TOKEN: "leak-me-please" }),
        home: home.provider,
      },
    );
    spawn.child.emit("close", 0, null);
    await promise;
    const call = spawn.calls()[0];
    const made = home.made()[0] ?? "";
    expect(call?.options.shell).toBe(false);
    // PATH is name-copied; the planted secret never reaches the child; HOME/USERPROFILE are the
    // ephemeral dir (C5), so the env is exactly {PATH, HOME, USERPROFILE} — no parent spread.
    expect(call?.options.env).toEqual({ PATH: "/bin", HOME: made, USERPROFILE: made });
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
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(4);
    kills.restore();
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
          PATH: "/bin",
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
