import type { PathLike } from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({ restoreTarget: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (oldPath: PathLike, newPath: PathLike): void => {
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
  portableSourceCanReplaceManaged,
  portableSourceIsNewer,
  upgradeManagedInstall,
} from "./portable-install.js";
import type { ValidatedPortableRoot } from "./portable-install.js";
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
});
