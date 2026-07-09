import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdatePortableStagingSummary } from "@oscharko-dev/keiko-contracts";
import { createUpdateLocalStateManager } from "./update-local-state.js";
import { createPortableUpdateActivator } from "./update-portable-activation.js";

const TARGET_VERSION = "0.2.12";
const OLD_VERSION = "0.2.11";
const TARGET = "windows-x64";
const tempRoots: string[] = [];

function setupManifest(version: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    platformTarget: TARGET,
    packageName: "@oscharko-dev/keiko",
    packageVersion: version,
    stable: true,
    primaryLauncher: "Keiko.exe",
    bootstrapUpdateEligible: false,
    runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
  });
}

function writeInstall(root: string, version: string): void {
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(join(root, ".portable"), { recursive: true });
  mkdirSync(join(root, "runtime", "node"), { recursive: true });
  writeFileSync(join(root, "Keiko.exe"), `launcher-${version}`, "utf8");
  writeFileSync(join(root, "runtime", "node", "node.exe"), "node", "utf8");
  writeFileSync(
    join(root, "app", "package.json"),
    JSON.stringify({ name: "@oscharko-dev/keiko", version }),
    "utf8",
  );
  writeFileSync(join(root, ".portable", "setup-manifest.json"), setupManifest(version), "utf8");
}

function stageSummary(): UpdatePortableStagingSummary {
  return {
    stageId: "stage-1",
    status: "staged",
    target: TARGET,
    packageVersion: TARGET_VERSION,
    assetName: "keiko-windows-x64.zip",
    assetId: 1,
    releaseId: 2,
    sizeBytes: 3,
    sha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
}

async function makeInstall(): Promise<{
  readonly home: string;
  readonly stateDir: string;
  readonly managedRoot: string;
  readonly packageRoot: string;
  readonly stageRoot: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "keiko-portable-activation-"));
  tempRoots.push(home);
  const managedRoot = join(home, "AppData", "Local", "Programs", "Keiko");
  const packageRoot = join(managedRoot, "app");
  const stageRoot = join(dirname(managedRoot), ".keiko-portable-updates", "stage-1", "Keiko");
  writeInstall(managedRoot, OLD_VERSION);
  writeInstall(stageRoot, TARGET_VERSION);
  writeFileSync(join(managedRoot, "active.txt"), "active", "utf8");
  return {
    home,
    stateDir: join(home, ".keiko"),
    managedRoot,
    packageRoot,
    stageRoot,
  };
}

function childProcess(): ChildProcess {
  return { unref: vi.fn() } as unknown as ChildProcess;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable update activation", () => {
  it("promotes the staged install, refreshes registration, relaunches, and records redacted state", async () => {
    const install = await makeInstall();
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    const spawnCalls: [string, readonly string[], SpawnOptions][] = [];
    const spawnFn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
      spawnCalls.push([command, args, options]);
      return childProcess();
    });
    const activator = createPortableUpdateActivator({
      env: {
        KEIKO_STATE_DIR: install.stateDir,
        APPDATA: join(install.home, "AppData", "Roaming"),
        LOCALAPPDATA: join(install.home, "AppData", "Local"),
      },
      homedir: () => install.home,
      localState,
      now: () => Date.parse("2026-07-06T00:00:00.000Z"),
      spawnFn,
      versionVerifier: () => Promise.resolve(true),
    });

    const activation = await activator.activate({
      sessionId: "session-1",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
    });

    expect(activation).toMatchObject({
      status: "activated",
      packageVersion: TARGET_VERSION,
      registrationRefreshed: true,
      relaunchRequested: true,
      versionVerified: true,
    });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
    expect(existsSync(join(install.managedRoot, "active.txt"))).toBe(false);
    expect(spawnCalls[0]?.[0]).toBe(join(install.managedRoot, "Keiko.exe"));
    expect(readFileSync(join(install.stateDir, "portable-install-state.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
    const runtimeState = JSON.stringify(localState.readRuntimeState());
    expect(runtimeState).toContain("portableActivation");
    expect(runtimeState).not.toContain(install.managedRoot);
    const audit = readFileSync(join(install.stateDir, "updates", "update-audit.jsonl"), "utf8");
    expect(audit).toContain("portable-activation-result");
    expect(audit).toContain("portable-relaunch-result");
    expect(audit).not.toContain(install.managedRoot);
  });

  it("keeps the promoted install live but records failure when relaunch version is not verified", async () => {
    const install = await makeInstall();
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    const activator = createPortableUpdateActivator({
      env: {
        KEIKO_STATE_DIR: install.stateDir,
        APPDATA: join(install.home, "AppData", "Roaming"),
        LOCALAPPDATA: join(install.home, "AppData", "Local"),
      },
      homedir: () => install.home,
      localState,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(false),
    });

    await expect(
      activator.activate({
        sessionId: "session-version-miss",
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toMatchObject({ reason: "portable-version-verification-failed" });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
    expect(existsSync(join(install.managedRoot, "active.txt"))).toBe(false);
    expect(localState.readRuntimeState().portableActivation).toBeUndefined();
    const audit = readFileSync(join(install.stateDir, "updates", "update-audit.jsonl"), "utf8");
    expect(audit).toContain("portable-activation-result");
    expect(audit).toContain('"status":"failed"');
    expect(audit).not.toContain("portable-relaunch-result");
    expect(audit).not.toContain(install.managedRoot);
  });

  it("refreshes a quoted Windows shortcut when the managed launcher path contains spaces", async () => {
    const base = await mkdtemp(join(tmpdir(), "keiko-portable-activation-"));
    tempRoots.push(base);
    const home = join(base, "User Profile");
    const managedRoot = join(home, "AppData", "Local", "Programs", "Keiko App");
    const packageRoot = join(managedRoot, "app");
    const stageRoot = join(dirname(managedRoot), ".keiko-portable-updates", "stage-1", "Keiko");
    const stateDir = join(home, ".keiko");
    writeInstall(managedRoot, OLD_VERSION);
    writeInstall(stageRoot, TARGET_VERSION);
    const activator = createPortableUpdateActivator({
      env: {
        KEIKO_STATE_DIR: stateDir,
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
      },
      homedir: () => home,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });

    await activator.activate({
      sessionId: "session-spaced-shortcut",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot, portableStateDir: stateDir },
    });

    const shortcutPath = join(
      home,
      "AppData",
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Keiko.bat",
    );
    expect(readFileSync(shortcutPath, "utf8")).toBe(
      `@start "" "${join(managedRoot, "Keiko.exe")}" start --open\r\n`,
    );
  });

  it("fails closed and preserves the active install when the staged candidate is incomplete", async () => {
    const install = await makeInstall();
    await rm(join(install.stageRoot, "Keiko.exe"), { force: true });
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      localState: createUpdateLocalStateManager({ stateDir: install.stateDir }),
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(
      activator.activate({
        sessionId: "session-2",
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toMatchObject({ reason: "portable-activation-failed" });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(join(install.managedRoot, "active.txt"), "utf8")).toBe("active");
  });

  it("restores the active install when registration refresh fails before relaunch", async () => {
    const install = await makeInstall();
    const unsafeStateTarget = join(install.home, "unsafe-state-target");
    mkdirSync(unsafeStateTarget);
    symlinkSync(unsafeStateTarget, install.stateDir, "dir");
    const spawnFn = vi.fn(() => childProcess());
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn,
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(
      activator.activate({
        sessionId: "session-3",
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toMatchObject({ reason: "portable-activation-failed" });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(join(install.managedRoot, "active.txt"), "utf8")).toBe("active");
  });
});
