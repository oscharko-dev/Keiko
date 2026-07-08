import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runPortableCli } from "./portable.js";
import {
  readPortableInstallRegistration,
  writeFailedRegistration,
} from "./portable-registration.js";

type PortableTarget = "windows-x64" | "macos-arm64" | "macos-x64";

const roots: string[] = [];
const NOW = new Date("2026-07-06T00:00:00.000Z");

function tempRoot(): string {
  const base = join(homedir(), ".keiko-test-roots");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "portable-cli-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function capture(): {
  readonly io: { readonly out: (text: string) => void; readonly err: (text: string) => void };
  readonly out: () => string;
  readonly err: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      out: (text: string): void => {
        stdout += text;
      },
      err: (text: string): void => {
        stderr += text;
      },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

function setupManifest(target: PortableTarget, version = "0.2.11"): string {
  const runtime =
    target === "windows-x64"
      ? { nodePlatform: "win32", nodeArchitecture: "x64" }
      : {
          nodePlatform: "darwin",
          nodeArchitecture: target === "macos-arm64" ? "arm64" : "x64",
        };
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      platformTarget: target,
      packageName: "@oscharko-dev/keiko",
      packageVersion: version,
      stable: true,
      primaryLauncher: target === "windows-x64" ? "Keiko.exe" : "Keiko.app",
      bootstrapUpdateEligible: false,
      runtime,
    },
    null,
    2,
  )}\n`;
}

function setupManifestRecord(target: PortableTarget): Record<string, unknown> {
  return JSON.parse(setupManifest(target)) as Record<string, unknown>;
}

function writeSetupManifest(root: string, manifest: unknown): void {
  writeFileSync(
    join(root, ".portable", "setup-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeApp(appRoot: string, version = "0.2.11"): void {
  mkdirSync(join(appRoot, "dist", "cli"), { recursive: true });
  writeFileSync(
    join(appRoot, "package.json"),
    `${JSON.stringify({ name: "@oscharko-dev/keiko", version }, null, 2)}\n`,
  );
  writeFileSync(join(appRoot, "dist", "cli", "index.js"), "fixture cli\n");
}

function writeWindowsFixture(root: string, version = "0.2.11", manifestVersion = "0.2.11"): void {
  mkdirSync(join(root, "runtime", "node"), { recursive: true });
  mkdirSync(join(root, ".portable"), { recursive: true });
  writeApp(join(root, "app"), version);
  writeFileSync(join(root, "runtime", "node", "node.exe"), "fixture node\n");
  writeFileSync(join(root, "Keiko.exe"), "fixture launcher\n");
  writeFileSync(
    join(root, ".portable", "setup-manifest.json"),
    setupManifest("windows-x64", manifestVersion),
  );
}

function writeMacFixture(
  root: string,
  target: "macos-arm64" | "macos-x64",
  version = "0.2.11",
  manifestVersion = "0.2.11",
): string {
  const app = join(root, "Keiko.app");
  const resources = join(app, "Contents", "Resources");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(resources, "runtime", "node", "bin"), { recursive: true });
  mkdirSync(join(resources, ".portable"), { recursive: true });
  writeApp(join(resources, "app"), version);
  writeFileSync(join(resources, "runtime", "node", "bin", "node"), "fixture node\n");
  writeFileSync(join(app, "Contents", "MacOS", "Keiko"), "fixture launcher\n");
  writeFileSync(
    join(resources, ".portable", "setup-manifest.json"),
    setupManifest(target, manifestVersion),
  );
  return app;
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

function writePortableFixture(root: string, target: PortableTarget, version = "0.2.11"): string {
  if (target === "windows-x64") {
    writeWindowsFixture(root, version, version);
    return root;
  }
  writeMacFixture(root, target, version, version);
  return root;
}

function managedRootForTarget(home: string, target: PortableTarget): string {
  if (target === "windows-x64") return join(home, "managed", "Keiko");
  return join(home, "Applications", "Keiko.app");
}

function appPackagePath(managedRoot: string, target: PortableTarget): string {
  if (target === "windows-x64") return join(managedRoot, "app", "package.json");
  return join(managedRoot, "Contents", "Resources", "app", "package.json");
}

function packageVersionAt(managedRoot: string, target: PortableTarget): string {
  const parsed: unknown = JSON.parse(readFileSync(appPackagePath(managedRoot, target), "utf8"));
  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new Error("package fixture is malformed");
  }
  return parsed.version;
}

function portableLaunchArgs(
  target: PortableTarget,
  portableRoot: string,
  managedRoot: string,
  stateDir: string,
): readonly string[] {
  return [
    "launch",
    "--target",
    target,
    "--portable-root",
    portableRoot,
    "--managed-root",
    managedRoot,
    "--state-dir",
    stateDir,
  ];
}

function registration(stateDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(stateDir, "portable-install-state.json"), "utf8"),
  );
  if (!isRecord(parsed)) {
    throw new Error("portable registration is malformed");
  }
  return parsed;
}

function writePortableRegistration(stateDir: string, record: Record<string, unknown>): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "portable-install-state.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

interface InvalidSetupManifestCase {
  readonly name: string;
  readonly manifest: (base: Record<string, unknown>) => unknown;
  readonly message: string;
}

const INVALID_SETUP_MANIFEST_CASES: readonly InvalidSetupManifestCase[] = [
  {
    name: "wrong schema",
    manifest: (base) => ({ ...base, schemaVersion: 2 }),
    message: "portable setup manifest is malformed",
  },
  {
    name: "unsupported target",
    manifest: (base) => ({ ...base, platformTarget: "linux-x64" }),
    message: "portable setup manifest target is unsupported",
  },
  {
    name: "malformed package fields",
    manifest: (base) => ({ ...base, packageVersion: 11 }),
    message: "portable setup manifest package fields are malformed",
  },
  {
    name: "malformed state flags",
    manifest: (base) => ({ ...base, stable: "yes" }),
    message: "portable setup manifest state flags are malformed",
  },
  {
    name: "malformed launcher",
    manifest: (base) => ({ ...base, primaryLauncher: 42 }),
    message: "portable setup manifest launcher field is malformed",
  },
  {
    name: "malformed runtime",
    manifest: (base) => ({ ...base, runtime: null }),
    message: "portable setup manifest runtime is malformed",
  },
  {
    name: "unsupported runtime platform",
    manifest: (base) => ({
      ...base,
      runtime: { nodePlatform: "linux", nodeArchitecture: "x64" },
    }),
    message: "portable setup manifest runtime platform is unsupported",
  },
  {
    name: "unsupported runtime architecture",
    manifest: (base) => ({
      ...base,
      runtime: { nodePlatform: "win32", nodeArchitecture: "ppc64" },
    }),
    message: "portable setup manifest runtime architecture is unsupported",
  },
  {
    name: "target mismatch",
    manifest: (base) => ({ ...base, platformTarget: "macos-arm64" }),
    message: "portable setup manifest target mismatch",
  },
  {
    name: "package mismatch",
    manifest: (base) => ({ ...base, packageName: "keiko" }),
    message: "portable setup manifest package mismatch",
  },
  {
    name: "unstable release",
    manifest: (base) => ({ ...base, stable: false }),
    message: "portable setup manifest must describe a stable release",
  },
  {
    name: "bootstrap update eligible",
    manifest: (base) => ({ ...base, bootstrapUpdateEligible: true }),
    message: "bootstrap roots are not update eligible",
  },
  {
    name: "launcher mismatch",
    manifest: (base) => ({ ...base, primaryLauncher: "Keiko.app" }),
    message: "portable setup manifest launcher target mismatch",
  },
  {
    name: "runtime target mismatch",
    manifest: (base) => ({
      ...base,
      runtime: { nodePlatform: "darwin", nodeArchitecture: "arm64" },
    }),
    message: "portable setup manifest runtime target mismatch",
  },
];

describe("runPortableCli", () => {
  it.each([[[]], [["--help"]], [["-h"]]] as const)(
    "prints help for portable args %j",
    async (args) => {
      const c = capture();

      const code = await runPortableCli(args, c.io, {});

      expect(code).toBe(0);
      expect(c.out()).toContain("keiko portable setup");
    },
  );

  it.each([
    ["unknown command", ["bogus"]],
    ["unknown flag", ["setup", "--bogus"]],
    ["missing flag value", ["setup", "--target"]],
    ["unsupported target flag", ["setup", "--target", "linux-x64"]],
  ] as const)("prints usage for invalid portable args: %s", async (_name, args) => {
    const c = capture();

    const code = await runPortableCli(args, c.io, {});

    expect(code).toBe(2);
    expect(c.err()).toContain("keiko portable setup");
  });

  it("rejects a host without an implicit portable target", async () => {
    const c = capture();

    const code = await runPortableCli(
      ["setup"],
      c.io,
      {},
      {
        platform: () => "linux",
        arch: () => "x64",
      },
    );

    expect(code).toBe(2);
    expect(c.err()).toContain("keiko portable setup");
  });

  it("creates the Windows Start Menu shortcut only during explicit setup and targets the managed install", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    const managedRoot = join(env.LOCALAPPDATA, "Programs", "Keiko");
    const shortcut = join(
      env.APPDATA,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Keiko.bat",
    );
    writeWindowsFixture(source);
    const c = capture();

    expect(existsSync(shortcut)).toBe(false);

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
        stateDir,
      ],
      c.io,
      env,
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(0);
    expect(existsSync(shortcut)).toBe(true);
    expect(readFileSync(shortcut, "utf8")).toContain(join(managedRoot, "Keiko.exe"));
  });

  it("promotes a Windows bootstrap payload into a managed root and records content-free state", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "managed", "Keiko");
    const stateDir = join(root, "state");
    writeWindowsFixture(source);
    const c = capture();

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
        stateDir,
      ],
      c.io,
      env,
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(0);
    expect(existsSync(join(managedRoot, "Keiko.exe"))).toBe(true);
    expect(registration(stateDir)).toMatchObject({
      schemaVersion: 1,
      status: "managed",
      updateEligible: true,
      platformTarget: "windows-x64",
      packageVersion: "0.2.11",
      stable: true,
    });
    expect(readFileSync(join(stateDir, "portable-install-state.json"), "utf8")).not.toContain(root);
  });

  it("stores a home-relative managed-root locator for a custom Windows managed root", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "PortableApps", "Keiko");
    const stateDir = join(root, "state");
    writeWindowsFixture(source);

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
        stateDir,
      ],
      capture().io,
      env,
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(0);
    expect(readPortableInstallRegistration(stateDir)).toMatchObject({
      status: "managed",
      managedRootLocator: {
        kind: "home-relative",
        path: "PortableApps/Keiko",
      },
    });
  });

  it("ignores hostile managed-root locators when reading portable install state", () => {
    const root = tempRoot();
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    for (const managedRootLocator of [
      { kind: "home-relative", path: "../escape" },
      { kind: "home-relative", path: "/tmp/Keiko" },
      { kind: "absolute-local", path: "PortableApps/Keiko" },
    ]) {
      writeFileSync(
        join(stateDir, "portable-install-state.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            status: "managed",
            updateEligible: true,
            platformTarget: "windows-x64",
            packageVersion: "0.2.11",
            stable: true,
            managedRootLocator,
            updatedAt: NOW.toISOString(),
          },
          null,
          2,
        )}\n`,
      );

      const registration = readPortableInstallRegistration(stateDir);
      expect(registration?.status).toBe("managed");
      expect(registration?.status === "managed" ? registration.managedRootLocator : undefined).toBe(
        undefined,
      );
    }
  });

  it("creates the macOS user-local app only during explicit setup", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const managedRoot = join(home, "Applications", "Keiko.app");
    const stateDir = join(root, "state");
    writeMacFixture(source, "macos-x64");
    const c = capture();

    expect(existsSync(managedRoot)).toBe(false);

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
        stateDir,
      ],
      c.io,
      {},
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(0);
    expect(existsSync(join(managedRoot, "Contents", "MacOS", "Keiko"))).toBe(true);
    expect(registration(stateDir)).toMatchObject({
      status: "managed",
      platformTarget: "macos-x64",
      updateEligible: true,
    });
  });

  it.each(INVALID_SETUP_MANIFEST_CASES)(
    "rejects invalid setup manifest: $name",
    async ({ manifest, message }) => {
      const root = tempRoot();
      const source = join(root, "bootstrap");
      const stateDir = join(root, "state");
      writeWindowsFixture(source);
      writeSetupManifest(source, manifest(setupManifestRecord("windows-x64")));
      const c = capture();

      const code = await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          source,
          "--managed-root",
          join(root, "managed", "Keiko"),
          "--state-dir",
          stateDir,
        ],
        c.io,
        {},
        { now: () => NOW },
      );

      expect(code).toBe(1);
      expect(c.err()).toContain(message);
      expect(registration(stateDir)).toMatchObject({
        status: "setup-failed",
        updateEligible: false,
      });
    },
  );

  it("records setup-failed as not update eligible when validation fails", async () => {
    const root = tempRoot();
    const source = join(root, "bootstrap");
    const stateDir = join(root, "state");
    writeWindowsFixture(source, "0.2.10");
    const c = capture();

    const code = await runPortableCli(
      [
        "setup",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        join(root, "managed", "Keiko"),
        "--state-dir",
        stateDir,
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("portable app package version mismatch");
    expect(registration(stateDir)).toMatchObject({
      status: "setup-failed",
      updateEligible: false,
      platformTarget: "windows-x64",
    });
  });

  it("keeps failed setup registration content-free when filesystem validation fails", async () => {
    const root = tempRoot();
    const source = join(root, "bootstrap");
    const stateDir = join(root, "state");
    writeWindowsFixture(source);
    rmSync(join(source, "runtime", "node", "node.exe"), { force: true });
    const c = capture();

    const code = await runPortableCli(
      [
        "setup",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        join(root, "managed", "Keiko"),
        "--state-dir",
        stateDir,
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    const state = readFileSync(join(stateDir, "portable-install-state.json"), "utf8");
    expect(code).toBe(1);
    expect(c.err()).toContain("missing portable bundled Node runtime");
    expect(registration(stateDir)).toMatchObject({
      status: "setup-failed",
      updateEligible: false,
      failureReason: "runtime-invalid",
    });
    expect(state).not.toContain(root);
  });

  it("refuses a symlinked portable install record during setup without overwriting the symlink target", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(env.LOCALAPPDATA, "Programs", "Keiko");
    const stateDir = join(root, "state");
    const outside = join(root, "outside-record.json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(outside, "keep-me\n", "utf8");
    symlinkSync(outside, join(stateDir, "portable-install-state.json"));
    writeWindowsFixture(source);
    const c = capture();

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
        stateDir,
      ],
      c.io,
      env,
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("portable install record refuses symlinked state file");
    expect(readFileSync(outside, "utf8")).toBe("keep-me\n");
  });

  it("refuses to read a symlinked portable install record", () => {
    const root = tempRoot();
    const stateDir = join(root, "state");
    const outside = join(root, "outside-record.json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(outside, "{}\n", "utf8");
    symlinkSync(outside, join(stateDir, "portable-install-state.json"));

    expect(() => readPortableInstallRegistration(stateDir)).toThrow(
      "portable install record refuses symlinked state file",
    );
  });

  it("refuses to write through a symlinked state directory", () => {
    const root = tempRoot();
    const outsideState = join(root, "outside-state");
    const linkedState = join(root, "linked-state");
    mkdirSync(outsideState, { recursive: true });
    symlinkSync(outsideState, linkedState, "dir");

    expect((): void => {
      writeFailedRegistration("windows-x64", linkedState, NOW, "portable setup manifest is broken");
    }).toThrow("portable install record refuses symlinked state directory");
    expect(existsSync(join(outsideState, "portable-install-state.json"))).toBe(false);
  });

  it("refuses to read through a symlinked state directory", () => {
    const root = tempRoot();
    const outsideState = join(root, "outside-state");
    const linkedState = join(root, "linked-state");
    mkdirSync(outsideState, { recursive: true });
    writeFileSync(
      join(outsideState, "portable-install-state.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "setup-failed",
          updateEligible: false,
          platformTarget: "windows-x64",
          packageVersion: "unknown",
          stable: false,
          failureReason: "setup-failed",
          updatedAt: NOW.toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    symlinkSync(outsideState, linkedState, "dir");

    expect(() => readPortableInstallRegistration(linkedState)).toThrow(
      "portable install record refuses symlinked state directory",
    );
  });

  it("returns undefined for missing or unrecognized portable install records", () => {
    const root = tempRoot();
    const stateDir = join(root, "state");

    expect(readPortableInstallRegistration(stateDir)).toBeUndefined();

    writePortableRegistration(stateDir, { schemaVersion: 1, status: "unknown" });

    expect(readPortableInstallRegistration(stateDir)).toBeUndefined();
  });

  it("reads managed records with default and absolute-local locators", () => {
    const root = tempRoot();
    const stateDir = join(root, "state");

    for (const managedRootLocator of [
      { kind: "default" },
      { kind: "absolute-local", path: "C:\\Users\\Keiko\\AppData\\Local\\Programs\\Keiko" },
    ]) {
      writePortableRegistration(stateDir, {
        schemaVersion: 1,
        status: "managed",
        updateEligible: true,
        platformTarget: "windows-x64",
        packageVersion: "0.2.11",
        stable: true,
        managedRootLocator,
      });

      const parsed = readPortableInstallRegistration(stateDir);
      expect(parsed).toMatchObject({
        status: "managed",
        managedRootLocator,
        updatedAt: "",
      });
    }
  });

  it("reads failed records without optional failure details", () => {
    const root = tempRoot();
    const stateDir = join(root, "state");
    writePortableRegistration(stateDir, {
      schemaVersion: 1,
      status: "setup-failed",
      updateEligible: false,
      platformTarget: "macos-arm64",
      packageVersion: "unknown",
      stable: false,
    });

    expect(readPortableInstallRegistration(stateDir)).toMatchObject({
      status: "setup-failed",
      platformTarget: "macos-arm64",
      failureReason: undefined,
      updatedAt: "",
    });
  });

  it("classifies an unpromoted macOS app bundle as unmanaged", async () => {
    const root = tempRoot();
    const app = writeMacFixture(join(root, "bootstrap"), "macos-x64");
    const c = capture();

    const code = await runPortableCli(
      [
        "status",
        "--target",
        "macos-x64",
        "--portable-root",
        app,
        "--managed-root",
        join(root, "Applications", "Keiko.app"),
        "--state-dir",
        join(root, "state"),
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    expect(code).toBe(0);
    expect(JSON.parse(c.out())).toMatchObject({
      status: "unmanaged",
      updateEligible: false,
      platformTarget: "macos-x64",
    });
  });

  it("does not mark a same-path managed root update-eligible before setup attestation", async () => {
    const root = tempRoot();
    const managedRoot = join(root, "managed", "Keiko");
    const c = capture();
    writeWindowsFixture(managedRoot);

    const code = await runPortableCli(
      [
        "status",
        "--target",
        "windows-x64",
        "--portable-root",
        managedRoot,
        "--managed-root",
        managedRoot,
        "--state-dir",
        join(root, "state"),
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    expect(code).toBe(0);
    expect(JSON.parse(c.out())).toMatchObject({
      status: "unmanaged",
      updateEligible: false,
      platformTarget: "windows-x64",
    });
  });

  it("launches by promoting the bootstrap payload, writing content-free state, and handing off to the managed launcher", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "managed", "Keiko");
    const stateDir = join(root, "state");
    const c = capture();
    const spawns: {
      command: string;
      args: readonly string[];
      options: SpawnOptions;
    }[] = [];
    writeWindowsFixture(source);

    const code = await runPortableCli(
      [
        "launch",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        managedRoot,
        "--state-dir",
        stateDir,
      ],
      c.io,
      env,
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: (command, args, options) => {
          spawns.push({ command, args, options });
          return spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
        },
      },
    );

    expect(code).toBe(0);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      command: join(managedRoot, "Keiko.exe"),
      args: [],
      options: { detached: true, stdio: "ignore" },
    });
    expect(registration(stateDir)).toMatchObject({
      status: "managed",
      updateEligible: true,
      platformTarget: "windows-x64",
    });
    expect(readFileSync(join(stateDir, "portable-install-state.json"), "utf8")).not.toContain(root);
  });

  it("launches the existing managed install when the bootstrap launcher is clicked after setup", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "managed", "Keiko");
    const stateDir = join(root, "state");
    const spawns: string[] = [];
    const lifecycleStarts: string[] = [];
    writeWindowsFixture(source);

    const first = await runPortableCli(
      [
        "launch",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        managedRoot,
        "--state-dir",
        stateDir,
      ],
      capture().io,
      env,
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: (command) => {
          spawns.push(command);
          return spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
        },
      },
    );
    const secondCapture = capture();

    const second = await runPortableCli(
      [
        "launch",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        managedRoot,
        "--state-dir",
        stateDir,
      ],
      secondCapture.io,
      env,
      {
        homedir: () => home,
        now: () => NOW,
        lifecycleFn: (_command, _args, _io, _env, deps) => {
          lifecycleStarts.push(deps.cwd);
          return Promise.resolve(0);
        },
      },
    );

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(spawns).toEqual([join(managedRoot, "Keiko.exe")]);
    expect(lifecycleStarts).toEqual([join(managedRoot, "app")]);
    expect(secondCapture.err()).not.toContain("already exists");
  });

  it.each(["windows-x64", "macos-arm64", "macos-x64"] as const)(
    "upgrades the managed install when a newer %s package is clicked",
    async (target) => {
      const root = tempRoot();
      const home = join(root, "home");
      const stateDir = join(root, "state");
      const managedRoot = managedRootForTarget(home, target);
      const env = target === "windows-x64" ? windowsPortableEnv(home) : {};
      const oldSource = writePortableFixture(join(root, "bootstrap"), target, "0.2.11");
      const newSource = writePortableFixture(join(root, "downloaded"), target, "0.2.12");
      const events: string[] = [];

      const first = await runPortableCli(
        portableLaunchArgs(target, oldSource, managedRoot, stateDir),
        capture().io,
        env,
        {
          homedir: () => home,
          now: () => NOW,
          spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
        },
      );
      writeFileSync(join(managedRoot, "active.txt"), "old install marker\n");
      const c = capture();

      const second = await runPortableCli(
        portableLaunchArgs(target, newSource, managedRoot, stateDir),
        c.io,
        env,
        {
          homedir: () => home,
          now: () => new Date("2026-07-07T00:00:00.000Z"),
          lifecycleFn: (command) => {
            events.push(command);
            return Promise.resolve(0);
          },
        },
      );

      expect(first).toBe(0);
      expect(second).toBe(0);
      expect(events).toEqual(["stop", "start"]);
      expect(packageVersionAt(managedRoot, target)).toBe("0.2.12");
      expect(existsSync(join(managedRoot, "active.txt"))).toBe(false);
      expect(registration(stateDir)).toMatchObject({ packageVersion: "0.2.12" });
      expect(c.out()).toContain("portable upgrade installed from downloaded package");
    },
  );

  it("does not downgrade the managed install when an older downloaded package is clicked", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const target: PortableTarget = "windows-x64";
    const managedRoot = managedRootForTarget(home, target);
    const env = windowsPortableEnv(home);
    const currentSource = writePortableFixture(join(root, "current"), target, "0.2.12");
    const olderSource = writePortableFixture(join(root, "older-download"), target, "0.2.11");
    const events: string[] = [];

    await runPortableCli(
      portableLaunchArgs(target, currentSource, managedRoot, stateDir),
      capture().io,
      env,
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      },
    );

    const code = await runPortableCli(
      portableLaunchArgs(target, olderSource, managedRoot, stateDir),
      capture().io,
      env,
      {
        homedir: () => home,
        lifecycleFn: (command) => {
          events.push(command);
          return Promise.resolve(0);
        },
      },
    );

    expect(code).toBe(0);
    expect(events).toEqual(["start"]);
    expect(packageVersionAt(managedRoot, target)).toBe("0.2.12");
    expect(registration(stateDir)).toMatchObject({ packageVersion: "0.2.12" });
  });

  it("replaces an attested Intel Mac managed install when an Apple Silicon package is clicked", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const managedRoot = managedRootForTarget(home, "macos-x64");
    const intelSource = writePortableFixture(join(root, "intel"), "macos-x64", "0.2.12");
    const armSource = writePortableFixture(join(root, "arm"), "macos-arm64", "0.2.12");
    const events: string[] = [];

    await runPortableCli(
      portableLaunchArgs("macos-x64", intelSource, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      },
    );

    const code = await runPortableCli(
      portableLaunchArgs("macos-arm64", armSource, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        now: () => new Date("2026-07-07T00:00:00.000Z"),
        lifecycleFn: (command) => {
          events.push(command);
          return Promise.resolve(0);
        },
      },
    );

    expect(code).toBe(0);
    expect(events).toEqual(["stop", "start"]);
    expect(packageVersionAt(managedRoot, "macos-arm64")).toBe("0.2.12");
    expect(registration(stateDir)).toMatchObject({
      packageVersion: "0.2.12",
      platformTarget: "macos-arm64",
    });
  });

  it("replaces a valid Intel Mac managed install when registration is stale setup-failed", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const managedRoot = managedRootForTarget(home, "macos-x64");
    const intelSource = writePortableFixture(join(root, "intel"), "macos-x64", "0.2.12");
    const armSource = writePortableFixture(join(root, "arm"), "macos-arm64", "0.2.12");
    const events: string[] = [];

    await runPortableCli(
      portableLaunchArgs("macos-x64", intelSource, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      },
    );
    writeFailedRegistration("macos-arm64", stateDir, NOW, "managed root already exists");

    const code = await runPortableCli(
      portableLaunchArgs("macos-arm64", armSource, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        now: () => new Date("2026-07-07T00:00:00.000Z"),
        lifecycleFn: (command) => {
          events.push(command);
          return Promise.resolve(0);
        },
      },
    );

    expect(code).toBe(0);
    expect(events).toEqual(["stop", "start"]);
    expect(packageVersionAt(managedRoot, "macos-arm64")).toBe("0.2.12");
    expect(registration(stateDir)).toMatchObject({
      packageVersion: "0.2.12",
      platformTarget: "macos-arm64",
      status: "managed",
    });
  });

  it("does not replace a newer Intel Mac managed install when an older Apple Silicon package is clicked", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const managedRoot = managedRootForTarget(home, "macos-x64");
    const intelSource = writePortableFixture(join(root, "intel"), "macos-x64", "0.2.12");
    const olderArmSource = writePortableFixture(join(root, "arm"), "macos-arm64", "0.2.11");
    const events: string[] = [];

    await runPortableCli(
      portableLaunchArgs("macos-x64", intelSource, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      },
    );

    const code = await runPortableCli(
      portableLaunchArgs("macos-arm64", olderArmSource, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        lifecycleFn: (command) => {
          events.push(command);
          return Promise.resolve(0);
        },
      },
    );

    expect(code).toBe(0);
    expect(events).toEqual(["start"]);
    expect(packageVersionAt(managedRoot, "macos-x64")).toBe("0.2.12");
    expect(registration(stateDir)).toMatchObject({
      packageVersion: "0.2.12",
      platformTarget: "macos-x64",
    });
  });

  it("preserves the managed install when the running UI cannot be stopped before upgrade", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const target: PortableTarget = "windows-x64";
    const managedRoot = managedRootForTarget(home, target);
    const env = windowsPortableEnv(home);
    const oldSource = writePortableFixture(join(root, "bootstrap"), target, "0.2.11");
    const newSource = writePortableFixture(join(root, "downloaded"), target, "0.2.12");
    const events: string[] = [];

    await runPortableCli(
      portableLaunchArgs(target, oldSource, managedRoot, stateDir),
      capture().io,
      env,
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      },
    );

    const code = await runPortableCli(
      portableLaunchArgs(target, newSource, managedRoot, stateDir),
      capture().io,
      env,
      {
        homedir: () => home,
        lifecycleFn: (command) => {
          events.push(command);
          return Promise.resolve(command === "stop" ? 1 : 0);
        },
      },
    );

    expect(code).toBe(1);
    expect(events).toEqual(["stop"]);
    expect(packageVersionAt(managedRoot, target)).toBe("0.2.11");
    expect(registration(stateDir)).toMatchObject({ packageVersion: "0.2.11" });
  });

  it("restores and relaunches the previous install when upgrade registration fails", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const target: PortableTarget = "windows-x64";
    const managedRoot = managedRootForTarget(home, target);
    const env = windowsPortableEnv(home);
    const oldSource = writePortableFixture(join(root, "bootstrap"), target, "0.2.11");
    const newSource = writePortableFixture(join(root, "downloaded"), target, "0.2.12");
    const events: string[] = [];

    await runPortableCli(
      portableLaunchArgs(target, oldSource, managedRoot, stateDir),
      capture().io,
      env,
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      },
    );
    writeFileSync(join(managedRoot, "active.txt"), "old install marker\n");
    writeFileSync(
      join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.bat"),
      "foreign launcher\n",
    );
    const c = capture();

    const code = await runPortableCli(
      portableLaunchArgs(target, newSource, managedRoot, stateDir),
      c.io,
      env,
      {
        homedir: () => home,
        lifecycleFn: (command) => {
          events.push(command);
          return Promise.resolve(0);
        },
      },
    );

    expect(code).toBe(1);
    expect(events).toEqual(["stop", "start"]);
    expect(packageVersionAt(managedRoot, target)).toBe("0.2.11");
    expect(readFileSync(join(managedRoot, "active.txt"), "utf8")).toBe("old install marker\n");
    expect(registration(stateDir)).toMatchObject({ packageVersion: "0.2.11" });
    expect(c.err()).toContain("portable registration refused unknown artifact");
  });

  it("launches a same-path portable root through lifecycle after setup attestation", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const managedRoot = join(home, "managed", "Keiko");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    const lifecycleStarts: string[] = [];
    writeWindowsFixture(managedRoot);

    const code = await runPortableCli(
      [
        "launch",
        "--target",
        "windows-x64",
        "--portable-root",
        managedRoot,
        "--managed-root",
        managedRoot,
        "--state-dir",
        stateDir,
      ],
      capture().io,
      env,
      {
        homedir: () => home,
        now: () => NOW,
        lifecycleFn: (_command, _args, _io, _env, deps) => {
          lifecycleStarts.push(deps.cwd);
          return Promise.resolve(0);
        },
      },
    );

    expect(code).toBe(0);
    expect(lifecycleStarts).toEqual([join(managedRoot, "app")]);
    expect(registration(stateDir)).toMatchObject({
      status: "managed",
      updateEligible: true,
    });
  });

  it("launch can set up without relaunching when --no-relaunch is explicit", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const managedRoot = join(home, "managed", "Keiko");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    const spawns: string[] = [];
    writeWindowsFixture(source);

    const code = await runPortableCli(
      [
        "launch",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        managedRoot,
        "--state-dir",
        stateDir,
        "--no-relaunch",
      ],
      capture().io,
      env,
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: (command) => {
          spawns.push(command);
          return spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
        },
      },
    );

    expect(code).toBe(0);
    expect(spawns).toEqual([]);
    expect(existsSync(join(managedRoot, "Keiko.exe"))).toBe(true);
  });

  it("rejects managed roots that pass through a symlinked ancestor before copying", async () => {
    const root = tempRoot();
    const source = join(root, "bootstrap");
    const stateDir = join(root, "state");
    const symlinkTarget = join(root, "state", ".keiko", "managed-parent");
    const symlinkParent = join(root, "managed-link");
    writeWindowsFixture(source);
    mkdirSync(symlinkTarget, { recursive: true });
    symlinkSync(symlinkTarget, symlinkParent, "dir");
    const c = capture();

    const code = await runPortableCli(
      [
        "setup",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        join(symlinkParent, "Keiko"),
        "--state-dir",
        stateDir,
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("managed install root must not use symlinked ancestors");
    expect(registration(stateDir)).toMatchObject({
      status: "setup-failed",
      updateEligible: false,
      failureReason: "managed-root-symlink",
    });
    expect(existsSync(join(symlinkTarget, "Keiko"))).toBe(false);
  });

  it("rejects managed roots inside repository directories before copying", async () => {
    const root = tempRoot();
    const source = join(root, "bootstrap");
    const stateDir = join(root, "state");
    const repoRoot = join(root, "customer-repo");
    writeWindowsFixture(source);
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const c = capture();

    const code = await runPortableCli(
      [
        "setup",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        join(repoRoot, "Keiko"),
        "--state-dir",
        stateDir,
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("managed install root must be outside customer repositories");
    expect(registration(stateDir)).toMatchObject({
      status: "setup-failed",
      updateEligible: false,
      failureReason: "setup-failed",
    });
    expect(existsSync(join(repoRoot, "Keiko"))).toBe(false);
  });

  it("refuses a symlinked Start Menu ancestor during setup without creating outside artifacts", async () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(env.LOCALAPPDATA, "Programs", "Keiko");
    const stateDir = join(root, "state");
    const programsDir = join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
    const outsidePrograms = join(root, "outside-programs");
    mkdirSync(outsidePrograms, { recursive: true });
    mkdirSync(join(programsDir, ".."), { recursive: true });
    rmSync(programsDir, { recursive: true, force: true });
    symlinkSync(outsidePrograms, programsDir, "dir");
    writeWindowsFixture(source);
    const c = capture();

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
        stateDir,
      ],
      c.io,
      env,
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(1);
    expect(existsSync(join(outsidePrograms, "Keiko.bat"))).toBe(false);
    expect(existsSync(managedRoot)).toBe(false);
    expect(c.err()).toContain("portable registration refused symlinked ancestor");
  });
});
