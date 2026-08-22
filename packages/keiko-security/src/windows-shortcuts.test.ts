import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WINDOWS_SHORTCUT_MAX_BYTES,
  WINDOWS_SHORTCUT_TIMEOUT_MS,
  equivalentWindowsShortcutPath,
  parseWindowsShortcutFallback,
  readWindowsShortcutDefinition,
  runWindowsShortcutCommand,
  windowsShortcutFallbackContent,
  writeWindowsShortcutDefinition,
  type WindowsShortcutDefinition,
  type WindowsShortcutSpawnFn,
} from "./windows-shortcuts.js";

const DEFINITION: WindowsShortcutDefinition = {
  targetPath: String.raw`C:\Users\pilot\AppData\Local\Programs\Keiko\Keiko.exe`,
  workingDirectory: String.raw`C:\Users\pilot\AppData\Local\Programs\Keiko`,
  iconPath: String.raw`C:\Users\pilot\AppData\Local\Programs\Keiko\Keiko.exe`,
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-shortcut-test-"));
  roots.push(root);
  return root;
}

function spawnResult(
  overrides: Partial<ReturnType<WindowsShortcutSpawnFn>> = {},
): ReturnType<WindowsShortcutSpawnFn> {
  return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), ...overrides };
}

describe("windows shortcut fallback codec", () => {
  it("round-trips a definition through the JSON stand-in", () => {
    const path = join(tempRoot(), "Keiko.lnk");
    writeFileSync(path, windowsShortcutFallbackContent(DEFINITION), "utf8");
    expect(parseWindowsShortcutFallback(path)).toEqual(DEFINITION);
  });

  it.each([
    ["not json", "{broken"],
    ["wrong schema", `${JSON.stringify({ schema: "other", ...DEFINITION })}\n`],
    [
      "missing field",
      `${JSON.stringify({ schema: "keiko-windows-shortcut-v1", targetPath: "x" })}\n`,
    ],
    ["non-object", '"just a string"\n'],
    [
      "non-string targetPath",
      `${JSON.stringify({
        schema: "keiko-windows-shortcut-v1",
        targetPath: 123,
        workingDirectory: "wd",
        iconPath: "ip",
      })}\n`,
    ],
    [
      "non-string iconPath",
      `${JSON.stringify({
        schema: "keiko-windows-shortcut-v1",
        targetPath: "tp",
        workingDirectory: "wd",
        iconPath: 123,
      })}\n`,
    ],
  ])("refuses a %s fallback document", (_label, content) => {
    const path = join(tempRoot(), "Keiko.lnk");
    writeFileSync(path, content, "utf8");
    expect(parseWindowsShortcutFallback(path)).toBeUndefined();
  });

  it("refuses a missing fallback document", () => {
    expect(parseWindowsShortcutFallback(join(tempRoot(), "absent.lnk"))).toBeUndefined();
  });

  it("bounds the fallback document size inside the parser itself", () => {
    const oversized = join(tempRoot(), "oversized.lnk");
    const padding = JSON.stringify({
      schema: "keiko-windows-shortcut-v1",
      ...DEFINITION,
      pad: "x".repeat(WINDOWS_SHORTCUT_MAX_BYTES),
    });
    writeFileSync(oversized, `${padding}\n`, "utf8");
    expect(parseWindowsShortcutFallback(oversized)).toBeUndefined();

    const empty = join(tempRoot(), "empty.lnk");
    writeFileSync(empty, "", "utf8");
    expect(parseWindowsShortcutFallback(empty)).toBeUndefined();
  });
});

// The two entry points portable-maintenance and update-portable-activation-files actually call.
// Off Windows they must round-trip through the JSON stand-in with identical semantics.
describe.skipIf(process.platform === "win32")("definition read/write entry points", () => {
  it("round-trips a definition through write and read on a non-Windows host", () => {
    const path = join(tempRoot(), "Keiko.lnk");
    writeWindowsShortcutDefinition(path, DEFINITION, {}, "test prefix");
    expect(readWindowsShortcutDefinition(path, {}, "test prefix")).toEqual(DEFINITION);
  });

  it("returns undefined for an unreadable definition instead of throwing", () => {
    const path = join(tempRoot(), "broken.lnk");
    writeFileSync(path, "{broken", "utf8");
    expect(readWindowsShortcutDefinition(path, {}, "test prefix")).toBeUndefined();
  });
});

// The win32 route of the same two entry points, exercised via the injected spawn seam with the
// platform gate stubbed — the cscript binary itself never runs, so this stays hermetic anywhere.
describe("definition read/write entry points on the win32 route", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");

  afterEach(() => {
    if (platform !== undefined) Object.defineProperty(process, "platform", platform);
  });

  function stubWin32(): void {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  }

  it("reads three UTF-16LE lines through cscript and refuses a short read", () => {
    stubWin32();
    const lines = `${DEFINITION.targetPath}\r\n${DEFINITION.workingDirectory}\r\n${DEFINITION.iconPath}\r\n`;
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() =>
      spawnResult({ stdout: Buffer.from(lines, "utf16le") }),
    );
    expect(readWindowsShortcutDefinition("p", {}, "test prefix", spawnFn)).toEqual(DEFINITION);

    const short = vi.fn<WindowsShortcutSpawnFn>(() =>
      spawnResult({ stdout: Buffer.from("only-one-line", "utf16le") }),
    );
    expect(readWindowsShortcutDefinition("p", {}, "test prefix", short)).toBeUndefined();
  });

  it("creates through cscript instead of the JSON stand-in", () => {
    stubWin32();
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() => spawnResult());
    writeWindowsShortcutDefinition("p", DEFINITION, {}, "test prefix", spawnFn);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0]?.[1]).toContain("create");
  });

  it("returns undefined instead of throwing when the underlying cscript call fails", () => {
    // On the win32 route, readWindowsShortcutDefinition is a fail-closed READ: any refusal from
    // runWindowsShortcutCommand (a nonzero exit here) must be swallowed, not propagated.
    stubWin32();
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() => spawnResult({ status: 1 }));
    expect(readWindowsShortcutDefinition("p", {}, "test prefix", spawnFn)).toBeUndefined();
  });
});

describe("runWindowsShortcutCommand", () => {
  it("invokes cscript by absolute SystemRoot path with argv-carried fields", () => {
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() =>
      spawnResult({ stdout: Buffer.from("out\n", "utf16le") }),
    );
    const output = runWindowsShortcutCommand(
      "create",
      String.raw`C:\Menu\Keiko.lnk`,
      DEFINITION,
      { SystemRoot: String.raw`C:\Windows` },
      "test prefix",
      spawnFn,
    );
    expect(output).toBe("out\n");
    const [command, args, options] = spawnFn.mock.calls[0] ?? [];
    expect(command).toBe(String.raw`C:\Windows\System32\cscript.exe`);
    expect(args?.slice(0, 3)).toEqual(["//Nologo", "//U", "//E:JScript"]);
    expect(args?.slice(4)).toEqual([
      "create",
      String.raw`C:\Menu\Keiko.lnk`,
      DEFINITION.targetPath,
      DEFINITION.workingDirectory,
      DEFINITION.iconPath,
    ]);
    expect(options?.shell).toBe(false);
    // A wedged script host must be killed, never waited on forever.
    expect(options?.timeout).toBe(WINDOWS_SHORTCUT_TIMEOUT_MS);
    // Minimal script-host environment only — never the caller's secret-bearing process env.
    expect(options?.env).toEqual({
      SystemRoot: String.raw`C:\Windows`,
      WINDIR: String.raw`C:\Windows`,
      ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
    });
  });

  it("falls back to the default SystemRoot when the environment offers a relative one", () => {
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() => spawnResult());
    runWindowsShortcutCommand(
      "read",
      String.raw`C:\Menu\Keiko.lnk`,
      DEFINITION,
      { SystemRoot: "not-absolute" },
      "test prefix",
      spawnFn,
    );
    expect(spawnFn.mock.calls[0]?.[0]).toBe(String.raw`C:\Windows\System32\cscript.exe`);
  });

  it("passes TEMP/TMP through to the script-host environment when the caller's env carries them", () => {
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() => spawnResult());
    runWindowsShortcutCommand(
      "read",
      "p",
      DEFINITION,
      { SystemRoot: String.raw`C:\Windows`, TEMP: String.raw`C:\Temp`, TMP: String.raw`C:\Tmp` },
      "test prefix",
      spawnFn,
    );
    expect(spawnFn.mock.calls[0]?.[2]?.env).toEqual({
      SystemRoot: String.raw`C:\Windows`,
      WINDIR: String.raw`C:\Windows`,
      ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
      TEMP: String.raw`C:\Temp`,
      TMP: String.raw`C:\Tmp`,
    });
  });

  it("falls back to an empty buffer when stdout/stderr are null instead of throwing", () => {
    // The WindowsShortcutSpawnFn type allows a null stdout/stderr (matches spawnSync's own return
    // shape); every OTHER fixture in this file supplies a real Buffer, so the `?? Buffer.alloc(0)`
    // fallback on each field is otherwise never exercised.
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() =>
      spawnResult({ stdout: null, stderr: null }),
    );
    expect(runWindowsShortcutCommand("read", "p", DEFINITION, {}, "test prefix", spawnFn)).toBe("");
  });

  it("fails closed on a nonzero exit", () => {
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() => spawnResult({ status: 1 }));
    expect(() =>
      runWindowsShortcutCommand("read", "p", DEFINITION, {}, "test prefix", spawnFn),
    ).toThrow("test prefix");
  });

  it("fails closed on ANY stderr output even with exit 0, without echoing its content", () => {
    const stderr = Buffer.from(String.raw`Error at C:\Users\José\shortcut.js`, "utf16le");
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() => spawnResult({ stderr }));
    expect(() =>
      runWindowsShortcutCommand("create", "p", DEFINITION, {}, "test prefix", spawnFn),
    ).toThrow(`test prefix (cscript exit 0, stderr ${String(stderr.byteLength)} bytes)`);
    // The profile-bearing stderr body never reaches the message. Captured unconditionally: if
    // the command ever stops throwing here, the missing error itself fails the assertion.
    let thrown: unknown;
    try {
      runWindowsShortcutCommand("create", "p", DEFINITION, {}, "test prefix", spawnFn);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain("José");
  });

  it("decodes UTF-16LE read output so non-ASCII profile paths survive the readback", () => {
    const lines = `${String.raw`C:\Users\José\Programs\Keiko\Keiko.exe`}\r\n`;
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() =>
      spawnResult({ stdout: Buffer.from(lines, "utf16le") }),
    );
    const output = runWindowsShortcutCommand("read", "p", DEFINITION, {}, "test prefix", spawnFn);
    expect(output).toContain("José");
  });

  it("propagates a spawn error", () => {
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() =>
      spawnResult({ error: new Error("ENOENT") }),
    );
    expect(() =>
      runWindowsShortcutCommand("read", "p", DEFINITION, {}, "test prefix", spawnFn),
    ).toThrow("ENOENT");
  });
});

describe("equivalentWindowsShortcutPath", () => {
  it("treats case and separator variants as the same installed path", () => {
    expect(
      equivalentWindowsShortcutPath(
        String.raw`C:\Users\Pilot\KEIKO\Keiko.exe`,
        "c:/users/pilot/keiko/Keiko.exe",
      ),
    ).toBe(true);
    expect(
      equivalentWindowsShortcutPath(String.raw`C:\a\Keiko.exe`, String.raw`C:\b\Keiko.exe`),
    ).toBe(false);
  });
});
