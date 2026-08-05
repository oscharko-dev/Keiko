import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { windowsLauncher } from "./launcher-platforms.js";
import {
  nativeRegistrationKinds,
  parseWindowsStartMenuRegistration,
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

  it("reads only bounded regular unlinked Windows launcher registrations", () => {
    const root = mkdtempSync(join(homedir(), ".keiko-registration-"));
    try {
      const exe = "C:\\Users\\keiko\\AppData\\Local\\Programs\\Keiko\\Keiko.exe";
      const launcher = join(root, "Keiko.bat");
      const canonical = windowsLauncher.generateContent({ exe, port: undefined });
      writeFileSync(launcher, canonical);
      expect(parseWindowsStartMenuRegistration(launcher)).toBe(exe);

      writeFileSync(launcher, "x".repeat(64 * 1024 + 1));
      expect(parseWindowsStartMenuRegistration(launcher)).toBeUndefined();

      const target = join(root, "target.bat");
      writeFileSync(target, canonical);
      rmSync(launcher);
      symlinkSync(target, launcher);
      expect(parseWindowsStartMenuRegistration(launcher)).toBeUndefined();

      rmSync(launcher);
      linkSync(target, launcher);
      expect(parseWindowsStartMenuRegistration(launcher)).toBeUndefined();

      rmSync(launcher);
      const linkedParent = join(root, "linked-parent");
      const outside = join(root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, linkedParent, "dir");
      const nestedLauncher = join(linkedParent, "Keiko.bat");
      writeFileSync(join(outside, "Keiko.bat"), canonical);
      expect(parseWindowsStartMenuRegistration(nestedLauncher)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
