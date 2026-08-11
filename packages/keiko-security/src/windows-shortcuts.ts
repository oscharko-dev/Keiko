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
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 as win32Path } from "node:path";

export interface WindowsShortcutDefinition {
  readonly targetPath: string;
  readonly workingDirectory: string;
  readonly iconPath: string;
}

export const WINDOWS_SHORTCUT_MAX_BYTES = 128 * 1024;
// A wedged script host (WSH is COM-backed and can hang on a broken shell registration) must not
// block a setup or activation forever: spawnSync enforces this bound and surfaces the kill as a
// spawn error, which the caller already fails closed on.
export const WINDOWS_SHORTCUT_TIMEOUT_MS = 30_000;
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
    readonly env: NodeJS.ProcessEnv;
    readonly shell: false;
    readonly stdio: "pipe";
    readonly timeout: number;
    readonly windowsHide: true;
  },
) => {
  readonly error?: Error | undefined;
  readonly status: number | null;
  readonly stdout: Buffer | null;
  readonly stderr: Buffer | null;
};

/**
 * The trusted Windows system root: an absolute SystemRoot/WINDIR from the environment, or the
 * platform default. The one shared trust decision every governed Windows child-process helper
 * (cscript, powershell) resolves its executable against.
 */
export function windowsSystemRoot(env: ShortcutEnvSource): string {
  const root = env.SystemRoot ?? env.WINDIR ?? DEFAULT_WINDOWS_ROOT;
  return win32Path.isAbsolute(root) ? root : DEFAULT_WINDOWS_ROOT;
}

function windowsCscriptExecutable(env: ShortcutEnvSource): string {
  return win32Path.join(windowsSystemRoot(env), "System32", "cscript.exe");
}

// The script host gets ONLY the variables it needs to run — never the caller's process
// environment, which in the server holds provider API keys and other secrets.
function windowsShortcutEnv(env: ShortcutEnvSource): NodeJS.ProcessEnv {
  const root = windowsSystemRoot(env);
  return {
    SystemRoot: root,
    WINDIR: root,
    ComSpec: win32Path.join(root, "System32", "cmd.exe"),
    ...(env.TEMP === undefined ? {} : { TEMP: env.TEMP }),
    ...(env.TMP === undefined ? {} : { TMP: env.TMP }),
  };
}

function windowsShortcutArgs(
  mode: "create" | "read",
  scriptPath: string,
  path: string,
  definition: WindowsShortcutDefinition,
): readonly string[] {
  // `//U` makes cscript emit UTF-16LE on stdout/stderr; without it, redirected output uses the
  // active ANSI/OEM code page and non-ASCII profile paths (e.g. `José`) come back corrupted,
  // failing the post-create readback verification.
  if (mode === "read") return ["//Nologo", "//U", "//E:JScript", scriptPath, mode, path];
  return [
    "//Nologo",
    "//U",
    "//E:JScript",
    scriptPath,
    mode,
    path,
    definition.targetPath,
    definition.workingDirectory,
    definition.iconPath,
  ];
}

// Failure text stays content-free: WSH stderr names the script path and the shortcut path, and
// both live under the user profile, so embedding it would carry the OS username into operator
// diagnostics. Status and byte count are enough to diagnose the class of failure.
function shortcutFailure(failurePrefix: string, status: number | null, stderr: Buffer): string {
  return `${failurePrefix} (cscript exit ${String(status)}, stderr ${String(stderr.byteLength)} bytes)`;
}

/**
 * Run the fixed shortcut JScript through cscript. Fails closed on spawn errors, nonzero exits,
 * and ANY stderr output; returns decoded stdout (three UTF-16LE lines in read mode).
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
        env: windowsShortcutEnv(env),
        shell: false,
        stdio: "pipe",
        timeout: WINDOWS_SHORTCUT_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (result.error !== undefined) throw result.error;
    const stderr = result.stderr ?? Buffer.alloc(0);
    if (result.status !== 0 || stderr.byteLength > 0) {
      throw new Error(shortcutFailure(failurePrefix, result.status, stderr));
    }
    return (result.stdout ?? Buffer.alloc(0)).toString("utf16le");
  } finally {
    rmSync(scriptRoot, { recursive: true, force: true });
  }
}

/** The JSON stand-in written on non-Windows hosts instead of a binary `.lnk`. */
export function windowsShortcutFallbackContent(definition: WindowsShortcutDefinition): string {
  return `${JSON.stringify({ schema: WINDOWS_SHORTCUT_FALLBACK_SCHEMA, ...definition })}\n`;
}

function shortcutDefinitionFromRecord(raw: unknown): WindowsShortcutDefinition | undefined {
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
}

export function parseWindowsShortcutFallback(path: string): WindowsShortcutDefinition | undefined {
  try {
    // The size bound lives here, not only at the call sites: this is an exported entry point,
    // and a reader that JSON-parses an unbounded file is a bug waiting for its first caller.
    const size = statSync(path).size;
    if (size <= 0 || size > WINDOWS_SHORTCUT_MAX_BYTES) return undefined;
    return shortcutDefinitionFromRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
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
