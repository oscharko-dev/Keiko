import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_COMMAND_RULES } from "@oscharko-dev/keiko-tools";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import {
  LspProcessError,
  createEphemeralHome,
  escalateKill,
  preflightSpawnEnv,
  resolveExecutableOutsideWorkspace,
} from "./lspNodeAdapter.js";
import type { KillScheduler, KillableChild } from "./lspNodeAdapter.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
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
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
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
    symlinkSync(realTarget, join(pathDir, "fakelsp"));
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
