// Governed Windows Start Menu shortcut integration (issue #3072). The one home of the `.lnk`
// create/read layer that the portable CLI registration (keiko-cli/portable-maintenance) and the
// server update activation (keiko-server/update-portable-activation-files) both consume — the
// same role macos-keychain.ts plays for the macOS credential store: a fail-closed wrapper around
// a platform tool this repository never reimplements.
//
// Mechanics: `cscript.exe` (absolute path under a validated SystemRoot) runs a fixed JScript
// written to a private temp directory; shortcut fields travel as argv, never interpolated into
// script text, so no caller-controlled value is evaluated. Any nonzero exit or stderr output
// fails closed. On non-Windows hosts (unit suites, cross-platform staging) a JSON fallback
// document stands in for the binary `.lnk` so behaviour stays testable everywhere.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 as win32Path } from "node:path";

export interface WindowsShortcutDefinition {
  readonly targetPath: string;
  readonly workingDirectory: string;
  readonly iconPath: string;
}

export const WINDOWS_SHORTCUT_MAX_BYTES = 128 * 1024;
const WINDOWS_SHORTCUT_FALLBACK_SCHEMA = "keiko-windows-shortcut-v1";
const DEFAULT_WINDOWS_ROOT = String.raw`C:\Windows`;

const WINDOWS_SHORTCUT_SCRIPT = [
  'var shell = WScript.CreateObject("WScript.Shell");',
  "var mode = WScript.Arguments.Item(0);",
  "var path = WScript.Arguments.Item(1);",
  "var shortcut = shell.CreateShortcut(path);",
  'if (mode === "create") {',
  "  shortcut.TargetPath = WScript.Arguments.Item(2);",
  '  shortcut.Arguments = "";',
  "  shortcut.WorkingDirectory = WScript.Arguments.Item(3);",
  "  shortcut.IconLocation = WScript.Arguments.Item(4);",
  '  shortcut.Description = "Keiko";',
  "  shortcut.Save();",
  "} else {",
  "  WScript.StdOut.WriteLine(shortcut.TargetPath);",
  "  WScript.StdOut.WriteLine(shortcut.WorkingDirectory);",
  "  WScript.StdOut.WriteLine(shortcut.IconLocation);",
  "}",
  "",
].join("\r\n");

type ShortcutEnvSource = Readonly<Record<string, string | undefined>>;

export type WindowsShortcutSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    readonly encoding: "utf8";
    readonly env: NodeJS.ProcessEnv;
    readonly shell: false;
    readonly stdio: "pipe";
    readonly windowsHide: true;
  },
) => {
  readonly error?: Error | undefined;
  readonly status: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
};

function windowsSystemRoot(env: ShortcutEnvSource): string {
  const root = env.SystemRoot ?? env.WINDIR ?? DEFAULT_WINDOWS_ROOT;
  return win32Path.isAbsolute(root) ? root : DEFAULT_WINDOWS_ROOT;
}

function windowsCscriptExecutable(env: ShortcutEnvSource): string {
  return win32Path.join(windowsSystemRoot(env), "System32", "cscript.exe");
}

function windowsShortcutEnv(env: ShortcutEnvSource): NodeJS.ProcessEnv {
  const root = windowsSystemRoot(env);
  return {
    ...process.env,
    ...env,
    SystemRoot: root,
    WINDIR: root,
    ComSpec: win32Path.join(root, "System32", "cmd.exe"),
  };
}

function windowsShortcutArgs(
  mode: "create" | "read",
  scriptPath: string,
  path: string,
  definition: WindowsShortcutDefinition,
): readonly string[] {
  if (mode === "read") return ["//Nologo", "//E:JScript", scriptPath, mode, path];
  return [
    "//Nologo",
    "//E:JScript",
    scriptPath,
    mode,
    path,
    definition.targetPath,
    definition.workingDirectory,
    definition.iconPath,
  ];
}

function shortcutFailure(failurePrefix: string, stderr: string | null): string {
  const detail = stderr?.trim();
  return detail === undefined || detail.length === 0
    ? failurePrefix
    : `${failurePrefix}: ${detail}`;
}

/**
 * Run the fixed shortcut JScript through cscript. Fails closed on spawn errors, nonzero exits,
 * and ANY stderr output; returns raw stdout (three lines in read mode).
 */
export function runWindowsShortcutCommand(
  mode: "create" | "read",
  path: string,
  definition: WindowsShortcutDefinition,
  env: ShortcutEnvSource,
  failurePrefix: string,
  spawnFn: WindowsShortcutSpawnFn = spawnSync,
): string {
  const scriptRoot = mkdtempSync(join(tmpdir(), "keiko-shortcut-"));
  const scriptPath = join(scriptRoot, "shortcut.js");
  try {
    writeFileSync(scriptPath, WINDOWS_SHORTCUT_SCRIPT, "utf8");
    const result = spawnFn(
      windowsCscriptExecutable(env),
      windowsShortcutArgs(mode, scriptPath, path, definition),
      {
        encoding: "utf8",
        env: windowsShortcutEnv(env),
        shell: false,
        stdio: "pipe",
        windowsHide: true,
      },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0 || (result.stderr !== null && result.stderr.length > 0)) {
      throw new Error(shortcutFailure(failurePrefix, result.stderr));
    }
    return result.stdout ?? "";
  } finally {
    rmSync(scriptRoot, { recursive: true, force: true });
  }
}

/** The JSON stand-in written on non-Windows hosts instead of a binary `.lnk`. */
export function windowsShortcutFallbackContent(definition: WindowsShortcutDefinition): string {
  return `${JSON.stringify({ schema: WINDOWS_SHORTCUT_FALLBACK_SCHEMA, ...definition })}\n`;
}

export function parseWindowsShortcutFallback(path: string): WindowsShortcutDefinition | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    if (record.schema !== WINDOWS_SHORTCUT_FALLBACK_SCHEMA) return undefined;
    if (typeof record.targetPath !== "string") return undefined;
    if (typeof record.workingDirectory !== "string") return undefined;
    if (typeof record.iconPath !== "string") return undefined;
    return {
      targetPath: record.targetPath,
      workingDirectory: record.workingDirectory,
      iconPath: record.iconPath,
    };
  } catch {
    return undefined;
  }
}

const EMPTY_DEFINITION: WindowsShortcutDefinition = {
  targetPath: "",
  workingDirectory: "",
  iconPath: "",
};

/** Read a shortcut's fields; undefined on any refusal (fail-closed read). */
export function readWindowsShortcutDefinition(
  path: string,
  env: ShortcutEnvSource,
  failurePrefix: string,
  spawnFn: WindowsShortcutSpawnFn = spawnSync,
): WindowsShortcutDefinition | undefined {
  if (process.platform !== "win32") return parseWindowsShortcutFallback(path);
  try {
    const output = runWindowsShortcutCommand(
      "read",
      path,
      EMPTY_DEFINITION,
      env,
      failurePrefix,
      spawnFn,
    );
    const [targetPath, workingDirectory, iconPath] = output.split(/\r?\n/u);
    if (targetPath === undefined || workingDirectory === undefined || iconPath === undefined) {
      return undefined;
    }
    return { targetPath, workingDirectory, iconPath };
  } catch {
    return undefined;
  }
}

/** Create/overwrite the shortcut (JSON fallback off Windows). Throws on failure. */
export function writeWindowsShortcutDefinition(
  path: string,
  definition: WindowsShortcutDefinition,
  env: ShortcutEnvSource,
  failurePrefix: string,
  spawnFn: WindowsShortcutSpawnFn = spawnSync,
): void {
  if (process.platform !== "win32") {
    writeFileSync(path, windowsShortcutFallbackContent(definition), "utf8");
    return;
  }
  runWindowsShortcutCommand("create", path, definition, env, failurePrefix, spawnFn);
}

/** Case- and separator-insensitive Windows path equivalence for shortcut field comparison. */
export function equivalentWindowsShortcutPath(left: string, right: string): boolean {
  return win32Path.normalize(left).toLowerCase() === win32Path.normalize(right).toLowerCase();
}
