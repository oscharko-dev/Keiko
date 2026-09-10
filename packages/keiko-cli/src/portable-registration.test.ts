import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPortableInstallRegistrationCorrupt,
  readPortableInstallRegistration,
  registrationMatches,
  writeFailedRegistration,
  writeManagedRegistration,
} from "./portable-registration.js";
import {
  PACKAGE_NAME,
  layoutFor,
  type PortableLayout,
  type SetupManifest,
  type WindowsGenerationBinding,
} from "./portable-shared.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const WINDOWS_LAUNCHER = Buffer.from("windows-launcher-fixture", "utf8");
const MAC_LAUNCHER = Buffer.from("mac-launcher-fixture", "utf8");
const roots: string[] = [];

interface RegistrationFixture {
  readonly root: string;
  readonly stateDir: string;
  readonly layout: PortableLayout;
  readonly manifest: SetupManifest;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(homedir(), ".keiko-registration-"));
  roots.push(root);
  return root;
}

function generationBinding(
  treeSha256 = "a".repeat(64),
  launcherSha256 = sha256(WINDOWS_LAUNCHER),
): WindowsGenerationBinding {
  return {
    schemaVersion: 1,
    resourceRoot: `.portable/generations/${treeSha256}`,
    treeHashSchema: "KHT1",
    treeSha256,
    launcherPath: "Keiko.exe",
    launcherSha256,
  };
}

function createWindowsFixture(schemaVersion: 1 | 2 = 2): RegistrationFixture {
  const root = temporaryRoot();
  const stateDir = join(root, "state");
  const binding = generationBinding();
  const baseLayout = layoutFor("windows-x64", root);
  const layout =
    schemaVersion === 2
      ? { ...baseLayout, resourceRoot: join(root, ...binding.resourceRoot.split("/")) }
      : baseLayout;
  const manifest: SetupManifest =
    schemaVersion === 2
      ? {
          schemaVersion: 2,
          platformTarget: "windows-x64",
          packageName: PACKAGE_NAME,
          packageVersion: "1.2.3",
          stable: true,
          primaryLauncher: "Keiko.exe",
          bootstrapUpdateEligible: false,
          runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
          windowsGeneration: binding,
        }
      : {
          schemaVersion: 1,
          platformTarget: "windows-x64",
          packageName: PACKAGE_NAME,
          packageVersion: "1.2.3",
          stable: true,
          primaryLauncher: "Keiko.exe",
          bootstrapUpdateEligible: false,
          runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
        };
  writeFixtureFiles(layout, manifest, WINDOWS_LAUNCHER);
  return { root, stateDir, layout, manifest };
}

function createMacFixture(): RegistrationFixture {
  const root = temporaryRoot();
  const stateDir = join(root, "state");
  const layout = layoutFor("macos-arm64", root);
  const manifest: SetupManifest = {
    schemaVersion: 1,
    platformTarget: "macos-arm64",
    packageName: PACKAGE_NAME,
    packageVersion: "1.2.3",
    stable: true,
    primaryLauncher: "Keiko.app",
    bootstrapUpdateEligible: false,
    runtime: { nodePlatform: "darwin", nodeArchitecture: "arm64" },
  };
  writeFixtureFiles(layout, manifest, MAC_LAUNCHER);
  return { root, stateDir, layout, manifest };
}

function writeFixtureFiles(
  layout: PortableLayout,
  manifest: SetupManifest,
  launcher: Buffer,
): void {
  mkdirSync(layout.installRoot, { recursive: true });
  mkdirSync(dirname(layout.setupManifestPath), { recursive: true });
  mkdirSync(dirname(layout.primaryLauncherPath), { recursive: true });
  writeFileSync(layout.setupManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(layout.primaryLauncherPath, launcher);
}

function writeManaged(fixture: RegistrationFixture): void {
  writeManagedRegistration({
    stateDir: fixture.stateDir,
    layout: fixture.layout,
    manifest: fixture.manifest,
    env: {},
    home: fixture.root,
    now: NOW,
  });
}

function registrationPath(stateDir: string): string {
  return join(stateDir, "portable-install-state.json");
}

function readRawRegistration(stateDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(registrationPath(stateDir), "utf8")) as Record<string, unknown>;
}

function writeRawRegistration(stateDir: string, registration: Record<string, unknown>): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(registrationPath(stateDir), `${JSON.stringify(registration, null, 2)}\n`);
}

function expectCorruptRegistration(stateDir: string): void {
  expect(readPortableInstallRegistration(stateDir)).toBeUndefined();
  expect(isPortableInstallRegistrationCorrupt(stateDir)).toBe(true);
}

describe("Windows generation registration", () => {
  it("round-trips an eligible schema 2 registration bound to real setup and launcher files", () => {
    const fixture = createWindowsFixture();
    writeManaged(fixture);

    const raw = readRawRegistration(fixture.stateDir);
    const registration = readPortableInstallRegistration(fixture.stateDir);
    expect(Object.keys(raw).sort()).toEqual(
      [
        "installRootIdentitySha256",
        "launcherIdentitySha256",
        "managedRootLocator",
        "packageVersion",
        "platformTarget",
        "schemaVersion",
        "setupManifestSha256",
        "stable",
        "status",
        "updateEligible",
        "updatedAt",
        "windowsGeneration",
      ].sort(),
    );
    expect(registration).toMatchObject({
      schemaVersion: 2,
      status: "managed",
      updateEligible: true,
      stable: true,
      packageVersion: fixture.manifest.packageVersion,
      setupManifestSha256: sha256(readFileSync(fixture.layout.setupManifestPath)),
      installRootIdentitySha256: sha256(fixture.layout.installRoot),
      launcherIdentitySha256: sha256(WINDOWS_LAUNCHER),
      windowsGeneration:
        fixture.manifest.schemaVersion === 2 ? fixture.manifest.windowsGeneration : undefined,
    });
    expect(
      registration?.status === "managed" &&
        registrationMatches(registration, fixture.layout, fixture.manifest),
    ).toBe(true);
  });

  it.each([
    [
      "an extra binding field",
      (binding: Record<string, unknown>): void => {
        binding.extra = true;
      },
    ],
    [
      "a non-canonical resource root",
      (binding: Record<string, unknown>): void => {
        binding.resourceRoot = ".portable/generations/other";
      },
    ],
    [
      "a launcher digest that does not bind the selected launcher",
      (binding: Record<string, unknown>): void => {
        binding.launcherSha256 = "b".repeat(64);
      },
    ],
  ])("rejects schema 2 with %s", (_label, mutate) => {
    const fixture = createWindowsFixture();
    writeManaged(fixture);
    const raw = readRawRegistration(fixture.stateDir);
    mutate(raw.windowsGeneration as Record<string, unknown>);
    writeRawRegistration(fixture.stateDir, raw);

    expectCorruptRegistration(fixture.stateDir);
  });

  it.each([
    [
      "missing managed root locator",
      (value: Record<string, unknown>): void => {
        delete value.managedRootLocator;
      },
    ],
    [
      "malformed managed root locator",
      (value: Record<string, unknown>): void => {
        value.managedRootLocator = { kind: "default", path: "extra" };
      },
    ],
    [
      "missing setup digest",
      (value: Record<string, unknown>): void => {
        delete value.setupManifestSha256;
      },
    ],
    [
      "malformed setup digest",
      (value: Record<string, unknown>): void => {
        value.setupManifestSha256 = "A".repeat(64);
      },
    ],
    [
      "missing root identity",
      (value: Record<string, unknown>): void => {
        delete value.installRootIdentitySha256;
      },
    ],
    [
      "malformed root identity",
      (value: Record<string, unknown>): void => {
        value.installRootIdentitySha256 = "not-a-digest";
      },
    ],
    [
      "missing launcher identity",
      (value: Record<string, unknown>): void => {
        delete value.launcherIdentitySha256;
      },
    ],
    [
      "malformed launcher identity",
      (value: Record<string, unknown>): void => {
        value.launcherIdentitySha256 = "f".repeat(63);
      },
    ],
    [
      "invalid package version",
      (value: Record<string, unknown>): void => {
        value.packageVersion = "";
      },
    ],
    [
      "invalid timestamp",
      (value: Record<string, unknown>): void => {
        value.updatedAt = "yesterday";
      },
    ],
  ])("rejects schema 2 with %s", (_label, mutate) => {
    const fixture = createWindowsFixture();
    writeManaged(fixture);
    const raw = readRawRegistration(fixture.stateDir);
    mutate(raw);
    writeRawRegistration(fixture.stateDir, raw);

    expectCorruptRegistration(fixture.stateDir);
  });

  it.each([
    ["non-managed status", "status", "setup-failed"],
    ["manual eligibility", "updateEligible", false],
    ["non-stable release", "stable", false],
    ["non-Windows target", "platformTarget", "macos-arm64"],
  ])("rejects schema 2 with %s", (_label, key, value) => {
    const fixture = createWindowsFixture();
    writeManaged(fixture);
    const raw = readRawRegistration(fixture.stateDir);
    raw[key] = value;
    writeRawRegistration(fixture.stateDir, raw);

    expectCorruptRegistration(fixture.stateDir);
  });

  it("rejects extra schema 2 registration fields", () => {
    const fixture = createWindowsFixture();
    writeManaged(fixture);
    const raw = readRawRegistration(fixture.stateDir);
    raw.extra = "unreviewed";
    writeRawRegistration(fixture.stateDir, raw);

    expectCorruptRegistration(fixture.stateDir);
  });

  it("requires the registration to match the selected setup and launcher bytes", () => {
    const fixture = createWindowsFixture();
    writeManaged(fixture);
    const registration = readPortableInstallRegistration(fixture.stateDir);
    expect(registration?.status).toBe("managed");
    if (registration?.status !== "managed") throw new Error("managed registration missing");

    writeFileSync(fixture.layout.setupManifestPath, "changed setup");
    expect(registrationMatches(registration, fixture.layout, fixture.manifest)).toBe(false);
    writeFileSync(
      fixture.layout.setupManifestPath,
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
    );
    writeFileSync(fixture.layout.primaryLauncherPath, "changed launcher");
    expect(registrationMatches(registration, fixture.layout, fixture.manifest)).toBe(false);
  });

  it("requires all six generation binding fields to match the selected setup", () => {
    const fixture = createWindowsFixture();
    writeManaged(fixture);
    const registration = readPortableInstallRegistration(fixture.stateDir);
    expect(registration?.status).toBe("managed");
    if (registration?.status !== "managed" || fixture.manifest.schemaVersion !== 2) {
      throw new Error("Windows generation registration missing");
    }
    const changedTreeSha256 = "b".repeat(64);
    const changedManifest: SetupManifest = {
      ...fixture.manifest,
      windowsGeneration: {
        ...fixture.manifest.windowsGeneration,
        resourceRoot: `.portable/generations/${changedTreeSha256}`,
        treeSha256: changedTreeSha256,
      },
    };

    expect(registrationMatches(registration, fixture.layout, changedManifest)).toBe(false);
  });

  it("keeps flat Windows schema 1 readable, manual-only, and byte-for-byte unmigrated", () => {
    const fixture = createWindowsFixture(1);
    writeManaged(fixture);
    const before = readFileSync(registrationPath(fixture.stateDir), "utf8");

    const registration = readPortableInstallRegistration(fixture.stateDir);

    expect(registration).toMatchObject({
      schemaVersion: 1,
      status: "managed",
      updateEligible: false,
      platformTarget: "windows-x64",
    });
    expect(
      registration?.status === "managed" &&
        registrationMatches(registration, fixture.layout, fixture.manifest),
    ).toBe(true);
    expect(readFileSync(registrationPath(fixture.stateDir), "utf8")).toBe(before);
  });

  it("normalizes historical schema 1 true eligibility to manual-only without rewriting it", () => {
    const fixture = createWindowsFixture(1);
    writeManaged(fixture);
    const raw = readRawRegistration(fixture.stateDir);
    raw.updateEligible = true;
    writeRawRegistration(fixture.stateDir, raw);
    const historicalBytes = readFileSync(registrationPath(fixture.stateDir), "utf8");

    expect(readPortableInstallRegistration(fixture.stateDir)).toMatchObject({
      schemaVersion: 1,
      status: "managed",
      updateEligible: false,
      platformTarget: "windows-x64",
    });
    expect(readFileSync(registrationPath(fixture.stateDir), "utf8")).toBe(historicalBytes);
  });

  it("does not normalize a raw false schema 2 eligibility value to true", () => {
    const fixture = createWindowsFixture();
    writeManaged(fixture);
    const raw = readRawRegistration(fixture.stateDir);
    raw.updateEligible = false;
    writeRawRegistration(fixture.stateDir, raw);

    expectCorruptRegistration(fixture.stateDir);
  });

  it("retains authoritative generation and file identity through failure and retry", () => {
    const fixture = createWindowsFixture();
    writeManaged(fixture);
    const managed = readPortableInstallRegistration(fixture.stateDir);
    expect(managed?.status).toBe("managed");
    if (managed?.status !== "managed") throw new Error("managed registration missing");

    writeFailedRegistration("windows-x64", fixture.stateDir, NOW, "runtime invalid");
    const firstFailure = readPortableInstallRegistration(fixture.stateDir);
    expect(firstFailure).toMatchObject({
      schemaVersion: 1,
      status: "setup-failed",
      updateEligible: false,
      packageVersion: managed.packageVersion,
      stable: managed.stable,
      installRootPlatformTarget: managed.platformTarget,
      setupManifestSha256: managed.setupManifestSha256,
      installRootIdentitySha256: managed.installRootIdentitySha256,
      launcherIdentitySha256: managed.launcherIdentitySha256,
      windowsGeneration: managed.windowsGeneration,
    });

    writeFailedRegistration("windows-x64", fixture.stateDir, NOW, "launcher invalid");
    expect(readPortableInstallRegistration(fixture.stateDir)).toMatchObject({
      status: "setup-failed",
      setupManifestSha256: managed.setupManifestSha256,
      installRootIdentitySha256: managed.installRootIdentitySha256,
      launcherIdentitySha256: managed.launcherIdentitySha256,
      windowsGeneration: managed.windowsGeneration,
    });

    writeManaged(fixture);
    const retried = readPortableInstallRegistration(fixture.stateDir);
    expect(
      retried?.status === "managed" &&
        registrationMatches(retried, fixture.layout, fixture.manifest),
    ).toBe(true);
  });
});

describe("macOS registration compatibility", () => {
  it("preserves schema 1 eligibility and validation", () => {
    const fixture = createMacFixture();
    writeManaged(fixture);

    const registration = readPortableInstallRegistration(fixture.stateDir);
    expect(registration).toMatchObject({
      schemaVersion: 1,
      status: "managed",
      updateEligible: true,
      platformTarget: "macos-arm64",
    });
    expect(
      registration?.status === "managed" &&
        registrationMatches(registration, fixture.layout, fixture.manifest),
    ).toBe(true);
  });
});
