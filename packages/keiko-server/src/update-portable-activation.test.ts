import { mkdtemp, rm } from "node:fs/promises";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdatePortableStagingSummary } from "@oscharko-dev/keiko-contracts";
import { createUpdateLocalStateManager } from "./update-local-state.js";
import { createPortableUpdateActivator } from "./update-portable-activation.js";
import {
  activationIdFor,
  capturePortableRegistration,
  readPortableActivationRecovery,
  readWindowsPortableShortcutTarget,
  refreshPortableShortcut,
} from "./update-portable-activation-files.js";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";
import {
  parseWindowsShortcutFallback,
  windowsShortcutFallbackContent,
} from "@oscharko-dev/keiko-security";

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
  copyFileSync(process.execPath, join(root, "Keiko.exe"));
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

function filesUnder(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable update activation", () => {
  it.each([
    "",
    ".",
    "..",
    "nested/stage",
    "nested\\stage",
    "/absolute",
    "C:\\stage",
    "bad\u0000id",
  ])("rejects unsafe stage id %j before install or registration mutation", async (stageId) => {
    const install = await makeInstall();
    const registrationPath = join(install.stateDir, "portable-install-state.json");
    mkdirSync(install.stateDir, { recursive: true });
    writeFileSync(registrationPath, "old-registration\n", "utf8");
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(
      activator.activate({
        sessionId: "unsafe-stage",
        targetVersion: TARGET_VERSION,
        stage: { ...stageSummary(), stageId },
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toMatchObject({ reason: "portable-activation-failed" });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(registrationPath, "utf8")).toBe("old-registration\n");
  });

  it.each([
    "",
    ".",
    "..",
    "nested/stage",
    "nested\\stage",
    "/absolute",
    "C:\\stage",
    "bad\u0000id",
  ])("rejects unsafe recovery stage id %j", async (stageId) => {
    const install = await makeInstall();
    mkdirSync(join(install.stateDir, "updates"), { recursive: true });
    writeFileSync(
      join(install.stateDir, "updates", "portable-activation-recovery.json"),
      JSON.stringify({ activationId: "a".repeat(32), stageId, target: TARGET, phase: "prepared" }),
      "utf8",
    );

    expect(() => readPortableActivationRecovery(install.stateDir)).toThrow(
      "portable activation recovery metadata is malformed",
    );
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
  });

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

  it("restores the previously working install and retains staging when relaunch version is not verified", async () => {
    const install = await makeInstall();
    const registrationPath = join(install.stateDir, "portable-install-state.json");
    mkdirSync(install.stateDir, { recursive: true });
    writeFileSync(registrationPath, '{"packageVersion":"0.2.14"}\n', "utf8");
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
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(join(install.managedRoot, "active.txt"), "utf8")).toBe("active");
    expect(readFileSync(registrationPath, "utf8")).toBe('{"packageVersion":"0.2.14"}\n');
    expect(readFileSync(join(install.stageRoot, "app", "package.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
    expect(localState.readRuntimeState().portableActivation).toBeUndefined();
    const audit = readFileSync(join(install.stateDir, "updates", "update-audit.jsonl"), "utf8");
    expect(audit).toContain("portable-activation-result");
    expect(audit).toContain('"status":"failed"');
    expect(audit).not.toContain("portable-relaunch-result");
    expect(audit).not.toContain(install.managedRoot);
    expect(existsSync(join(install.stateDir, "updates", "portable-activation-recovery.json"))).toBe(
      false,
    );
  });

  // KEIKO-0493: a cancellation landing between requestRelaunch() and the relaunch's own
  // version-verification poll used to roll back the promoted layout while a live process,
  // spawned against exactly those files, was starting up. `kill` appeared nowhere in the
  // module before this fix, so the spawned child simply outlived the rollback.
  it("terminates an already-spawned relaunch before rolling the promotion back (KEIKO-0493)", async () => {
    const install = await makeInstall();
    mkdirSync(install.stateDir, { recursive: true });
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    // Ordering matters, not just the call: a rollback that restored the old install BEFORE
    // killing the child would still satisfy a bare toHaveBeenCalled. Assert inside the mock
    // that the promoted layout is still in place when the signal is sent.
    const kill = vi.fn(() => {
      expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(
        TARGET_VERSION,
      );
      return true;
    });
    const activator = createPortableUpdateActivator({
      env: {
        KEIKO_STATE_DIR: install.stateDir,
        APPDATA: join(install.home, "AppData", "Roaming"),
        LOCALAPPDATA: join(install.home, "AppData", "Local"),
      },
      homedir: () => install.home,
      localState,
      spawnFn: () => ({ unref: vi.fn(), kill }) as unknown as ChildProcess,
      // Fails verification AFTER the relaunch has been spawned — exactly the window the
      // finding describes.
      versionVerifier: () => Promise.resolve(false),
    });

    await expect(
      activator.activate({
        sessionId: "session-relaunch-rollback",
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toMatchObject({ reason: "portable-version-verification-failed" });

    expect(kill).toHaveBeenCalledTimes(1);
    // The rollback itself still completed — terminating the child must not replace it.
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
  });

  it("refreshes a quoted Windows shortcut when the managed launcher path contains spaces", async () => {
    const base = await mkdtemp(join(tmpdir(), "keiko-portable-activation-"));
    tempRoots.push(base);
    const home = join(base, "User Profile");
    const managedRoot = join(home, "AppData", "Local", "Programs", "Keiko App");
    const packageRoot = join(managedRoot, "app");
    const stageRoot = join(dirname(managedRoot), ".keiko-portable-updates", "stage-1", "Keiko");
    const stateDir = join(home, ".keiko");
    const activatorEnv = {
      KEIKO_STATE_DIR: stateDir,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
    };
    writeInstall(managedRoot, OLD_VERSION);
    writeInstall(stageRoot, TARGET_VERSION);
    const activator = createPortableUpdateActivator({
      env: activatorEnv,
      homedir: () => home,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });

    const summary = await activator.activate({
      sessionId: "session-spaced-shortcut",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot, portableStateDir: stateDir },
    });

    expect(summary.target).toBe(TARGET);
    expect(summary.shortcutRefreshed).toBe(true);
    const shortcutPath = join(
      home,
      "AppData",
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Keiko.lnk",
    );
    expect(filesUnder(home).filter((path) => path.endsWith(".lnk"))).toContain(shortcutPath);
    expect(readWindowsPortableShortcutTarget(shortcutPath, activatorEnv)).toBe(
      join(managedRoot, "Keiko.exe"),
    );
  });

  it("rewrites an attributed shortcut with a stale working directory and refuses a foreign one", async () => {
    const base = await mkdtemp(join(tmpdir(), "keiko-portable-shortcut-guard-"));
    tempRoots.push(base);
    const home = join(base, "home");
    const installRoot = join(home, "AppData", "Local", "Programs", "Keiko");
    const launcherPath = join(installRoot, "Keiko.exe");
    const env = { APPDATA: join(home, "AppData", "Roaming") };
    const shortcutPath = join(
      env.APPDATA,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Keiko.lnk",
    );
    const layout = {
      installRoot,
      appRoot: join(installRoot, "app"),
      packageJsonPath: join(installRoot, "app", "package.json"),
      setupManifestPath: join(installRoot, "app", "keiko-setup-manifest.json"),
      launcherPath,
    };
    mkdirSync(dirname(shortcutPath), { recursive: true });

    // Attributed (target = managed launcher) but stale working directory: the refresh must
    // repair it, not refuse it — this is the exact artifact the rewrite exists to heal.
    writeFileSync(
      shortcutPath,
      windowsShortcutFallbackContent({
        targetPath: launcherPath,
        workingDirectory: join(home, "old-install-root"),
        iconPath: launcherPath,
      }),
      "utf8",
    );
    expect(refreshPortableShortcut({ target: "windows-x64", layout, env, home })).toBe(true);
    expect(parseWindowsShortcutFallback(shortcutPath)?.workingDirectory).toBe(installRoot);

    // Foreign target: cannot be attributed to this install, must be refused and left intact.
    const foreign = windowsShortcutFallbackContent({
      targetPath: join(home, "SomethingElse", "Other.exe"),
      workingDirectory: join(home, "SomethingElse"),
      iconPath: join(home, "SomethingElse", "Other.exe"),
    });
    writeFileSync(shortcutPath, foreign, "utf8");
    expect(refreshPortableShortcut({ target: "windows-x64", layout, env, home })).toBe(false);
    expect(readFileSync(shortcutPath, "utf8")).toBe(foreign);
  });

  it("falls back to the profile location when APPDATA is empty or relative", async () => {
    const base = await mkdtemp(join(tmpdir(), "keiko-portable-appdata-guard-"));
    tempRoots.push(base);
    const home = join(base, "home");
    const installRoot = join(home, "AppData", "Local", "Programs", "Keiko");
    const launcherPath = join(installRoot, "Keiko.exe");
    const layout = {
      installRoot,
      appRoot: join(installRoot, "app"),
      packageJsonPath: join(installRoot, "app", "package.json"),
      setupManifestPath: join(installRoot, "app", "keiko-setup-manifest.json"),
      launcherPath,
    };
    const fallbackShortcut = join(
      home,
      "AppData",
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Keiko.lnk",
    );

    // An empty or relative APPDATA must anchor at the profile fallback, never at the process
    // working directory.
    for (const appData of ["", "relative\\appdata"]) {
      expect(
        refreshPortableShortcut({
          target: "windows-x64",
          layout,
          env: { APPDATA: appData },
          home,
        }),
      ).toBe(true);
      expect(parseWindowsShortcutFallback(fallbackShortcut)?.targetPath).toBe(launcherPath);
      rmSync(fallbackShortcut);
    }
    expect(existsSync(join(process.cwd(), "Microsoft"))).toBe(false);
    expect(existsSync(join(process.cwd(), "relative"))).toBe(false);
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
    expect(existsSync(join(install.stateDir, "portable-install-state.json"))).toBe(false);
  });

  it("restores the active install when registration refresh fails before relaunch", async () => {
    const install = await makeInstall();
    const unsafeStateTarget = join(install.home, "unsafe-state-target");
    mkdirSync(unsafeStateTarget);
    mkdirSync(install.stateDir);
    symlinkSync(unsafeStateTarget, join(install.stateDir, "portable-install-state.json"), "file");
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
    expect(readFileSync(join(install.stageRoot, "app", "package.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
  });

  it("restores the active install when relaunch cannot be started", async () => {
    const install = await makeInstall();
    const registrationPath = join(install.stateDir, "portable-install-state.json");
    mkdirSync(install.stateDir, { recursive: true });
    writeFileSync(registrationPath, '{"packageVersion":"0.2.14"}\n', "utf8");
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => {
        throw new Error("launcher unavailable");
      },
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(
      activator.activate({
        sessionId: "session-relaunch-failed",
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
      }),
    ).rejects.toMatchObject({ reason: "portable-relaunch-failed" });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(join(install.managedRoot, "active.txt"), "utf8")).toBe("active");
    expect(readFileSync(registrationPath, "utf8")).toBe('{"packageVersion":"0.2.14"}\n');
    expect(readFileSync(join(install.stageRoot, "app", "package.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
  });

  it("blocks a concurrent promotion until the active activation has settled", async () => {
    const install = await makeInstall();
    let completeVerification: (() => void) | undefined;
    const verification = new Promise<boolean>((resolve) => {
      completeVerification = (): void => {
        resolve(true);
      };
    });
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => childProcess(),
      versionVerifier: () => verification,
    });
    const request = {
      sessionId: "session-concurrent",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
    };

    const first = activator.activate(request);
    const concurrentActivator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });
    await expect(concurrentActivator.activate(request)).rejects.toMatchObject({
      reason: "portable-activation-failed",
    });
    completeVerification?.();
    await expect(first).resolves.toMatchObject({ status: "activated" });
  });

  it("settles an interrupted promotion from content-free recovery metadata before promoting", async () => {
    const install = await makeInstall();
    const request = {
      sessionId: "session-interrupted",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
    };
    const activationId = activationIdFor(request);
    const backupRoot = join(dirname(install.managedRoot), `.keiko-previous-${activationId}`);
    renameSync(install.managedRoot, backupRoot);
    renameSync(install.stageRoot, install.managedRoot);
    mkdirSync(join(install.stateDir, "updates"), { recursive: true });
    writeFileSync(
      join(install.stateDir, "updates", "portable-activation-recovery.json"),
      JSON.stringify({ activationId, stageId: "stage-1", target: TARGET, phase: "promoted" }),
      "utf8",
    );
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(activator.activate(request)).resolves.toMatchObject({ status: "activated" });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(
      TARGET_VERSION,
    );
    expect(existsSync(backupRoot)).toBe(false);
    expect(existsSync(join(install.stateDir, "updates", "portable-activation-recovery.json"))).toBe(
      false,
    );
  });

  it("restores prior registration for an interrupted registered candidate before failing safely", async () => {
    const install = await makeInstall();
    const request = {
      sessionId: "session-registered-recovery",
      targetVersion: TARGET_VERSION,
      stage: stageSummary(),
      runtimeFacts: { packageRoot: install.packageRoot, portableStateDir: install.stateDir },
    };
    const registrationPath = join(install.stateDir, "portable-install-state.json");
    const oldRegistration = '{"packageVersion":"0.2.14"}\n';
    mkdirSync(install.stateDir, { recursive: true });
    writeFileSync(registrationPath, oldRegistration, "utf8");
    const activationId = activationIdFor(request);
    capturePortableRegistration({ stateDir: install.stateDir, activationId });
    const backupRoot = join(dirname(install.managedRoot), `.keiko-previous-${activationId}`);
    renameSync(install.managedRoot, backupRoot);
    renameSync(install.stageRoot, install.managedRoot);
    writeFileSync(registrationPath, '{"packageVersion":"0.2.12"}\n', "utf8");
    mkdirSync(join(install.stateDir, "updates"), { recursive: true });
    writeFileSync(
      join(install.stateDir, "updates", "portable-activation-recovery.json"),
      JSON.stringify({ activationId, stageId: "stage-1", target: TARGET, phase: "registered" }),
      "utf8",
    );
    await rm(join(install.managedRoot, "Keiko.exe"), { force: true });
    const activator = createPortableUpdateActivator({
      env: { KEIKO_STATE_DIR: install.stateDir },
      homedir: () => install.home,
      spawnFn: () => childProcess(),
      versionVerifier: () => Promise.resolve(true),
    });

    await expect(activator.activate(request)).rejects.toMatchObject({
      reason: "portable-activation-failed",
    });
    expect(readFileSync(join(install.packageRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    expect(readFileSync(registrationPath, "utf8")).toBe(oldRegistration);
  });
});

// PR #3355 review (IDX62): a hostile/malformed SystemRoot/WINDIR must reach the activity log
// through the PRODUCTION refreshPortableShortcut call path, not only keiko-security's own unit
// suite. `readWindowsShortcutDefinition`/`writeWindowsShortcutDefinition` only take the win32
// (cscript) route when `process.platform === "win32"`, so this block stubs the platform exactly
// like windows-shortcuts.test.ts does to exercise that route hermetically (the resolver throws
// strictly before any spawn is attempted — real Windows is never required).
describe("refreshPortableShortcut logs a trust-boundary refusal (win32 route)", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");

  afterEach(() => {
    if (platform !== undefined) Object.defineProperty(process, "platform", platform);
  });

  function stubWin32(): void {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  }

  const HOSTILE_ENV = { SystemRoot: String.raw`\\attacker\share` };

  it.each([
    ["absent", "create"],
    ["existing", "read"],
  ] as const)(
    "activation correlates the %s-shortcut refusal to its request",
    async (shortcutState, mode) => {
      stubWin32();
      const install = await makeInstall();
      const appData = join(install.home, "AppData", "Roaming");
      const shortcutPath = join(
        appData,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Keiko.lnk",
      );
      if (shortcutState === "existing") {
        mkdirSync(dirname(shortcutPath), { recursive: true });
        writeFileSync(shortcutPath, "placeholder-shortcut-bytes", "utf8");
      }
      const events: SecurityLogEvent[] = [];
      const request = {
        sessionId: `session-correlated-${shortcutState}`,
        targetVersion: TARGET_VERSION,
        stage: stageSummary(),
        runtimeFacts: {
          packageRoot: install.packageRoot,
          portableStateDir: install.stateDir,
        },
      } as const;
      const correlationId = activationIdFor(request);
      const activator = createPortableUpdateActivator({
        env: {
          ...HOSTILE_ENV,
          APPDATA: appData,
          KEIKO_STATE_DIR: install.stateDir,
          LOCALAPPDATA: join(install.home, "AppData", "Local"),
        },
        homedir: () => install.home,
        securityLogSink: {
          write: (event): void => {
            events.push(event);
          },
        },
        spawnFn: () => childProcess(),
        versionVerifier: () => Promise.resolve(true),
      });

      await expect(activator.activate(request)).resolves.toMatchObject({
        shortcutRefreshed: false,
      });
      expect(events).toEqual([
        expect.objectContaining({
          correlationId,
          op: "security.windows-shortcut.system-root-refused",
          extra: { mode },
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain("attacker");
    },
  );

  function layoutFor(installRoot: string): {
    readonly installRoot: string;
    readonly appRoot: string;
    readonly packageJsonPath: string;
    readonly setupManifestPath: string;
    readonly launcherPath: string;
  } {
    return {
      installRoot,
      appRoot: join(installRoot, "app"),
      packageJsonPath: join(installRoot, "app", "package.json"),
      setupManifestPath: join(installRoot, "app", "keiko-setup-manifest.json"),
      launcherPath: join(installRoot, "Keiko.exe"),
    };
  }

  it("first-install branch: no prior shortcut, refuses the write and still logs the refusal", async () => {
    stubWin32();
    const base = await mkdtemp(join(tmpdir(), "keiko-shortcut-root-refused-absent-"));
    tempRoots.push(base);
    const home = join(base, "home");
    const layout = layoutFor(join(home, "AppData", "Local", "Programs", "Keiko"));
    const write = vi.fn<SecurityLogSink["write"]>();
    const sink: SecurityLogSink = { write };

    // Absent case: nothing under Start Menu\Programs yet, so refreshPortableShortcut takes the
    // CREATE branch straight into writeShortcut/writeWindowsShortcutDefinition.
    expect(
      refreshPortableShortcut({
        target: "windows-x64",
        layout,
        env: HOSTILE_ENV,
        home,
        securityLogSink: sink,
      }),
    ).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        category: "security",
        op: "security.windows-shortcut.system-root-refused",
        extra: { mode: "create" },
      }),
    );
  });

  it("existing-shortcut branch: a prior shortcut on disk refuses the read and still logs the refusal", async () => {
    stubWin32();
    const base = await mkdtemp(join(tmpdir(), "keiko-shortcut-root-refused-existing-"));
    tempRoots.push(base);
    const home = join(base, "home");
    const layout = layoutFor(join(home, "AppData", "Local", "Programs", "Keiko"));
    const shortcutPath = join(
      home,
      "AppData",
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Keiko.lnk",
    );
    mkdirSync(dirname(shortcutPath), { recursive: true });
    // Any non-empty regular file stands in for a prior shortcut here: refreshPortableShortcut's
    // overwrite guard must resolve SystemRoot to attempt the READ before it can decide whether to
    // rewrite, and that resolution — never cscript, which is stubbed win32 never actually reaches
    // here — is exactly what the hostile env refuses. The content is never parsed.
    writeFileSync(shortcutPath, "placeholder-shortcut-bytes", "utf8");
    const write = vi.fn<SecurityLogSink["write"]>();
    const sink: SecurityLogSink = { write };

    expect(
      refreshPortableShortcut({
        target: "windows-x64",
        layout,
        env: HOSTILE_ENV,
        home,
        securityLogSink: sink,
      }),
    ).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        category: "security",
        op: "security.windows-shortcut.system-root-refused",
        extra: { mode: "read" },
      }),
    );
  });

  it("stays a silent no-op boolean when no sink is wired, matching every pre-existing caller", async () => {
    stubWin32();
    const base = await mkdtemp(join(tmpdir(), "keiko-shortcut-root-refused-no-sink-"));
    tempRoots.push(base);
    const home = join(base, "home");
    const layout = layoutFor(join(home, "AppData", "Local", "Programs", "Keiko"));

    expect(refreshPortableShortcut({ target: "windows-x64", layout, env: HOSTILE_ENV, home })).toBe(
      false,
    );
  });
});
