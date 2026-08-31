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
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WINDOWS_SHORTCUT_MAX_BYTES,
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
  type SecurityLogEvent,
  type SecurityLogSink,
  windowsShortcutFallbackContent,
} from "@oscharko-dev/keiko-security";

import { windowsLauncher } from "./launcher-platforms.js";
import { layoutFor } from "./portable-shared.js";
import { createCliSecurityLogSink } from "./security-log.js";
import {
  installNativeRegistration,
  nativeRegistrationKinds,
  parseWindowsStartMenuRegistration,
  portableManagedRootMode,
  portableRegistrationHealth,
  removePortableRegistrationArtifacts,
  repairUserLocalRegistration,
  windowsLegacyStartMenuRegistrationPath,
  windowsStartMenuRegistrationPath,
} from "./portable-maintenance.js";

const TRUSTED_WINDOWS_POWERSHELL = String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
// Frozen historical bytes: migration coverage must not move in lockstep with today's generator.
const PREVIOUSLY_SHIPPED_POWERSHELL_LINE =
  "@powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " +
  "JABlAHgAZQA9AFsAUwB5AHMAdABlAG0ALgBUAGUAeAB0AC4ARQBuAGMAbwBkAGkAbgBnAF0AOgA6AFUAVABGADgALgBHAGUAdABTAHQAcgBpAG4AZwAoAFsAUwB5AHMAdABlAG0ALgBDAG8AbgB2AGUAcgB0AF0AOgA6AEYAcgBvAG0AQgBhAHMAZQA2ADQAUwB0AHIAaQBuAGcAKAAkAGUAbgB2ADoASwBFAEkASwBPAF8ARQBYAEUAXwBCADYANAApACkAOwAkAGEAcgBnAHUAbQBlAG4AdABzAD0AQAAoACcAcwB0AGEAcgB0ACcALAAnAC0ALQBvAHAAZQBuACcAKQA7AGkAZgAoACQAZQBuAHYAOgBLAEUASQBLAE8AXwBQAE8AUgBUACkAewAkAGEAcgBnAHUAbQBlAG4AdABzACsAPQBAACgAJwAtAC0AcABvAHIAdAAnACwAJABlAG4AdgA6AEsARQBJAEsATwBfAFAATwBSAFQAKQB9ADsAUwB0AGEAcgB0AC0AUAByAG8AYwBlAHMAcwAgAC0ARgBpAGwAZQBQAGEAdABoACAAJABlAHgAZQAgAC0AQQByAGcAdQBtAGUAbgB0AEwAaQBzAHQAIAAkAGEAcgBnAHUAbQBlAG4AdABzAA==";

function previouslyShippedWindowsLauncher(exe: string): string {
  return [
    "@setlocal DisableDelayedExpansion",
    `@set "KEIKO_EXE_B64=${Buffer.from(exe, "utf8").toString("base64")}"`,
    '@set "KEIKO_PORT="',
    PREVIOUSLY_SHIPPED_POWERSHELL_LINE,
    "@endlocal",
    "",
  ].join("\r\n");
}

function recordingCliSink(stateDir: string): {
  readonly sink: SecurityLogSink;
  readonly events: SecurityLogEvent[];
} {
  const events: SecurityLogEvent[] = [];
  const sink = createCliSecurityLogSink(stateDir, (_selectedStateDir) => ({
    write(event): void {
      events.push(event);
    },
  }));
  if (sink === undefined) throw new Error("test security log sink was not created");
  return { sink, events };
}

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

  it("installs the shortcut registration and retires the legacy launcher during setup", () => {
    const root = mkdtempSync(join(homedir(), ".keiko-install-registration-"));
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

      installNativeRegistration(layout, "windows-x64", installRoot, env, home, io);

      // The `.lnk` is written and verified, and the contract-matching `.bat` is retired in the
      // same pass — never two Start Menu entries after a setup.
      expect(parseWindowsStartMenuRegistration(windowsStartMenuRegistrationPath(env, home))).toBe(
        layout.primaryLauncherPath,
      );
      expect(existsSync(legacyPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("retires the exact previously shipped encoded launcher during setup migration", () => {
    const root = mkdtempSync(join(homedir(), ".keiko-install-encoded-migration-"));
    try {
      const home = join(root, "home");
      const env = { APPDATA: join(home, "AppData", "Roaming") };
      const installRoot = join(home, "Keiko Program");
      const layout = layoutFor("windows-x64", installRoot);
      const legacyPath = windowsLegacyStartMenuRegistrationPath(env, home);
      mkdirSync(dirname(legacyPath), { recursive: true });
      writeFileSync(legacyPath, previouslyShippedWindowsLauncher(layout.primaryLauncherPath));
      const io = { out: (): undefined => undefined, err: (): undefined => undefined };

      installNativeRegistration(layout, "windows-x64", installRoot, env, home, io, {
        resolveWindowsPowerShell: () => TRUSTED_WINDOWS_POWERSHELL,
      });

      expect(existsSync(windowsStartMenuRegistrationPath(env, home))).toBe(true);
      expect(existsSync(legacyPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "hostile root",
      String.raw`\\attacker\share`,
      undefined,
      "security",
      "security.windows-portable-legacy-launcher.system-root-refused",
      "WindowsSystemDirectoryError",
    ],
    [
      "missing PowerShell",
      String.raw`Z:\KeikoMissingWindowsRoot`,
      (): string => {
        throw new WindowsSystemBinaryMissingError();
      },
      "diagnostic",
      "security.windows-portable-legacy-launcher.system-binary-missing",
      "WINDOWS_SYSTEM_BINARY_MISSING",
    ],
  ] as const)(
    "keeps verified shortcut installation successful when legacy cleanup meets %s",
    (_label, systemRoot, resolveWindowsPowerShell, category, op, errorKind) => {
      const root = mkdtempSync(join(homedir(), ".keiko-legacy-helper-refused-"));
      try {
        const home = join(root, "home");
        const env = {
          APPDATA: join(home, "AppData", "Roaming"),
          SystemRoot: systemRoot,
        };
        const installRoot = join(home, "Keiko Program");
        const layout = layoutFor("windows-x64", installRoot);
        const { sink, events } = recordingCliSink(join(root, ".keiko"));
        const errors: string[] = [];
        const io = {
          out: (): void => undefined,
          err: (line: string): void => {
            errors.push(line);
          },
        };

        expect(() => {
          installNativeRegistration(layout, "windows-x64", installRoot, env, home, io, {
            securityLogSink: sink,
            ...(resolveWindowsPowerShell === undefined ? {} : { resolveWindowsPowerShell }),
          });
        }).not.toThrow();

        expect(existsSync(windowsStartMenuRegistrationPath(env, home))).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ category, op, errorKind });
        expect(events[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
        expect(errors.join("")).toContain("trusted Windows launch helper is unavailable");
        expect(JSON.stringify({ events, errors })).not.toContain(systemRoot);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("counts action-required registrations and reports a refused legacy removal", () => {
    const root = mkdtempSync(join(homedir(), ".keiko-action-required-"));
    try {
      const home = join(root, "home");
      const env = { APPDATA: join(home, "AppData", "Roaming") };
      const installRoot = join(home, "AppData", "Local", "Programs", "Keiko");
      const layout = layoutFor("windows-x64", installRoot);
      const lnkPath = windowsStartMenuRegistrationPath(env, home);
      const legacyPath = windowsLegacyStartMenuRegistrationPath(env, home);
      mkdirSync(dirname(lnkPath), { recursive: true });
      const health = (): ReturnType<typeof portableRegistrationHealth> =>
        portableRegistrationHealth(layout, "windows-x64", installRoot, env, home);

      // Symlink, foreign content, oversize, hardlink: every unmanaged shape must surface as
      // action-required — never as repairable-missing, never silently ok.
      const target = join(root, "target.txt");
      writeFileSync(target, "outside");
      symlinkSync(target, lnkPath);
      expect(health().actionRequired).toBeGreaterThan(0);
      rmSync(lnkPath);

      writeFileSync(
        lnkPath,
        windowsShortcutFallbackContent({
          targetPath: join(root, "SomewhereElse", "Other.exe"),
          workingDirectory: join(root, "SomewhereElse"),
          iconPath: join(root, "SomewhereElse", "Other.exe"),
        }),
      );
      expect(health().actionRequired).toBeGreaterThan(0);
      rmSync(lnkPath);

      writeFileSync(lnkPath, Buffer.alloc(WINDOWS_SHORTCUT_MAX_BYTES + 1, 0x20));
      expect(health().actionRequired).toBeGreaterThan(0);
      rmSync(lnkPath);

      linkSync(target, lnkPath);
      expect(health().actionRequired).toBeGreaterThan(0);
      rmSync(lnkPath);

      // A user-edited legacy launcher is refused by the content-verified removal, surfaces
      // through the repairing CLI's io, and stays in place.
      writeFileSync(lnkPath, "");
      rmSync(lnkPath);
      const errors: string[] = [];
      const io = {
        out: (): undefined => undefined,
        err: (line: string): void => {
          errors.push(line);
        },
      };
      writeFileSync(legacyPath, "@echo edited by hand\r\n");
      repairUserLocalRegistration(layout, "windows-x64", installRoot, env, home, io);
      expect(existsSync(legacyPath)).toBe(true);
      expect(errors.join("")).toContain("left in place");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps every artifact in place on a dry-run removal", () => {
    const root = mkdtempSync(join(homedir(), ".keiko-dryrun-removal-"));
    try {
      const home = join(root, "home");
      const env = { APPDATA: join(home, "AppData", "Roaming") };
      const installRoot = join(home, "AppData", "Local", "Programs", "Keiko");
      const layout = layoutFor("windows-x64", installRoot);
      const legacyPath = windowsLegacyStartMenuRegistrationPath(env, home);
      mkdirSync(dirname(legacyPath), { recursive: true });
      writeFileSync(
        legacyPath,
        windowsLauncher.generateContent({ exe: layout.primaryLauncherPath, port: undefined }),
      );
      const io = { out: (): undefined => undefined, err: (): undefined => undefined };
      installNativeRegistration(layout, "windows-x64", installRoot, env, home, io);
      // installNativeRegistration retired the legacy launcher; restore it for the dry-run pass.
      writeFileSync(
        legacyPath,
        windowsLauncher.generateContent({ exe: layout.primaryLauncherPath, port: undefined }),
      );

      const removed = removePortableRegistrationArtifacts({
        layout,
        target: "windows-x64",
        managedRoot: installRoot,
        env,
        home,
        dryRun: true,
        io,
      });
      expect(removed).toBeGreaterThan(0);
      expect(existsSync(windowsStartMenuRegistrationPath(env, home))).toBe(true);
      expect(existsSync(legacyPath)).toBe(true);
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

  it("accepts only the encoded launcher whose PowerShell path is the trusted resolver", () => {
    const root = mkdtempSync(join(homedir(), ".keiko-registration-powershell-trust-"));
    try {
      const exe = "C:\\Program Files\\Keiko\\Keiko.exe";
      const launcher = join(root, "Keiko.bat");
      const parse = (): string | undefined =>
        parseWindowsStartMenuRegistration(
          launcher,
          {},
          {
            resolveWindowsPowerShell: () => TRUSTED_WINDOWS_POWERSHELL,
          },
        );
      writeFileSync(
        launcher,
        windowsLauncher.generateContent({
          exe,
          port: undefined,
          windowsPowerShellPath: TRUSTED_WINDOWS_POWERSHELL,
        }),
      );
      expect(parse()).toBe(exe);

      const foreignPowerShell = String.raw`C:\attacker\System32\WindowsPowerShell\v1.0\powershell.exe`;
      writeFileSync(
        launcher,
        windowsLauncher.generateContent({
          exe,
          port: undefined,
          windowsPowerShellPath: foreignPowerShell,
        }),
      );
      expect(parse()).toBeUndefined();
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

// PR #3355 review (IDX62 follow-up): readWindowsShortcutDefinition RE-THROWS a
// WindowsSystemDirectoryError instead of masking a hostile/malformed SystemRoot as "absent"
// (windows-shortcuts.ts). parseWindowsStartMenuRegistration sits one frame above that call, on
// the real `keiko portable setup` installation-detection path (portable-install.ts's
// windowsRegisteredLauncherTargets), behind a bare `catch { return undefined }` that used to
// swallow the rethrow right back into the same silent "absent" signal it exists to avoid.
describe("parseWindowsStartMenuRegistration propagates a trust-boundary refusal", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");

  afterEach(() => {
    if (platform !== undefined) Object.defineProperty(process, "platform", platform);
  });

  it("throws WindowsSystemDirectoryError for a hostile SystemRoot instead of returning undefined", () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    // homedir()-based, like every other test in this file that reaches
    // parseWindowsStartMenuRegistration/assertNoSymlinkAncestor: on macOS, os.tmpdir() sits
    // under /tmp, itself a symlink to /private/tmp, so assertNoSymlinkAncestor's ancestor walk
    // would throw an ordinary Error on the FIRST ancestor it checks — before ever reaching
    // readWindowsShortcut — and this test's catch would (correctly) swallow that unrelated
    // symlink refusal into `undefined`, never exercising the WindowsSystemDirectoryError path
    // this test exists to pin.
    const root = mkdtempSync(join(homedir(), ".keiko-shortcut-root-refused-"));
    try {
      const shortcut = join(root, "Keiko.lnk");
      // Content is never parsed: resolution fails before cscript would ever run (same win32
      // stub technique windows-shortcuts.test.ts and update-portable-activation.test.ts use).
      // Only needs to sit inside the shortcut size bounds so the earlier `stat.size` gate here
      // does not itself return undefined before readWindowsShortcut is ever reached.
      writeFileSync(shortcut, "placeholder-shortcut-bytes");
      expect(() =>
        parseWindowsStartMenuRegistration(shortcut, { SystemRoot: String.raw`\\attacker\share` }),
      ).toThrow(WindowsSystemDirectoryError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits a correlated body-free read event before failing closed", () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const root = mkdtempSync(join(homedir(), ".keiko-shortcut-read-event-"));
    try {
      const shortcut = join(root, "Keiko.lnk");
      writeFileSync(shortcut, "placeholder-shortcut-bytes");
      const { sink, events } = recordingCliSink(join(root, ".keiko"));

      expect(() =>
        parseWindowsStartMenuRegistration(
          shortcut,
          { SystemRoot: String.raw`\\attacker\share` },
          { securityLogSink: sink },
        ),
      ).toThrow(WindowsSystemDirectoryError);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        category: "security",
        op: "security.windows-shortcut.system-root-refused",
        errorKind: "WindowsSystemDirectoryError",
        extra: { mode: "read" },
      });
      expect(events[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(JSON.stringify(events)).not.toContain("attacker");
      expect(JSON.stringify(events)).not.toContain(shortcut);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the typed refusal when the lazy CLI sink factory is unavailable", () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const root = mkdtempSync(join(homedir(), ".keiko-shortcut-sink-failure-"));
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation((): void => undefined);
    try {
      const shortcut = join(root, "Keiko.lnk");
      writeFileSync(shortcut, "placeholder-shortcut-bytes");
      const sink = createCliSecurityLogSink(join(root, ".keiko"), () => {
        throw new Error("sink factory failure containing SensitiveProfilePath");
      });

      expect(() =>
        parseWindowsStartMenuRegistration(
          shortcut,
          { SystemRoot: String.raw`\\attacker\share` },
          { securityLogSink: sink },
        ),
      ).toThrow(WindowsSystemDirectoryError);
      expect(emitWarning).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(emitWarning.mock.calls)).not.toContain("SensitiveProfilePath");
    } finally {
      emitWarning.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits a correlated body-free create event and leaves an absent shortcut absent", () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const root = mkdtempSync(join(homedir(), ".keiko-shortcut-create-event-"));
    try {
      const home = join(root, "home");
      const env = { SystemRoot: String.raw`\\attacker\share` };
      const installRoot = join(home, "AppData", "Local", "Programs", "Keiko");
      const layout = layoutFor("windows-x64", installRoot);
      const shortcut = windowsStartMenuRegistrationPath(env, home);
      const { sink, events } = recordingCliSink(join(root, ".keiko"));
      const io = { out: (): void => undefined, err: (): void => undefined };

      expect(() => {
        installNativeRegistration(layout, "windows-x64", installRoot, env, home, io, {
          securityLogSink: sink,
        });
      }).toThrow(WindowsSystemDirectoryError);

      expect(existsSync(shortcut)).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        category: "security",
        op: "security.windows-shortcut.system-root-refused",
        errorKind: "WindowsSystemDirectoryError",
        extra: { mode: "create" },
      });
      expect(events[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(JSON.stringify(events)).not.toContain("attacker");
      expect(JSON.stringify(events)).not.toContain(shortcut);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
