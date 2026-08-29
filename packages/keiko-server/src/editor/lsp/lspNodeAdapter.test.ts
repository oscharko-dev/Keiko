import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_COMMAND_RULES } from "@oscharko-dev/keiko-tools";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import {
  LspProcessError,
  buildLspSpawnPlan,
  createApprovedExecutablePath,
  createEphemeralHome,
  defaultLspSpawnFn,
  escalateKill,
  preflightSpawnEnv,
  resolveExecutableOutsideWorkspace,
} from "./lspNodeAdapter.js";
import type { KillScheduler, KillableChild } from "./lspNodeAdapter.js";
import {
  executableFixtureName,
  writeExecutableFixture,
  writeNodeExecutableFixture,
} from "./testing/executableFixture.js";
import { UNKNOWN_CORRELATION_ID } from "../../correlation.js";
import { redactLogFields } from "../../observability/log-redaction.js";
import type { ServerLogEvent } from "../../observability/server-log.js";
import {
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "../../observability/server-logger.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  // Every test in this file shares the process-wide logger slot (AGENTS.md §8 Rule 1 tests below
  // install a capturing one); resetting unconditionally is a harmless no-op for tests that never
  // touch it and prevents leaking a captured sink into an unrelated later suite.
  resetServerLogger();
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeWorkspace(root: string): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function writeExecutable(dir: string, name: string): string {
  return writeExecutableFixture(dir, name);
}

describe("resolveExecutableOutsideWorkspace", () => {
  it("resolves a bare name found on PATH outside the workspace", () => {
    const binDir = makeTempDir("keiko-bin-");
    const workspaceDir = makeTempDir("keiko-ws-");
    writeExecutable(binDir, "fakelsp");
    const env: NodeJS.ProcessEnv = { PATH: binDir };

    const resolved = resolveExecutableOutsideWorkspace("fakelsp", makeWorkspace(workspaceDir), env);

    expect(resolved).toContain("fakelsp");
  });

  it("resolves a PATHEXT command fixture on Windows", () => {
    const binDir = makeTempDir("keiko-bin-");
    const workspaceDir = makeTempDir("keiko-ws-");
    writeExecutableFixture(binDir, "fakelsp", "win32");
    const env: NodeJS.ProcessEnv = { PATH: binDir, PATHEXT: ".EXE;.CMD" };

    const resolved = resolveExecutableOutsideWorkspace(
      "fakelsp",
      makeWorkspace(workspaceDir),
      env,
      "win32",
    );

    expect(resolved).toContain("fakelsp.CMD");
  });

  it("rejects a name that is not on PATH", () => {
    const workspaceDir = makeTempDir("keiko-ws-");
    const env: NodeJS.ProcessEnv = { PATH: makeTempDir("keiko-empty-") };

    expect(() =>
      resolveExecutableOutsideWorkspace("absent", makeWorkspace(workspaceDir), env),
    ).toThrow(LspProcessError);
  });

  it.each([["with/slash"], ["with\\backslash"], ["with space"], [""]])(
    "rejects a non-bare name %s",
    (name) => {
      const env: NodeJS.ProcessEnv = { PATH: makeTempDir("keiko-bin-") };
      expect(() =>
        resolveExecutableOutsideWorkspace(name, makeWorkspace(makeTempDir("keiko-ws-")), env),
      ).toThrow(LspProcessError);
    },
  );

  it("rejects an executable that resolves inside the workspace via a symlink (I2)", () => {
    const workspaceDir = makeTempDir("keiko-ws-");
    const realTarget = writeExecutable(workspaceDir, "inside");
    const pathDir = makeTempDir("keiko-bin-");
    symlinkSync(realTarget, join(pathDir, executableFixtureName("fakelsp")));
    const env: NodeJS.ProcessEnv = { PATH: pathDir };

    expect(() =>
      resolveExecutableOutsideWorkspace("fakelsp", makeWorkspace(workspaceDir), env),
    ).toThrow(LspProcessError);
  });

  it("rejects a directly-resolved executable lying inside the workspace", () => {
    const workspaceDir = makeTempDir("keiko-ws-");
    writeExecutable(workspaceDir, "fakelsp");
    const env: NodeJS.ProcessEnv = { PATH: workspaceDir };

    expect(() =>
      resolveExecutableOutsideWorkspace("fakelsp", makeWorkspace(workspaceDir), env),
    ).toThrow(LspProcessError);
  });

  it("returns EXECUTABLE_NOT_FOUND for an empty PATH", () => {
    const env: NodeJS.ProcessEnv = {};
    try {
      resolveExecutableOutsideWorkspace("fakelsp", makeWorkspace(makeTempDir("keiko-ws-")), env);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LspProcessError);
      expect((error as LspProcessError).code).toBe("EXECUTABLE_NOT_FOUND");
    }
  });
});

describe("createEphemeralHome", () => {
  it("creates an empty directory and removes it on cleanup", () => {
    const home = createEphemeralHome();
    expect(existsSync(home.path)).toBe(true);

    home.cleanup();

    expect(existsSync(home.path)).toBe(false);
  });

  it("cleanup is idempotent and never throws", () => {
    const home = createEphemeralHome();
    home.cleanup();
    expect(() => {
      home.cleanup();
    }).not.toThrow();
  });
});

describe("createApprovedExecutablePath", () => {
  it("exposes only exact approved external binaries and cleans the private PATH", () => {
    const binDir = makeTempDir("keiko-approved-bin-");
    const workspaceDir = makeTempDir("keiko-approved-ws-");
    const node = writeExecutable(binDir, "node");
    const shellcheck = writeExecutable(binDir, "shellcheck");
    writeExecutable(binDir, "shfmt");

    const approved = createApprovedExecutablePath(
      ["node", "shellcheck"],
      [{ executable: "node" }, { executable: "shellcheck" }],
      makeWorkspace(workspaceDir),
      { PATH: binDir },
    );

    expect(readdirSync(approved.path).sort()).toEqual(["node", "shellcheck"]);
    expect(realpathSync(join(approved.path, "node"))).toBe(realpathSync(node));
    expect(realpathSync(join(approved.path, "shellcheck"))).toBe(realpathSync(shellcheck));
    expect(existsSync(join(approved.path, "shfmt"))).toBe(false);
    approved.cleanup();
    expect(existsSync(approved.path)).toBe(false);
  });

  it("rejects workspace PATH shadowing without retaining a private directory", () => {
    const workspaceDir = makeTempDir("keiko-shadow-ws-");
    writeExecutable(workspaceDir, "shellcheck");

    expect(() =>
      createApprovedExecutablePath(
        ["shellcheck"],
        [{ executable: "shellcheck" }],
        makeWorkspace(workspaceDir),
        { PATH: workspaceDir },
      ),
    ).toThrow(LspProcessError);
  });
});

interface KillTracker extends KillableChild {
  readonly signals: NodeJS.Signals[];
}

function makeKillTracker(pid: number | undefined): KillTracker {
  const signals: NodeJS.Signals[] = [];
  return {
    pid,
    signals,
    kill: (signal): void => {
      signals.push(signal);
    },
  };
}

const immediateScheduler: KillScheduler = {
  setTimer: (callback): unknown => {
    callback();
    return 0;
  },
};

describe("escalateKill", () => {
  it("sends only SIGTERM when the child exits within the grace window", async () => {
    const tracker = makeKillTracker(1234);

    await escalateKill(tracker, 5_000, () => true, immediateScheduler);

    expect(tracker.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when the child has not exited by the grace deadline", async () => {
    const tracker = makeKillTracker(1234);

    await escalateKill(tracker, 5_000, () => false, immediateScheduler);

    expect(tracker.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not send SIGKILL when the child exits during the grace window", async () => {
    const tracker = makeKillTracker(1234);
    let exited = false;
    const scheduler: KillScheduler = {
      setTimer: (callback): unknown => {
        exited = true;
        callback();
        return 0;
      },
    };

    await escalateKill(tracker, 5_000, () => exited, scheduler);

    expect(tracker.signals).toEqual(["SIGTERM"]);
  });

  it("swallows a kill that throws (child already gone)", async () => {
    const throwing: KillableChild = {
      pid: 1,
      kill: (): void => {
        throw new Error("ESRCH");
      },
    };

    await expect(
      escalateKill(throwing, 5_000, () => true, immediateScheduler),
    ).resolves.toBeUndefined();
  });

  it("resolves early via whenExited without firing the grace timer or SIGKILL (FIX 2)", async () => {
    const tracker = makeKillTracker(1234);
    let timerFired = false;
    // A scheduler whose timer never fires within the test — only the whenExited registration can
    // resolve escalateKill. Proves the prompt-exit short-circuit, not the grace fallback.
    const neverScheduler: KillScheduler = {
      setTimer: (): unknown => {
        timerFired = true;
        return 0;
      },
    };
    let exited = false;
    let registered: (() => void) | undefined;
    const whenExited = (onExit: () => void): void => {
      registered = onExit;
    };

    const settled = escalateKill(tracker, 5_000, () => exited, neverScheduler, whenExited);
    // Fire the child's exit asynchronously, after escalateKill has wired its registration.
    exited = true;
    registered?.();

    await expect(settled).resolves.toBeUndefined();
    expect(tracker.signals).toEqual(["SIGTERM"]);
    expect(timerFired).toBe(true); // the timer was scheduled, but the exit resolved first
  });
});

describe("preflightSpawnEnv", () => {
  const rules: readonly CommandRule[] = [{ executable: "fakelsp" }];

  it("returns a copy-only env containing only allowlisted names", () => {
    const env = preflightSpawnEnv(
      rules,
      "fakelsp",
      [],
      { PATH: "/usr/bin", SECRET_TOKEN: "should-not-leak", LANG: "en_US" },
      ["PATH", "LANG"],
    );

    expect(env).toEqual({ PATH: "/usr/bin", LANG: "en_US" });
    expect(env).not.toHaveProperty("SECRET_TOKEN");
  });

  it("throws EXECUTABLE_NOT_FOUND when the command is denied (I5)", () => {
    try {
      preflightSpawnEnv(DEFAULT_COMMAND_RULES, "rm", ["-rf", "/"], { PATH: "/usr/bin" }, ["PATH"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LspProcessError);
      expect((error as LspProcessError).code).toBe("EXECUTABLE_NOT_FOUND");
    }
  });
});

describe("resolveExecutableOutsideWorkspace — realpath fallback", () => {
  it("returns the lexical path when realpathSync fails for the workspace root", () => {
    // Covers the `catch { return root; }` branch of realWorkspaceRoot (line 98).
    // A non-existent workspace root causes realpathSync to throw; the function must
    // fall back to the lexical root and still resolve the executable correctly.
    const binDir = makeTempDir("keiko-bin-");
    writeExecutable(binDir, "fakelsp");
    // Use a workspace root path that does not exist on disk — realpathSync will throw.
    const nonExistentRoot = join(tmpdir(), "keiko-ghost-ws-does-not-exist-xyzzy");
    const env: NodeJS.ProcessEnv = { PATH: binDir };

    // Should not throw; the fallback root is used for the inside-workspace check.
    const resolved = resolveExecutableOutsideWorkspace(
      "fakelsp",
      makeWorkspace(nonExistentRoot),
      env,
    );

    expect(resolved).toContain("fakelsp");
  });
});

describe("escalateKill — pid undefined branch", () => {
  it("falls back to direct child.kill when pid is undefined", async () => {
    // Covers the `if (pid === undefined) { safeKill(child, signal); return; }` branch
    // inside wrapChild's kill closure (line 232-234). We test this via escalateKill with
    // a KillTracker that has pid=undefined — safeKill calls child.kill directly.
    const signals: NodeJS.Signals[] = [];
    const pidlessChild: KillableChild = {
      pid: undefined,
      kill: (signal): void => {
        signals.push(signal);
      },
    };

    await escalateKill(pidlessChild, 5_000, () => true, immediateScheduler);

    // SIGTERM should have been sent via the direct child.kill path (pid was undefined).
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("SIGKILL is sent via direct child.kill when pid is undefined and grace period elapses", async () => {
    const signals: NodeJS.Signals[] = [];
    const pidlessChild: KillableChild = {
      pid: undefined,
      kill: (signal): void => {
        signals.push(signal);
      },
    };

    await escalateKill(pidlessChild, 5_000, () => false, immediateScheduler);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

// Pins defaultLspSpawnFn's OWN call site (issue #3350). Every other LSP test injects `deps.spawn`
// and never reaches this adapter, so without these cases both the hardened cmd.exe wrapper call and
// the `windowsVerbatimArguments` spread could be deleted and the suite would stay green — while
// silently reintroducing EINVAL for npm-installed `.cmd` language servers.
describe("buildLspSpawnPlan", () => {
  const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;

  it("routes a resolved .cmd language server through the hardened cmd.exe wrapper on win32", () => {
    const plan = buildLspSpawnPlan(
      String.raw`C:\tools\typescript-language-server.cmd`,
      ["--stdio"],
      env,
      String.raw`C:\workspace`,
      { platform: "win32", env: { SystemRoot: String.raw`C:\Windows` } },
    );

    expect(plan.command.toLowerCase().endsWith(String.raw`\system32\cmd.exe`.toLowerCase())).toBe(
      true,
    );
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.args[3]).toContain("typescript-language-server.cmd");
    // The spread must survive: without it Node re-quotes the pre-escaped line and the escaping is lost.
    expect(plan.options.windowsVerbatimArguments).toBe(true);
    // Windows has no process groups here, so the child is never detached.
    expect(plan.options.detached).toBe(false);
  });

  it("passes a resolved .exe language server through unchanged on win32", () => {
    const plan = buildLspSpawnPlan(
      String.raw`C:\tools\pyright-langserver.exe`,
      ["--stdio"],
      env,
      String.raw`C:\workspace`,
      { platform: "win32", env: { SystemRoot: String.raw`C:\Windows` } },
    );

    expect(plan.command).toBe(String.raw`C:\tools\pyright-langserver.exe`);
    expect(plan.args).toEqual(["--stdio"]);
    expect(plan.options.windowsVerbatimArguments).toBeUndefined();
  });

  it("spawns detached and unwrapped on a POSIX host so the manager can group-kill", () => {
    const plan = buildLspSpawnPlan("/usr/bin/typescript-language-server", ["--stdio"], env, "/ws", {
      platform: "linux",
    });

    expect(plan.command).toBe("/usr/bin/typescript-language-server");
    expect(plan.args).toEqual(["--stdio"]);
    expect(plan.options.detached).toBe(true);
    expect(plan.options.windowsVerbatimArguments).toBeUndefined();
  });
});

// A PR reviewer finding (AGENTS.md §8 Rule 1): this adapter's win32 wrapper-engagement decision
// (buildLspSpawnPlan, pinned above) and its win32 taskkill.exe tree-kill decision (nodeGroupKill,
// same primitive as runCommand's killGroup in keiko-tools exec.ts) shipped with no activity-log
// evidence anywhere. defaultLspSpawnFn has no injected log port — it reaches processServerLogSink()
// directly — so these tests install a capturing ServerLogger via the process-wide test seam
// (setServerLogger/resetServerLogger) rather than a constructor-injected fake.
describe("defaultLspSpawnFn — activity-log evidence (AGENTS.md §8 Rule 1)", () => {
  function captureLog(): ServerLogEvent[] {
    const events: ServerLogEvent[] = [];
    setServerLogger(
      createServerLogger({ sink: { write: (event) => events.push(event) }, level: "debug" }),
    );
    return events;
  }

  it("logs lsp.spawn.completed with the wrapper-engagement decision, platform, and the childPid", async () => {
    const events = captureLog();
    const binDir = makeTempDir("keiko-lsp-real-");
    const executable = writeExecutableFixture(binDir, "fakelsp");

    const handle = defaultLspSpawnFn(executable, [], { PATH: "/usr/bin" }, binDir);
    await new Promise<void>((resolve) => {
      handle.onExit(() => {
        resolve();
      });
    });

    const spawned = events.find((event) => event.op === "lsp.spawn.completed");
    expect(spawned).toBeDefined();
    expect(spawned?.category).toBe("diagnostic");
    expect(spawned?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
    const extra = spawned?.extra ?? {};
    // POSIX (this test host is never win32): the hardened cmd.exe wrapper never engages.
    expect(extra.windowsWrapperEngaged).toBe(false);
    expect(extra.platform).toBe(process.platform);
    expect(typeof extra.childPid).toBe("number");
    // Body-free: never the resolved executable path or args on the evidence line.
    expect(Object.keys(extra).sort()).toEqual(["childPid", "platform", "windowsWrapperEngaged"]);
    // Through the REAL redactor (review 5058571583 finding 1): `pid` is a reserved envelope name
    // and would be silently dropped — every evidence field here must SURVIVE redaction.
    const redacted = redactLogFields(extra) ?? {};
    expect(Object.keys(redacted).sort()).toEqual(Object.keys(extra).sort());
    expect(redacted.childPid).toBe(extra.childPid);
  });

  it("logs lsp.spawn.failed with the closed EXECUTABLE_NOT_FOUND code for a non-absolute executable", () => {
    const events = captureLog();

    expect(() => defaultLspSpawnFn("relative-name", [], {}, "/tmp")).toThrow(LspProcessError);

    const failed = events.find((event) => event.op === "lsp.spawn.failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("error");
    expect(failed?.category).toBe("diagnostic");
    expect(failed?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
    expect(failed?.errorKind).toBe("EXECUTABLE_NOT_FOUND");
  });

  // Review 5058544058/5058571583: spawn() returning is NOT spawn success — ENOENT arrives
  // asynchronously via 'error', with no 'exit' following. The pre-fix adapter logged
  // lsp.spawn.completed on dispatch, emitted no failure line, and cleaned the ephemeral HOME only
  // on exit — leaking one keiko-lsp-home-* directory per failed attempt. The same cleanup guard
  // covers the synchronous throw paths (buildLspSpawnPlan rejecting a control character or an
  // untrusted SystemRoot on win32, wrapChild's null-stdio check): they share cleanupHomeOnce +
  // logLspSpawnFailed + rethrow.
  it("an async spawn failure logs lsp.spawn.failed, never lsp.spawn.completed, and leaks no HOME", async () => {
    const events = captureLog();
    const binDir = makeTempDir("keiko-lsp-enoent-");
    const missing = join(binDir, "does-not-exist");
    const homesBefore = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith("keiko-lsp-home-")),
    );

    const handle = defaultLspSpawnFn(missing, [], { PATH: "/usr/bin" }, binDir);
    await new Promise<void>((resolve) => {
      handle.onError(() => {
        resolve();
      });
    });
    // The error path must have cleaned up by the time the failure line is written.
    await new Promise((resolve) => setImmediate(resolve));

    expect(events.some((event) => event.op === "lsp.spawn.completed")).toBe(false);
    const failed = events.find((event) => event.op === "lsp.spawn.failed");
    expect(failed).toBeDefined();
    expect(failed?.errorKind).toBe("SPAWN_FAILED");
    const homesAfter = readdirSync(tmpdir()).filter((name) => name.startsWith("keiko-lsp-home-"));
    const leaked = homesAfter.filter((name) => !homesBefore.has(name));
    expect(leaked).toEqual([]);
  });

  it("logs lsp.process.terminated with signal and the VERIFIED tree-kill disposition on kill()", async () => {
    const events = captureLog();
    const binDir = makeTempDir("keiko-lsp-kill-");
    const executable = writeNodeExecutableFixture(
      binDir,
      "hanglsp",
      "setInterval(() => {}, 1000);\n",
    );

    const handle = defaultLspSpawnFn(executable, [], { PATH: "/usr/bin" }, binDir);
    const exited = new Promise<void>((resolve) => {
      handle.onExit(() => {
        resolve();
      });
    });
    handle.kill("SIGTERM");
    await exited;

    const terminated = events.find((event) => event.op === "lsp.process.terminated");
    expect(terminated).toBeDefined();
    expect(terminated?.category).toBe("diagnostic");
    expect(terminated?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
    const extra = terminated?.extra ?? {};
    // POSIX (this test host is never win32): the taskkill.exe tree-kill path never engages, and
    // the line says so honestly instead of a dispatched-therefore-succeeded boolean.
    expect(extra.windowsTreeKill).toBe("not-attempted");
    expect(extra.signal).toBe("SIGTERM");
    expect(typeof extra.childPid).toBe("number");
    expect(Object.keys(extra).sort()).toEqual(["childPid", "signal", "windowsTreeKill"]);
    const redacted = redactLogFields(extra) ?? {};
    expect(Object.keys(redacted).sort()).toEqual(Object.keys(extra).sort());
  });
});
