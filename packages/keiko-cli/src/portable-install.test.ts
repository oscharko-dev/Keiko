import type { PathLike } from "node:fs";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({
  recreateLockTarget: undefined as string | undefined,
  restoreTarget: undefined as string | undefined,
}));
const readControl = vi.hoisted(() => ({
  growPath: undefined as string | undefined,
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
    readSync: (...args: Parameters<typeof actual.readSync>): number => {
      const path = readControl.growPath;
      if (path !== undefined) {
        const opened = actual.fstatSync(args[0]);
        const current = actual.lstatSync(path);
        if (opened.dev === current.dev && opened.ino === current.ino) {
          readControl.growPath = undefined;
          actual.appendFileSync(path, "x");
        }
      }
      return actual.readSync(...args);
    },
  };
});

import {
  _copyTreeSafeForTests,
  attestedExistingPortableInstall,
  portableManagedSetupLockPath,
  portableSourceCanReplaceManaged,
  portableSourceIsNewer,
  recoverableFailedManagedRoot,
  upgradeManagedInstall,
  validatePortableRoot,
  withPortableManagedMutation,
} from "./portable-install.js";
import type {
  PortableManagedInspectionAllowance,
  PortableManagedInspectionFn,
  PortableManagedUpgradeFn,
  ValidatedPortableRoot,
} from "./portable-install.js";
import { writeFailedRegistration, writeManagedRegistration } from "./portable-registration.js";
import { hashPortableTreeKht1 } from "@oscharko-dev/keiko-security/portable-tree-attestation";
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

async function seedWindowsGenerationRoot(root: string): Promise<string> {
  const launcher = Buffer.from("signed root launcher");
  rmSync(join(root, ".portable", "generations"), { recursive: true, force: true });
  const provisionalRoot = join(root, ".portable", "generations", "pending");
  mkdirSync(join(provisionalRoot, "app"), { recursive: true });
  mkdirSync(join(provisionalRoot, "runtime", "node"), { recursive: true });
  mkdirSync(join(provisionalRoot, "runtime", "native"), { recursive: true });
  mkdirSync(join(root, "support"), { recursive: true });
  writeFileSync(
    join(provisionalRoot, "app", "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version: "0.3.17" }),
  );
  writeFileSync(join(provisionalRoot, "runtime", "node", "node.exe"), "node");
  writeFileSync(
    join(provisionalRoot, "runtime", "native", "keiko-runtime-supervisor.exe"),
    "supervisor",
  );
  writeFileSync(join(root, "Keiko.exe"), launcher);
  writeFileSync(
    join(root, "support", "keiko-support.cmd"),
    '@echo off\r\nset "SCRIPT_DIR=%~dp0"\r\n"%SCRIPT_DIR%..\\Keiko.exe" %*\r\n',
  );
  const treeSha256 = await hashPortableTreeKht1(provisionalRoot, {
    deadline: Date.now() + 5_000,
    now: Date.now,
    yieldControl: () => Promise.resolve(),
  });
  const generationRoot = join(root, ".portable", "generations", treeSha256);
  renameSync(provisionalRoot, generationRoot);
  const binding = {
    schemaVersion: 1,
    resourceRoot: `.portable/generations/${treeSha256}`,
    treeHashSchema: "KHT1",
    treeSha256,
    launcherPath: "Keiko.exe",
    launcherSha256: createHash("sha256").update(launcher).digest("hex"),
  } as const;
  writeFileSync(
    join(root, ".portable", "setup-manifest.json"),
    JSON.stringify({
      schemaVersion: 2,
      platformTarget: "windows-x64",
      packageName: PACKAGE_NAME,
      packageVersion: "0.3.17",
      stable: true,
      primaryLauncher: "Keiko.exe",
      bootstrapUpdateEligible: false,
      runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
      windowsGeneration: binding,
    }),
  );
  return treeSha256;
}

afterEach(() => {
  renameControl.recreateLockTarget = undefined;
  renameControl.restoreTarget = undefined;
  readControl.growPath = undefined;
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
      runtimeSupervisorPath: "/user/Keiko/runtime/native/keiko-runtime-supervisor.exe",
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
  it("validates a Windows schema 2 root through its attested generation layout", async () => {
    const root = makePolicyAllowedRoot();
    const generation = await seedWindowsGenerationRoot(root);

    const validated = validatePortableRoot("windows-x64", root);
    expect(validated.manifest.schemaVersion).toBe(2);
    expect(validated.layout.resourceRoot).toContain(generation);
    expect(validated.layout.primaryLauncherPath).toBe(join(root, "Keiko.exe"));
    expect(validated.layout.setupManifestPath).toBe(join(root, ".portable", "setup-manifest.json"));
  });

  it("recovers a failed Windows schema 2 install through its retained generation identity", async () => {
    const root = makePolicyAllowedRoot();
    const managedRoot = join(root, "managed", "Keiko");
    const stateDir = join(root, "state");
    await seedWindowsGenerationRoot(managedRoot);
    const validated = validatePortableRoot("windows-x64", managedRoot);
    writeManagedRegistration({
      stateDir,
      layout: validated.layout,
      manifest: validated.manifest,
      env: {},
      home: root,
      now: new Date("2026-09-07T12:00:00.000Z"),
    });
    writeFailedRegistration(
      "windows-x64",
      stateDir,
      new Date("2026-09-07T12:01:00.000Z"),
      "runtime invalid",
    );

    expect(recoverableFailedManagedRoot("windows-x64", managedRoot, stateDir)).toBe(managedRoot);
    writeFileSync(validated.layout.primaryLauncherPath, "rebound launcher");
    expect(recoverableFailedManagedRoot("windows-x64", managedRoot, stateDir)).toBeUndefined();
  });

  it("rejects post-closure non-PE mutations of a Windows generation", async () => {
    const root = makePolicyAllowedRoot();
    const generation = await seedWindowsGenerationRoot(root);
    writeFileSync(
      join(
        root,
        ".portable",
        "generations",
        generation,
        "runtime",
        "native",
        "keiko-runtime-supervisor.exe",
      ),
      "replacement supervisor",
    );
    expect(() => validatePortableRoot("windows-x64", root)).toThrow(
      "portable handoff tree digest mismatch",
    );
  });

  it("rejects rebound or noncanonical Windows schema 2 root files", async () => {
    const root = makePolicyAllowedRoot();
    const generation = await seedWindowsGenerationRoot(root);
    const reboundGeneration = "b".repeat(64);
    renameSync(
      join(root, ".portable", "generations", generation),
      join(root, ".portable", "generations", reboundGeneration),
    );
    const manifestPath = join(root, ".portable", "setup-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      windowsGeneration: { resourceRoot: string; treeSha256: string };
    };
    manifest.windowsGeneration.resourceRoot = `.portable/generations/${reboundGeneration}`;
    manifest.windowsGeneration.treeSha256 = reboundGeneration;
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    expect(() => validatePortableRoot("windows-x64", root)).toThrow(
      "portable handoff tree digest mismatch",
    );

    await seedWindowsGenerationRoot(root);
    writeFileSync(join(root, "Keiko.exe"), "replacement launcher");
    expect(() => validatePortableRoot("windows-x64", root)).toThrow(
      "portable root launcher digest mismatch",
    );

    await seedWindowsGenerationRoot(root);
    writeFileSync(join(root, "support", "keiko-support.cmd"), "@echo off\r\n");
    expect(() => validatePortableRoot("windows-x64", root)).toThrow(
      "portable Windows support launcher is not canonical",
    );
  });

  it("rejects sparse oversized root launchers and support files before materializing them", async () => {
    const root = makePolicyAllowedRoot();
    await seedWindowsGenerationRoot(root);
    truncateSync(join(root, "Keiko.exe"), 64 * 1024 * 1024 + 1);
    expect(() => validatePortableRoot("windows-x64", root)).toThrow(
      "portable root launcher is unsafe",
    );

    await seedWindowsGenerationRoot(root);
    truncateSync(join(root, "support", "keiko-support.cmd"), 64 * 1024 * 1024 + 1);
    expect(() => validatePortableRoot("windows-x64", root)).toThrow(
      "portable Windows support launcher is not canonical",
    );
  });

  it("rejects a support file that grows after its exact-size check", async () => {
    const root = makePolicyAllowedRoot();
    await seedWindowsGenerationRoot(root);
    readControl.growPath = join(root, "support", "keiko-support.cmd");

    expect(() => validatePortableRoot("windows-x64", root)).toThrow(
      "portable Windows support launcher is not canonical",
    );
  });

  it("streams an in-budget root launcher hash", async () => {
    const root = makePolicyAllowedRoot();
    await seedWindowsGenerationRoot(root);
    const launcher = Buffer.alloc(128 * 1024, 0x5a);
    const launcherPath = join(root, "Keiko.exe");
    writeFileSync(launcherPath, launcher);
    const manifestPath = join(root, ".portable", "setup-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      windowsGeneration: { launcherSha256: string };
    };
    manifest.windowsGeneration.launcherSha256 = createHash("sha256").update(launcher).digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    expect(validatePortableRoot("windows-x64", root).layout.primaryLauncherPath).toBe(launcherPath);
  });

  it("enforces the absolute schema 2 validation deadline", async () => {
    const root = makePolicyAllowedRoot();
    await seedWindowsGenerationRoot(root);
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(1).mockReturnValue(900_002);
    try {
      expect(() => validatePortableRoot("windows-x64", root)).toThrow(
        "portable handoff preparation timed out",
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects symlinked and multiply-linked Windows generation files", async () => {
    const root = makePolicyAllowedRoot();
    const generation = await seedWindowsGenerationRoot(root);
    const supervisor = join(
      root,
      ".portable",
      "generations",
      generation,
      "runtime",
      "native",
      "keiko-runtime-supervisor.exe",
    );
    const replacement = join(root, "supervisor-replacement.exe");
    writeFileSync(replacement, "supervisor");
    rmSync(supervisor);
    symlinkSync(replacement, supervisor);
    expect(() => validatePortableRoot("windows-x64", root)).toThrow(
      "portable handoff tree contains an unsupported entry",
    );

    const secondRoot = makePolicyAllowedRoot();
    await seedWindowsGenerationRoot(secondRoot);
    const support = join(secondRoot, "support", "keiko-support.cmd");
    const secondLink = join(secondRoot, "support-copy.cmd");
    linkSync(support, secondLink);
    expect(() => validatePortableRoot("windows-x64", secondRoot)).toThrow(
      "portable Windows support launcher is not canonical",
    );
  });

  it("preserves macOS and schema 1 flat portable validation", () => {
    const root = makePolicyAllowedRoot();
    seedPortableRoot("macos-arm64", root, "0.3.17");

    expect(validatePortableRoot("macos-arm64", root).manifest.schemaVersion).toBe(1);
  });

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
        io: { out: () => undefined, err: () => undefined },
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
      io: { out: () => undefined, err: () => undefined },
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

  it("scopes Windows generation inspection to an active matching mutation lock", async () => {
    const root = makePolicyAllowedRoot();
    const managedRoot = join(root, "managed", "Keiko");
    const stateDir = join(root, ".keiko-state");
    const selected = await seedWindowsGenerationRoot(managedRoot);
    const layout = validatePortableRoot("windows-x64", managedRoot).layout;
    const candidate = "b".repeat(64);
    const activationId = "c".repeat(32);
    const incoming = `.portable/generations/.incoming-${activationId}`;
    for (const resourceRoot of [`.portable/generations/${candidate}`, incoming]) {
      const absoluteRoot = join(managedRoot, ...resourceRoot.split("/"));
      mkdirSync(join(absoluteRoot, "app"), { recursive: true });
      mkdirSync(join(absoluteRoot, "runtime", "native"), { recursive: true });
      writeFileSync(
        join(absoluteRoot, "app", "package.json"),
        JSON.stringify({ name: PACKAGE_NAME, version: "0.3.18" }),
      );
      writeFileSync(
        join(absoluteRoot, "runtime", "native", "keiko-runtime-attestation.exe"),
        "attestation",
      );
    }
    const allowance: PortableManagedInspectionAllowance = {
      kind: "windows-generation-v1",
      managedRoot,
      activationId,
      allowedResourceRoots: [
        `.portable/generations/${selected}`,
        `.portable/generations/${candidate}`,
        incoming,
      ],
    };

    await withPortableManagedMutation(
      { target: "windows-x64", managedRoot, stateDir },
      (_upgrade, inspect) => {
        const scan = inspect(layout, allowance);
        expect(scan.issues).toEqual([]);
        expect(scan.files).toContain(
          join(
            managedRoot,
            ".portable",
            "generations",
            candidate,
            "runtime",
            "native",
            "keiko-runtime-attestation.exe",
          ),
        );
        mkdirSync(join(managedRoot, ".portable", "generations", "d".repeat(64)));
        expect(inspect(layout, allowance).issues).toContain(
          `portable managed install contains unknown entry: .portable/generations/${"d".repeat(64)}`,
        );
        writeFileSync(
          join(
            managedRoot,
            ".portable",
            "generations",
            candidate,
            "runtime",
            "native",
            "unknown.exe",
          ),
          "unknown",
        );
        expect(inspect(layout, allowance).issues).toContain(
          `portable managed install contains unknown entry: .portable/generations/${candidate}/runtime/native/unknown.exe`,
        );
        return Promise.resolve();
      },
    );
  });

  it("rejects malformed and cross-scope Windows inspection allowances", async () => {
    const root = makePolicyAllowedRoot();
    const managedRoot = join(root, "managed", "Keiko");
    const stateDir = join(root, ".keiko-state");
    const selected = await seedWindowsGenerationRoot(managedRoot);
    const layout = validatePortableRoot("windows-x64", managedRoot).layout;
    const activationId = "c".repeat(32);
    const selectedRoot = `.portable/generations/${selected}`;
    const base: PortableManagedInspectionAllowance = {
      kind: "windows-generation-v1",
      managedRoot,
      activationId,
      allowedResourceRoots: [selectedRoot],
    };
    const malformed = [
      { ...base, kind: "windows-flat-v1" } as unknown as PortableManagedInspectionAllowance,
      { ...base, managedRoot: join(root, "other", "Keiko") },
      { ...base, activationId: "C".repeat(32) },
      { ...base, allowedResourceRoots: [] },
      { ...base, allowedResourceRoots: [selectedRoot, selectedRoot] },
      { ...base, allowedResourceRoots: [selectedRoot, ".portable/generations/../outside"] },
      {
        ...base,
        allowedResourceRoots: [selectedRoot, `.portable/generations/.incoming-${"d".repeat(32)}`],
      },
      { ...base, allowedResourceRoots: [`.portable/generations/${"e".repeat(64)}`] },
    ] as readonly PortableManagedInspectionAllowance[];

    await withPortableManagedMutation(
      { target: "windows-x64", managedRoot, stateDir },
      (_upgrade, inspect) => {
        for (const allowance of malformed) expect(() => inspect(layout, allowance)).toThrow();
        expect(() =>
          inspect({ ...layout, installRoot: join(root, "other", "Keiko") }, base),
        ).toThrow("portable inspection lock scope does not match the managed install");
        return Promise.resolve();
      },
    );
  });

  it("revokes the inspection capability when its callback throws", async () => {
    const root = makePolicyAllowedRoot();
    const managedRoot = join(root, "managed", "Keiko");
    const stateDir = join(root, ".keiko-state");
    await seedWindowsGenerationRoot(managedRoot);
    const layout = validatePortableRoot("windows-x64", managedRoot).layout;
    let escaped: PortableManagedInspectionFn | undefined;

    await expect(
      withPortableManagedMutation(
        { target: "windows-x64", managedRoot, stateDir },
        (_upgrade, inspect) => {
          escaped = inspect;
          return Promise.reject(new Error("callback failed"));
        },
      ),
    ).rejects.toThrow("callback failed");
    const escapedInspection = escaped;
    if (escapedInspection === undefined) {
      throw new Error("inspection capability was not provided");
    }
    expect(() => escapedInspection(layout)).toThrow(
      "portable inspection lock capability is no longer active",
    );
    await expect(
      withPortableManagedMutation({ target: "windows-x64", managedRoot, stateDir }, () =>
        Promise.resolve(),
      ),
    ).resolves.toBeUndefined();
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

// KEIKO-0901: bounded copyTreeSafe (depth / entry / byte caps). Each cap surfaces as a
// named Error, so setupPortable's existing catch converts it into a fail-closed
// registration — same shape as the pre-existing "unsafe links" refusal.
//
// The entry-count and byte-count tests below inject a small budget via _copyTreeSafeForTests'
// third parameter (comment 3865273684) rather than exceeding the real production caps, which
// would require hundreds of thousands of files or gigabytes of fixture data. "Huge" limits stand
// in for "effectively unbounded" on the dimension a given test is not exercising.
const PORTABLE_TEST_HUGE_ENTRIES = 1_000_000;
const PORTABLE_TEST_HUGE_BYTES = 4 * 1024 * 1024 * 1024;

describe("copyTreeSafe payload budgets (KEIKO-0901)", () => {
  it("throws a named error when the payload exceeds the maximum depth", () => {
    const source = makePolicyAllowedRoot();
    const dest = makePolicyAllowedRoot();
    rmSync(dest, { recursive: true, force: true });
    // Build 40 nested directories with a leaf file — comfortably over the 32-depth cap.
    let cursor = source;
    for (let i = 0; i < 40; i += 1) {
      cursor = join(cursor, `d${String(i)}`);
      mkdirSync(cursor, { recursive: true });
    }
    writeFileSync(join(cursor, "leaf.txt"), "leaf", "utf8");
    expect(() => {
      _copyTreeSafeForTests(source, dest);
    }).toThrow(/exceeds maximum depth/);
  });

  it("copies a shallow tree successfully within the budget", () => {
    const source = makePolicyAllowedRoot();
    const dest = makePolicyAllowedRoot();
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(source, "a"), { recursive: true });
    writeFileSync(join(source, "a", "leaf.txt"), "leaf", "utf8");
    expect(() => {
      _copyTreeSafeForTests(source, dest);
    }).not.toThrow();
    expect(readFileSync(join(dest, "a", "leaf.txt"), "utf8")).toBe("leaf");
  });

  // #2906 round 3 (comment 3865273684): the previous readdirSafe materialized the FULL
  // directory listing via readdirSync before the loop ever incremented the budget, so the
  // entry-count guard could only ever fire AFTER the whole (potentially huge) listing had
  // already been read into memory. A small injected `maxEntries` proves the cap is honored
  // without needing hundreds of thousands of real files on disk: the pre-fix implementation
  // ignores this third parameter entirely (its budget was hardwired to the real 200,000/1,000,000
  // constant), so this fixture — four entries against a cap of three — never trips it and the
  // expected throw never happens.
  it("throws a named error when the payload exceeds a small injected entry-count budget", () => {
    const source = makePolicyAllowedRoot();
    const dest = makePolicyAllowedRoot();
    rmSync(dest, { recursive: true, force: true });
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(join(source, `f${String(i)}.txt`), "x", "utf8");
    }
    expect(() => {
      _copyTreeSafeForTests(source, dest, { maxEntries: 3, maxBytes: PORTABLE_TEST_HUGE_BYTES });
    }).toThrow(/exceeds maximum entry count \(3\)/);
  });

  // The enumeration must abort AS SOON AS the cap is exceeded, not after copying everything and
  // checking at the end: with a 3-entry cap and 4 source files, at most 3 files may have been
  // copied before the throw.
  it("stops copying once the injected entry-count budget is exceeded, mid-directory", () => {
    const source = makePolicyAllowedRoot();
    const dest = makePolicyAllowedRoot();
    rmSync(dest, { recursive: true, force: true });
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(join(source, `f${String(i)}.txt`), "x", "utf8");
    }
    expect(() => {
      _copyTreeSafeForTests(source, dest, { maxEntries: 3, maxBytes: PORTABLE_TEST_HUGE_BYTES });
    }).toThrow();
    const copied = existsSync(dest) ? readdirSync(dest).length : 0;
    expect(copied).toBeLessThanOrEqual(3);
  });

  // #2906 round 3 (comment 3865273684): the cumulative-byte cap (unaffected by the entries-cap
  // change) had no dedicated regression at all. A small injected `maxBytes` proves it without
  // writing gigabytes of fixture data.
  it("throws a named error when the payload exceeds a small injected byte budget", () => {
    const source = makePolicyAllowedRoot();
    const dest = makePolicyAllowedRoot();
    rmSync(dest, { recursive: true, force: true });
    writeFileSync(join(source, "big.txt"), "0123456789", "utf8"); // 10 bytes
    expect(() => {
      _copyTreeSafeForTests(source, dest, { maxEntries: PORTABLE_TEST_HUGE_ENTRIES, maxBytes: 5 });
    }).toThrow(/exceeds maximum cumulative size \(5 bytes\)/);
  });
});
