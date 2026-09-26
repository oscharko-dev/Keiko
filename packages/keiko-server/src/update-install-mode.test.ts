import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CommandDeniedError, DEFAULT_SANDBOX_POLICY, runCommand } from "@oscharko-dev/keiko-tools";
import {
  UPDATE_COMMAND_RULES,
  buildUpdateCommand,
  detectUpdateInstallMode,
  productionUpdateFacts,
  type UpdateRuntimeFacts,
} from "./update-install-mode.js";

const ROOT = "/usr/local/lib/node_modules/@oscharko-dev/keiko";
const YARN_ROOT = "/Users/alice/.config/yarn/global/node_modules/@oscharko-dev/keiko";
const WINDOWS_NPM_ROOT =
  "C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\@oscharko-dev\\keiko";
const PORTABLE_ROOT = "/Users/alice/Applications/Keiko.app/Contents/Resources/app";
const PORTABLE_STATE_DIR = "/Users/alice/.keiko";

type TestDetectorFs = NonNullable<Parameters<typeof productionUpdateFacts>[1]> & {
  readonly fileStatSync: (path: string) => {
    readonly ctimeMs: number;
    readonly dev: number;
    readonly ino: number;
    readonly isFile: () => boolean;
    readonly isSymbolicLink: () => boolean;
    readonly mtimeMs: number;
    readonly nlink: number;
    readonly size: number;
  };
  readonly readFileBytesSync: (path: string) => Uint8Array;
};

function fakeDetectorFs(manifestPath: string): Parameters<typeof productionUpdateFacts>[1] {
  return {
    existsSync: (path: string): boolean => path === manifestPath,
    readFileSync: (): string => JSON.stringify({ name: "@oscharko-dev/keiko" }),
    realpathSync: (path: string): string => path,
    lstatSync: () => ({ isSymbolicLink: () => false }),
  };
}

function fakeFiles(
  files: Readonly<Record<string, string>>,
  symlinks: readonly string[] = [],
): TestDetectorFs {
  const symlinkSet = new Set(symlinks);
  return {
    existsSync: (path: string): boolean =>
      Object.prototype.hasOwnProperty.call(files, path) || symlinkSet.has(path),
    readFileSync: (path: string): string => files[path] ?? "",
    readFileBytesSync: (path: string): Uint8Array => Buffer.from(files[path] ?? ""),
    fileStatSync: (path: string) => ({
      ctimeMs: 0,
      dev: 1,
      ino: 1,
      isFile: () => Object.prototype.hasOwnProperty.call(files, path),
      isSymbolicLink: () => false,
      mtimeMs: 0,
      nlink: 1,
      size: Buffer.byteLength(files[path] ?? ""),
    }),
    realpathSync: (path: string): string => path,
    lstatSync: (path: string) => ({ isSymbolicLink: () => symlinkSet.has(path) }),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function windowsGenerationFiles(
  overrides: {
    readonly registration?: ((value: Record<string, unknown>) => void) | undefined;
    readonly setup?: ((value: Record<string, unknown>) => void) | undefined;
  } = {},
): ReturnType<typeof fakeFiles> {
  const treeSha256 = "a".repeat(64);
  const launcher = "bounded signed launcher fixture";
  const launcherSha256 = sha256(launcher);
  const binding = {
    schemaVersion: 1,
    resourceRoot: `.portable/generations/${treeSha256}`,
    treeHashSchema: "KHT1",
    treeSha256,
    launcherPath: "Keiko.exe",
    launcherSha256,
  };
  const installRoot = "/Users/alice/Applications/Keiko";
  const packageRoot = `${installRoot}/${binding.resourceRoot}/app`;
  const setup: Record<string, unknown> = {
    schemaVersion: 2,
    platformTarget: "windows-x64",
    packageName: "@oscharko-dev/keiko",
    packageVersion: "0.2.14",
    stable: true,
    primaryLauncher: "Keiko.exe",
    bootstrapUpdateEligible: false,
    runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
    windowsGeneration: binding,
  };
  overrides.setup?.(setup);
  const setupBytes = `${JSON.stringify(setup, null, 2)}\n`;
  const registration: Record<string, unknown> = {
    schemaVersion: 2,
    status: "managed",
    updateEligible: true,
    platformTarget: "windows-x64",
    packageVersion: "0.2.14",
    stable: true,
    managedRootLocator: { kind: "default" },
    setupManifestSha256: sha256(setupBytes),
    installRootIdentitySha256: sha256(installRoot),
    launcherIdentitySha256: launcherSha256,
    windowsGeneration: binding,
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
  overrides.registration?.(registration);
  return fakeFiles({
    [`${packageRoot}/package.json`]: JSON.stringify({
      name: "@oscharko-dev/keiko",
      version: "0.2.14",
    }),
    [`${installRoot}/.portable/setup-manifest.json`]: setupBytes,
    [`${installRoot}/Keiko.exe`]: launcher,
    [`${PORTABLE_STATE_DIR}/portable-install-state.json`]: JSON.stringify(registration),
  });
}

function facts(overrides: Partial<UpdateRuntimeFacts> = {}): UpdateRuntimeFacts {
  return {
    packageRoot: ROOT,
    packageName: "@oscharko-dev/keiko",
    packageManagerHint: "npm",
    installScope: "global",
    ...overrides,
  };
}

function portableManifest(
  platformTarget: "windows-x64" | "macos-arm64" | "macos-x64" = "macos-arm64",
): string {
  return JSON.stringify({
    schemaVersion: 1,
    platformTarget,
    packageName: "@oscharko-dev/keiko",
    packageVersion: "0.2.14",
    stable: true,
  });
}

function managedRegistration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    status: "managed",
    updateEligible: true,
    platformTarget: "macos-arm64",
    packageVersion: "0.2.14",
    stable: true,
    managedRootLocator: { kind: "default" },
    setupManifestSha256: "a".repeat(64),
    installRootIdentitySha256: "b".repeat(64),
    launcherIdentitySha256: "c".repeat(64),
    updatedAt: "2026-07-06T00:00:00.000Z",
    ...overrides,
  });
}

function portableFiles(
  packageRoot: string = PORTABLE_ROOT,
  registration: string | false = managedRegistration(),
): ReturnType<typeof fakeFiles> {
  const files: Record<string, string> = {
    [join(packageRoot, "package.json")]: JSON.stringify({ name: "@oscharko-dev/keiko" }),
    [join(dirname(packageRoot), ".portable", "setup-manifest.json")]: portableManifest(),
  };
  if (registration !== false) {
    files[join(PORTABLE_STATE_DIR, "portable-install-state.json")] = registration;
  }
  return fakeFiles(files);
}

describe("detectUpdateInstallMode", () => {
  it("supports deterministic global npm and Yarn installs", () => {
    const npmMode = detectUpdateInstallMode(facts());
    const yarnMode = detectUpdateInstallMode(facts({ packageManagerHint: "yarn" }));

    expect(npmMode.packageManager).toBe("npm");
    expect(npmMode.installKind).toBe("package-manager");
    expect(npmMode.recommendedAction).toBe("package-manager-maintenance");
    expect(yarnMode.packageManager).toBe("yarn");
  });

  it("refuses transient, checkout, linked, launcher-drift, and local installs", () => {
    expect(detectUpdateInstallMode(facts({ transientRunner: true })).reason).toBe(
      "transient-runner",
    );
    expect(detectUpdateInstallMode(facts({ localCheckout: true })).reason).toBe("local-checkout");
    expect(detectUpdateInstallMode(facts({ linkedPackage: true })).reason).toBe("linked-package");
    expect(detectUpdateInstallMode(facts({ launcherDrift: true })).reason).toBe("launcher-drift");
    expect(detectUpdateInstallMode(facts({ installScope: "local" })).reason).toBe("local-install");
  });

  it("fails closed when the package manager is ambiguous", () => {
    expect(detectUpdateInstallMode(facts({ packageManagerHint: undefined })).reason).toBe(
      "package-manager-ambiguous",
    );
  });

  it("infers npm from an env-free published global bin path", () => {
    const runtimeFacts = productionUpdateFacts(
      { KEIKO_CLI_BIN_PATH: `${ROOT}/dist/cli/index.js` },
      fakeDetectorFs(`${ROOT}/package.json`),
    );

    expect(runtimeFacts.packageManagerHint).toBe("npm");
    expect(detectUpdateInstallMode(runtimeFacts, {}).packageManager).toBe("npm");
  });

  it("infers npm from an env-free Windows global bin path", () => {
    const runtimeFacts = productionUpdateFacts(
      { KEIKO_CLI_BIN_PATH: `${WINDOWS_NPM_ROOT}\\dist\\cli\\index.js` },
      fakeDetectorFs(`${WINDOWS_NPM_ROOT}\\package.json`),
    );

    expect(runtimeFacts.packageRoot).toBe(WINDOWS_NPM_ROOT);
    expect(runtimeFacts.packageManagerHint).toBe("npm");
    expect(runtimeFacts.installScope).toBeUndefined();
    expect(detectUpdateInstallMode(runtimeFacts, {}).packageManager).toBe("npm");
  });

  it("infers Yarn from an env-free Yarn global bin path", () => {
    const runtimeFacts = productionUpdateFacts(
      { KEIKO_CLI_BIN_PATH: `${YARN_ROOT}/dist/cli/index.js` },
      fakeDetectorFs(`${YARN_ROOT}/package.json`),
    );

    expect(runtimeFacts.packageManagerHint).toBe("yarn");
    expect(detectUpdateInstallMode(runtimeFacts, {}).packageManager).toBe("yarn");
  });

  it("attests portable-managed installs from managed install records", () => {
    const mode = detectUpdateInstallMode(
      facts({
        packageRoot: PORTABLE_ROOT,
        packageManagerHint: undefined,
        installScope: "local",
        portableStateDir: PORTABLE_STATE_DIR,
      }),
      {},
      portableFiles(),
    );

    expect(mode.status).toBe("supported");
    expect(mode.installKind).toBe("portable-managed");
    expect(mode.packageManager).toBeUndefined();
    expect(mode.recommendedAction).toBe("portable-managed-update");
    expect(mode.portable).toMatchObject({
      status: "managed",
      target: "macos-arm64",
      updateEligible: true,
      packageVersion: "0.2.14",
      managedRootKind: "default",
    });
  });

  it("attests a Windows managed generation only when setup, registration, launcher, and package agree", () => {
    const treeSha256 = "a".repeat(64);
    const packageRoot = `/Users/alice/Applications/Keiko/.portable/generations/${treeSha256}/app`;
    const mode = detectUpdateInstallMode(
      facts({
        packageRoot,
        packageManagerHint: undefined,
        installScope: "local",
        portableStateDir: PORTABLE_STATE_DIR,
      }),
      {},
      windowsGenerationFiles(),
    );

    expect(mode).toMatchObject({
      status: "supported",
      installKind: "portable-managed",
      portable: {
        status: "managed",
        target: "windows-x64",
        updateEligible: true,
        packageVersion: "0.2.14",
      },
    });
  });

  it("refuses an oversized Windows launcher before reading its bytes", () => {
    const treeSha256 = "a".repeat(64);
    const installRoot = "/Users/alice/Applications/Keiko";
    const packageRoot = `${installRoot}/.portable/generations/${treeSha256}/app`;
    const base = windowsGenerationFiles();
    const launcherPath = `${installRoot}/Keiko.exe`;
    const readFileBytesSync = vi.fn(base.readFileBytesSync);
    const detectorFs: TestDetectorFs = {
      ...base,
      readFileBytesSync,
      fileStatSync: (path) =>
        path === launcherPath
          ? {
              ctimeMs: 0,
              dev: 1,
              ino: 1,
              isFile: () => true,
              isSymbolicLink: () => false,
              mtimeMs: 0,
              nlink: 1,
              size: 64 * 1024 * 1024 + 1,
            }
          : base.fileStatSync(path),
    };

    expect(() =>
      detectUpdateInstallMode(
        facts({
          packageRoot,
          packageManagerHint: undefined,
          installScope: "local",
          portableStateDir: PORTABLE_STATE_DIR,
        }),
        {},
        detectorFs,
      ),
    ).toThrow("portable identity file is unsafe or oversized");
    expect(readFileBytesSync.mock.calls.some(([path]) => path === launcherPath)).toBe(false);
  });

  it.each(["ctime", "hardlink"] as const)(
    "refuses a Windows launcher whose %s identity changes during hashing",
    (scenario) => {
      const treeSha256 = "a".repeat(64);
      const installRoot = "/Users/alice/Applications/Keiko";
      const packageRoot = `${installRoot}/.portable/generations/${treeSha256}/app`;
      const launcherPath = `${installRoot}/Keiko.exe`;
      const base = windowsGenerationFiles();
      let launcherStats = 0;
      const detectorFs: TestDetectorFs = {
        ...base,
        fileStatSync: (path) => {
          const stat = base.fileStatSync(path);
          if (path !== launcherPath) return stat;
          launcherStats += 1;
          return {
            ...stat,
            ...(scenario === "ctime" ? { ctimeMs: launcherStats } : {}),
            ...(scenario === "hardlink" && launcherStats === 2 ? { nlink: 2 } : {}),
          };
        },
      };

      expect(() =>
        detectUpdateInstallMode(
          facts({
            packageRoot,
            packageManagerHint: undefined,
            installScope: "local",
            portableStateDir: PORTABLE_STATE_DIR,
          }),
          {},
          detectorFs,
        ),
      ).toThrow("portable identity file changed while it was read");
      expect(launcherStats).toBe(2);
    },
  );

  it("keeps historical flat Windows schema 1 registrations manual-only", () => {
    const installRoot = "/Users/alice/Applications/Keiko";
    const packageRoot = `${installRoot}/app`;
    const detectorFs = fakeFiles({
      [`${installRoot}/.portable/setup-manifest.json`]: portableManifest("windows-x64"),
      [`${PORTABLE_STATE_DIR}/portable-install-state.json`]: managedRegistration({
        platformTarget: "windows-x64",
        updateEligible: true,
      }),
    });
    const mode = detectUpdateInstallMode(
      facts({
        packageRoot,
        packageManagerHint: undefined,
        installScope: "local",
        portableStateDir: PORTABLE_STATE_DIR,
      }),
      {},
      detectorFs,
    );

    expect(mode).toMatchObject({
      status: "unsupported",
      reason: "portable-bootstrap",
      portable: { target: "windows-x64", updateEligible: false },
    });
  });

  it.each([
    [
      "registration generation",
      windowsGenerationFiles({
        registration: (value) => {
          value.windowsGeneration = {
            ...(value.windowsGeneration as Record<string, unknown>),
            launcherSha256: "c".repeat(64),
          };
        },
      }),
    ],
    [
      "setup generation",
      windowsGenerationFiles({
        setup: (value) => {
          value.windowsGeneration = {
            ...(value.windowsGeneration as Record<string, unknown>),
            launcherSha256: "c".repeat(64),
          };
        },
      }),
    ],
    [
      "launcher digest",
      windowsGenerationFiles({
        registration: (value) => {
          value.launcherIdentitySha256 = "d".repeat(64);
        },
      }),
    ],
    [
      "root identity",
      windowsGenerationFiles({
        registration: (value) => {
          value.installRootIdentitySha256 = "e".repeat(64);
        },
      }),
    ],
  ])("refuses Windows managed eligibility when %s is rebound", (_name, detectorFs) => {
    const treeSha256 = "a".repeat(64);
    const mode = detectUpdateInstallMode(
      facts({
        packageRoot: `/Users/alice/Applications/Keiko/.portable/generations/${treeSha256}/app`,
        packageManagerHint: undefined,
        installScope: "local",
        portableStateDir: PORTABLE_STATE_DIR,
      }),
      {},
      detectorFs,
    );

    expect(mode.status).toBe("unsupported");
    expect(mode.reason).toBe("portable-registration-invalid");
  });

  it("treats unmanaged portable ZIP roots as bootstrap-only", () => {
    const mode = detectUpdateInstallMode(
      facts({
        packageRoot: PORTABLE_ROOT,
        packageManagerHint: undefined,
        installScope: "local",
        portableStateDir: PORTABLE_STATE_DIR,
      }),
      {},
      portableFiles(PORTABLE_ROOT, false),
    );

    expect(mode.status).toBe("unsupported");
    expect(mode.reason).toBe("portable-bootstrap");
    expect(mode.installKind).toBe("portable-bootstrap");
    expect(mode.recommendedAction).toBe("portable-bootstrap-setup");
    expect(mode.portable?.updateEligible).toBe(false);
  });

  it("does not mark system-managed portable installs as self-update eligible", () => {
    const packageRoot = "/Applications/Keiko.app/Contents/Resources/app";
    const mode = detectUpdateInstallMode(
      facts({
        packageRoot,
        packageManagerHint: undefined,
        installScope: "local",
        portableStateDir: PORTABLE_STATE_DIR,
      }),
      {},
      portableFiles(packageRoot),
    );

    expect(mode.status).toBe("unsupported");
    expect(mode.reason).toBe("portable-it-managed");
    expect(mode.portable).toMatchObject({
      status: "it-managed",
      updateEligible: false,
    });
  });

  it("fails closed when a portable record does not match the running portable manifest", () => {
    const mode = detectUpdateInstallMode(
      facts({
        packageRoot: PORTABLE_ROOT,
        packageManagerHint: undefined,
        installScope: "local",
        portableStateDir: PORTABLE_STATE_DIR,
      }),
      {},
      portableFiles(PORTABLE_ROOT, managedRegistration({ packageVersion: "0.2.13" })),
    );

    expect(mode.status).toBe("unsupported");
    expect(mode.reason).toBe("portable-registration-invalid");
    expect(mode.recommendedAction).toBe("manual-download");
  });

  it("includes portable state directory facts in production detection", () => {
    const runtimeFacts = productionUpdateFacts(
      {
        KEIKO_CLI_BIN_PATH: `${PORTABLE_ROOT}/dist/cli/index.js`,
        KEIKO_STATE_DIR: PORTABLE_STATE_DIR,
      },
      portableFiles(),
    );

    expect(runtimeFacts.portableStateDir).toBe(PORTABLE_STATE_DIR);
    expect(detectUpdateInstallMode(runtimeFacts, {}, portableFiles()).installKind).toBe(
      "portable-managed",
    );
  });
});

describe("update command policy", () => {
  it("builds exact npm and Yarn argv without shell strings", () => {
    expect(buildUpdateCommand("npm", "0.2.12")).toMatchObject({
      executable: "npm",
      args: ["install", "--global", "--ignore-scripts", "@oscharko-dev/keiko@0.2.12"],
    });
    expect(buildUpdateCommand("yarn", "0.2.12")).toMatchObject({
      executable: "yarn",
      args: ["global", "add", "--ignore-scripts", "@oscharko-dev/keiko@0.2.12"],
    });
  });

  it("denies package-manager flags outside the update argv", async () => {
    await expect(
      runCommand(
        {
          command: "npm",
          args: ["--prefix", "/tmp/evil", "install", "@oscharko-dev/keiko@0.2.12"],
          cwd: undefined,
          timeoutMs: 1_000,
          signal: new AbortController().signal,
        },
        {
          workspace: {
            root: process.cwd(),
            selectedRoot: process.cwd(),
            name: undefined,
            version: undefined,
            testFramework: "unknown",
            sourceDirs: [],
            testDirs: [],
            languages: [],
            ignoreLines: [],
          },
          policy: DEFAULT_SANDBOX_POLICY,
          commandRules: UPDATE_COMMAND_RULES,
          spawn: () => {
            throw new Error("spawn should not run");
          },
          processEnv: { PATH: process.env.PATH },
          now: Date.now,
        },
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
  });
});
