import { describe, expect, it } from "vitest";

import {
  defaultManagedRoot,
  layoutFor,
  primaryLauncherName,
  targetForHost,
  targetRuntime,
} from "./portable-shared.js";

describe("portable target layout", () => {
  it("maps supported hosts to their bundled runtime", () => {
    expect(targetForHost("win32", "x64")).toBe("windows-x64");
    expect(targetForHost("darwin", "arm64")).toBe("macos-arm64");
    expect(targetForHost("linux", "x64")).toBeUndefined();
    expect(targetRuntime("macos-x64")).toEqual({
      nodePlatform: "darwin",
      nodeArchitecture: "x64",
    });
  });

  it("uses the canonical launcher and managed layout for every platform", () => {
    expect(primaryLauncherName("windows-x64")).toBe("Keiko.exe");
    expect(defaultManagedRoot("macos-arm64", {}, "/Users/keiko")).toBe("/Applications/Keiko.app");
    expect(layoutFor("windows-x64", "C:\\Keiko").runtimeNodePath).toContain("node.exe");
    expect(layoutFor("macos-arm64", "/Applications/Keiko.app")).toMatchObject({
      rootKind: "macos-app",
      installRoot: "/Applications/Keiko.app",
    });
  });
});
