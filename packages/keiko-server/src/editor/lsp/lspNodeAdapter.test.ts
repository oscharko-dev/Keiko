import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_COMMAND_RULES } from "@oscharko-dev/keiko-tools";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import {
  LspProcessError,
  buildLspSpawnPlan,
  createApprovedExecutablePath,
  createDefaultLspSpawnFn,
  createEphemeralHome,
  defaultLspSpawnFn,
  escalateKill,
  nodeGroupKill,
  preflightSpawnEnv,
  resolveExecutableOutsideWorkspace,
} from "./lspNodeAdapter.js";
import type { KillScheduler, KillableChild, LspProcessKillResult } from "./lspNodeAdapter.js";
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

function makeContainmentTracker(): KillableChild {
  let result: LspProcessKillResult | undefined;
  return {
    pid: 1234,
    kill: (signal): void => {
      result = {
        windowsTreeKill: "not-attempted",
        treeContainment: signal === "SIGKILL" ? "confirmed" : "unconfirmed",
      };
    },
    lastKillResult: (): LspProcessKillResult | undefined => result,
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

  it("does not claim containment from SIGTERM alone", async () => {
    await expect(
      escalateKill(makeContainmentTracker(), 5_000, () => true, immediateScheduler),
    ).resolves.toEqual({
      windowsTreeKill: "not-attempted",
      treeContainment: "unconfirmed",
    });
  });

  it("upgrades containment monotonically when escalation reaches group SIGKILL", async () => {
    await expect(
      escalateKill(makeContainmentTracker(), 5_000, () => false, immediateScheduler),
    ).resolves.toEqual({
      windowsTreeKill: "not-attempted",
      treeContainment: "confirmed",
    });
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
    // An injected pidless KillableChild still follows the generic escalation signal sequence. The
    // production manager handles Node's pidless pre-spawn error as confirmed-not-spawned instead.
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
    expect(plan.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(plan.options.detached).toBe(true);
    expect(plan.options.windowsVerbatimArguments).toBeUndefined();
  });
});

describe("nodeGroupKill — protected pid guard", () => {
  it.each([process.pid, process.ppid])(
    "refuses pid %s before taskkill and the direct-child fallback",
    (pid) => {
      const childKill = vi.fn();
      const child: KillableChild = { pid, kill: childKill };
      const killWindowsTree = vi.fn(() => "succeeded" as const);
      expect(
        nodeGroupKill(pid, child, "SIGTERM", {
          platform: "win32",
          processEnv: {},
          killWindowsTree,
        }),
      ).toEqual({
        windowsTreeKill: "refused-self-pid",
        treeContainment: "unconfirmed",
      });
      expect(killWindowsTree).not.toHaveBeenCalled();
      expect(childKill).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["succeeded", "confirmed"],
    ["failed", "unconfirmed"],
    ["root-not-found", "unconfirmed"],
    ["blocked-untrusted-system-root", "unconfirmed"],
    ["budget-exhausted", "unconfirmed"],
    ["unknown", "unconfirmed"],
  ] as const)(
    "maps a Windows %s disposition to %s tree containment",
    (windowsTreeKill, treeContainment) => {
      const childKill = vi.fn();
      const child: KillableChild = { pid: 41_234, kill: childKill };

      expect(
        nodeGroupKill(41_234, child, "SIGKILL", {
          platform: "win32",
          processEnv: {},
          killWindowsTree: () => windowsTreeKill,
        }),
      ).toEqual({ windowsTreeKill, treeContainment });
      expect(childKill).toHaveBeenCalledWith("SIGKILL");
    },
  );

  it("classifies a throwing Windows tree-kill implementation as unconfirmed failure", () => {
    const childKill = vi.fn();
    const child: KillableChild = { pid: 41_234, kill: childKill };

    expect(
      nodeGroupKill(41_234, child, "SIGKILL", {
        platform: "win32",
        processEnv: {},
        killWindowsTree: () => {
          throw new Error("injected taskkill failure");
        },
      }),
    ).toEqual({ windowsTreeKill: "failed", treeContainment: "unconfirmed" });
    expect(childKill).toHaveBeenCalledWith("SIGKILL");
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

  // The LSP twin of the reused-pid window closed in keiko-tools' exec.ts (PR #3355 review, P1).
  // `nodeGroupKill`'s own comment claims "the same defect and the same fix as runCommand's
  // killGroup", but the guard was missing here: Node releases the child handle at 'exit', so once
  // the process has left the table the OS may REUSE its pid — and nodeGroupKill's first act is
  // `process.kill(-pid, …)` on POSIX and `taskkill /PID <pid> /T /F` on win32, either of which can
  // then reach an unrelated tree. Every crash-then-dispose sequence takes this path.
  //
  // Asserts that NOTHING IS SIGNALLED, not the evidence value: on this POSIX host the disposition
  // reads "not-attempted" whether or not the guard exists (the POSIX branch returns that either
  // way), so an evidence-only assertion passes with the guard removed — it was written that way
  // first and the sabotage run caught it.
  it("does not signal at all once the child has exited", async () => {
    const events = captureLog();
    const binDir = makeTempDir("keiko-lsp-exited-");
    const executable = writeExecutableFixture(binDir, "fakelsp");

    const handle = defaultLspSpawnFn(executable, [], { PATH: "/usr/bin" }, binDir);
    await new Promise<void>((resolve) => {
      handle.onExit(() => {
        resolve();
      });
    });

    const nativeKill = process.kill.bind(process);
    const signalled: number[] = [];
    process.kill = (pid: number, signal?: string | number): true => {
      signalled.push(pid);
      return nativeKill(pid, signal);
    };
    try {
      // The child is demonstrably gone; disposal still calls kill().
      handle.kill("SIGTERM");
    } finally {
      process.kill = nativeKill;
    }

    // No raw-pid signal may leave this path — that pid may already belong to someone else.
    expect(signalled).toEqual([]);
    const terminated = events.filter((event) => event.op === "lsp.process.terminated");
    expect(terminated.at(-1)?.extra?.windowsTreeKill).toBe("not-attempted");
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
  // untrusted SystemRoot on win32, or spawn itself): they share cleanupHomeOnce + logLspSpawnFailed
  // + rethrow. The spawn seam itself returns ChildProcessWithoutNullStreams because the plan fixes
  // stdio to three pipes; null stdio is not a production state.
  //
  // F2 (PR reviewer finding): the handler used to discard the real Error and always log the generic
  // `errorKind: "SPAWN_FAILED"`, so a support bundle could not tell an ENOENT apart from an EACCES
  // or a resource-limit failure. errorKind must now be the REAL classification (errorKindOf reads
  // only the error's coded `.code`, e.g. Node's own "ENOENT" — see the sibling synchronous-catch
  // test below for a second, different classification, proving the two are told apart).
  it("an async spawn failure logs lsp.spawn.failed with the real ENOENT classification, never lsp.spawn.completed, and leaks no HOME", async () => {
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
    expect(failed?.errorKind).toBe("ENOENT");
    expect(failed?.errorKind).not.toBe("SPAWN_FAILED");
    // BODY-FREE: Node's real ENOENT carries the resolved executable PATH on both `.message` and
    // `.path` (`Error: spawn <path> ENOENT`) — none of it may reach the line, in any field.
    expect(JSON.stringify(failed)).not.toContain(missing);
    // Whatever WAS emitted must survive the REAL redactor unchanged — proof it is already
    // conforming, not merely proof the redactor would have caught a violation.
    const extra = failed?.extra ?? {};
    const redacted = redactLogFields(extra) ?? {};
    expect(Object.keys(redacted).sort()).toEqual(Object.keys(extra).sort());
    const homesAfter = readdirSync(tmpdir()).filter((name) => name.startsWith("keiko-lsp-home-"));
    const leaked = homesAfter.filter((name) => !homesBefore.has(name));
    expect(leaked).toEqual([]);
  });

  it("keeps HOME owned after a post-spawn error until the child exit is observed", async () => {
    const events = captureLog();
    const binDir = makeTempDir("keiko-lsp-post-spawn-error-");
    const executable = writeNodeExecutableFixture(
      binDir,
      "hanglsp",
      "setInterval(() => {}, 1000);\n",
    );
    let nativeChild: ChildProcessWithoutNullStreams | undefined;
    let homePath = "";
    const spawnLsp = createDefaultLspSpawnFn(
      (command, args, options) => {
        nativeChild = nodeSpawn(command, args, options);
        return nativeChild;
      },
      () => {
        const home = createEphemeralHome();
        homePath = home.path;
        return home;
      },
    );

    const handle = spawnLsp(executable, [], { PATH: "/usr/bin" }, binDir);
    handle.onError(() => undefined);
    const child = nativeChild;
    if (child === undefined) throw new Error("native child missing");
    await new Promise<void>((resolve) => child.once("spawn", resolve));
    expect(existsSync(homePath)).toBe(true);

    child.emit("error", Object.assign(new Error("runtime fault"), { code: "EIO" }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events.some((event) => event.op === "lsp.spawn.failed")).toBe(false);
    const runtimeError = events.find((event) => event.op === "lsp.process.runtime-error");
    expect(runtimeError?.errorKind).toBe("EIO");
    expect(runtimeError?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
    expect(runtimeError?.extra?.childPid).toBe(child.pid);
    const runtimeExtra = runtimeError?.extra ?? {};
    expect(redactLogFields(runtimeExtra)).toEqual(runtimeExtra);
    expect(existsSync(homePath)).toBe(true);

    const exited = new Promise<void>((resolve) => {
      handle.onExit(() => {
        resolve();
      });
    });
    handle.kill("SIGTERM");
    await exited;
    expect(existsSync(homePath)).toBe(false);
  });

  // F2 (PR reviewer finding): "the synchronous catch below likewise ignores its captured error when
  // logging." A NUL byte anywhere in the executable path makes Node's real spawn() throw
  // SYNCHRONOUSLY (node:child_process's own validateArgumentNullCheck, code ERR_INVALID_ARG_VALUE) —
  // deterministic and cross-platform, unlike EACCES (a root-run process ignores POSIX permission
  // bits, so a chmod-based probe would be flaky under exactly the containers this suite runs in).
  // Node's own thrown message embeds the raw path too, making this the sharpest available
  // body-freedom probe for the synchronous branch. Because the throw is SYNCHRONOUS, the stack
  // passes through defaultLspSpawnFn's own call to spawn() before unwinding — unlike the async
  // ENOENT case above, this is real evidence that `extra.frames` is correctly wired end to end.
  it("a synchronous spawn failure logs lsp.spawn.failed with a distinct classification, real frames, and rethrows", () => {
    const events = captureLog();
    const binDir = makeTempDir("keiko-lsp-nul-");
    const withNulByte = `${join(binDir, "does-not-exist")}${String.fromCharCode(0)}`;

    expect(() => defaultLspSpawnFn(withNulByte, [], { PATH: "/usr/bin" }, binDir)).toThrow();

    const failed = events.find((event) => event.op === "lsp.spawn.failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("error");
    // A DIFFERENT real cause than the ENOENT test above yields a DIFFERENT errorKind — proof the
    // line now tells failures apart instead of collapsing every spawn failure onto one constant.
    expect(failed?.errorKind).toBe("ERR_INVALID_ARG_VALUE");
    expect(failed?.errorKind).not.toBe("SPAWN_FAILED");
    const frames = failed?.extra?.frames;
    expect(Array.isArray(frames)).toBe(true);
    const frameList = Array.isArray(frames) ? frames : [];
    expect(
      frameList.some((frame) => typeof frame === "string" && frame.includes("lspNodeAdapter.ts")),
    ).toBe(true);
    // BODY-FREE: Node's ERR_INVALID_ARG_VALUE message embeds the raw executable path verbatim
    // (`Received '<path>'`) — it must never reach the line, and neither must the temp dir it lives
    // under.
    expect(JSON.stringify(failed)).not.toContain(binDir);
    const extra = failed?.extra ?? {};
    const redacted = redactLogFields(extra) ?? {};
    expect(Object.keys(redacted).sort()).toEqual(Object.keys(extra).sort());
    // frames must survive the redactor's own re-validation (redactKeikoFrames) with every element
    // intact, not merely as a same-length array of markers.
    expect(redacted.frames).toEqual(frameList);
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
    expect(extra.treeContainment).toBe("unconfirmed");
    expect(extra.signal).toBe("SIGTERM");
    expect(typeof extra.childPid).toBe("number");
    expect(Object.keys(extra).sort()).toEqual([
      "childPid",
      "signal",
      "treeContainment",
      "windowsTreeKill",
    ]);
    const redacted = redactLogFields(extra) ?? {};
    expect(Object.keys(redacted).sort()).toEqual(Object.keys(extra).sort());
  });
});
