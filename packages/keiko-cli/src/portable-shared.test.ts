import { describe, expect, it } from "vitest";

import {
  defaultManagedRoot,
  layoutFor,
  layoutForSetupManifest,
  parseWindowsGenerationBinding,
  primaryLauncherName,
  targetForHost,
  targetRuntime,
} from "./portable-shared.js";

describe("portable target layout", () => {
  it("maps supported hosts to their bundled runtime", () => {
    expect(targetForHost("win32", "x64")).toBe("windows-x64");
    expect(targetForHost("darwin", "arm64")).toBe("macos-arm64");
    expect(targetForHost("linux", "x64")).toBe("linux-x64");
    expect(targetRuntime("linux-x64")).toEqual({
      nodePlatform: "linux",
      nodeArchitecture: "x64",
    });
    expect(targetRuntime("macos-x64")).toEqual({
      nodePlatform: "darwin",
      nodeArchitecture: "x64",
    });
  });

  it("uses the canonical launcher and managed layout for every platform", () => {
    expect(primaryLauncherName("windows-x64")).toBe("Keiko.exe");
    expect(defaultManagedRoot("macos-arm64", {}, "/Users/keiko")).toBe("/Applications/Keiko.app");
    expect(layoutFor("windows-x64", "C:\\Keiko").runtimeNodePath).toContain("node.exe");
    expect(defaultManagedRoot("linux-x64", {}, "/home/keiko")).toBe("/home/keiko/.local/opt/Keiko");
    expect(layoutFor("linux-x64", "/home/keiko/.local/opt/Keiko")).toMatchObject({
      rootKind: "linux-root",
      primaryLauncherPath: "/home/keiko/.local/opt/Keiko/Keiko",
      runtimeNodePath: "/home/keiko/.local/opt/Keiko/runtime/node/bin/node",
    });
    expect(layoutFor("macos-arm64", "/Applications/Keiko.app")).toMatchObject({
      rootKind: "macos-app",
      installRoot: "/Applications/Keiko.app",
    });
  });

  it("resolves Windows schema 2 runtime resources inside the bound generation", () => {
    const digest = "a".repeat(64);
    const layout = layoutForSetupManifest("windows-x64", "C:\\Keiko", {
      schemaVersion: 2,
      platformTarget: "windows-x64",
      packageName: "@oscharko-dev/keiko",
      packageVersion: "0.3.17",
      stable: true,
      primaryLauncher: "Keiko.exe",
      bootstrapUpdateEligible: false,
      runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
      windowsGeneration: {
        schemaVersion: 1,
        resourceRoot: `.portable/generations/${digest}`,
        treeHashSchema: "KHT1",
        treeSha256: digest,
        launcherPath: "Keiko.exe",
        launcherSha256: "b".repeat(64),
      },
    });

    expect(layout.installRoot).toBe("C:\\Keiko");
    expect(layout.primaryLauncherPath).toContain("Keiko.exe");
    expect(layout.setupManifestPath).toContain("setup-manifest.json");
    expect(layout.resourceRoot).toContain(digest);
    expect(layout.runtimeNodePath).toContain(digest);
    expect(layout.runtimeSupervisorPath).toContain(digest);
  });

  it("accepts only the exact Windows generation binding shape", () => {
    const digest = "a".repeat(64);
    expect(
      parseWindowsGenerationBinding({
        schemaVersion: 1,
        resourceRoot: `.portable/generations/${digest}`,
        treeHashSchema: "KHT1",
        treeSha256: digest,
        launcherPath: "Keiko.exe",
        launcherSha256: "b".repeat(64),
      }),
    ).toMatchObject({ treeSha256: digest });
    expect(() =>
      parseWindowsGenerationBinding({
        schemaVersion: 1,
        resourceRoot: `.portable/generations/${digest}`,
        treeHashSchema: "KHT1",
        treeSha256: digest,
        launcherPath: "Keiko.exe",
        launcherSha256: "b".repeat(64),
        extra: true,
      }),
    ).toThrow("portable setup manifest Windows generation binding is malformed");
  });
});
