import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  equivalentWindowsShortcutPath,
  parseWindowsShortcutFallback,
  runWindowsShortcutCommand,
  windowsShortcutFallbackContent,
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
  return { status: 0, stdout: "", stderr: "", ...overrides };
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
  ])("refuses a %s fallback document", (_label, content) => {
    const path = join(tempRoot(), "Keiko.lnk");
    writeFileSync(path, content, "utf8");
    expect(parseWindowsShortcutFallback(path)).toBeUndefined();
  });

  it("refuses a missing fallback document", () => {
    expect(parseWindowsShortcutFallback(join(tempRoot(), "absent.lnk"))).toBeUndefined();
  });
});

describe("runWindowsShortcutCommand", () => {
  it("invokes cscript by absolute SystemRoot path with argv-carried fields", () => {
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() => spawnResult({ stdout: "out\n" }));
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
    expect(args?.slice(0, 2)).toEqual(["//Nologo", "//E:JScript"]);
    expect(args?.slice(3)).toEqual([
      "create",
      String.raw`C:\Menu\Keiko.lnk`,
      DEFINITION.targetPath,
      DEFINITION.workingDirectory,
      DEFINITION.iconPath,
    ]);
    expect(options?.shell).toBe(false);
    expect(options?.env.SystemRoot).toBe(String.raw`C:\Windows`);
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

  it("fails closed on a nonzero exit", () => {
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() => spawnResult({ status: 1 }));
    expect(() =>
      runWindowsShortcutCommand("read", "p", DEFINITION, {}, "test prefix", spawnFn),
    ).toThrow("test prefix");
  });

  it("fails closed on ANY stderr output even with exit 0", () => {
    const spawnFn = vi.fn<WindowsShortcutSpawnFn>(() =>
      spawnResult({ stderr: "WshShortcut refused" }),
    );
    expect(() =>
      runWindowsShortcutCommand("create", "p", DEFINITION, {}, "test prefix", spawnFn),
    ).toThrow("test prefix: WshShortcut refused");
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
