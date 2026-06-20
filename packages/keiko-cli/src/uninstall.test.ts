import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUninstallCli, type UninstallCliDeps } from "./uninstall.js";
import { runLauncherCli } from "./launcher.js";
import { KEIKO_START_SCRIPT, KEIKO_STOP_SCRIPT } from "./init.js";
import type { CliIo } from "./runner.js";

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function makeIo(): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-uninstall-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedState(root: string, pid = "2147483646"): string {
  const stateDir = join(root, ".keiko");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ui.pid"), `${pid}\n`, "utf8");
  writeFileSync(join(stateDir, "ui.log"), "log line\n", "utf8");
  return stateDir;
}

function seedPackageJson(root: string, extra: Record<string, string> = {}): string {
  const path = join(root, "package.json");
  const scripts = { "keiko:start": KEIKO_START_SCRIPT, "keiko:stop": KEIKO_STOP_SCRIPT, ...extra };
  writeFileSync(path, `${JSON.stringify({ name: "demo", scripts }, null, 2)}\n`, "utf8");
  return path;
}

function readScripts(path: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
}

function installLauncher(root: string): { stateDir: string; shortcut: string } {
  const stateDir = join(root, ".keiko");
  const deps = {
    cwd: root,
    homedir: (): string => root,
    platform: (): NodeJS.Platform => "linux",
    resolveExe: (): string => "/usr/local/bin/keiko",
    stateDir,
  };
  const c = makeIo();
  const code = runLauncherCli(["install"], c.io, {}, deps);
  expect(code).toBe(0);
  return { stateDir, shortcut: join(root, ".local", "share", "applications", "keiko.desktop") };
}

describe("runUninstallCli — usage", () => {
  it("prints help and exits 0", () => {
    const c = makeIo();
    expect(runUninstallCli(["--help"], c.io, {})).toBe(0);
    expect(c.out()).toContain("keiko uninstall");
  });

  it("rejects an unknown flag with exit 2", () => {
    const c = makeIo();
    expect(runUninstallCli(["--bogus"], c.io, {})).toBe(2);
    expect(c.err()).toContain("Usage:");
  });

  it("rejects a valued flag missing its value with exit 2", () => {
    const c = makeIo();
    expect(runUninstallCli(["--state-dir"], c.io, {})).toBe(2);
  });
});

describe("runUninstallCli — dry run", () => {
  it("reports would-remove without changing anything", () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const pkg = seedPackageJson(root, { custom: "echo hi" });
    const c = makeIo();
    const deps: UninstallCliDeps = { cwd: root, homedir: () => root };
    expect(runUninstallCli(["--dry-run"], c.io, {}, deps)).toBe(0);
    expect(c.out()).toContain("would-remove");
    expect(c.out()).toContain("To remove the package itself");
    // Nothing actually removed.
    expect(existsSync(join(stateDir, "ui.pid"))).toBe(true);
    expect(readScripts(pkg)["keiko:start"]).toBe(KEIKO_START_SCRIPT);
  });
});

describe("runUninstallCli — apply", () => {
  it("removes state, keiko scripts (keeping custom), and prints guidance", () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const pkg = seedPackageJson(root, { custom: "echo hi" });
    const c = makeIo();
    const deps: UninstallCliDeps = { cwd: root, homedir: () => root };
    expect(runUninstallCli([], c.io, {}, deps)).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
    const scripts = readScripts(pkg);
    expect(scripts["keiko:start"]).toBeUndefined();
    expect(scripts["keiko:stop"]).toBeUndefined();
    expect(scripts.custom).toBe("echo hi");
  });

  it("with --scripts only, leaves the state directory untouched", () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const pkg = seedPackageJson(root);
    const c = makeIo();
    expect(runUninstallCli(["--scripts"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(existsSync(stateDir)).toBe(true);
    expect(readScripts(pkg)["keiko:start"]).toBeUndefined();
  });

  it("with --state only, leaves package.json scripts untouched", () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const pkg = seedPackageJson(root);
    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
    expect(readScripts(pkg)["keiko:start"]).toBe(KEIKO_START_SCRIPT);
  });

  it("keeps a customized keiko:start script", () => {
    const root = makeRoot();
    const pkg = seedPackageJson(root, { "keiko:start": "my custom start" });
    const c = makeIo();
    expect(runUninstallCli(["--scripts"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(readScripts(pkg)["keiko:start"]).toBe("my custom start");
    expect(c.out()).toContain("kept: keiko:start");
  });

  it("keeps the state directory when it holds non-Keiko files", () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    writeFileSync(join(stateDir, "user-notes.txt"), "keep me\n", "utf8");
    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(join(stateDir, "user-notes.txt"))).toBe(true);
    expect(existsSync(join(stateDir, "ui.pid"))).toBe(false);
    expect(c.out()).toContain("non-Keiko entr");
  });

  it("sweeps leftover launcher temp dirs", () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    mkdirSync(join(stateDir, ".launcher-state-abc123"), { recursive: true });
    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });
});

describe("runUninstallCli — scripts edge cases", () => {
  it("reports a missing package.json without failing", () => {
    const root = makeRoot();
    const c = makeIo();
    expect(runUninstallCli(["--scripts"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(c.out()).toContain("package.json not found");
  });

  it("skips an invalid package.json with a stderr note", () => {
    const root = makeRoot();
    writeFileSync(join(root, "package.json"), "{not json", "utf8");
    const c = makeIo();
    expect(runUninstallCli(["--scripts"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(c.err()).toContain("not valid JSON");
  });

  it("reports when there are no keiko scripts to remove", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "x" }, null, 2)}\n`,
      "utf8",
    );
    const c = makeIo();
    expect(runUninstallCli(["--scripts"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(c.out()).toContain("no keiko:start / keiko:stop scripts");
  });

  it("honors a custom --package path", () => {
    const root = makeRoot();
    const nested = join(root, "nested");
    mkdirSync(nested, { recursive: true });
    const pkg = seedPackageJson(nested);
    const c = makeIo();
    expect(
      runUninstallCli(
        ["--scripts", "--package", "nested/package.json"],
        c.io,
        {},
        { cwd: root, homedir: () => root },
      ),
    ).toBe(0);
    expect(readScripts(pkg)["keiko:start"]).toBeUndefined();
  });
});

describe("runUninstallCli — state directory edge cases", () => {
  it("reports an absent state directory", () => {
    const root = makeRoot();
    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(c.out()).toContain("not found (nothing to remove)");
  });

  it("honors a custom --state-dir", () => {
    const root = makeRoot();
    const custom = join(root, "custom-state");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "ui.log"), "x\n", "utf8");
    const c = makeIo();
    expect(
      runUninstallCli(
        ["--state", "--state-dir", "custom-state"],
        c.io,
        {},
        { cwd: root, homedir: () => root },
      ),
    ).toBe(0);
    expect(existsSync(custom)).toBe(false);
  });

  it("resolves the state directory from KEIKO_STATE_DIR", () => {
    const root = makeRoot();
    const envDir = join(root, "env-state");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "ui.log"), "x\n", "utf8");
    const c = makeIo();
    expect(
      runUninstallCli(
        ["--state"],
        c.io,
        { KEIKO_STATE_DIR: envDir },
        { cwd: root, homedir: () => root },
      ),
    ).toBe(0);
    expect(existsSync(envDir)).toBe(false);
  });
});

describe("runUninstallCli — running server guard", () => {
  it("refuses to remove state while the UI is running", () => {
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    const c = makeIo();
    const deps: UninstallCliDeps = { cwd: root, homedir: () => root, isProcessAlive: () => true };
    expect(runUninstallCli(["--state"], c.io, {}, deps)).toBe(1);
    expect(c.err()).toContain("is running");
    expect(existsSync(join(stateDir, "ui.pid"))).toBe(true);
  });

  it("stops the running UI with --force and removes state", () => {
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      isProcessAlive: () => true,
      killProcess: (pid, signal) => {
        killed.push([pid, signal]);
      },
    };
    const c = makeIo();
    expect(runUninstallCli(["--state", "--force"], c.io, {}, deps)).toBe(0);
    expect(killed).toEqual([[555, "SIGTERM"]]);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("with --force --dry-run reports would-stop and does not kill", () => {
    const root = makeRoot();
    seedState(root, "555");
    let killCount = 0;
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      isProcessAlive: () => true,
      killProcess: () => {
        killCount += 1;
      },
    };
    const c = makeIo();
    expect(runUninstallCli(["--state", "--force", "--dry-run"], c.io, {}, deps)).toBe(0);
    expect(c.out()).toContain("would-stop");
    expect(killCount).toBe(0);
  });

  it("swallows a kill error when the process already exited", () => {
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      isProcessAlive: () => true,
      killProcess: () => {
        throw new Error("ESRCH");
      },
    };
    const c = makeIo();
    expect(runUninstallCli(["--state", "--force"], c.io, {}, deps)).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("does not invoke the running-server guard when state is out of scope", () => {
    const root = makeRoot();
    seedPackageJson(root);
    seedState(root, "555");
    let killCount = 0;
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      isProcessAlive: () => true,
      killProcess: () => {
        killCount += 1;
      },
    };
    const c = makeIo();
    expect(runUninstallCli(["--scripts"], c.io, {}, deps)).toBe(0);
    expect(killCount).toBe(0);
  });
});

describe("runUninstallCli — launcher integration", () => {
  it("removes a recorded launcher shortcut", () => {
    const root = makeRoot();
    const { shortcut } = installLauncher(root);
    expect(existsSync(shortcut)).toBe(true);
    const c = makeIo();
    expect(runUninstallCli(["--launchers"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(existsSync(shortcut)).toBe(false);
  });

  it("refuses to delete a modified shortcut and exits 1", () => {
    const root = makeRoot();
    const { shortcut } = installLauncher(root);
    writeFileSync(shortcut, "tampered content\n", "utf8");
    const c = makeIo();
    expect(runUninstallCli(["--launchers"], c.io, {}, { cwd: root, homedir: () => root })).toBe(1);
    expect(existsSync(shortcut)).toBe(true);
    expect(c.err()).toContain("refusing");
  });

  it("reports nothing to remove when no shortcuts are recorded", () => {
    const root = makeRoot();
    const c = makeIo();
    expect(runUninstallCli(["--launchers"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(c.out()).toContain("nothing to remove");
  });

  it("surfaces a LauncherError (symlinked state file) as exit 1", () => {
    const root = makeRoot();
    installLauncher(root);
    const stateFile = join(root, ".keiko", "launcher-state.json");
    rmSync(stateFile, { force: true });
    symlinkSync(join(root, "elsewhere.json"), stateFile);
    const c = makeIo();
    expect(runUninstallCli(["--launchers"], c.io, {}, { cwd: root, homedir: () => root })).toBe(1);
    expect(c.err()).toContain("symlink");
  });
});

describe("runUninstallCli — package guidance", () => {
  it("lists the local uninstall command first when a local install exists", () => {
    const root = makeRoot();
    mkdirSync(join(root, "node_modules", "@oscharko-dev", "keiko"), { recursive: true });
    const c = makeIo();
    expect(runUninstallCli([], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    const out = c.out();
    const localIdx = out.indexOf("local install in this project");
    const globalIdx = out.indexOf("if also installed globally");
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(localIdx).toBeLessThan(globalIdx);
  });

  it("lists the global uninstall command first when no local install exists", () => {
    const root = makeRoot();
    const c = makeIo();
    expect(runUninstallCli([], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(c.out()).toContain("npm uninstall -g @oscharko-dev/keiko     (global install)");
  });
});
