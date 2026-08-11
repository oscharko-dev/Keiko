import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WINDOWS_SHORTCUT_MAX_BYTES } from "@oscharko-dev/keiko-security";

import { windowsLauncher } from "./launcher-platforms.js";
import { layoutFor } from "./portable-shared.js";
import {
  nativeRegistrationKinds,
  parseWindowsStartMenuRegistration,
  portableManagedRootMode,
  repairUserLocalRegistration,
  windowsLegacyStartMenuRegistrationPath,
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
    const appDataPath = windowsStartMenuRegistrationPath(
      { APPDATA: "C:\\Users\\keiko\\AppData\\Roaming" },
      "C:\\Users\\keiko",
    );
    expect(appDataPath).toContain("Start Menu");
    // An absolute APPDATA is used as supplied — the profile fallback must not kick in here.
    expect(appDataPath.startsWith("C:\\Users\\keiko\\AppData\\Roaming")).toBe(true);
    expect(
      portableManagedRootMode("macos-x64", "/Applications/Keiko.app", {}, "/Users/keiko"),
    ).toBe("default");
  });

  it("retires the contract-matching legacy launcher when repair verifies the shortcut", () => {
    // Under the home directory like the sibling tests: the registration guards refuse symlinked
    // ancestors, and the macOS tmpdir lives beneath the /var -> /private/var link.
    const root = mkdtempSync(join(homedir(), ".keiko-repair-migration-"));
    try {
      const home = join(root, "home");
      const env = { APPDATA: join(home, "AppData", "Roaming") };
      const installRoot = join(home, "AppData", "Local", "Programs", "Keiko");
      const layout = layoutFor("windows-x64", installRoot);
      const legacyPath = windowsLegacyStartMenuRegistrationPath(env, home);
      mkdirSync(join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"), {
        recursive: true,
      });
      writeFileSync(
        legacyPath,
        windowsLauncher.generateContent({ exe: layout.primaryLauncherPath, port: undefined }),
      );
      const io = { out: (): undefined => undefined, err: (): undefined => undefined };

      // The `.lnk` is missing and the contract-matching `.bat` is present: repair must write
      // the shortcut AND retire the legacy launcher, or the user keeps two Start Menu entries.
      const repaired = repairUserLocalRegistration(
        layout,
        "windows-x64",
        installRoot,
        env,
        home,
        io,
      );
      expect(repaired).toBeGreaterThan(0);
      expect(existsSync(windowsStartMenuRegistrationPath(env, home))).toBe(true);
      expect(existsSync(legacyPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the profile location when APPDATA is empty or relative", () => {
    // An empty or relative APPDATA must never re-anchor the Start Menu path at the process
    // working directory — the registration falls back to the canonical profile location.
    for (const appData of ["", "relative\\appdata"]) {
      const path = windowsStartMenuRegistrationPath({ APPDATA: appData }, "/home/keiko");
      expect(path).toContain(join("/home/keiko", "AppData", "Roaming"));
    }
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

  it("refuses shortcut registrations outside the size bounds", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-shortcut-bounds-"));
    try {
      const empty = join(root, "Keiko.lnk");
      writeFileSync(empty, "");
      expect(parseWindowsStartMenuRegistration(empty)).toBeUndefined();

      const oversized = join(root, "Oversized.lnk");
      writeFileSync(oversized, Buffer.alloc(WINDOWS_SHORTCUT_MAX_BYTES + 1, 0x20));
      expect(parseWindowsStartMenuRegistration(oversized)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
