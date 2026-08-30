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
const TRUSTED_SYSTEM_ROOT = {
  existsAsFile: (): boolean => true,
  systemDirectoryIdentity: (): boolean => true,
};
const WIN_ENV = {
  env: { SystemRoot: String.raw`C:\Windows` },
  platform: "win32" as const,
  ...TRUSTED_SYSTEM_ROOT,
};

function expectedSystemBinary(selectedRoot: string, binaryName: string): string {
  return `${selectedRoot}\\System32\\${binaryName}`;
}

const CMD_EXE = expectedSystemBinary(String.raw`C:\Windows`, "cmd.exe");

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
      ...TRUSTED_SYSTEM_ROOT,
    });
    expect(result.command).toBe(expectedSystemBinary(String.raw`D:\NonstandardWindows`, "cmd.exe"));
  });

  it("falls back to WINDIR when SystemRoot is absent", () => {
    const result = buildWindowsShellInvocation(CMD_PATH, [], {
      platform: "win32",
      env: { WINDIR: String.raw`E:\Win` },
      ...TRUSTED_SYSTEM_ROOT,
    });
    expect(result.command).toBe(expectedSystemBinary(String.raw`E:\Win`, "cmd.exe"));
  });

  it("falls back to the hard-coded default when neither SystemRoot nor WINDIR is set", () => {
    const result = buildWindowsShellInvocation(CMD_PATH, [], {
      platform: "win32",
      env: {},
      ...TRUSTED_SYSTEM_ROOT,
    });
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
      // Finding T46: TAB (U+0009) is C0, not a cmd.exe metachar — CMD_METACHARACTERS never
      // touches it, so the only thing the metachar pass escapes here is the two quotes the
      // wrapping step adds around it, exactly as for "plain word" above.
      "tab",
      "\t",
      ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"\t^""'],
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

  it("accepts TAB inside an argument — cross-spawn escapes it correctly, only NUL/CR/LF break the line", () => {
    // Review 5058571583 finding 4: rejecting TAB was a silent, platform-divergent capability loss
    // (a TSV/JSON/diff argument failing on Windows only). Inside the double-quoted argument TAB is
    // a literal for the outer cmd.exe parse and the child's CRT. Exact-match (finding T46): a bare
    // `toContain` here could not catch a broken escaping pass that left this substring intact but
    // corrupted the quoting around it.
    const result = buildWindowsShellInvocation(CMD_PATH, ["a\tb"], WIN_ENV);
    expect(result).toEqual({
      command: CMD_EXE,
      args: ["/d", "/s", "/c", '"C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd ^"a\tb^""'],
      windowsVerbatimArguments: true,
    });
  });

  it.each([
    ["NUL", "a\u0000b"],
    ["LF", "a\nb"],
    ["CR", "a\rb"],
  ])(
    "rejects %s — the characters that genuinely break a cmd.exe command line",
    (_label, argument) => {
      expect(() => buildWindowsShellInvocation(CMD_PATH, [argument], WIN_ENV)).toThrow(
        WindowsShellInvocationError,
      );
    },
  );

  it("rejects '%' on the wrap path — cmd.exe expands %NAME% before any escaping applies", () => {
    // Review 5058544058 P1 3887021639: there is no literal transport for a percent-carrying
    // argument through `cmd /c` (caret does not survive the early expansion phase, and batch-file
    // %%-doubling does not apply to a command line). Fail closed rather than deliver a different
    // argv than the caller passed — e.g. `npm view %PATH%` reaching npm.cmd expanded.
    expect(() => buildWindowsShellInvocation(CMD_PATH, ["%PATH%"], WIN_ENV)).toThrow(
      WindowsShellInvocationError,
    );
    expect(() => buildWindowsShellInvocation(CMD_PATH, ["100%"], WIN_ENV)).toThrow(
      WindowsShellInvocationError,
    );
  });

  it("a '%' in a NON-wrapped invocation passes through untouched (pass-through path)", () => {
    const result = buildWindowsShellInvocation(
      String.raw`C:\tools\tsserver.exe`,
      ["%PATH%"],
      WIN_ENV,
    );
    expect(result.windowsVerbatimArguments).toBe(false);
    expect(result.args).toEqual(["%PATH%"]);
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

// Finding T46 (PR #3355 review): the golden-vector battery above pins every printable cmd.exe
// metacharacter this module accepts, and the describe block above pins the reject/accept boundary
// for NUL/CR/LF/'%' — but nothing pinned the ESCAPING of the C0 control range and DEL this module
// deliberately re-admitted as safe (TAB, and the rest of C0 minus NUL/CR/LF), and the golden-vector
// battery itself is hand-transcribed against this SAME task's algorithm rather than diffed against
// an independently sourced implementation. `crossSpawnEscapeCommand`/`crossSpawnEscapeArgument`
// below are vendored VERBATIM from the actually-installed cross-spawn 7.0.6 package
// (`node_modules/cross-spawn/lib/util/escape.js`, MIT licensed — see windows-shell.ts's file header
// for the full license text; this is the same upstream source, copied a second time here as a
// fixed, independent oracle). This copy must NEVER be edited to track a future change in
// windows-shell.ts's own escaping — regressing it here to "fix" a failing sweep is exactly the
// silent divergence this fixture exists to catch.
// https://github.com/moxystudio/node-cross-spawn/blob/v7.0.6/lib/util/escape.js
const CROSS_SPAWN_METACHARACTERS_VENDORED = /([()\][%!^"`<>&|;, *?])/g;

function crossSpawnEscapeCommand(arg: string): string {
  return arg.replace(CROSS_SPAWN_METACHARACTERS_VENDORED, "^$1");
}

function crossSpawnEscapeArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  let escaped = arg;
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, String.raw`$1$1\"`);
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = '"' + escaped + '"';
  escaped = escaped.replace(CROSS_SPAWN_METACHARACTERS_VENDORED, "^$1");
  if (doubleEscapeMetaChars) {
    escaped = escaped.replace(CROSS_SPAWN_METACHARACTERS_VENDORED, "^$1");
  }
  return escaped;
}

describe("buildWindowsShellInvocation — differential parity against vendored cross-spawn 7.0.6 (finding T46)", () => {
  // CMD_PATH contains no cmd.exe metacharacter, so cross-spawn's own escape.command is a no-op on
  // it — asserted rather than assumed, so this constant is grounded in the vendored oracle too,
  // not hand-copied from the golden-vector literals above.
  const ESCAPED_COMMAND_PREFIX = crossSpawnEscapeCommand(CMD_PATH);

  it("cross-spawn's own escape.command is a no-op on CMD_PATH (no metacharacters to escape)", () => {
    expect(ESCAPED_COMMAND_PREFIX).toBe(CMD_PATH);
  });

  function expectedCommandLine(arg: string): string {
    return `"${ESCAPED_COMMAND_PREFIX} ${crossSpawnEscapeArgument(arg, false)}"`;
  }

  // NUL (0x00), LF (0x0A) and CR (0x0D) are rejected outright (pinned above) and excluded here: the
  // module's additional rejection of those three, plus '%', is a security FEATURE beyond
  // cross-spawn's own behaviour, not a divergence this parity sweep exists to catch. Every other
  // codepoint in the C0 control range, plus DEL (U+007F), must be ACCEPTED and must escape
  // byte-identically to the vendored cross-spawn oracle.
  const REJECTED_CODEPOINTS = new Set<number>([0x00, 0x0a, 0x0d]);
  const ACCEPTED_C0_AND_DEL_CODEPOINTS: readonly (readonly [label: string, char: string])[] = [
    ...Array.from({ length: 0x20 }, (_unused, codepoint) => codepoint),
    0x7f,
  ]
    .filter((codepoint) => !REJECTED_CODEPOINTS.has(codepoint))
    .map((codepoint) => [
      `U+${codepoint.toString(16).padStart(4, "0").toUpperCase()}`,
      String.fromCharCode(codepoint),
    ]);

  it.each(ACCEPTED_C0_AND_DEL_CODEPOINTS)(
    "accepts C0/DEL codepoint %s and escapes it byte-identically to cross-spawn 7.0.6",
    (_label, char) => {
      const result = buildWindowsShellInvocation(CMD_PATH, [char], WIN_ENV);
      expect(result).toEqual({
        command: CMD_EXE,
        args: ["/d", "/s", "/c", expectedCommandLine(char)],
        windowsVerbatimArguments: true,
      });
    },
  );

  // Every character in this module's own CMD_METACHARACTERS class, except '%' (rejected outright,
  // pinned above and excluded here for the same reason as NUL/CR/LF).
  const ACCEPTED_METACHARACTERS: readonly string[] = [
    "(",
    ")",
    "[",
    "]",
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

  it.each(ACCEPTED_METACHARACTERS)(
    "escapes cmd.exe metacharacter %j byte-identically to cross-spawn 7.0.6",
    (char) => {
      const result = buildWindowsShellInvocation(CMD_PATH, [char], WIN_ENV);
      expect(result).toEqual({
        command: CMD_EXE,
        args: ["/d", "/s", "/c", expectedCommandLine(char)],
        windowsVerbatimArguments: true,
      });
    },
  );
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
  const TRUSTED_SYSTEM_ROOT = (): boolean => true;

  it("resolves the hard-coded default when no override is present", () => {
    expect(resolveWindowsSystemDirectory({}, TRUSTED_SYSTEM_ROOT)).toBe(String.raw`C:\Windows`);
    expect(resolveSystemBinaryPath("taskkill.exe", {}, () => true, TRUSTED_SYSTEM_ROOT)).toBe(
      expectedSystemBinary(String.raw`C:\Windows`, "taskkill.exe"),
    );
  });

  it("accepts a valid drive-absolute SystemRoot override", () => {
    const env = { SystemRoot: String.raw`D:\NonstandardWindows` };
    expect(resolveWindowsSystemDirectory(env, TRUSTED_SYSTEM_ROOT)).toBe(
      String.raw`D:\NonstandardWindows`,
    );
    expect(resolveSystemBinaryPath("cmd.exe", env, () => true, TRUSTED_SYSTEM_ROOT)).toBe(
      expectedSystemBinary(String.raw`D:\NonstandardWindows`, "cmd.exe"),
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
