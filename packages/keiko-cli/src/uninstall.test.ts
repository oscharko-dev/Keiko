import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUninstallCli, type UninstallCliDeps } from "./uninstall.js";
import { runLauncherCli } from "./launcher.js";
import { runPortableCli } from "./portable.js";
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
const NOW = new Date("2026-07-06T00:00:00.000Z");
const REAL_TMPDIR = realpathSync(tmpdir());

function makeRoot(): string {
  const root = mkdtempSync(join(REAL_TMPDIR, "keiko-uninstall-"));
  tempRoots.push(root);
  return root;
}

function makePolicyAllowedRoot(prefix: string): string {
  const cwdParent = dirname(process.cwd());
  const parent = cwdParent.startsWith(REAL_TMPDIR) ? homedir() : cwdParent;
  const root = mkdtempSync(join(parent, `.keiko-${prefix}-`));
  tempRoots.push(root);
  return root;
}

function makePortableHome(): string {
  return makePolicyAllowedRoot("portable-home");
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

function windowsPortableEnv(home: string): {
  readonly APPDATA: string;
  readonly LOCALAPPDATA: string;
} {
  return {
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
  };
}

function writePortableApp(appRoot: string, version = "0.2.11"): void {
  mkdirSync(join(appRoot, "dist", "cli"), { recursive: true });
  writeFileSync(
    join(appRoot, "package.json"),
    `${JSON.stringify({ name: "@oscharko-dev/keiko", version }, null, 2)}\n`,
  );
  writeFileSync(join(appRoot, "dist", "cli", "index.js"), "fixture cli\n");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writePortableWindowsFixture(root: string, version = "0.2.11"): void {
  mkdirSync(join(root, "runtime", "node"), { recursive: true });
  mkdirSync(join(root, ".portable"), { recursive: true });
  writePortableApp(join(root, "app"), version);
  writeFileSync(join(root, "runtime", "node", "node.exe"), "fixture node\n");
  writeFileSync(join(root, "Keiko.exe"), "fixture launcher\n");
  writeFileSync(
    join(root, ".portable", "setup-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platformTarget: "windows-x64",
        packageName: "@oscharko-dev/keiko",
        packageVersion: version,
        stable: true,
        primaryLauncher: "Keiko.exe",
        bootstrapUpdateEligible: false,
        runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
      },
      null,
      2,
    )}\n`,
  );
}

async function installPortableWindows(
  root: string,
  options: { readonly managedRoot?: string | undefined; readonly home?: string | undefined } = {},
): Promise<{
  readonly home: string;
  readonly managedRoot: string;
  readonly shortcut: string;
  readonly env: { readonly APPDATA: string; readonly LOCALAPPDATA: string };
}> {
  const home = options.home ?? makePortableHome();
  const source = join(root, "portable-bootstrap");
  const env = windowsPortableEnv(home);
  const managedRoot = options.managedRoot ?? join(env.LOCALAPPDATA, "Programs", "Keiko");
  const shortcut = join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.bat");
  writePortableWindowsFixture(source);
  const c = makeIo();
  const code = await runPortableCli(
    [
      "setup",
      "--target",
      "windows-x64",
      "--portable-root",
      source,
      "--managed-root",
      managedRoot,
      "--state-dir",
      join(root, ".keiko"),
    ],
    c.io,
    env,
    { homedir: () => home, now: () => NOW },
  );
  expect(code).toBe(0);
  return { home, managedRoot, shortcut, env };
}

function writePortableMacFixture(root: string, target: "macos-arm64" | "macos-x64"): void {
  const app = join(root, "Keiko.app");
  const resources = join(app, "Contents", "Resources");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(resources, "runtime", "node", "bin"), { recursive: true });
  mkdirSync(join(resources, ".portable"), { recursive: true });
  writePortableApp(join(resources, "app"));
  writeFileSync(join(resources, "runtime", "node", "bin", "node"), "fixture node\n");
  writeFileSync(join(app, "Contents", "MacOS", "Keiko"), "fixture launcher\n");
  writeFileSync(
    join(resources, ".portable", "setup-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platformTarget: target,
        packageName: "@oscharko-dev/keiko",
        packageVersion: "0.2.11",
        stable: true,
        primaryLauncher: "Keiko.app",
        bootstrapUpdateEligible: false,
        runtime: {
          nodePlatform: "darwin",
          nodeArchitecture: target === "macos-arm64" ? "arm64" : "x64",
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function installPortableMacCustom(root: string): Promise<{
  readonly home: string;
  readonly managedRoot: string;
}> {
  const home = makePortableHome();
  const source = join(root, "portable-bootstrap");
  const managedRoot = join(home, "Portable Apps", "Keiko.app");
  writePortableMacFixture(source, "macos-x64");
  const c = makeIo();
  const code = await runPortableCli(
    [
      "setup",
      "--target",
      "macos-x64",
      "--portable-root",
      source,
      "--managed-root",
      managedRoot,
      "--state-dir",
      join(root, ".keiko"),
    ],
    c.io,
    {},
    { homedir: () => home, now: () => NOW },
  );
  expect(code).toBe(0);
  return { home, managedRoot };
}

function tamperPortableRecordToRepoRoot(
  managedRoot: string,
  shortcut: string,
  stateDir: string,
): string {
  const invalidBase = mkdtempSync(join(process.cwd(), ".keiko-portable-policy-invalid-"));
  tempRoots.push(invalidBase);
  const invalidRoot = join(invalidBase, "Keiko");
  cpSync(managedRoot, invalidRoot, { recursive: true });
  unlinkSync(shortcut);
  const statePath = join(stateDir, "portable-install-state.json");
  const registration = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  const realInvalidRoot = realpathSync(invalidRoot);
  registration.managedRootLocator = { kind: "absolute-local", path: realInvalidRoot };
  registration.installRootIdentitySha256 = sha256Text(realInvalidRoot);
  registration.setupManifestSha256 = sha256File(
    join(invalidRoot, ".portable", "setup-manifest.json"),
  );
  registration.launcherIdentitySha256 = sha256File(join(invalidRoot, "Keiko.exe"));
  writeFileSync(statePath, `${JSON.stringify(registration, null, 2)}\n`, "utf8");
  return invalidRoot;
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

  it("exits 1 gracefully when package.json cannot be written", () => {
    // Skip where the read-only bit does not block the owner (Windows, or running as root).
    if (process.platform === "win32") return;
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const root = makeRoot();
    const pkg = seedPackageJson(root);
    chmodSync(pkg, 0o444);
    const c = makeIo();
    const code = runUninstallCli(["--scripts"], c.io, {}, { cwd: root, homedir: () => root });
    chmodSync(pkg, 0o644); // restore so afterEach cleanup can remove it
    expect(code).toBe(1);
    expect(c.err()).toContain("keiko uninstall:");
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

describe("runUninstallCli — portable managed install", () => {
  it("removes the attested managed install and user-local Start Menu registration", async () => {
    const root = makeRoot();
    const { home, managedRoot, shortcut, env } = await installPortableWindows(root);
    const c = makeIo();

    expect(runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home })).toBe(0);
    expect(existsSync(managedRoot)).toBe(false);
    expect(existsSync(shortcut)).toBe(false);
    expect(existsSync(join(root, ".keiko"))).toBe(false);
  });

  it("refuses a modified Start Menu registration and keeps the managed install", async () => {
    const root = makeRoot();
    const { home, managedRoot, shortcut, env } = await installPortableWindows(root);
    writeFileSync(shortcut, "tampered content\r\n", "utf8");
    const c = makeIo();

    expect(runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home })).toBe(1);
    expect(existsSync(managedRoot)).toBe(true);
    expect(existsSync(shortcut)).toBe(true);
    expect(c.err()).toContain("portable registration refused unknown artifact");
  });

  it("refuses a symlink inside the managed install and keeps the portable state", async () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    const { home, managedRoot, shortcut, env } = await installPortableWindows(root);
    writeFileSync(join(root, "outside.txt"), "keep", "utf8");
    symlinkSync(join(root, "outside.txt"), join(managedRoot, "app", "rogue-link"));
    const c = makeIo();

    expect(runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home })).toBe(1);
    expect(existsSync(managedRoot)).toBe(true);
    expect(existsSync(shortcut)).toBe(true);
    expect(existsSync(join(root, ".keiko", "portable-install-state.json"))).toBe(true);
    expect(c.err()).toContain("portable managed install refused symlink");
  });

  it("refuses a nested unknown portable app file and preserves the Start Menu registration", async () => {
    const root = makeRoot();
    const { home, managedRoot, shortcut, env } = await installPortableWindows(root);
    writeFileSync(join(managedRoot, "app", "rogue.txt"), "rogue\n", "utf8");
    const c = makeIo();

    expect(runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home })).toBe(1);
    expect(existsSync(managedRoot)).toBe(true);
    expect(existsSync(shortcut)).toBe(true);
    expect(c.err()).toContain("app/rogue.txt");
  });

  it("removes a custom-root Windows install even when the Start Menu registration is missing", async () => {
    const root = makeRoot();
    const home = makePortableHome();
    const customRoot = join(home, "PortableApps", "Keiko");
    const { managedRoot, shortcut, env } = await installPortableWindows(root, {
      home,
      managedRoot: customRoot,
    });
    rmSync(shortcut, { force: true });
    const c = makeIo();

    expect(runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home })).toBe(0);
    expect(existsSync(managedRoot)).toBe(false);
    expect(existsSync(join(root, ".keiko"))).toBe(false);
  });

  it("removes a macOS custom managed root using the local record hint", async () => {
    const root = makeRoot();
    const { home, managedRoot } = await installPortableMacCustom(root);
    const c = makeIo();

    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => home })).toBe(0);
    expect(existsSync(managedRoot)).toBe(false);
    expect(existsSync(join(root, ".keiko"))).toBe(false);
  });

  it("refuses a locator tampered toward a policy-invalid repository root even when hashes match", async () => {
    const root = makeRoot();
    const home = makePortableHome();
    const customRoot = join(home, "PortableApps", "Keiko");
    const { managedRoot, shortcut, env } = await installPortableWindows(root, {
      home,
      managedRoot: customRoot,
    });
    const invalidRoot = tamperPortableRecordToRepoRoot(managedRoot, shortcut, join(root, ".keiko"));
    const c = makeIo();

    expect(runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home })).toBe(1);
    expect(existsSync(invalidRoot)).toBe(true);
    expect(existsSync(managedRoot)).toBe(true);
    expect(existsSync(join(root, ".keiko", "portable-install-state.json"))).toBe(true);
    expect(c.err()).toContain("could not be attested");
  });

  it("refuses a symlinked Start Menu ancestor without deleting outside artifacts", async () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    const { home, managedRoot, shortcut, env } = await installPortableWindows(root);
    const programsDir = join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
    const outsidePrograms = join(root, "outside-programs");
    mkdirSync(outsidePrograms, { recursive: true });
    const outsideShortcut = join(outsidePrograms, "Keiko.bat");
    writeFileSync(outsideShortcut, readFileSync(shortcut, "utf8"), "utf8");
    rmSync(programsDir, { recursive: true, force: true });
    symlinkSync(outsidePrograms, programsDir, "dir");
    const c = makeIo();

    expect(runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home })).toBe(1);
    expect(existsSync(managedRoot)).toBe(true);
    expect(readFileSync(outsideShortcut, "utf8")).toContain("Keiko.exe");
    expect(c.err()).toContain("portable registration refused symlinked ancestor");
  });
});

// ─── uninstall --state runtime-state manifest (Issue #1321) ───────────────────

function seedFullState(root: string, pid = "2147483646"): string {
  const stateDir = join(root, ".keiko");
  mkdirSync(join(stateDir, "credentials"), { recursive: true });
  mkdirSync(join(stateDir, "memory"), { recursive: true });
  mkdirSync(join(stateDir, "local-knowledge", "default"), { recursive: true });
  mkdirSync(join(stateDir, "evidence", "figma"), { recursive: true });
  mkdirSync(join(stateDir, "evidence", "qi", "figma-snapshots", "run-1"), { recursive: true });
  const files: Record<string, string> = {
    "ui.pid": `${pid}\n`,
    "ui.log": "log\n",
    "keiko-ui.db": "db",
    "keiko-ui.db-wal": "wal",
    "keiko-ui.db-shm": "shm",
    "keiko-ui.db.corrupt.2026-06-20T12-00-00-000Z": "quarantine",
    "keiko.config.json": "{}",
    "credentials/provider-credentials.vault": "sealed",
    "credentials/provider-credentials-vault.key": "key",
    "credentials/.secret-vault.1234.deadbeefdeadbeef.tmp": "temp",
    "memory/keiko-memory.db": "db",
    "memory/keiko-memory.db-wal": "wal",
    "memory/keiko-memory.db-wal.corrupt.2026-06-20T12-00-00-000Z": "quarantine",
    "local-knowledge/default/capsules.db": "db",
    "local-knowledge/default/capsules.db-shm": "shm",
    "evidence/run-1.json": "{}",
    "evidence/run-1.json.123e4567-e89b-12d3-a456-426614174000.tmp": "{}",
    "evidence/figma/figma-token.vault": "sealed",
    "evidence/figma/figma-vault.key": "key",
    "evidence/qi/run-1.qi.json": "{}",
    "evidence/qi/run-1.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp": "{}",
    "evidence/qi/run-1.candidates.json": "{}",
    "evidence/qi/run-1.review.json": "{}",
    "evidence/qi/run-1.figma-snapshot.management.json": "{}",
    "evidence/qi/figma-snapshots/run-1/screen.png": "img",
  };
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(stateDir, rel), body, "utf8");
  return stateDir;
}

describe("runUninstallCli — runtime state manifest", () => {
  it("removes every Keiko-owned sensitive artifact and then the state dir", () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("with --state --dry-run lists the sensitive artifacts without removing them", () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const c = makeIo();
    expect(
      runUninstallCli(["--state", "--dry-run"], c.io, {}, { cwd: root, homedir: () => root }),
    ).toBe(0);
    const out = c.out();
    expect(out).toContain(join(stateDir, "keiko-ui.db"));
    expect(out).toContain(join(stateDir, "memory", "keiko-memory.db"));
    expect(out).toContain(join(stateDir, "credentials", "provider-credentials.vault"));
    expect(out).toContain(join(stateDir, "credentials", ".secret-vault.1234.deadbeefdeadbeef.tmp"));
    expect(out).toContain(join(stateDir, "credentials", "provider-credentials-vault.key"));
    expect(out).toContain(join(stateDir, "evidence", "figma", "figma-token.vault"));
    expect(out).toContain(join(stateDir, "evidence", "figma", "figma-vault.key"));
    expect(out).toContain(join(stateDir, "evidence", "qi", "run-1.qi.json"));
    expect(out).toContain(
      join(stateDir, "evidence", "qi", "run-1.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp"),
    );
    // Nothing actually removed.
    expect(existsSync(join(stateDir, "keiko-ui.db"))).toBe(true);
    expect(existsSync(stateDir)).toBe(true);
  });

  it("removes WAL/SHM and quarantine sidecars alongside every database", () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    for (const rel of [
      "keiko-ui.db-wal",
      "keiko-ui.db-shm",
      "keiko-ui.db.corrupt.2026-06-20T12-00-00-000Z",
      "memory/keiko-memory.db-wal",
      "memory/keiko-memory.db-wal.corrupt.2026-06-20T12-00-00-000Z",
      "local-knowledge/default/capsules.db-shm",
      "evidence/figma/figma-vault.key",
    ]) {
      expect(existsSync(join(stateDir, rel))).toBe(false);
    }
  });

  it("keeps a customer file and the state dir, but still removes Keiko artifacts", () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const userFile = join(stateDir, "user-notes.txt");
    writeFileSync(userFile, "keep me\n", "utf8");
    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(userFile)).toBe(true);
    expect(existsSync(join(stateDir, "keiko-ui.db"))).toBe(false);
    expect(existsSync(join(stateDir, "credentials", "provider-credentials.vault"))).toBe(false);
    expect(c.out()).toContain("non-Keiko entr");
  });

  it("refuses to follow a symlink and keeps the state dir", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const outsideTarget = join(root, "outside-secret.txt");
    writeFileSync(outsideTarget, "do not delete\n", "utf8");
    symlinkSync(outsideTarget, join(stateDir, "evil-link"));
    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(existsSync(outsideTarget)).toBe(true); // never followed
    expect(existsSync(join(stateDir, "evil-link"))).toBe(true); // left in place
    expect(existsSync(stateDir)).toBe(true);
    expect(c.out()).toContain("symlink — not followed");
  });

  it("refuses a symlinked state root without deleting the target tree", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    const target = join(root, "outside-state");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keiko-ui.db"), "db", "utf8");
    symlinkSync(target, join(root, ".keiko"), "dir");

    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(1);
    expect(c.err()).toContain("refusing to use symlinked state directory");
    expect(existsSync(join(target, "keiko-ui.db"))).toBe(true);
    expect(existsSync(join(root, ".keiko"))).toBe(true);
  });

  it("refuses a non-directory state root without crashing", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".keiko"), "not a directory", "utf8");

    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(1);
    expect(c.err()).toContain("refusing to use non-directory state path");
    expect(existsSync(join(root, ".keiko"))).toBe(true);
  });

  it("keeps customer lookalikes in known state subdirectories", () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const kept = [
      "evidence/manual export.json",
      "evidence/manual export.lock",
      "evidence/qi/debug dump.json",
      "evidence/qi/run-1.notes.json",
      "credentials/backup.key",
      "credentials/backup.vault",
      "credentials/.secret-vault.abc.deadbeefdeadbeef.tmp",
      "evidence/figma/backup.key",
      "evidence/figma/backup.vault",
      "evidence/manual export.json.123e4567-e89b-12d3-a456-426614174000.tmp",
      "evidence/qi/debug dump.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp",
    ];
    for (const rel of kept) writeFileSync(join(stateDir, rel), "customer", "utf8");
    mkdirSync(join(stateDir, "local-knowledge", "notes"), { recursive: true });

    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(existsSync(stateDir)).toBe(true);
    for (const rel of kept) expect(existsSync(join(stateDir, rel))).toBe(true);
    expect(existsSync(join(stateDir, "local-knowledge", "notes"))).toBe(true);
    expect(existsSync(join(stateDir, "keiko-ui.db"))).toBe(false);
    expect(existsSync(join(stateDir, "credentials", "provider-credentials.vault"))).toBe(false);
    expect(c.out()).toContain("not a recognized Keiko artifact");
  });

  it("keeps an owned-looking hardlink and reports why the state dir remains", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const outsideDb = join(root, "outside-db");
    writeFileSync(outsideDb, "db", "utf8");
    rmSync(join(stateDir, "keiko-ui.db"), { force: true });
    linkSync(outsideDb, join(stateDir, "keiko-ui.db"));

    const c = makeIo();
    expect(runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root })).toBe(0);
    expect(existsSync(outsideDb)).toBe(true);
    expect(existsSync(join(stateDir, "keiko-ui.db"))).toBe(true);
    expect(c.out()).toContain("hardlink — not modified or removed");
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
