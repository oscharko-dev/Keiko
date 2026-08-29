// Golden-vector tests for the hardened Windows shell invocation builder (issue #3350 / Node
// CVE-2024-27980). Expected argv arrays below are independently derived from the specified
// cross-spawn escaping algorithm (caret-escape metacharacters, double-escape quotes/trailing
// backslashes, wrap in cmd.exe's /d /s /c form) by a standalone script that transcribes the
// algorithm directly — NOT read back from this module's own output — so a transcription bug in
// the implementation (a wrong regex, a dropped escape pass, a swapped join order) has an
// independent oracle to fail against, and every literal below is a plain JSON string (no
// hand-built template-literal concatenation) to remove a second class of transcription risk.
import { describe, expect, it } from "vitest";
import {
  buildWindowsShellInvocation,
  resolveSystemBinaryPath,
  resolveWindowsSystemDirectory,
  WindowsShellInvocationError,
  WindowsSystemDirectoryError,
} from "./windows-shell.js";

const CMD_PATH = String.raw`C:\Users\test\AppData\Roaming\npm\npm.cmd`;
const UNC_CMD_PATH = String.raw`\\build-server\share\tools\npm.cmd`;
const SHIM_CMD_PATH = String.raw`C:\proj\node_modules\.bin\tsserver.cmd`;
const CMD_EXE = String.raw`C:\Windows\System32\cmd.exe`;
const WIN_ENV = { env: { SystemRoot: String.raw`C:\Windows` }, platform: "win32" as const };

describe("buildWindowsShellInvocation — pass-through (no wrapping)", () => {
  it("returns the input unchanged on a non-win32 platform, even for a .cmd path", () => {
    const result = buildWindowsShellInvocation(CMD_PATH, ["install"], { platform: "linux" });
    expect(result).toEqual({
      command: CMD_PATH,
      args: ["install"],
      windowsVerbatimArguments: false,
    });
  });

  it("returns the input unchanged on darwin, even for a .bat path", () => {
    const batPath = String.raw`C:\tools\run.bat`;
    const result = buildWindowsShellInvocation(batPath, ["x"], { platform: "darwin" });
    expect(result).toEqual({ command: batPath, args: ["x"], windowsVerbatimArguments: false });
  });

  it("returns a resolved .exe path unchanged on win32 (git.exe pass-through)", () => {
    const gitExe = String.raw`C:\Program Files\Git\cmd\git.exe`;
    const result = buildWindowsShellInvocation(gitExe, ["status"], { platform: "win32" });
    expect(result).toEqual({
      command: gitExe,
      args: ["status"],
      windowsVerbatimArguments: false,
    });
  });

  it("returns a resolved .com path unchanged on win32", () => {
    const comPath = String.raw`C:\Windows\System32\where.com`;
    const result = buildWindowsShellInvocation(comPath, [], { platform: "win32" });
    expect(result).toEqual({ command: comPath, args: [], windowsVerbatimArguments: false });
  });

  it("returns a resolved path with no extension unchanged on win32", () => {
    const noExt = String.raw`C:\tools\customtool`;
    const result = buildWindowsShellInvocation(noExt, ["a"], { platform: "win32" });
    expect(result).toEqual({ command: noExt, args: ["a"], windowsVerbatimArguments: false });
  });
});

describe("buildWindowsShellInvocation — case-insensitive .cmd/.bat detection", () => {
  it("wraps an uppercase .CMD path (PATHEXT's default entry is uppercase)", () => {
    const upper = String.raw`C:\Users\test\AppData\Roaming\npm\npm.CMD`;
    const result = buildWindowsShellInvocation(upper, [], WIN_ENV);
    expect(result.windowsVerbatimArguments).toBe(true);
    expect(result.command).toBe(CMD_EXE);
  });

  it("wraps a mixed-case .Bat path", () => {
    const mixed = String.raw`C:\tools\run.Bat`;
    const result = buildWindowsShellInvocation(mixed, [], WIN_ENV);
    expect(result.windowsVerbatimArguments).toBe(true);
  });
});

describe("buildWindowsShellInvocation — cmd.exe resolution (never PATH)", () => {
  it("uses SystemRoot when present", () => {
    const result = buildWindowsShellInvocation(CMD_PATH, [], {
      platform: "win32",
      env: { SystemRoot: String.raw`D:\NonstandardWindows`, WINDIR: String.raw`C:\Windows` },
    });
    expect(result.command).toBe(String.raw`D:\NonstandardWindows\System32\cmd.exe`);
  });

  it("falls back to WINDIR when SystemRoot is absent", () => {
    const result = buildWindowsShellInvocation(CMD_PATH, [], {
      platform: "win32",
      env: { WINDIR: String.raw`E:\Win` },
    });
    expect(result.command).toBe(String.raw`E:\Win\System32\cmd.exe`);
  });

  it("falls back to the hard-coded default when neither SystemRoot nor WINDIR is set", () => {
    const result = buildWindowsShellInvocation(CMD_PATH, [], { platform: "win32", env: {} });
    expect(result.command).toBe(CMD_EXE);
  });
});

describe("buildWindowsShellInvocation — default opts (ambient process.env / process.platform)", () => {
  it("falls back to process.platform when opts is omitted entirely", () => {
    const result = buildWindowsShellInvocation(CMD_PATH, ["x"]);
    if (process.platform === "win32") {
      expect(result.windowsVerbatimArguments).toBe(true);
    } else {
      expect(result).toEqual({ command: CMD_PATH, args: ["x"], windowsVerbatimArguments: false });
    }
  });

  it("falls back to process.env when opts.env is omitted but platform is forced to win32", () => {
    const result = buildWindowsShellInvocation(CMD_PATH, ["x"], { platform: "win32" });
    // The exact SystemRoot/WINDIR precedence is pinned by the golden-vector tests above with an
    // explicit env; this only proves the omitted-env path still delegates to SOME real env and
    // produces a well-formed cmd.exe path, without re-deriving that fallback formula here.
    expect(result.windowsVerbatimArguments).toBe(true);
    expect(result.command.endsWith(String.raw`\System32\cmd.exe`)).toBe(true);
  });
});

// Every `expectedArgs` array below was produced by a standalone independent transcription of the
// task's exact algorithm (not this file, not windows-shell.ts) and pasted verbatim as a JSON
// literal — see the PR description for the generator script.
const SINGLE_ARG_VECTORS: readonly [label: string, arg: string, expectedArgs: readonly string[]][] =
  [
    [
      "plain word",
      "hello",
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"hello^""'],
    ],
    [
      "arg with spaces",
      "hello world",
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"hello^ world^""'],
    ],
    [
      "ampersand",
      "&",
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^&^""'],
    ],
    ["pipe", "|", ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^|^""']],
    [
      "redirect-out",
      ">",
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^>^""'],
    ],
    [
      "redirect-in",
      "<",
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^<^""'],
    ],
    ["caret", "^", ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^^^""']],
    [
      "double-quote",
      '"',
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"\\^"^""'],
    ],
    [
      "percent",
      "%",
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^%^""'],
    ],
    ["bang", "!", ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^!^""']],
    [
      "open-paren",
      "(",
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^(^""'],
    ],
    [
      "close-paren",
      ")",
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^)^""'],
    ],
    [
      "asterisk",
      "*",
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^*^""'],
    ],
    [
      "trailing-backslash",
      "trailing\\",
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"trailing\\\\^""'],
    ],
    [
      "embedded-quote",
      'has"quote',
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"has\\^"quote^""'],
    ],
    ["empty", "", ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^""']],
  ];

describe("buildWindowsShellInvocation — golden-vector escaping battery (single arg)", () => {
  it.each(SINGLE_ARG_VECTORS)(
    "%s: arg %j escapes to the exact expected argv",
    (_l, arg, expectedArgs) => {
      const result = buildWindowsShellInvocation(CMD_PATH, [arg], WIN_ENV);
      expect(result).toEqual({
        command: CMD_EXE,
        args: expectedArgs,
        windowsVerbatimArguments: true,
      });
    },
  );
});

describe("buildWindowsShellInvocation — npm .bin cmd-shim (doubleEscapeMetaChars)", () => {
  // cross-spawn double-escapes ONLY for an npm-generated node_modules\.bin\<name>.cmd shim, because
  // that shim re-parses `%*` through a second cmd.exe tokenization (issue #3350 finding 1). The
  // trigger is the .bin-shim PATH SHAPE — never a UNC path, which cross-spawn does not treat
  // specially at all.
  it("double-escapes metacharacters for a node_modules\\.bin\\*.cmd shim", () => {
    const result = buildWindowsShellInvocation(SHIM_CMD_PATH, ["&"], WIN_ENV);
    expect(result).toEqual({
      command: CMD_EXE,
      args: ["/d", "/s", "/c", '"C:\\proj\\node_modules\\.bin\\tsserver.cmd ^^^"^^^&^^^""'],
      windowsVerbatimArguments: true,
    });
  });

  it("single-escapes metacharacters for an ordinary (non-.bin) .cmd command", () => {
    const result = buildWindowsShellInvocation(CMD_PATH, ["&"], WIN_ENV);
    expect(result.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"^&^""',
    ]);
  });

  it("does NOT double-escape a UNC .cmd that is not a .bin shim (finding 1 regression)", () => {
    // A UNC path is not, by itself, a reason to double-escape — only the .bin-shim shape is. This
    // is the exact case the previous UNC-keyed trigger got wrong.
    const result = buildWindowsShellInvocation(UNC_CMD_PATH, ["&"], WIN_ENV);
    expect(result.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"\\\\build-server\\share\\tools\\npm.cmd ^"^&^""',
    ]);
  });

  it("double-escapes a .bin shim reached over a UNC path (shape, not location, decides)", () => {
    const uncShim = String.raw`\\build\share\proj\node_modules\.bin\eslint.cmd`;
    const result = buildWindowsShellInvocation(uncShim, ["&"], WIN_ENV);
    expect(result.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"\\\\build\\share\\proj\\node_modules\\.bin\\eslint.cmd ^^^"^^^&^^^""',
    ]);
  });

  it("does not treat an ordinary .cmd whose folder merely contains '.bin' as a shim", () => {
    // The shape is node_modules\.bin\<name>.cmd; a lookalike must single-escape.
    const lookalike = String.raw`C:\tools\.binaries\npm.cmd`;
    const result = buildWindowsShellInvocation(lookalike, ["&"], WIN_ENV);
    expect(result.args).toEqual(["/d", "/s", "/c", '"C:\\tools\\.binaries\\npm.cmd ^"^&^""']);
  });

  // Finding 2 (ReDoS): the backslash-doubling replacements must be backtracking-free. A long all-
  // backslash argument that takes tens of seconds under the naive /(\\*)"/g form must complete in
  // milliseconds. The tight timeout is the primary regression signal — a revert to the quadratic
  // regex blows past it. The count is a second, independent guard: cross-spawn's lookahead form
  // adds ONE backslash to a trailing run of k (verified against the vendored cross-spawn 7.0.6:
  // `foo\\` -> `foo\\\`), so a k=200000 run yields 200001, whereas the naive "always double" form
  // would yield 400000 — a revert fails on BOTH the timeout and this number.
  it(
    "escapes a long backslash-run argument without quadratic backtracking",
    { timeout: 4000 },
    () => {
      const backslashes = "\\".repeat(200_000);
      const result = buildWindowsShellInvocation(String.raw`C:\t\x.cmd`, [backslashes], WIN_ENV);
      const argument = result.args[3];
      // 2 separators in the command path + (200000 + 1) in the escaped trailing run.
      const backslashCount = (argument?.match(/\\/gu) ?? []).length;
      expect(backslashCount).toBe(2 + 200_001);
    },
  );
});

describe("buildWindowsShellInvocation — command-path escaping (defence in depth)", () => {
  it("caret-escapes a space in the resolved command path itself", () => {
    const spaced = String.raw`C:\Program Files\tools\my tool.cmd`;
    const result = buildWindowsShellInvocation(spaced, [], WIN_ENV);
    expect(result.args).toEqual(["/d", "/s", "/c", '"C:\\Program^ Files\\tools\\my^ tool.cmd"']);
  });
});

describe("buildWindowsShellInvocation — multi-argument assembly", () => {
  it("joins the escaped command and every escaped argument with single spaces", () => {
    const result = buildWindowsShellInvocation(
      CMD_PATH,
      ["install", "--save", "left-pad"],
      WIN_ENV,
    );
    expect(result).toEqual({
      command: CMD_EXE,
      args: [
        "/d",
        "/s",
        "/c",
        '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"install^" ^"--save^" ^"left-pad^""',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("wraps a zero-argument invocation (command only)", () => {
    const result = buildWindowsShellInvocation(CMD_PATH, [], WIN_ENV);
    expect(result.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd"',
    ]);
  });
});

// Finding 1 (PR #3354, P1): cross-spawn's metachar class omits CR/LF, so a model/workspace-
// controlled newline could previously reach the assembled cmd.exe command line and be
// reinterpreted as a command boundary (moxystudio/node-cross-spawn#179). These pin the fail-closed
// fix: buildWindowsShellInvocation now rejects CR/LF and the rest of the C0 control range in the
// resolved command path and every argument BEFORE building that command line.
describe("buildWindowsShellInvocation — CR/LF and C0 control-character rejection (finding 1)", () => {
  it("rejects a bare CR in an argument", () => {
    expect(() => buildWindowsShellInvocation(CMD_PATH, ["a\rb"], WIN_ENV)).toThrow(
      WindowsShellInvocationError,
    );
  });

  it("rejects a bare LF in an argument", () => {
    expect(() => buildWindowsShellInvocation(CMD_PATH, ["a\nb"], WIN_ENV)).toThrow(
      WindowsShellInvocationError,
    );
  });

  it("rejects a CRLF pair in an argument (the cross-spawn #179 command-injection shape)", () => {
    expect(() =>
      buildWindowsShellInvocation(CMD_PATH, ["innocent\r\necho PWNED"], WIN_ENV),
    ).toThrow(WindowsShellInvocationError);
  });

  it("rejects a non-CR/LF C0 control character (the full range, not only CR/LF)", () => {
    expect(() => buildWindowsShellInvocation(CMD_PATH, ["a\u0007b"], WIN_ENV)).toThrow(
      WindowsShellInvocationError,
    );
  });

  it("rejects a control character in the resolved command path itself", () => {
    const poisoned = "C:\\tools\\evil\r\nx.cmd";
    expect(() => buildWindowsShellInvocation(poisoned, ["install"], WIN_ENV)).toThrow(
      WindowsShellInvocationError,
    );
  });

  it("still accepts a normal argument on the wrap path (no false positive)", () => {
    const result = buildWindowsShellInvocation(CMD_PATH, ["hello"], WIN_ENV);
    expect(result.windowsVerbatimArguments).toBe(true);
    expect(result.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"hello^""',
    ]);
  });

  it("does not reject a newline in an argument when no cmd.exe wrapping occurs", () => {
    // The check guards the cmd.exe command-LINE string this module builds; a pass-through call
    // (non-Windows, or a resolved path that is not .cmd/.bat) never constructs one, so a literal
    // newline in an argument — e.g. a multi-line commit message passed to git.exe — is inert and
    // must not be rejected here.
    const gitExe = String.raw`C:\Program Files\Git\cmd\git.exe`;
    const result = buildWindowsShellInvocation(gitExe, ["a\nb"], { platform: "win32" });
    expect(result).toEqual({ command: gitExe, args: ["a\nb"], windowsVerbatimArguments: false });
  });
});

// Finding 2 (PR #3354, P1/P2): `SystemRoot`/`WINDIR` are mutable, inherited environment text. An
// empty or relative value previously produced a RELATIVE `System32\cmd.exe`, resolved against the
// workspace cwd a caller spawns with; an absolute UNC or device-path value selected an arbitrary,
// possibly attacker-planted, executable outright. These pin the fail-closed fix: an override is
// validated for canonical shape and the resolver THROWS rather than silently substituting a
// default when it is invalid.
const HOSTILE_SYSTEM_ROOT_VECTORS: readonly [label: string, value: string][] = [
  ["empty string", ""],
  ["relative (bare name)", "Windows"],
  ["workspace-local relative path", String.raw`workspace\fake-system32`],
  ["UNC path", String.raw`\\attacker\share`],
  ["device path", String.raw`\\?\C:\Windows`],
  ["drive-absolute with a cmd metacharacter", String.raw`C:\Windows^Sneaky`],
  ["drive-absolute with an embedded quote", 'C:\\Windows"Sneaky'],
  ["drive-absolute with a path-traversal segment", String.raw`C:\Windows\..\Windows`],
  ["drive-absolute with an embedded control character", "C:\\Windows\r\nEvil"],
];

describe("resolveWindowsSystemDirectory / resolveSystemBinaryPath — canonical validation (finding 2)", () => {
  it("resolves the hard-coded default when no override is present", () => {
    expect(resolveWindowsSystemDirectory({})).toBe(String.raw`C:\Windows`);
    expect(resolveSystemBinaryPath("taskkill.exe", {})).toBe(
      String.raw`C:\Windows\System32\taskkill.exe`,
    );
  });

  it("accepts a valid drive-absolute SystemRoot override", () => {
    const env = { SystemRoot: String.raw`D:\NonstandardWindows` };
    expect(resolveWindowsSystemDirectory(env)).toBe(String.raw`D:\NonstandardWindows`);
    expect(resolveSystemBinaryPath("cmd.exe", env)).toBe(
      String.raw`D:\NonstandardWindows\System32\cmd.exe`,
    );
  });

  it.each(HOSTILE_SYSTEM_ROOT_VECTORS)(
    "rejects a hostile SystemRoot override: %s",
    (_label, value) => {
      expect(() => resolveWindowsSystemDirectory({ SystemRoot: value })).toThrow(
        WindowsSystemDirectoryError,
      );
    },
  );

  it("fails closed on a hostile WINDIR override too, not only SystemRoot", () => {
    expect(() => resolveWindowsSystemDirectory({ WINDIR: String.raw`\\attacker\share` })).toThrow(
      WindowsSystemDirectoryError,
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

  it("propagates the failure through buildWindowsShellInvocation when SystemRoot is hostile", () => {
    expect(() =>
      buildWindowsShellInvocation(CMD_PATH, ["install"], {
        platform: "win32",
        env: { SystemRoot: String.raw`\\attacker\share` },
      }),
    ).toThrow(WindowsSystemDirectoryError);
  });

  it("rejects a binaryName that is not a bare System32 file name", () => {
    expect(() => resolveSystemBinaryPath(String.raw`..\evil.exe`, {})).toThrow(
      WindowsSystemDirectoryError,
    );
    expect(() => resolveSystemBinaryPath("sub/evil.exe", {})).toThrow(WindowsSystemDirectoryError);
    expect(() => resolveSystemBinaryPath("", {})).toThrow(WindowsSystemDirectoryError);
  });

  it("falls back to process.env when env is omitted, without throwing", () => {
    expect(() => resolveWindowsSystemDirectory()).not.toThrow();
    expect(() => resolveSystemBinaryPath("cmd.exe")).not.toThrow();
  });
});
