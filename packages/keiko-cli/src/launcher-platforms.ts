// Pure per-OS modules for `keiko launcher install`. Each platform exports `generateContent`
// (a pure string-producing function over a sanitized executable path + optional port),
// `installDirFor(homedir)` (the user-local approved directory), and `safeFileName()`
// (the canonical filename written under that directory).
//
// SECURITY — POSIX content generators do not quote or escape, so they refuse any executable path
// outside the strict `validateExecPath` allow-list. The Windows generator preserves that legacy
// format for allow-listed paths and otherwise uses an ASCII-only PowerShell encoded-command
// transport whose script contains only a base64-encoded executable path and fixed arguments. Its
// parser accepts only content the generator reproduces byte-for-byte. Portable-managed Windows
// installs create a real `.lnk` Start Menu app shortcut in `portable-maintenance.ts`; this helper
// remains for standalone `keiko launcher install` and legacy `.bat` recovery.
//
// PLATFORMS:
//   - Linux:   `~/.local/share/applications/keiko.desktop` (XDG Desktop Entry, text).
//   - macOS:   `~/Applications/Keiko Launcher.command` (bash script, chmod 0o755).
//   - Windows: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Keiko.bat` for standalone
//              launcher installs and legacy recovery. Portable-managed installs create
//              `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Keiko.lnk`.

import { Buffer } from "node:buffer";
import { posix as posixPath, win32 as win32Path } from "node:path";

// Allow-list: alphanumerics + the small set of safe path separators / characters that npm
// install paths legitimately produce. Anything else — spaces, quotes, `;`, `$`, backtick,
// `&`, `|`, `(`, `)`, `<`, `>`, `*`, `?`, `~`, `#`, `!`, `,`, `=`, `+`, control chars —
// is rejected. The intent is defense-in-depth even though XDG `.desktop` and `.bat`
// have their own quoting rules: no metacharacter ever reaches the file content.
const EXEC_PATH_RE = /^[A-Za-z0-9_@\-./\\:]+$/;
const WINDOWS_POWERSHELL_SUFFIX = " -NoLogo -NoProfile -NonInteractive -EncodedCommand ";
const WINDOWS_POWERSHELL_PATH_END = String.raw`\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_POWERSHELL_SCRIPT =
  "$exe=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:KEIKO_EXE_B64));$arguments=@('start','--open');if($env:KEIKO_PORT){$arguments+=@('--port',$env:KEIKO_PORT)};Start-Process -FilePath $exe -ArgumentList $arguments";
const WINDOWS_POWERSHELL_COMMAND = Buffer.from(WINDOWS_POWERSHELL_SCRIPT, "utf16le").toString(
  "base64",
);
const PREVIOUSLY_SHIPPED_WINDOWS_POWERSHELL_COMMAND = `@powershell.exe${WINDOWS_POWERSHELL_SUFFIX}${WINDOWS_POWERSHELL_COMMAND}`;
const WINDOWS_ENCODED_EXE_PREFIX = '@set "KEIKO_EXE_B64=';
const WINDOWS_ENCODED_PORT_PREFIX = '@set "KEIKO_PORT=';
const WINDOWS_LEGACY_REGISTRATION_RE =
  /^@start "" ([A-Za-z0-9_@\-./\\:]+) start --open(?: --port (\d+))?\r\n$/;

export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

export type Platform = "linux" | "darwin" | "win32";

export class LauncherError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "LauncherError";
  }
}

export function validateExecPath(path: string): string {
  if (path.length === 0) {
    throw new LauncherError(
      "EXEC_PATH_EMPTY",
      "keiko launcher: resolved executable path is empty.",
    );
  }
  if (path.length > 4096) {
    throw new LauncherError(
      "EXEC_PATH_TOO_LONG",
      "keiko launcher: resolved executable path exceeds 4096 chars.",
    );
  }
  if (!EXEC_PATH_RE.test(path)) {
    throw new LauncherError(
      "EXEC_PATH_UNSAFE",
      `keiko launcher: resolved executable path contains disallowed characters: ${path}\nOnly [A-Za-z0-9_@\\-./\\\\:] are permitted. Re-install keiko under a path without spaces or shell metacharacters.`,
    );
  }
  return path;
}

export function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new LauncherError(
      "PORT_OUT_OF_RANGE",
      `keiko launcher: --port must be an integer in [${String(MIN_PORT)}, ${String(MAX_PORT)}]; received ${String(port)}.`,
    );
  }
  return port;
}

export interface LauncherContentInput {
  readonly exe: string;
  readonly port: number | undefined;
  // Required only when the Windows executable needs the encoded transport. Production callers
  // resolve this absolute path through keiko-security's OS-identity-checked SystemRoot boundary;
  // keeping it explicit prevents a generated Start Menu BAT from deferring trust to a mutable
  // `%SystemRoot%`/`%WINDIR%` expansion at click time.
  readonly windowsPowerShellPath?: string | undefined;
}

export interface WindowsLauncherParseOptions {
  readonly resolveTrustedWindowsPowerShell?: (() => string) | undefined;
}

export interface PlatformLauncher {
  readonly id: Platform;
  readonly installDirFor: (homedir: string) => string;
  readonly safeFileName: () => string;
  readonly generateContent: (input: LauncherContentInput) => string;
  readonly fileMode: number;
}

function portFlag(port: number | undefined): string {
  if (port === undefined) return "";
  validatePort(port);
  return ` --port ${String(port)}`;
}

function requireSafeExe(exe: string): string {
  return validateExecPath(exe);
}

function requireWindowsLauncherExe(exe: string): string {
  if (exe.length === 0) {
    throw new LauncherError(
      "EXEC_PATH_EMPTY",
      "keiko launcher: resolved executable path is empty.",
    );
  }
  if (exe.length > 4096) {
    throw new LauncherError(
      "EXEC_PATH_TOO_LONG",
      "keiko launcher: resolved executable path exceeds 4096 chars.",
    );
  }
  if (
    exe.includes('"') ||
    Array.from(exe).some((character): boolean => (character.codePointAt(0) ?? 0) <= 0x1f)
  ) {
    throw new LauncherError(
      "EXEC_PATH_UNSAFE",
      "keiko launcher: resolved Windows executable path contains a quote or control character.",
    );
  }
  return exe;
}

export function windowsLauncherNeedsPowerShell(exe: string): boolean {
  return !EXEC_PATH_RE.test(requireWindowsLauncherExe(exe));
}

function requireWindowsPowerShellPath(path: string | undefined): string {
  if (
    path === undefined ||
    !win32Path.isAbsolute(path) ||
    !path.toLowerCase().endsWith(WINDOWS_POWERSHELL_PATH_END.toLowerCase()) ||
    path.includes('"') ||
    path.includes("%") ||
    Array.from(path).some((character): boolean => (character.codePointAt(0) ?? 0) <= 0x1f)
  ) {
    throw new LauncherError(
      "WINDOWS_POWERSHELL_UNTRUSTED",
      "keiko launcher: encoded Windows launch requires an identity-validated absolute PowerShell path.",
    );
  }
  return path;
}

function windowsPowerShellCommand(path: string): string {
  return `@"${path}"${WINDOWS_POWERSHELL_SUFFIX}${WINDOWS_POWERSHELL_COMMAND}`;
}

function encodedWindowsLauncherContent(
  safeExe: string,
  port: number | undefined,
  powerShellCommand: string,
): string {
  const encodedExe = Buffer.from(safeExe, "utf8").toString("base64");
  return [
    "@setlocal DisableDelayedExpansion",
    `${WINDOWS_ENCODED_EXE_PREFIX}${encodedExe}"`,
    `${WINDOWS_ENCODED_PORT_PREFIX}${port === undefined ? "" : String(port)}"`,
    powerShellCommand,
    "@endlocal",
    "",
  ].join("\r\n");
}

function windowsLauncherContent(
  exe: string,
  port: number | undefined,
  powerShellPath?: string,
): string {
  const safeExe = requireWindowsLauncherExe(exe);
  const flag = portFlag(port);
  if (!windowsLauncherNeedsPowerShell(safeExe)) {
    return `@start "" ${safeExe} start --open${flag}\r\n`;
  }
  const trustedPowerShell = requireWindowsPowerShellPath(powerShellPath);
  return encodedWindowsLauncherContent(safeExe, port, windowsPowerShellCommand(trustedPowerShell));
}

function canonicalBase64Utf8(encoded: string): string | undefined {
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  return Buffer.from(decoded, "utf8").toString("base64") === encoded ? decoded : undefined;
}

interface ParsedWindowsLauncherContent {
  readonly executablePath: string;
  readonly port: number | undefined;
}

function parseLegacyWindowsLauncherContent(
  content: string,
): ParsedWindowsLauncherContent | undefined {
  const legacy = WINDOWS_LEGACY_REGISTRATION_RE.exec(content);
  if (legacy === null) return undefined;
  const port = legacy[2] === undefined ? undefined : Number(legacy[2]);
  try {
    const executablePath = legacy[1] ?? "";
    return windowsLauncherContent(executablePath, port) === content
      ? { executablePath, port }
      : undefined;
  } catch {
    return undefined;
  }
}

interface EncodedRegistration {
  readonly lines: readonly string[];
  readonly powerShellCommand: string;
  // Undefined identifies the one frozen, previously shipped bare command. Current absolute
  // commands always carry a candidate that must equal the trusted resolver result before use.
  readonly powerShellPath: string | undefined;
}

function encodedPowerShellPath(command: string): string | undefined {
  if (command === PREVIOUSLY_SHIPPED_WINDOWS_POWERSHELL_COMMAND) return undefined;
  const commandEnd = `${WINDOWS_POWERSHELL_SUFFIX}${WINDOWS_POWERSHELL_COMMAND}`;
  if (!command.startsWith('@"') || !command.endsWith(commandEnd)) {
    throw new Error("unexpected Windows registration command");
  }
  return requireWindowsPowerShellPath(command.slice(2, -commandEnd.length - 1));
}

function encodedRegistrationLines(content: string): EncodedRegistration {
  const lines = content.split("\r\n");
  if (lines.length !== 6) throw new Error("unexpected Windows registration line count");
  if (lines[0] !== "@setlocal DisableDelayedExpansion") {
    throw new Error("unexpected Windows registration preamble");
  }
  const command = lines[3] ?? "";
  if (lines[4] !== "@endlocal" || lines[5] !== "") {
    throw new Error("unexpected Windows registration terminator");
  }
  return { lines, powerShellCommand: command, powerShellPath: encodedPowerShellPath(command) };
}

function batchEnvironmentValue(line: string | undefined, prefix: string): string {
  if (line === undefined || !line.startsWith(prefix) || !line.endsWith('"')) {
    throw new Error("invalid Windows registration environment value");
  }
  return line.slice(prefix.length, -1);
}

function decodedRegistrationPort(portText: string): number | undefined {
  if (portText === "") return undefined;
  if (!/^\d+$/u.test(portText)) throw new Error("invalid Windows registration port");
  return validatePort(Number(portText));
}

interface DecodedEncodedRegistration extends ParsedWindowsLauncherContent {
  readonly powerShellCommand: string;
  readonly powerShellPath: string | undefined;
}

function decodeEncodedWindowsLauncherContent(
  content: string,
): DecodedEncodedRegistration | undefined {
  try {
    const { lines, powerShellCommand, powerShellPath } = encodedRegistrationLines(content);
    const encodedExe = batchEnvironmentValue(lines[1], WINDOWS_ENCODED_EXE_PREFIX);
    const decodedExe = canonicalBase64Utf8(encodedExe);
    if (decodedExe === undefined) return undefined;
    const portText = batchEnvironmentValue(lines[2], WINDOWS_ENCODED_PORT_PREFIX);
    const port = decodedRegistrationPort(portText);
    const executablePath = requireWindowsLauncherExe(decodedExe);
    if (!windowsLauncherNeedsPowerShell(executablePath)) return undefined;
    return encodedWindowsLauncherContent(executablePath, port, powerShellCommand) === content
      ? { executablePath, port, powerShellCommand, powerShellPath }
      : undefined;
  } catch {
    return undefined;
  }
}

function acceptsEncodedPowerShell(
  registration: DecodedEncodedRegistration,
  options: WindowsLauncherParseOptions | undefined,
): boolean {
  if (registration.powerShellPath === undefined) return true;
  const resolveTrusted = options?.resolveTrustedWindowsPowerShell;
  if (resolveTrusted === undefined) return false;
  const trustedPath = requireWindowsPowerShellPath(resolveTrusted());
  return registration.powerShellCommand === windowsPowerShellCommand(trustedPath);
}

function parseEncodedWindowsLauncherContent(
  content: string,
  options: WindowsLauncherParseOptions | undefined,
): ParsedWindowsLauncherContent | undefined {
  const registration = decodeEncodedWindowsLauncherContent(content);
  return registration !== undefined && acceptsEncodedPowerShell(registration, options)
    ? registration
    : undefined;
}

function parseWindowsLauncher(
  content: string,
  options: WindowsLauncherParseOptions | undefined,
): ParsedWindowsLauncherContent | undefined {
  return (
    parseLegacyWindowsLauncherContent(content) ??
    parseEncodedWindowsLauncherContent(content, options)
  );
}

export function parseWindowsLauncherContent(
  content: string,
  options?: WindowsLauncherParseOptions,
): string | undefined {
  return parseWindowsLauncher(content, options)?.executablePath;
}

export function windowsLauncherContentMatches(
  content: string,
  expected: Pick<LauncherContentInput, "exe" | "port">,
  options?: WindowsLauncherParseOptions,
): boolean {
  const parsed = parseWindowsLauncher(content, options);
  return parsed?.executablePath === expected.exe && parsed.port === expected.port;
}

export const linuxLauncher: PlatformLauncher = {
  id: "linux",
  installDirFor: (homedir) => posixPath.join(homedir, ".local", "share", "applications"),
  safeFileName: () => "keiko.desktop",
  fileMode: 0o644,
  generateContent: ({ exe, port }) => {
    const safeExe = requireSafeExe(exe);
    const flag = portFlag(port);
    return [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Keiko",
      "Comment=Keiko local developer-assist workspace",
      `Exec=${safeExe} start --open${flag}`,
      "Terminal=false",
      "Categories=Development;",
      "StartupNotify=true",
      "",
    ].join("\n");
  },
};

export const macosLauncher: PlatformLauncher = {
  id: "darwin",
  installDirFor: (homedir) => posixPath.join(homedir, "Applications"),
  safeFileName: () => "Keiko Launcher.command",
  fileMode: 0o755,
  generateContent: ({ exe, port }) => {
    const safeExe = requireSafeExe(exe);
    const flag = portFlag(port);
    return [
      "#!/usr/bin/env bash",
      "# Keiko launcher — generated by `keiko launcher install`. Edit at your own risk.",
      "# Remove with: keiko launcher remove",
      "set -euo pipefail",
      `exec ${safeExe} start --open${flag}`,
      "",
    ].join("\n");
  },
};

// Legacy Windows .bat content for `keiko launcher install` and old portable registrations.
// Portable-managed Windows installs create a real Start Menu `.lnk` in portable-maintenance.ts.
// `@start "" <exe> ...` detaches the keiko process from the cmd window so the latter closes
// immediately after dispatch.
export const windowsLauncher: PlatformLauncher = {
  id: "win32",
  installDirFor: (homedir) =>
    win32Path.join(homedir, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
  safeFileName: () => "Keiko.bat",
  fileMode: 0o644,
  generateContent: ({ exe, port, windowsPowerShellPath }) =>
    windowsLauncherContent(exe, port, windowsPowerShellPath),
};

const REGISTRY: Readonly<Record<Platform, PlatformLauncher>> = {
  linux: linuxLauncher,
  darwin: macosLauncher,
  win32: windowsLauncher,
};

export function launcherFor(platform: NodeJS.Platform): PlatformLauncher {
  const entry = (REGISTRY as Readonly<Record<string, PlatformLauncher | undefined>>)[platform];
  if (entry === undefined) {
    throw new LauncherError(
      "PLATFORM_UNSUPPORTED",
      `keiko launcher: platform "${platform}" is not supported. Supported: linux, darwin, win32.`,
    );
  }
  return entry;
}
