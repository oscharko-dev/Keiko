// Direct unit coverage for the shared trusted-System32 decision (PR #3354 review). Before this
// file, every branch here was exercised only INDIRECTLY: via keiko-tools' windows-shell.test.ts
// (a different package/workspace's coverage run) and via windows-shortcuts.ts's `read`-mode
// wrapper, which always calls resolveWindowsSystemBinary with a fixed, literal binary name and so
// can never reach the control-character/cmd-metacharacter check on `binaryName` itself. Within
// this package's OWN test run that left resolveWindowsSystemBinary's defence-in-depth check for a
// hostile (non-literal) binary name at 0% coverage — untested exactly where its own doc comment
// says it matters: "an exported function whose stated purpose is containment must not depend on
// its callers staying literal to be safe."

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOWS_SYSTEM_ROOT,
  WINDOWS_CMD_METACHARACTER_SOURCE,
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
  resolveWindowsPowerShellExecutable,
  resolveWindowsSystemBinary,
  resolveWindowsSystemDirectory,
  resolveWindowsSystemExecutable,
  sameWindowsSystemDirectoryIdentity,
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
const TRUSTED_SYSTEM_ROOT = (): boolean => true;

function expectedSystemExecutable(selectedRoot: string, ...segments: readonly string[]): string {
  return [selectedRoot, ...segments].join("\\");
}

describe("resolveWindowsSystemDirectory", () => {
  it("resolves the hard-coded default when no override is present", () => {
    expect(resolveWindowsSystemDirectory({}, TRUSTED_SYSTEM_ROOT)).toBe(
      DEFAULT_WINDOWS_SYSTEM_ROOT,
    );
  });

  it("accepts a valid drive-absolute SystemRoot override", () => {
    expect(
      resolveWindowsSystemDirectory(
        { SystemRoot: String.raw`D:\NonstandardWindows` },
        TRUSTED_SYSTEM_ROOT,
      ),
    ).toBe(String.raw`D:\NonstandardWindows`);
  });

  it("falls back to WINDIR when SystemRoot is absent", () => {
    expect(
      resolveWindowsSystemDirectory({ WINDIR: String.raw`E:\AltWindows` }, TRUSTED_SYSTEM_ROOT),
    ).toBe(String.raw`E:\AltWindows`);
  });

  it("fails closed when a shaped override does not match the OS-owned root identity", () => {
    const identityCheck = (candidate: string, authoritativeRoot: string): boolean => {
      expect(candidate).toBe(String.raw`C:\workspace\fake-windows`);
      expect(authoritativeRoot).toBe(String.raw`\\?\GLOBALROOT\SystemRoot`);
      return false;
    };
    expect(() =>
      resolveWindowsSystemDirectory(
        { SystemRoot: String.raw`C:\workspace\fake-windows` },
        identityCheck,
      ),
    ).toThrow(WindowsSystemDirectoryError);
  });

  it("converts an identity-probe failure to a body-free trust-boundary refusal", () => {
    try {
      resolveWindowsSystemDirectory({ SystemRoot: String.raw`C:\attack-marker` }, () => {
        throw new Error("filesystem detail attack-marker");
      });
      expect.unreachable("must reject an unverified system root");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowsSystemDirectoryError);
      expect((error as Error).message).not.toContain("attack-marker");
    }
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
    expect(
      resolveWindowsSystemDirectory({ SystemRoot: String.raw`C:\Windows` }, TRUSTED_SYSTEM_ROOT),
    ).toBe(String.raw`C:\Windows`);
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

describe("sameWindowsSystemDirectoryIdentity", () => {
  it("accepts the same real directory and rejects a fake directory and a junction", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "keiko-system-root-identity-")));
    const authoritative = join(root, "authoritative");
    const fake = join(root, "fake");
    const junction = join(root, "junction");
    try {
      mkdirSync(authoritative);
      mkdirSync(fake);
      symlinkSync(authoritative, junction, process.platform === "win32" ? "junction" : "dir");

      expect(sameWindowsSystemDirectoryIdentity(authoritative, authoritative)).toBe(true);
      expect(sameWindowsSystemDirectoryIdentity(fake, authoritative)).toBe(false);
      expect(sameWindowsSystemDirectoryIdentity(junction, authoritative)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a real system directory reached through a mutable ancestor junction", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-system-root-ancestor-identity-"));
    const authoritativeParent = join(root, "authoritative-parent");
    const authoritative = join(authoritativeParent, "Windows");
    const ancestorJunction = join(root, "mutable-parent");
    try {
      mkdirSync(authoritativeParent);
      mkdirSync(authoritative);
      symlinkSync(
        authoritativeParent,
        ancestorJunction,
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(
        sameWindowsSystemDirectoryIdentity(join(ancestorJunction, "Windows"), authoritative),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when either identity cannot be read", () => {
    expect(
      sameWindowsSystemDirectoryIdentity(
        join(tmpdir(), "keiko-missing-system-root"),
        join(tmpdir(), "keiko-missing-authoritative-root"),
      ),
    ).toBe(false);
  });
});

describe("production Windows system-root identity", () => {
  it.runIf(process.platform === "win32")(
    "rejects a real fake directory and an env-selected junction",
    () => {
      const root = mkdtempSync(join(tmpdir(), "keiko-system-root-production-"));
      const fake = join(root, "fake-windows");
      const junction = join(root, "junction-windows");
      const actualRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (actualRoot === undefined) throw new Error("Windows system root is unavailable");
      try {
        mkdirSync(fake);
        symlinkSync(actualRoot, junction, "junction");

        expect(() => resolveWindowsSystemDirectory({ SystemRoot: fake })).toThrow(
          WindowsSystemDirectoryError,
        );
        expect(() => resolveWindowsSystemDirectory({ SystemRoot: junction })).toThrow(
          WindowsSystemDirectoryError,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("resolveWindowsSystemBinary", () => {
  it("joins the trusted directory's System32 with the requested binary name", () => {
    expect(resolveWindowsSystemBinary("taskkill.exe", {}, () => true, TRUSTED_SYSTEM_ROOT)).toBe(
      expectedSystemExecutable(String.raw`C:\Windows`, "System32", "taskkill.exe"),
    );
    expect(
      resolveWindowsSystemBinary(
        "cscript.exe",
        { SystemRoot: String.raw`D:\Win` },
        () => true,
        TRUSTED_SYSTEM_ROOT,
      ),
    ).toBe(expectedSystemExecutable(String.raw`D:\Win`, "System32", "cscript.exe"));
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

describe("resolveWindowsSystemExecutable", () => {
  it("resolves a fixed nested executable beneath an identity-approved root", () => {
    expect(
      resolveWindowsSystemExecutable(
        ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
        { SystemRoot: String.raw`D:\Windows` },
        () => true,
        TRUSTED_SYSTEM_ROOT,
      ),
    ).toBe(
      expectedSystemExecutable(
        String.raw`D:\Windows`,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
    );
  });

  it.each([
    ["an empty path", []],
    ["an empty segment", ["System32", ""]],
    ["a traversal segment", ["System32", "..", "cmd.exe"]],
    ["a separator", ["System32\\WindowsPowerShell", "powershell.exe"]],
    ["command syntax", ["System32", "cmd.exe&calc.exe"]],
  ] as const)("rejects %s", (_label, segments) => {
    expect(() =>
      resolveWindowsSystemExecutable(segments, {}, () => true, TRUSTED_SYSTEM_ROOT),
    ).toThrow(WindowsSystemDirectoryError);
  });
});

describe("resolveWindowsPowerShellExecutable", () => {
  it("pins the exact inbox PowerShell 5.1 executable segments", () => {
    const checked: string[] = [];

    expect(
      resolveWindowsPowerShellExecutable(
        { SystemRoot: String.raw`D:\Windows` },
        (path) => {
          checked.push(path);
          return true;
        },
        TRUSTED_SYSTEM_ROOT,
      ),
    ).toBe(
      expectedSystemExecutable(
        String.raw`D:\Windows`,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
    );
    expect(checked).toEqual([
      expectedSystemExecutable(
        String.raw`D:\Windows`,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
    ]);
  });
});

// After the OS-identity boundary accepts the directory, the binary still has an independent
// operational existence check. The two injected seams keep those decisions distinct and let both
// branches run hermetically without a real `C:\...` filesystem on this host.
describe("resolveWindowsSystemBinary — resolved-binary existence (finding 4)", () => {
  it("returns the resolved path when existsAsFile reports it present", () => {
    expect(resolveWindowsSystemBinary("cmd.exe", {}, () => true, TRUSTED_SYSTEM_ROOT)).toBe(
      expectedSystemExecutable(String.raw`C:\Windows`, "System32", "cmd.exe"),
    );
  });

  it("classifies an absent resolved binary separately from an untrusted system root", () => {
    expect(() =>
      resolveWindowsSystemBinary("cmd.exe", {}, () => false, TRUSTED_SYSTEM_ROOT),
    ).toThrow(WindowsSystemBinaryMissingError);
  });

  it("never echoes the resolved path in the thrown message", () => {
    try {
      resolveWindowsSystemBinary(
        "cmd.exe",
        { SystemRoot: String.raw`C:\attack-marker` },
        () => false,
        TRUSTED_SYSTEM_ROOT,
      );
      expect.unreachable("must throw when existsAsFile reports absent");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowsSystemBinaryMissingError);
      expect((error as Error).message).not.toContain("attack-marker");
    }
  });

  it("propagates an unexpected filesystem error instead of misclassifying it as absent", () => {
    const inaccessible = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(() =>
      resolveWindowsSystemBinary(
        "cmd.exe",
        {},
        () => {
          throw inaccessible;
        },
        TRUSTED_SYSTEM_ROOT,
      ),
    ).toThrow(inaccessible);
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
      TRUSTED_SYSTEM_ROOT,
    );
    expect(seen).toEqual([
      expectedSystemExecutable(String.raw`D:\Win`, "System32", "taskkill.exe"),
    ]);
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
      // The candidate root cannot be fake on production win32: it must first match GLOBALROOT's
      // identity. A GUID-named binary below that approved root is guaranteed absent on a real
      // Windows developer host as well as CI, and therefore pins the production filesystem check
      // without weakening the root-identity decision.
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      expect(() =>
        resolveWindowsSystemBinary(
          "keiko-missing-8f14e45f-ceea-467e-9764-58bf5e5fc4c1.exe",
          { SystemRoot: String.raw`C:\Windows` },
          undefined,
          () => true,
        ),
      ).toThrow(WindowsSystemBinaryMissingError);
    });
  });
});

describe("WINDOWS_CMD_METACHARACTER_SOURCE", () => {
  it("exports the complete stateless authority used by downstream escaping", () => {
    const matcher = new RegExp(WINDOWS_CMD_METACHARACTER_SOURCE, "u");
    const characters = [
      "(",
      ")",
      "]",
      "[",
      "%",
      "!",
      "^",
      '"',
      "`",
      "<",
      ">",
      "&",
      "|",
      ";",
      ",",
      " ",
      "*",
      "?",
    ];
    for (const character of characters) {
      expect(matcher.test(character)).toBe(true);
    }
  });
});
