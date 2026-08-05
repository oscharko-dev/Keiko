import type { PathLike } from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({
  recreateLockTarget: undefined as string | undefined,
  restoreTarget: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (oldPath: PathLike, newPath: PathLike): void => {
      if (
        renameControl.recreateLockTarget === String(oldPath) &&
        String(newPath).includes(".reclaim-")
      ) {
        actual.renameSync(oldPath, newPath);
        actual.mkdirSync(oldPath);
        actual.writeFileSync(
          `${String(oldPath)}${process.platform === "win32" ? "\\" : "/"}owner.json`,
          `${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`,
        );
        return;
      }
      if (
        renameControl.restoreTarget === String(newPath) &&
        String(oldPath).includes(".keiko-previous-")
      ) {
        throw new Error("simulated rollback rename failure");
      }
      actual.renameSync(oldPath, newPath);
    },
  };
});

import {
  attestedExistingPortableInstall,
  portableManagedSetupLockPath,
  portableSourceCanReplaceManaged,
  portableSourceIsNewer,
  upgradeManagedInstall,
  withPortableManagedMutation,
} from "./portable-install.js";
import type { PortableManagedUpgradeFn, ValidatedPortableRoot } from "./portable-install.js";
import { writeManagedRegistration } from "./portable-registration.js";
import {
  PACKAGE_NAME,
  layoutFor,
  primaryLauncherName,
  targetRuntime,
  type PortableTarget,
} from "./portable-shared.js";

const tempRoots: string[] = [];
const REAL_TMPDIR = realpathSync(tmpdir());

function pathInsideRepository(path: string): boolean {
  let cursor = path;
  for (;;) {
    if (existsSync(join(cursor, ".git"))) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function makePolicyAllowedRoot(): string {
  const cwdParent = dirname(process.cwd());
  const parent =
    cwdParent.startsWith(REAL_TMPDIR) || pathInsideRepository(cwdParent) ? homedir() : cwdParent;
  const root = mkdtempSync(join(parent, ".keiko-portable-upgrade-test-"));
  tempRoots.push(root);
  return root;
}

function seedPortableRoot(
  target: PortableTarget,
  root: string,
  version: string,
): ValidatedPortableRoot {
  const layout = layoutFor(target, root);
  const manifest = {
    schemaVersion: 1,
    platformTarget: target,
    packageName: PACKAGE_NAME,
    packageVersion: version,
    stable: true,
    primaryLauncher: primaryLauncherName(target),
    bootstrapUpdateEligible: false,
    runtime: targetRuntime(target),
  } as const;
  mkdirSync(dirname(layout.packageJsonPath), { recursive: true });
  mkdirSync(dirname(layout.runtimeNodePath), { recursive: true });
  mkdirSync(dirname(layout.primaryLauncherPath), { recursive: true });
  mkdirSync(dirname(layout.setupManifestPath), { recursive: true });
  writeFileSync(layout.packageJsonPath, JSON.stringify({ name: PACKAGE_NAME, version }), "utf8");
  writeFileSync(layout.runtimeNodePath, "node", "utf8");
  writeFileSync(layout.primaryLauncherPath, "launcher", "utf8");
  writeFileSync(layout.setupManifestPath, JSON.stringify(manifest), "utf8");
  return { layout, manifest };
}

afterEach(() => {
  renameControl.recreateLockTarget = undefined;
  renameControl.restoreTarget = undefined;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function portable(version: string, target = "windows-x64"): ValidatedPortableRoot {
  return {
    layout: {
      rootKind: "windows-root",
      installRoot: "/user/Keiko",
      resourceRoot: "/user/Keiko",
      appRoot: "/user/Keiko/app",
      packageJsonPath: "/user/Keiko/app/package.json",
      runtimeNodePath: "/user/Keiko/runtime/node/node.exe",
      primaryLauncherPath: "/user/Keiko/Keiko.exe",
      setupManifestPath: "/user/Keiko/.portable/setup-manifest.json",
    },
    manifest: {
      schemaVersion: 1,
      platformTarget: target === "macos-arm64" || target === "macos-x64" ? target : "windows-x64",
      packageName: "@oscharko-dev/keiko",
      packageVersion: version,
      stable: true,
      primaryLauncher: "Keiko.exe",
      bootstrapUpdateEligible: true,
      runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
    },
  };
}

describe("portable install decisions", () => {
  it("keeps managed-root lock identity stable when the root gains a different real path", () => {
    const policyRoot = makePolicyAllowedRoot();
    const managedRoot = join(policyRoot, "managed-root");
    const targetRoot = join(policyRoot, "link-target");
    mkdirSync(targetRoot);

    // Both transitions in one pin, because concurrent callers race them: the root goes from absent
    // to present, and its real path diverges from the path callers were authorized to manage. An
    // earlier `realpathSync`-when-present derivation gave the two callers different lock
    // directories, so both could hold a lock and overlap their upgrades.
    const before = portableManagedSetupLockPath("windows-x64", managedRoot);
    // A junction, not a symlink: Windows grants junction creation without elevation, so this stays
    // hermetic on every platform the suite runs on.
    symlinkSync(targetRoot, managedRoot, process.platform === "win32" ? "junction" : "dir");

    expect(portableManagedSetupLockPath("windows-x64", managedRoot)).toBe(before);
  });

  it("fails closed when no target may attest the requested root", () => {
    expect(attestedExistingPortableInstall("/user/.keiko/managed", "/user/.keiko")).toBeUndefined();
  });

  it("accepts only newer or target-corrective portable sources", () => {
    expect(portableSourceIsNewer(portable("0.2.16"), portable("0.2.15"))).toBe(true);
    expect(portableSourceIsNewer(portable("0.2.15"), portable("0.2.15"))).toBe(false);
    expect(
      portableSourceCanReplaceManaged(portable("0.2.15", "macos-arm64"), portable("0.2.15")),
    ).toBe(true);
  });

  it("preserves the previous install when upgrade rollback fails", () => {
    const root = makePolicyAllowedRoot();
    const target = "windows-x64";
    const source = seedPortableRoot(target, join(root, "source"), "0.2.16");
    const managedRoot = join(root, "managed", "Keiko");
    const current = seedPortableRoot(target, managedRoot, "0.2.15");
    const stateDir = join(root, ".keiko-state");
    const appDataFile = join(root, "blocked-app-data");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(appDataFile, "not a directory", "utf8");
    writeManagedRegistration({
      stateDir,
      layout: current.layout,
      manifest: current.manifest,
      env: { APPDATA: appDataFile },
      home: root,
      now: new Date("2026-08-02T00:00:00.000Z"),
    });
    renameControl.restoreTarget = managedRoot;

    let thrown: unknown;
    try {
      upgradeManagedInstall({
        target,
        source,
        current,
        managedRoot,
        stateDir,
        env: { APPDATA: appDataFile },
        home: root,
        now: new Date("2026-08-03T00:00:00.000Z"),
      });
    } catch (error) {
      thrown = error;
    }

    const backups = readdirSync(dirname(managedRoot)).filter((entry) =>
      entry.startsWith(".keiko-previous-"),
    );
    expect(backups).toHaveLength(1);
    const backupRoot = join(dirname(managedRoot), backups[0] ?? "");
    expect(existsSync(backupRoot)).toBe(true);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(backupRoot);
  });

  it("revokes a managed-upgrade capability before releasing its locks", async () => {
    const root = makePolicyAllowedRoot();
    const target = "windows-x64";
    const source = seedPortableRoot(target, join(root, "source"), "0.2.16");
    const managedRoot = join(root, "managed", "Keiko");
    const current = seedPortableRoot(target, managedRoot, "0.2.15");
    const stateDir = join(root, ".keiko-state");
    const input = {
      target,
      source,
      current,
      managedRoot,
      stateDir,
      env: {},
      home: root,
      now: new Date("2026-08-03T00:00:00.000Z"),
    } as const;
    let escaped: PortableManagedUpgradeFn | undefined;

    await withPortableManagedMutation(input, (upgrade) => {
      expect(() => upgrade({ ...input, managedRoot: join(root, "other", "Keiko") })).toThrow(
        "portable upgrade lock scope does not match the managed install",
      );
      escaped = upgrade;
      return Promise.resolve();
    });

    expect(escaped).toBeDefined();
    const escapedUpgrade = escaped;
    if (escapedUpgrade === undefined) throw new Error("upgrade capability was not provided");
    expect(() => escapedUpgrade(input)).toThrow(
      "portable upgrade lock capability is no longer active",
    );
  });

  it("reclaims a setup lock whose recorded owner is no longer running", async () => {
    const root = makePolicyAllowedRoot();
    const target = "windows-x64";
    const managedRoot = join(root, "managed", "Keiko");
    const stateDir = join(root, ".keiko-state");
    const stalePid = 2_147_483_647;
    mkdirSync(managedRoot, { recursive: true });
    const staleLock = portableManagedSetupLockPath(target, managedRoot);
    mkdirSync(staleLock);
    writeFileSync(
      join(staleLock, "owner.json"),
      `${JSON.stringify({ schemaVersion: 1, pid: stalePid })}\n`,
    );
    const processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === stalePid && signal === 0) {
        const error = new Error("stale process") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    });
    try {
      await expect(
        withPortableManagedMutation({ target, managedRoot, stateDir }, () => Promise.resolve()),
      ).resolves.toBeUndefined();
      expect(existsSync(staleLock)).toBe(false);
    } finally {
      processKill.mockRestore();
    }
  });

  it("does not delete a live lock recreated while a stale lock is reclaimed", async () => {
    const root = makePolicyAllowedRoot();
    const target = "windows-x64";
    const managedRoot = join(root, "managed", "Keiko");
    const stateDir = join(root, ".keiko-state");
    const stalePid = 2_147_483_647;
    mkdirSync(managedRoot, { recursive: true });
    const staleLock = portableManagedSetupLockPath(target, managedRoot);
    mkdirSync(staleLock);
    writeFileSync(
      join(staleLock, "owner.json"),
      `${JSON.stringify({ schemaVersion: 1, pid: stalePid })}\n`,
    );
    const processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === stalePid && signal === 0) {
        const error = new Error("stale process") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    });
    renameControl.recreateLockTarget = staleLock;
    try {
      await expect(
        withPortableManagedMutation({ target, managedRoot, stateDir }, () => Promise.resolve()),
      ).rejects.toThrow("already in progress");
      expect(JSON.parse(readFileSync(join(staleLock, "owner.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        pid: process.pid,
      });
    } finally {
      processKill.mockRestore();
    }
  });

  it("orders setup locks without locale-sensitive comparison", async () => {
    const root = makePolicyAllowedRoot();
    const options = {
      target: "windows-x64",
      managedRoot: join(root, "månaged", "Keiko"),
      stateDir: join(root, "ståte"),
    } as const;
    mkdirSync(options.managedRoot, { recursive: true });
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale-sensitive comparison reached lock ordering");
    });
    try {
      await expect(
        withPortableManagedMutation(options, () => Promise.resolve()),
      ).resolves.toBeUndefined();
      expect(localeCompare).not.toHaveBeenCalled();
    } finally {
      localeCompare.mockRestore();
    }
  });
});
