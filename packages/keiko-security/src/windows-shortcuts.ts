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
import { emitSecurityLogEvent, securityErrorKind, type SecurityLogSink } from "./log-port.js";
import {
  resolveWindowsSystemBinary,
  resolveWindowsSystemDirectory,
  type WindowsBinaryExistsCheck,
  type WindowsSystemDirectoryIdentityCheck,
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
} from "./windows-system-directory.js";

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

/** Optional process/log/filesystem seams shared by the read, write, and command entry points. */
export interface WindowsShortcutCommandOptions {
  readonly spawnFn?: WindowsShortcutSpawnFn | undefined;
  readonly sink?: SecurityLogSink | undefined;
  readonly existsAsFile?: WindowsBinaryExistsCheck | undefined;
  readonly systemDirectoryIdentity?: WindowsSystemDirectoryIdentityCheck | undefined;
}

/**
 * The trusted Windows system root: `SystemRoot`/`WINDIR` validated for canonical SHAPE, or the
 * platform default. The one shared trust decision every governed Windows child-process helper
 * (cscript, powershell) resolves its executable against — and, since PR #3354's review, the SAME
 * decision keiko-tools' `cmd.exe`/`taskkill.exe` resolution uses, because both now delegate to
 * `resolveWindowsSystemDirectory`.
 *
 * FAILS CLOSED (throws `WindowsSystemDirectoryError`) on a hostile or malformed override. The
 * previous `isAbsolute`-only check silently fell back to the default while ACCEPTING
 * `\\attacker\share`, `\\?\C:\Windows` and root-relative `\Windows` — a UNC or device-path
 * override could therefore select the `cscript.exe` this helper spawns.
 */
export function windowsSystemRoot(
  env: ShortcutEnvSource,
  identityCheck?: WindowsSystemDirectoryIdentityCheck,
): string {
  return resolveWindowsSystemDirectory(env, identityCheck);
}

function windowsCscriptExecutable(
  env: ShortcutEnvSource,
  existsAsFile?: WindowsBinaryExistsCheck,
  identityCheck?: WindowsSystemDirectoryIdentityCheck,
): string {
  return resolveWindowsSystemBinary("cscript.exe", env, existsAsFile, identityCheck);
}

// The script host gets ONLY the variables it needs to run — never the caller's process
// environment, which in the server holds provider API keys and other secrets.
function windowsShortcutEnv(
  env: ShortcutEnvSource,
  existsAsFile?: WindowsBinaryExistsCheck,
  identityCheck?: WindowsSystemDirectoryIdentityCheck,
): NodeJS.ProcessEnv {
  const root = windowsSystemRoot(env, identityCheck);
  return {
    SystemRoot: root,
    WINDIR: root,
    // Resolve ComSpec through the same System32 trust/existence boundary as cscript.exe. A manual
    // join here would reintroduce a second, weaker answer for the same system directory.
    ComSpec: resolveWindowsSystemBinary("cmd.exe", env, existsAsFile, identityCheck),
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

function logShortcutHostFailure(
  sink: SecurityLogSink | undefined,
  mode: "create" | "read",
  error: unknown,
): void {
  if (error instanceof WindowsSystemDirectoryError) {
    emitSecurityLogEvent(sink, {
      level: "warn",
      category: "security",
      op: "security.windows-shortcut.system-root-refused",
      errorKind: securityErrorKind(error),
      extra: { mode },
    });
  }
  if (error instanceof WindowsSystemBinaryMissingError) {
    emitSecurityLogEvent(sink, {
      level: "error",
      category: "diagnostic",
      op: "security.windows-shortcut.system-binary-missing",
      errorKind: securityErrorKind(error),
      extra: { mode },
    });
  }
}

/**
 * Run the fixed shortcut JScript through cscript. Fails closed on spawn errors, nonzero exits,
 * and ANY stderr output; returns decoded stdout (three UTF-16LE lines in read mode).
 *
 * A refusal of the trust boundary itself (`WindowsSystemDirectoryError`, thrown by SystemRoot/
 * WINDIR resolution before cscript ever runs) is logged through `options.sink` — when wired; a
 * no-op otherwise, same convention as `readMacosKeychainSecret` — and RE-THROWN unchanged. A
 * missing system binary is a separate operational failure and emits its own diagnostic event,
 * never this tampering event.
 */
export function runWindowsShortcutCommand(
  mode: "create" | "read",
  path: string,
  definition: WindowsShortcutDefinition,
  env: ShortcutEnvSource,
  failurePrefix: string,
  options: WindowsShortcutCommandOptions = {},
): string {
  const spawnFn = options.spawnFn ?? spawnSync;
  const scriptRoot = mkdtempSync(join(tmpdir(), "keiko-shortcut-"));
  const scriptPath = join(scriptRoot, "shortcut.js");
  try {
    writeFileSync(scriptPath, WINDOWS_SHORTCUT_SCRIPT, "utf8");
    const result = spawnFn(
      windowsCscriptExecutable(env, options.existsAsFile, options.systemDirectoryIdentity),
      windowsShortcutArgs(mode, scriptPath, path, definition),
      {
        env: windowsShortcutEnv(env, options.existsAsFile, options.systemDirectoryIdentity),
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
  } catch (error) {
    logShortcutHostFailure(options.sink, mode, error);
    throw error;
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

/**
 * Read a shortcut's fields; `undefined` when cscript cannot read the shortcut (a fail-closed READ
 * of the TARGET — missing file, malformed output, a nonzero cscript exit).
 *
 * A refusal of the trust boundary itself — a hostile or malformed `SystemRoot`/`WINDIR`
 * (`WindowsSystemDirectoryError`, thrown before cscript ever runs) — is a DIFFERENT failure class
 * and is never folded into that same "absent" signal: a poisoned environment must not be mistaken
 * for "no shortcut installed" by a caller that then treats absence as an invitation to (re)create
 * one. A missing System32 binary is likewise a typed operational failure, not shortcut absence.
 * `runWindowsShortcutCommand` already logs both classes through `sink` (when wired; a no-op
 * otherwise) before they reach this catch, so this only has to decide whether to RE-THROW them.
 */
export function readWindowsShortcutDefinition(
  path: string,
  env: ShortcutEnvSource,
  failurePrefix: string,
  options: WindowsShortcutCommandOptions = {},
): WindowsShortcutDefinition | undefined {
  if (process.platform !== "win32") return parseWindowsShortcutFallback(path);
  try {
    const output = runWindowsShortcutCommand(
      "read",
      path,
      EMPTY_DEFINITION,
      env,
      failurePrefix,
      options,
    );
    const [targetPath, workingDirectory, iconPath] = output.split(/\r?\n/u);
    if (targetPath === undefined || workingDirectory === undefined || iconPath === undefined) {
      return undefined;
    }
    return { targetPath, workingDirectory, iconPath };
  } catch (error) {
    if (
      error instanceof WindowsSystemDirectoryError ||
      error instanceof WindowsSystemBinaryMissingError
    ) {
      throw error;
    }
    return undefined;
  }
}

/**
 * Create/overwrite the shortcut (JSON fallback off Windows). Throws on failure — including a
 * trust-boundary refusal (`WindowsSystemDirectoryError`), which `runWindowsShortcutCommand` logs
 * through `options.sink` (when wired) before it propagates here unchanged. A missing cscript/cmd
 * binary also propagates with its own diagnostic event, but is not logged as a security refusal.
 */
export function writeWindowsShortcutDefinition(
  path: string,
  definition: WindowsShortcutDefinition,
  env: ShortcutEnvSource,
  failurePrefix: string,
  options: WindowsShortcutCommandOptions = {},
): void {
  if (process.platform !== "win32") {
    writeFileSync(path, windowsShortcutFallbackContent(definition), "utf8");
    return;
  }
  runWindowsShortcutCommand("create", path, definition, env, failurePrefix, options);
}

/** Case- and separator-insensitive Windows path equivalence for shortcut field comparison. */
export function equivalentWindowsShortcutPath(left: string, right: string): boolean {
  return win32Path.normalize(left).toLowerCase() === win32Path.normalize(right).toLowerCase();
}
