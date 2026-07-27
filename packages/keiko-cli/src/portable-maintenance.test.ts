import { describe, expect, it } from "vitest";

import {
  nativeRegistrationKinds,
  portableManagedRootMode,
  windowsStartMenuRegistrationPath,
} from "./portable-maintenance.js";

describe("portable native registration policy", () => {
  it("registers only canonical platform-managed roots", () => {
    expect(
      nativeRegistrationKinds(
        "windows-x64",
        "C:\\Users\\keiko\\AppData\\Local\\Programs\\Keiko",
        { LOCALAPPDATA: "C:\\Users\\keiko\\AppData\\Local" },
        "C:\\Users\\keiko",
      ),
    ).toEqual(["windows-start-menu"]);
    expect(
      nativeRegistrationKinds("macos-arm64", "/Applications/Keiko.app", {}, "/Users/keiko"),
    ).toEqual(["macos-system-applications"]);
    expect(
      nativeRegistrationKinds("macos-arm64", "/Users/keiko/Keiko.app", {}, "/Users/keiko"),
    ).toEqual([]);
  });

  it("derives deterministic registration locations and root modes", () => {
    expect(
      windowsStartMenuRegistrationPath(
        { APPDATA: "C:\\Users\\keiko\\AppData\\Roaming" },
        "C:\\Users\\keiko",
      ),
    ).toContain("Start Menu");
    expect(
      portableManagedRootMode("macos-x64", "/Applications/Keiko.app", {}, "/Users/keiko"),
    ).toBe("default");
  });
});
