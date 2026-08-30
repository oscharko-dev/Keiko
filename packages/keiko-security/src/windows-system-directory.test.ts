// Direct unit coverage for the shared trusted-System32 decision (PR #3354 review). Before this
// file, every branch here was exercised only INDIRECTLY: via keiko-tools' windows-shell.test.ts
// (a different package/workspace's coverage run) and via windows-shortcuts.ts's `read`-mode
// wrapper, which always calls resolveWindowsSystemBinary with a fixed, literal binary name and so
// can never reach the control-character/cmd-metacharacter check on `binaryName` itself. Within
// this package's OWN test run that left resolveWindowsSystemBinary's defence-in-depth check for a
// hostile (non-literal) binary name at 0% coverage — untested exactly where its own doc comment
// says it matters: "an exported function whose stated purpose is containment must not depend on
// its callers staying literal to be safe."

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOWS_SYSTEM_ROOT,
  WindowsSystemDirectoryError,
  resolveWindowsSystemBinary,
  resolveWindowsSystemDirectory,
} from "./windows-system-directory.js";

const HOSTILE_SYSTEM_ROOT_VECTORS: readonly [label: string, value: string][] = [
  ["empty string", ""],
  ["relative (bare name)", "Windows"],
  ["UNC path", String.raw`\\attacker\share`],
  ["device path", String.raw`\\?\C:\Windows`],
  ["root-relative path", String.raw`\Windows`],
  ["drive-absolute with a cmd metacharacter", String.raw`C:\Windows^Sneaky`],
  ["drive-absolute with an embedded quote", 'C:\\Windows"Sneaky'],
  ["drive-absolute with a path-traversal segment", String.raw`C:\Windows\..\Windows`],
  ["drive-absolute with an embedded control character", "C:\\Windows\r\nEvil"],
  // Finding 3 (PR #3354 review round 2): NTFS alternate-data-stream syntax. Neither the
  // drive-absolute regex (prefix-only, no `$` terminator) nor the cmd-metacharacter class (no `:`
  // member) rejected a colon appearing AFTER the mandatory one at index 1.
  ["a colon after the drive letter (NTFS alternate data stream)", String.raw`C:\Windows:evil`],
  ["a colon introducing a trailing $DATA stream marker", String.raw`C:\Windows\System32:$DATA`],
];

describe("resolveWindowsSystemDirectory", () => {
  it("resolves the hard-coded default when no override is present", () => {
    expect(resolveWindowsSystemDirectory({})).toBe(DEFAULT_WINDOWS_SYSTEM_ROOT);
  });

  it("accepts a valid drive-absolute SystemRoot override", () => {
    expect(resolveWindowsSystemDirectory({ SystemRoot: String.raw`D:\NonstandardWindows` })).toBe(
      String.raw`D:\NonstandardWindows`,
    );
  });

  it("falls back to WINDIR when SystemRoot is absent", () => {
    expect(resolveWindowsSystemDirectory({ WINDIR: String.raw`E:\AltWindows` })).toBe(
      String.raw`E:\AltWindows`,
    );
  });

  it("fails closed rather than falling back to WINDIR when SystemRoot is present but invalid", () => {
    // A hostile environment plausibly controls BOTH variables; silently trying the next candidate
    // would give it a second chance to defeat the check instead of failing the whole resolution.
    expect(() =>
      resolveWindowsSystemDirectory({
        SystemRoot: String.raw`\\attacker\share`,
        WINDIR: String.raw`C:\Windows`,
      }),
    ).toThrow(WindowsSystemDirectoryError);
  });

  it.each(HOSTILE_SYSTEM_ROOT_VECTORS)(
    "rejects a hostile SystemRoot override: %s",
    (_label, value) => {
      expect(() => resolveWindowsSystemDirectory({ SystemRoot: value })).toThrow(
        WindowsSystemDirectoryError,
      );
    },
  );

  // Be precise (finding 3): the ADS rejection above must not become an over-broad "no colon
  // anywhere" ban — the drive letter's OWN colon at index 1 is mandatory and legitimate, and every
  // valid override in this file carries exactly one. Pinned explicitly, not left to be inferred
  // from the other passing tests in this describe block.
  it("still accepts the mandatory drive-letter colon at index 1", () => {
    expect(resolveWindowsSystemDirectory({ SystemRoot: String.raw`C:\Windows` })).toBe(
      String.raw`C:\Windows`,
    );
  });

  it("falls back to process.env when env is omitted, without throwing", () => {
    expect(() => resolveWindowsSystemDirectory()).not.toThrow();
  });

  it("never echoes the rejected override in the thrown message", () => {
    try {
      resolveWindowsSystemDirectory({ SystemRoot: String.raw`\\attacker\shattack-marker` });
      expect.unreachable("must throw on a UNC override");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowsSystemDirectoryError);
      expect((error as Error).message).not.toContain("shattack-marker");
    }
  });
});

describe("resolveWindowsSystemBinary", () => {
  it("joins the trusted directory's System32 with the requested binary name", () => {
    expect(resolveWindowsSystemBinary("taskkill.exe", {})).toBe(
      String.raw`C:\Windows\System32\taskkill.exe`,
    );
    expect(resolveWindowsSystemBinary("cscript.exe", { SystemRoot: String.raw`D:\Win` })).toBe(
      String.raw`D:\Win\System32\cscript.exe`,
    );
  });

  it.each([
    ["empty", ""],
    ["a backslash path", String.raw`sub\evil.exe`],
    ["a forward-slash path", "sub/evil.exe"],
    ["exactly '..'", ".."],
  ])("rejects a binaryName that is not a bare file name: %s", (_label, binaryName) => {
    expect(() => resolveWindowsSystemBinary(binaryName, {})).toThrow(WindowsSystemDirectoryError);
  });

  // The branch this file exists to close: a bare (no slash, not "..") name can still smuggle a
  // control character or a cmd.exe metacharacter, and — unlike windows-shortcuts.ts's own callers,
  // which always pass a literal — a future or misbehaving caller is not guaranteed to. Every one of
  // these vectors passes the "bare file name" check above and must be caught by the second one.
  it.each([
    ["an embedded control character", "cscript.exe\r\nevil"],
    ["an embedded NUL", "cscript.exe\u0000"],
    ["an embedded cmd metacharacter", "cscript.exe&calc.exe"],
    ["an embedded quote", 'cscript.exe"'],
    // Finding 3, whole-class (AGENTS.md §7): a bare file name has NO position at which a colon is
    // legitimate — unlike the directory, there is no drive letter to skip — so, unlike
    // hasStreamColon's index-2 search for the directory, ANY colon here is rejected outright.
    ["a trailing NTFS alternate-data-stream marker", "cscript.exe:evil"],
    ["a $DATA stream marker", "cscript.exe:$DATA"],
  ])("rejects a bare binaryName carrying %s", (_label, binaryName) => {
    expect(() => resolveWindowsSystemBinary(binaryName, {})).toThrow(WindowsSystemDirectoryError);
  });

  it("accepts a binaryName with a literal dot, which is neither a metacharacter nor a separator", () => {
    expect(() => resolveWindowsSystemBinary("cscript.exe", {})).not.toThrow();
  });

  it("propagates a hostile SystemRoot failure through to the binary resolution", () => {
    expect(() =>
      resolveWindowsSystemBinary("cmd.exe", { SystemRoot: String.raw`\\attacker\share` }),
    ).toThrow(WindowsSystemDirectoryError);
  });

  it("falls back to process.env when env is omitted, without throwing", () => {
    expect(() => resolveWindowsSystemBinary("cmd.exe")).not.toThrow();
  });
});

// Finding 4 (PR #3354 review round 2, P1): the module's own header admits it validates SHAPE only,
// because Node has no binding to GetSystemDirectoryW. This narrows that gap for one concrete case —
// a shape-valid root that resolves to nothing on disk — by requiring the resolved binary to exist
// as a regular file. `existsAsFile` is the injected test seam described next to
// `defaultWindowsBinaryExists` in the source: it lets both branches be exercised hermetically,
// without needing a real `C:\...` filesystem on the host running the test.
describe("resolveWindowsSystemBinary — resolved-binary existence (finding 4)", () => {
  it("returns the resolved path when existsAsFile reports it present", () => {
    expect(resolveWindowsSystemBinary("cmd.exe", {}, () => true)).toBe(
      String.raw`C:\Windows\System32\cmd.exe`,
    );
  });

  it("fails closed with the same error type when the resolved binary does not exist", () => {
    expect(() => resolveWindowsSystemBinary("cmd.exe", {}, () => false)).toThrow(
      WindowsSystemDirectoryError,
    );
  });

  it("never echoes the resolved path in the thrown message", () => {
    try {
      resolveWindowsSystemBinary(
        "cmd.exe",
        { SystemRoot: String.raw`C:\attack-marker` },
        () => false,
      );
      expect.unreachable("must throw when existsAsFile reports absent");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowsSystemDirectoryError);
      expect((error as Error).message).not.toContain("attack-marker");
    }
  });

  it("receives the fully joined System32 path, not the bare directory or binary name", () => {
    const seen: string[] = [];
    resolveWindowsSystemBinary(
      "taskkill.exe",
      { SystemRoot: String.raw`D:\Win` },
      (resolvedPath) => {
        seen.push(resolvedPath);
        return true;
      },
    );
    expect(seen).toEqual([String.raw`D:\Win\System32\taskkill.exe`]);
  });

  describe("default existsAsFile (no override supplied)", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");

    afterEach(() => {
      if (platform !== undefined) Object.defineProperty(process, "platform", platform);
    });

    it("is a permissive no-op off win32 — every other test in this file depends on this", () => {
      // Every call above the "finding 4" describe block omits existsAsFile and runs on whatever
      // platform executes this suite; this test pins that the DEFAULT itself is what lets them
      // pass, not an accident of which vectors happened to be chosen.
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      expect(() => resolveWindowsSystemBinary("cmd.exe", {})).not.toThrow();
    });

    it("actually checks the filesystem when the platform is genuinely win32", () => {
      // IDX49 (PR #3355 review): the DEFAULT root (`C:\Windows`) is exactly where a REAL Windows
      // host keeps `cmd.exe` — asserting non-existence against it is only true because CI never
      // runs this suite on win32 (the Windows leg runs a separate, narrower smoke script instead;
      // see scripts/__tests__/windows-cmd-spawn-smoke.mjs). On an actual Windows developer machine
      // `statSync` would find the real binary and this assertion would fail. A GUID-suffixed root
      // cannot exist on ANY host, real or CI, so the fail-closed assertion holds everywhere while
      // still proving the gate is platform-READ (it reaches the real `statSync` and fails ENOENT on
      // this literal path), not platform-DECORATIVE.
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      const neverExistsRoot = String.raw`C:\keiko-test-8f14e45f-ceea-467e-9764-58bf5e5fc4c1`;
      expect(() => resolveWindowsSystemBinary("cmd.exe", { SystemRoot: neverExistsRoot })).toThrow(
        WindowsSystemDirectoryError,
      );
    });
  });
});
