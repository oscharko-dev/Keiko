import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, type SpawnOptions } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runPortableCli } from "./portable.js";
import { windowsLauncher } from "./launcher-platforms.js";
import { portableManagedSetupLockPath } from "./portable-install.js";
import { parseWindowsStartMenuRegistration } from "./portable-maintenance.js";
import { assertManagedRootAllowed } from "./portable-root-policy.js";
import {
  readPortableInstallRegistration,
  writeFailedRegistration,
} from "./portable-registration.js";
import { defaultManagedRoot } from "./portable-shared.js";

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
  it("uses the canonical macOS Applications location as the managed default", () => {
    expect(defaultManagedRoot("macos-arm64", {}, "/Users/alice")).toBe("/Applications/Keiko.app");
    expect(defaultManagedRoot("macos-x64", {}, "/Users/alice")).toBe("/Applications/Keiko.app");
  });

  it("allows only Keiko's canonical macOS app inside the system Applications directory", () => {
    const stateDir = join(tempRoot(), "state");

    expect(() => {
      assertManagedRootAllowed("/Applications/Keiko.app", stateDir, "macos-arm64");
    }).not.toThrow();
    expect(() => {
      assertManagedRootAllowed("/Applications/Other.app", stateDir, "macos-arm64");
    }).toThrow("managed install root must be user-local or the canonical Keiko macOS app");
    expect(() => {
      assertManagedRootAllowed("/Applications/Keiko.app", stateDir, "windows-x64");
    }).toThrow("managed install root must be user-local or the canonical Keiko macOS app");
  });

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
      "Keiko.lnk",
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
    expect(parseWindowsStartMenuRegistration(shortcut)).toBe(join(managedRoot, "Keiko.exe"));
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

    const resolved = capture();
    const resolveCode = await runPortableCli(
      ["resolve-root", "--target", "windows-x64", "--state-dir", stateDir],
      resolved.io,
      env,
      { homedir: () => home },
    );

    expect(resolveCode).toBe(0);
    expect(resolved.out()).toBe(`${managedRoot}\n`);
    expect(resolved.err()).toBe("");

    const mismatchedTarget = capture();
    expect(
      await runPortableCli(
        ["resolve-root", "--target", "macos-x64", "--state-dir", stateDir],
        mismatchedTarget.io,
        env,
        { homedir: () => home },
      ),
    ).toBe(1);
    expect(mismatchedTarget.out()).toBe("");
    expect(mismatchedTarget.err()).toContain(
      "registered managed install target does not match the requested target",
    );
  });

  it("retries an attested failed setup after rollback removed the managed root", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const originalSource = join(root, "original");
    const freshSource = join(root, "fresh");
    const managedRoot = join(home, "PortableApps", "Keiko");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    writeWindowsFixture(originalSource, "0.2.12", "0.2.12");
    writeWindowsFixture(freshSource, "0.2.13", "0.2.13");

    expect(
      await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          originalSource,
          "--managed-root",
          managedRoot,
          "--state-dir",
          stateDir,
        ],
        capture().io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(0);
    writeFailedRegistration("windows-x64", stateDir, NOW, "runtime invalid");
    rmSync(managedRoot, { recursive: true, force: true });

    const recovery = capture();
    expect(
      await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          freshSource,
          "--managed-root",
          managedRoot,
          "--state-dir",
          stateDir,
        ],
        recovery.io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(0);
    expect(recovery.err()).toBe("");
    expect(packageVersionAt(managedRoot, "windows-x64")).toBe("0.2.13");
    expect(registration(stateDir)).toMatchObject({ status: "managed", packageVersion: "0.2.13" });
  });

  it("uses the target default when no managed install has been recorded", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    const resolved = capture();

    const code = await runPortableCli(
      ["resolve-root", "--target", "windows-x64", "--state-dir", stateDir],
      resolved.io,
      env,
      { homedir: () => home },
    );

    expect(code).toBe(0);
    expect(resolved.out()).toBe(`${join(env.LOCALAPPDATA, "Programs", "Keiko")}\n`);
    expect(resolved.err()).toBe("");
  });

  it.each([
    ["quote", 'unsafe" & echo injected'],
    ["control character", "unsafe\npath"],
  ])("rejects a fallback Windows root containing a %s", async (_name, unsafeSegment) => {
    const root = tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const env = {
      ...windowsPortableEnv(home),
      LOCALAPPDATA: join(home, unsafeSegment),
    };
    const resolved = capture();

    const code = await runPortableCli(
      ["resolve-root", "--target", "windows-x64", "--state-dir", stateDir],
      resolved.io,
      env,
      { homedir: () => home },
    );

    expect(code).toBe(1);
    expect(resolved.out()).toBe("");
    expect(resolved.err()).toContain("managed install root cannot be safely transported");
  });

  it("fails closed when a recorded managed install root cannot be attested", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "PortableApps", "Keiko");
    const stateDir = join(root, "state");
    writeWindowsFixture(source);

    expect(
      await runPortableCli(
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
      ),
    ).toBe(0);
    writeFileSync(join(managedRoot, ".portable", "setup-manifest.json"), "{}\n", "utf8");
    const resolved = capture();

    const code = await runPortableCli(
      ["resolve-root", "--target", "windows-x64", "--state-dir", stateDir],
      resolved.io,
      env,
      { homedir: () => home },
    );

    expect(code).toBe(1);
    expect(resolved.out()).toBe("");
    expect(resolved.err()).toContain("registered managed install root could not be attested");
  });

  it("fails closed instead of defaulting when portable install state is malformed", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "portable-install-state.json"), "{}\n", "utf8");
    const resolved = capture();

    const code = await runPortableCli(
      ["resolve-root", "--target", "windows-x64", "--state-dir", stateDir],
      resolved.io,
      env,
      { homedir: () => home },
    );

    expect(code).toBe(1);
    expect(resolved.out()).toBe("");
    expect(resolved.err()).toContain("portable install registration is invalid");
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
      expect(
        registration?.status === "managed" ? registration.managedRootLocator : undefined,
      ).toBeUndefined();
    }
  });

  it("creates the macOS managed app only during explicit setup", async () => {
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
    const managedRoot = join(root, "managed", "Keiko");
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
        managedRoot,
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

    const resolved = capture();
    expect(
      await runPortableCli(
        [
          "resolve-root",
          "--target",
          "windows-x64",
          "--managed-root",
          managedRoot,
          "--state-dir",
          stateDir,
        ],
        resolved.io,
        {},
      ),
    ).toBe(0);
    expect(resolved.out()).toBe(`${managedRoot}\n`);
    expect(resolved.err()).toBe("");
  });

  it("preserves a healthy managed registration when a new source fails before locking", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const invalidSource = join(root, "invalid-download");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "PortableApps", "Keiko");
    writeWindowsFixture(source, "0.2.12", "0.2.12");
    writeWindowsFixture(invalidSource, "0.2.13", "0.2.13");

    expect(
      await runPortableCli(
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
      ),
    ).toBe(0);
    writeFileSync(join(invalidSource, ".portable", "setup-manifest.json"), "{}\n", "utf8");

    expect(
      await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          invalidSource,
          "--managed-root",
          managedRoot,
          "--state-dir",
          stateDir,
        ],
        capture().io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(1);
    expect(registration(stateDir)).toMatchObject({
      status: "managed",
      packageVersion: "0.2.12",
    });
    expect(packageVersionAt(managedRoot, "windows-x64")).toBe("0.2.12");
  });

  it("preserves a custom-root registration when native shortcut repair is refused", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const retrySource = join(root, "retry-download");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "PortableApps", "Keiko");
    writeWindowsFixture(source, "0.2.12", "0.2.12");
    writeWindowsFixture(retrySource, "0.2.13", "0.2.13");

    expect(
      await runPortableCli(
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
      ),
    ).toBe(0);
    const managedRegistration = registration(stateDir);
    writeFileSync(
      join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.lnk"),
      "foreign launcher\n",
    );
    const retry = capture();

    expect(
      await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          retrySource,
          "--managed-root",
          managedRoot,
          "--state-dir",
          stateDir,
        ],
        retry.io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(1);
    expect(retry.err()).toContain("portable registration refused unknown artifact");
    expect(registration(stateDir)).toEqual(managedRegistration);
    expect(packageVersionAt(managedRoot, "windows-x64")).toBe("0.2.12");
  });

  it("recovers a failed custom-root setup only from a fresh validated payload", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    const customRoot = join(home, "Kéiko Üñîçødé & 100% ! ^ (Programs)", "Keiko");
    writeWindowsFixture(source, "0.2.12", "0.2.12");
    expect(
      await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          source,
          "--managed-root",
          customRoot,
          "--state-dir",
          stateDir,
        ],
        capture().io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(0);
    writeFailedRegistration("windows-x64", stateDir, NOW, "simulated setup failure");
    expect(registration(stateDir)).toMatchObject({ status: "setup-failed" });
    expect(registration(stateDir).installRootIdentitySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(readFileSync(join(stateDir, "portable-install-state.json"), "utf8")).not.toContain(
      customRoot,
    );
    const resolved = capture();
    expect(
      await runPortableCli(
        ["resolve-root", "--target", "windows-x64", "--state-dir", stateDir],
        resolved.io,
        env,
        { homedir: () => home },
      ),
    ).toBe(0);
    expect(resolved.out()).toBe(`${customRoot}\n`);
    expect(resolved.err()).toBe("");
    expect(existsSync(join(customRoot, "Keiko.exe"))).toBe(true);

    const samePath = capture();
    expect(
      await runPortableCli(
        portableLaunchArgs("windows-x64", customRoot, customRoot, stateDir),
        samePath.io,
        env,
        {
          homedir: () => home,
          now: () => NOW,
        },
      ),
    ).toBe(1);
    expect(samePath.err()).toContain("existing same-path managed install root is not attested");
    expect(registration(stateDir)).toMatchObject({ status: "setup-failed", updateEligible: false });

    const freshSource = join(root, "fresh-extracted-payload");
    writeWindowsFixture(freshSource, "0.2.13", "0.2.13");
    const recovery = capture();
    expect(
      await runPortableCli(
        [
          "launch",
          "--target",
          "windows-x64",
          "--portable-root",
          freshSource,
          "--state-dir",
          stateDir,
          "--no-relaunch",
        ],
        recovery.io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(0);
    expect(recovery.out()).toContain("recovered at managed root");
    expect(recovery.err()).toBe("");
    expect(packageVersionAt(customRoot, "windows-x64")).toBe("0.2.13");
    expect(existsSync(join(env.LOCALAPPDATA, "Programs", "Keiko"))).toBe(false);
    expect(registration(stateDir)).toMatchObject({
      status: "managed",
      updateEligible: true,
      packageVersion: "0.2.13",
    });
  });

  it("rolls back failed-root recovery when native Windows registration cannot finalize", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const freshSource = join(root, "fresh-extracted-payload");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "PortableApps", "Keiko");
    writeWindowsFixture(source);
    writeWindowsFixture(freshSource, "0.2.12", "0.2.12");

    expect(
      await runPortableCli(
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
      ),
    ).toBe(0);
    writeFileSync(join(source, ".portable", "setup-manifest.json"), "{}\n", "utf8");
    expect(
      await runPortableCli(
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
      ),
    ).toBe(1);
    writeFailedRegistration("windows-x64", stateDir, NOW, "simulated setup failure");
    writeFileSync(
      join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.lnk"),
      "foreign launcher\n",
    );
    const oldMarker = join(managedRoot, "app", "dist", "old-install-marker.txt");
    writeFileSync(oldMarker, "old\n");

    const resolved = capture();
    expect(
      await runPortableCli(
        ["resolve-root", "--target", "windows-x64", "--state-dir", stateDir],
        resolved.io,
        env,
        { homedir: () => home },
      ),
    ).toBe(1);
    expect(resolved.err()).toContain("portable setup is incomplete");

    const recovery = capture();
    expect(
      await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          freshSource,
          "--managed-root",
          managedRoot,
          "--state-dir",
          stateDir,
        ],
        recovery.io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(1);
    expect(recovery.err()).toContain("portable registration refused unknown artifact");
    expect(packageVersionAt(managedRoot, "windows-x64")).toBe("0.2.11");
    expect(readFileSync(oldMarker, "utf8")).toBe("old\n");
    expect(registration(stateDir)).toMatchObject({ status: "setup-failed" });
    expect(registration(stateDir).installRootIdentitySha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses a legacy Windows launcher redirected to a foreign allowed root", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const freshSource = join(root, "fresh-extracted-payload");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "PortableApps", "Keiko");
    const foreignRoot = join(home, "Documents", "UnrelatedApp");
    writeWindowsFixture(source);
    writeWindowsFixture(freshSource, "0.2.12", "0.2.12");
    writeWindowsFixture(foreignRoot, "9.9.9", "9.9.9");

    expect(
      await runPortableCli(
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
      ),
    ).toBe(0);
    writeFileSync(join(source, ".portable", "setup-manifest.json"), "{}\n", "utf8");
    expect(
      await runPortableCli(
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
      ),
    ).toBe(1);
    writeFailedRegistration("windows-x64", stateDir, NOW, "simulated setup failure");
    writeFileSync(join(foreignRoot, "foreign-marker.txt"), "keep\n");
    writeFileSync(
      join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.bat"),
      windowsLauncher.generateContent({
        exe: join(foreignRoot, "Keiko.exe"),
        port: undefined,
      }),
    );

    // With the setup-created `.lnk` still intact, recovery resolves through the ATTESTED managed
    // root (the registration identity chain validates it) — never through the foreign `.bat`.
    const viaShortcut = capture();
    expect(
      await runPortableCli(
        ["resolve-root", "--target", "windows-x64", "--state-dir", stateDir],
        viaShortcut.io,
        env,
        { homedir: () => home },
      ),
    ).toBe(0);
    expect(viaShortcut.out().trim()).toBe(managedRoot);

    // The original #1394-era invariant, unchanged in strength: once only the redirected legacy
    // launcher remains, the foreign target must NOT resolve — fail closed.
    rmSync(join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.lnk"), {
      force: true,
    });
    const resolved = capture();
    expect(
      await runPortableCli(
        ["resolve-root", "--target", "windows-x64", "--state-dir", stateDir],
        resolved.io,
        env,
        { homedir: () => home },
      ),
    ).toBe(1);
    expect(resolved.out()).toBe("");
    expect(resolved.err()).toContain("portable setup is incomplete");

    const recovery = capture();
    expect(
      await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          freshSource,
          "--managed-root",
          foreignRoot,
          "--state-dir",
          stateDir,
        ],
        recovery.io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(1);
    expect(recovery.err()).toContain("does not match its recorded identity");
    expect(packageVersionAt(foreignRoot, "windows-x64")).toBe("9.9.9");
    expect(readFileSync(join(foreignRoot, "foreign-marker.txt"), "utf8")).toBe("keep\n");
    expect(packageVersionAt(managedRoot, "windows-x64")).toBe("0.2.11");
  });

  it("refuses recovery when a historically bound root was repurposed for user data", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const freshSource = join(root, "fresh-extracted-payload");
    const managedRoot = join(home, "PortableApps", "Keiko");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    writeWindowsFixture(source, "0.2.12", "0.2.12");
    writeWindowsFixture(freshSource, "0.2.13", "0.2.13");

    expect(
      await runPortableCli(
        [...portableLaunchArgs("windows-x64", source, managedRoot, stateDir), "--no-relaunch"],
        capture().io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(0);
    writeFileSync(join(source, ".portable", "setup-manifest.json"), "{}\n", "utf8");
    expect(
      await runPortableCli(
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
      ),
    ).toBe(1);
    writeFailedRegistration("windows-x64", stateDir, NOW, "simulated setup failure");
    rmSync(managedRoot, { recursive: true, force: true });
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(join(managedRoot, "important.txt"), "preserve me\n");

    const recovery = capture();
    expect(
      await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          freshSource,
          "--managed-root",
          managedRoot,
          "--state-dir",
          stateDir,
        ],
        recovery.io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(1);
    expect(recovery.err()).toContain("does not match its recorded identity");
    expect(readFileSync(join(managedRoot, "important.txt"), "utf8")).toBe("preserve me\n");
  });

  it("does not overwrite a managed registration with a pre-lock validation failure", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const managedRoot = join(home, "PortableApps", "Keiko");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    writeWindowsFixture(source, "0.2.12", "0.2.12");

    expect(
      await runPortableCli(
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
      ),
    ).toBe(0);
    const managedRegistration = registration(stateDir);
    writeFileSync(join(source, ".portable", "setup-manifest.json"), "{}\n", "utf8");
    const lockPath = portableManagedSetupLockPath("windows-x64", managedRoot);
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`,
    );

    expect(
      await runPortableCli(
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
      ),
    ).toBe(1);
    expect(registration(stateDir)).toEqual(managedRegistration);
    rmSync(lockPath, { recursive: true, force: true });
  });

  it("refuses downgrade recovery below the last attested managed version", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const downgradeSource = join(root, "older-extracted-payload");
    const managedRoot = join(home, "PortableApps", "Keiko");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    writeWindowsFixture(source, "0.2.12", "0.2.12");
    writeWindowsFixture(downgradeSource, "0.2.11", "0.2.11");

    expect(
      await runPortableCli(
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
      ),
    ).toBe(0);
    writeFileSync(join(source, ".portable", "setup-manifest.json"), "{}\n", "utf8");
    expect(
      await runPortableCli(
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
      ),
    ).toBe(1);
    writeFailedRegistration("windows-x64", stateDir, NOW, "simulated setup failure");

    const secondStateDir = join(root, "second-state");
    mkdirSync(secondStateDir, { recursive: true });
    copyFileSync(
      join(stateDir, "portable-install-state.json"),
      join(secondStateDir, "portable-install-state.json"),
    );
    const lockPath = portableManagedSetupLockPath("windows-x64", managedRoot);
    mkdirSync(lockPath);
    const busy = capture();
    expect(
      await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          downgradeSource,
          "--managed-root",
          managedRoot,
          "--state-dir",
          secondStateDir,
        ],
        busy.io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(1);
    expect(busy.err()).toContain("already in progress");
    expect(registration(secondStateDir)).toMatchObject({
      status: "setup-failed",
      packageVersion: "0.2.12",
    });
    expect(packageVersionAt(managedRoot, "windows-x64")).toBe("0.2.12");
    rmSync(lockPath, { recursive: true, force: true });

    const recovery = capture();
    expect(
      await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          downgradeSource,
          "--managed-root",
          managedRoot,
          "--state-dir",
          stateDir,
        ],
        recovery.io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(1);
    expect(recovery.err()).toContain("must not be older");
    expect(packageVersionAt(managedRoot, "windows-x64")).toBe("0.2.12");
    expect(registration(stateDir)).toMatchObject({
      status: "setup-failed",
      packageVersion: "0.2.12",
    });
  });

  it("keeps legacy failed records without attestation fail-closed and non-destructive", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const managedRoot = join(home, "PortableApps", "Keiko");
    const source = join(root, "fresh-extracted-payload");
    const stateDir = join(root, "state");
    writeWindowsFixture(managedRoot, "0.2.12", "0.2.12");
    writeWindowsFixture(source, "0.2.13", "0.2.13");
    writeFileSync(join(managedRoot, "important.txt"), "preserve me\n");
    writePortableRegistration(stateDir, {
      schemaVersion: 1,
      status: "setup-failed",
      updateEligible: false,
      platformTarget: "windows-x64",
      packageVersion: "unknown",
      stable: false,
      failureReason: "setup-failed",
      updatedAt: NOW.toISOString(),
    });
    const c = capture();

    expect(
      await runPortableCli(
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
        windowsPortableEnv(home),
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(1);
    expect(c.err()).toContain("managed install root already exists");
    expect(readFileSync(join(managedRoot, "important.txt"), "utf8")).toBe("preserve me\n");
  });

  it("adopts a pristine, fully validated root in place through same-path setup", async () => {
    // Owner-approved for 0.3.0-beta.1: the canonical install gesture moves the bundle to the
    // managed location BEFORE the first launch. With no registration at all, a root that passes
    // full validation is a first run and gets attested in place.
    const root = tempRoot();
    const home = join(root, "home");
    const managedRoot = join(home, "PortableApps", "Keiko");
    const stateDir = join(root, "state");
    const c = capture();
    writeWindowsFixture(managedRoot);

    const code = await runPortableCli(
      [
        "setup",
        "--target",
        "windows-x64",
        "--portable-root",
        managedRoot,
        "--managed-root",
        managedRoot,
        "--state-dir",
        stateDir,
      ],
      c.io,
      windowsPortableEnv(home),
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(0);
    expect(c.out()).toContain("Keiko portable setup ready at managed root.");
    expect(registration(stateDir)).toMatchObject({ status: "managed", updateEligible: true });
  });

  it("never adopts an unvalidated same-path root", async () => {
    // The relocated #2966 pin, half one: adoption goes through the complete portable-root
    // validation, so a root whose manifest is broken records a failure and is never attested.
    const root = tempRoot();
    const home = join(root, "home");
    const managedRoot = join(home, "PortableApps", "Keiko");
    const stateDir = join(root, "state");
    const c = capture();
    writeWindowsFixture(managedRoot);
    writeFileSync(join(managedRoot, ".portable", "setup-manifest.json"), "{ not json\n");

    const code = await runPortableCli(
      [
        "setup",
        "--target",
        "windows-x64",
        "--portable-root",
        managedRoot,
        "--managed-root",
        managedRoot,
        "--state-dir",
        stateDir,
      ],
      c.io,
      windowsPortableEnv(home),
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(1);
    expect(registration(stateDir)).toMatchObject({ status: "setup-failed", updateEligible: false });
  });

  it.each([
    // Unparseable JSON fails closed before adoption is even considered (the read itself throws);
    // a parseable record with an unknown schema reaches the adoption gate and must be treated as
    // an existing registration, not a pristine first run — treating it as absent would let
    // corrupting one file reopen adoption over a tampered root (#3026 review finding).
    ["unparseable JSON", "{ corrupted\n", undefined],
    [
      "schema-invalid record",
      '{"schemaVersion":999}\n',
      "existing same-path managed install root is not attested",
    ],
  ] as const)(
    "never adopts over a malformed existing registration (%s)",
    async (_label, stateBytes, expectedMessage) => {
      const root = tempRoot();
      const home = join(root, "home");
      const managedRoot = join(home, "PortableApps", "Keiko");
      const stateDir = join(root, "state");
      const c = capture();
      writeWindowsFixture(managedRoot);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "portable-install-state.json"), stateBytes);

      const code = await runPortableCli(
        [
          "setup",
          "--target",
          "windows-x64",
          "--portable-root",
          managedRoot,
          "--managed-root",
          managedRoot,
          "--state-dir",
          stateDir,
        ],
        c.io,
        windowsPortableEnv(home),
        { homedir: () => home, now: () => NOW },
      );

      expect(code).toBe(1);
      if (expectedMessage !== undefined) expect(c.err()).toContain(expectedMessage);
      // Neither shape may ever have attested the root.
      expect(c.out()).not.toContain("ready at managed root");
    },
  );

  it("never re-binds an existing registration to different same-path bytes", async () => {
    // The relocated #2966 pin, half two: once a registration exists, a same-path root whose
    // identity no longer matches it stays refused — this is exactly what detects
    // post-attestation tampering, and adoption must never open it.
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const managedRoot = join(home, "PortableApps", "Keiko");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    writeWindowsFixture(source);

    expect(
      await runPortableCli(
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
      ),
    ).toBe(0);
    expect(registration(stateDir)).toMatchObject({ status: "managed" });
    writeFileSync(join(managedRoot, "Keiko.exe"), "tampered launcher bytes");

    const c = capture();
    const code = await runPortableCli(
      [
        "setup",
        "--target",
        "windows-x64",
        "--portable-root",
        managedRoot,
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
    expect(c.err()).toContain("existing same-path managed install root is not attested");
  });

  it.each(["setup", "launch"] as const)(
    "adopts pristine macOS parent and Resources aliases in place during %s",
    async (command) => {
      // The alias spellings resolve to the same install root, so they follow the same
      // owner-approved first-run adoption as the direct bundle path.
      for (const alias of ["parent", "resources"] as const) {
        const root = tempRoot();
        const home = join(root, "home");
        const sourceRoot = join(home, `Applications-${command}-${alias}`);
        const managedRoot = writeMacFixture(sourceRoot, "macos-x64");
        const portableRoot =
          alias === "parent" ? sourceRoot : join(managedRoot, "Contents", "Resources");
        const stateDir = join(root, `state-${command}-${alias}`);
        const lifecycleStarts: string[] = [];
        const c = capture();

        const code = await runPortableCli(
          [
            command,
            "--target",
            "macos-x64",
            "--portable-root",
            portableRoot,
            "--managed-root",
            managedRoot,
            "--state-dir",
            stateDir,
          ],
          c.io,
          {},
          {
            homedir: () => home,
            now: () => NOW,
            activateMacosRuntimeFn: () => Promise.resolve("waived-unsigned" as const),
            lifecycleFn: (_command, _args, _io, _env, deps) => {
              lifecycleStarts.push(deps.cwd);
              return Promise.resolve(0);
            },
          },
        );

        expect(code).toBe(0);
        expect(registration(stateDir)).toMatchObject({ status: "managed", updateEligible: true });
        expect(lifecycleStarts).toEqual(
          command === "launch" ? [join(managedRoot, "Contents", "Resources", "app")] : [],
        );
      }
    },
  );

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

  it("activates the macOS runtime before starting the managed application", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = writePortableFixture(join(root, "bootstrap"), "macos-arm64");
    const managedRoot = managedRootForTarget(home, "macos-arm64");
    const stateDir = join(root, "state");
    const events: string[] = [];

    await runPortableCli(
      portableLaunchArgs("macos-arm64", source, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      },
    );

    const code = await runPortableCli(
      portableLaunchArgs("macos-arm64", managedRoot, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        activateMacosRuntimeFn: () => {
          events.push("activate");
          return Promise.resolve("active" as const);
        },
        lifecycleFn: () => {
          events.push("start");
          return Promise.resolve(0);
        },
      },
    );

    expect(code).toBe(0);
    expect(events).toEqual(["activate", "start"]);
  });

  it("keeps the managed macOS application stopped when runtime activation is incomplete", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = writePortableFixture(join(root, "bootstrap"), "macos-x64");
    const managedRoot = managedRootForTarget(home, "macos-x64");
    const stateDir = join(root, "state");
    const c = capture();
    let started = false;

    await runPortableCli(
      portableLaunchArgs("macos-x64", source, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      },
    );

    const code = await runPortableCli(
      portableLaunchArgs("macos-x64", managedRoot, managedRoot, stateDir),
      c.io,
      {},
      {
        homedir: () => home,
        activateMacosRuntimeFn: () => Promise.resolve("unavailable" as const),
        lifecycleFn: () => {
          started = true;
          return Promise.resolve(0);
        },
      },
    );

    expect(code).toBe(1);
    expect(started).toBe(false);
    expect(c.err()).toContain("macOS runtime activation is incomplete");
  });

  it("launches a macOS install whose containment is waived for the missing release signature", async () => {
    // The v0.3.0-beta.0 incident, pinned at the launch layer: the strict activation requirement
    // turned every double-click of the unsigned evaluation install into a silent exit 1. A waived
    // activation must start the server and must say what was waived.
    const root = tempRoot();
    const home = join(root, "home");
    const source = writePortableFixture(join(root, "bootstrap"), "macos-x64");
    const managedRoot = managedRootForTarget(home, "macos-x64");
    const stateDir = join(root, "state");
    const c = capture();
    let started = false;

    await runPortableCli(
      portableLaunchArgs("macos-x64", source, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      },
    );

    const code = await runPortableCli(
      portableLaunchArgs("macos-x64", managedRoot, managedRoot, stateDir),
      c.io,
      {},
      {
        homedir: () => home,
        activateMacosRuntimeFn: () => Promise.resolve("waived-unsigned" as const),
        lifecycleFn: () => {
          started = true;
          return Promise.resolve(0);
        },
      },
    );

    expect(code).toBe(0);
    expect(started).toBe(true);
    expect(c.out()).toContain("containment is waived");
  });

  it("surfaces a failed launch through the failure notifier with the launch environment", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = writePortableFixture(join(root, "bootstrap"), "macos-x64");
    const managedRoot = managedRootForTarget(home, "macos-x64");
    const stateDir = join(root, "state");
    const launchEnv = { KEIKO_PORTABLE_UI_LAUNCH: "1" };
    const notified: [string, unknown][] = [];

    await runPortableCli(
      portableLaunchArgs("macos-x64", source, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      },
    );

    const code = await runPortableCli(
      portableLaunchArgs("macos-x64", managedRoot, managedRoot, stateDir),
      capture().io,
      launchEnv,
      {
        homedir: () => home,
        activateMacosRuntimeFn: () => Promise.resolve("unavailable" as const),
        lifecycleFn: () => Promise.resolve(0),
        notifyFailureFn: (message, env) => {
          notified.push([message, env]);
        },
      },
    );

    expect(code).toBe(1);
    expect(notified).toEqual([
      ["keiko portable launch: macOS runtime activation is incomplete\n", launchEnv],
    ]);
  });

  it("does not raise the failure notifier for a successful launch", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = writePortableFixture(join(root, "bootstrap"), "macos-x64");
    const managedRoot = managedRootForTarget(home, "macos-x64");
    const stateDir = join(root, "state");
    let notified = false;

    const code = await runPortableCli(
      portableLaunchArgs("macos-x64", source, managedRoot, stateDir),
      capture().io,
      {},
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
        notifyFailureFn: () => {
          notified = true;
        },
      },
    );

    expect(code).toBe(0);
    expect(notified).toBe(false);
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
      const activeMarker = join(dirname(appPackagePath(managedRoot, target)), "dist", "active.txt");
      writeFileSync(activeMarker, "old install marker\n");
      const c = capture();

      const second = await runPortableCli(
        portableLaunchArgs(target, newSource, managedRoot, stateDir),
        c.io,
        env,
        {
          homedir: () => home,
          now: () => new Date("2026-07-07T00:00:00.000Z"),
          activateMacosRuntimeFn: () => Promise.resolve("active" as const),
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
      expect(existsSync(activeMarker)).toBe(false);
      expect(registration(stateDir)).toMatchObject({ packageVersion: "0.2.12" });
      expect(c.out()).toContain("portable upgrade installed from downloaded package");
    },
  );

  it("serializes healthy upgrades by managed root across distinct state directories", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const firstStateDir = join(root, "first-state");
    const secondStateDir = join(root, "second-state");
    const target: PortableTarget = "windows-x64";
    const managedRoot = managedRootForTarget(home, target);
    const env = windowsPortableEnv(home);
    const currentSource = writePortableFixture(join(root, "current"), target, "0.2.12");
    const newerSource = writePortableFixture(join(root, "newer"), target, "0.2.13");

    expect(
      await runPortableCli(
        [...portableLaunchArgs(target, currentSource, managedRoot, firstStateDir), "--no-relaunch"],
        capture().io,
        env,
        { homedir: () => home, now: () => NOW },
      ),
    ).toBe(0);
    mkdirSync(secondStateDir, { recursive: true });
    copyFileSync(
      join(firstStateDir, "portable-install-state.json"),
      join(secondStateDir, "portable-install-state.json"),
    );
    const rootLock = portableManagedSetupLockPath(target, managedRoot);
    mkdirSync(rootLock);
    const events: string[] = [];
    const c = capture();

    const code = await runPortableCli(
      portableLaunchArgs(target, newerSource, managedRoot, secondStateDir),
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
    expect(events).toEqual([]);
    expect(c.err()).toContain("setup or upgrade is already in progress");
    expect(packageVersionAt(managedRoot, target)).toBe("0.2.12");
    expect(registration(secondStateDir)).toMatchObject({
      status: "managed",
      packageVersion: "0.2.12",
    });
    rmSync(rootLock, { recursive: true, force: true });
  });

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
        activateMacosRuntimeFn: () => Promise.resolve("active" as const),
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

  it("recovers a stale macOS setup-failed registration from a fresh payload", async () => {
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

    const resolved = capture();
    expect(
      await runPortableCli(
        [
          "resolve-root",
          "--target",
          "macos-arm64",
          "--managed-root",
          managedRoot,
          "--state-dir",
          stateDir,
        ],
        resolved.io,
        {},
        { homedir: () => home },
      ),
    ).toBe(0);
    expect(resolved.out()).toBe(`${managedRoot}\n`);

    const code = await runPortableCli(
      [...portableLaunchArgs("macos-arm64", armSource, managedRoot, stateDir), "--no-relaunch"],
      capture().io,
      {},
      {
        homedir: () => home,
        now: () => new Date("2026-07-07T00:00:00.000Z"),
        activateMacosRuntimeFn: () => Promise.resolve("active" as const),
        lifecycleFn: (command) => {
          events.push(command);
          return Promise.resolve(0);
        },
      },
    );

    expect(code).toBe(0);
    expect(events).toEqual([]);
    expect(packageVersionAt(managedRoot, "macos-arm64")).toBe("0.2.12");
    expect(registration(stateDir)).toMatchObject({
      platformTarget: "macos-arm64",
      status: "managed",
      updateEligible: true,
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
        activateMacosRuntimeFn: () => Promise.resolve("active" as const),
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
    const activeMarker = join(managedRoot, "app", "dist", "active.txt");
    writeFileSync(activeMarker, "old install marker\n");
    writeFileSync(
      join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.lnk"),
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
    expect(readFileSync(activeMarker, "utf8")).toBe("old install marker\n");
    expect(registration(stateDir)).toMatchObject({ packageVersion: "0.2.11" });
    expect(c.err()).toContain("portable registration refused unknown artifact");
  });

  it("adopts and launches a pristine same-path portable root", async () => {
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
    const rejectedParent = join(repoRoot, "nested");
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
        join(rejectedParent, "Keiko"),
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
    expect(existsSync(rejectedParent)).toBe(false);
  });

  it("refuses a symlinked Start Menu ancestor during setup without creating outside artifacts", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
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
    expect(existsSync(join(outsidePrograms, "Keiko.lnk"))).toBe(false);
    expect(existsSync(managedRoot)).toBe(false);
    expect(c.err()).toContain("portable registration refused symlinked ancestor");
  });
});
