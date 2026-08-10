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
const WINDOWS_POWERSHELL_EXE = String.raw`@"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand `;
const WINDOWS_POWERSHELL_SCRIPT =
  "$exe=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:KEIKO_EXE_B64));$arguments=@('start','--open');if($env:KEIKO_PORT){$arguments+=@('--port',$env:KEIKO_PORT)};Start-Process -FilePath $exe -ArgumentList $arguments";
const WINDOWS_POWERSHELL_COMMAND = Buffer.from(WINDOWS_POWERSHELL_SCRIPT, "utf16le").toString(
  "base64",
);
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

function windowsLauncherContent(exe: string, port: number | undefined): string {
  const safeExe = requireWindowsLauncherExe(exe);
  const flag = portFlag(port);
  if (EXEC_PATH_RE.test(safeExe)) return `@start "" ${safeExe} start --open${flag}\r\n`;
  const encodedExe = Buffer.from(safeExe, "utf8").toString("base64");
  return [
    "@setlocal DisableDelayedExpansion",
    `${WINDOWS_ENCODED_EXE_PREFIX}${encodedExe}"`,
    `${WINDOWS_ENCODED_PORT_PREFIX}${port === undefined ? "" : String(port)}"`,
    `${WINDOWS_POWERSHELL_EXE}${WINDOWS_POWERSHELL_COMMAND}`,
    "@endlocal",
    "",
  ].join("\r\n");
}

function canonicalBase64Utf8(encoded: string): string | undefined {
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  return Buffer.from(decoded, "utf8").toString("base64") === encoded ? decoded : undefined;
}

function parseLegacyWindowsLauncherContent(content: string): string | undefined {
  const legacy = WINDOWS_LEGACY_REGISTRATION_RE.exec(content);
  if (legacy === null) return undefined;
  const port = legacy[2] === undefined ? undefined : Number(legacy[2]);
  try {
    return windowsLauncherContent(legacy[1] ?? "", port) === content ? legacy[1] : undefined;
  } catch {
    return undefined;
  }
}

function encodedRegistrationLines(content: string): readonly string[] {
  const lines = content.split("\r\n");
  if (lines.length !== 6) throw new Error("unexpected Windows registration line count");
  if (lines[0] !== "@setlocal DisableDelayedExpansion") {
    throw new Error("unexpected Windows registration preamble");
  }
  if (lines[3] !== `${WINDOWS_POWERSHELL_EXE}${WINDOWS_POWERSHELL_COMMAND}`) {
    throw new Error("unexpected Windows registration command");
  }
  if (lines[4] !== "@endlocal" || lines[5] !== "") {
    throw new Error("unexpected Windows registration terminator");
  }
  return lines;
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

function parseEncodedWindowsLauncherContent(content: string): string | undefined {
  try {
    const lines = encodedRegistrationLines(content);
    const encodedExe = batchEnvironmentValue(lines[1], WINDOWS_ENCODED_EXE_PREFIX);
    const decodedExe = canonicalBase64Utf8(encodedExe);
    if (decodedExe === undefined) return undefined;
    const portText = batchEnvironmentValue(lines[2], WINDOWS_ENCODED_PORT_PREFIX);
    const port = decodedRegistrationPort(portText);
    return windowsLauncherContent(decodedExe, port) === content ? decodedExe : undefined;
  } catch {
    return undefined;
  }
}

export function parseWindowsLauncherContent(content: string): string | undefined {
  return parseLegacyWindowsLauncherContent(content) ?? parseEncodedWindowsLauncherContent(content);
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
  generateContent: ({ exe, port }) => windowsLauncherContent(exe, port),
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
