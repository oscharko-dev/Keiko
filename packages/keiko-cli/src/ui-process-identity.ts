import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { KEIKO_UI_LAUNCH_ID_ENV, UI_LAUNCH_ID_FLAG } from "./state-paths.js";

export interface LiveLaunchIdentityReaders {
  readonly platform?: NodeJS.Platform;
  readonly readEnviron?: (pid: number) => string | undefined;
  readonly readCommandLine?: (pid: number) => string | undefined;
}

function isIdentityFieldBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === "\0" || /\s/u.test(ch);
}

function containsExactIdentityToken(text: string, token: string): boolean {
  if (token.length === 0) return false;
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(token, from);
    if (index === -1) return false;
    const before = index === 0 ? undefined : text[index - 1];
    const after = text[index + token.length];
    if (isIdentityFieldBoundary(before) && isIdentityFieldBoundary(after)) return true;
    from = index + 1;
  }
  return false;
}

export function liveIdentityTextHasLaunchId(text: string, launchId: string): boolean {
  if (launchId.length === 0) return false;
  return (
    containsExactIdentityToken(text, `${KEIKO_UI_LAUNCH_ID_ENV}=${launchId}`) ||
    containsExactIdentityToken(text, `${UI_LAUNCH_ID_FLAG}\0${launchId}`) ||
    containsExactIdentityToken(text, `${UI_LAUNCH_ID_FLAG} ${launchId}`)
  );
}

function readProcFile(pid: number, name: "environ" | "cmdline"): string | undefined {
  try {
    return readFileSync(`/proc/${String(pid)}/${name}`, "utf8");
  } catch {
    return undefined;
  }
}

function runPs(args: readonly string[]): string | undefined {
  try {
    const result = spawnSync("ps", [...args], { encoding: "utf8", timeout: 2_000 });
    return result.status === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

function readWindowsCommandLine(pid: number): string | undefined {
  try {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}').CommandLine`,
      ],
      { encoding: "utf8", timeout: 3_000, windowsHide: true },
    );
    return result.status === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

export function defaultReadProcessEnviron(
  pid: number,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === "linux") return readProcFile(pid, "environ");
  if (platform === "darwin") return runPs(["eww", "-p", String(pid)]);
  return undefined;
}

export function defaultReadProcessCommandLine(
  pid: number,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === "linux") return readProcFile(pid, "cmdline");
  if (platform === "darwin") return runPs(["-p", String(pid), "-ww", "-o", "args="]);
  if (platform === "win32") return readWindowsCommandLine(pid);
  return undefined;
}

export function liveProcessHasLaunchId(
  pid: number,
  launchId: string,
  options: LiveLaunchIdentityReaders = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const environ = (
    options.readEnviron ??
    ((id: number): string | undefined => defaultReadProcessEnviron(id, platform))
  )(pid);
  if (environ !== undefined && liveIdentityTextHasLaunchId(environ, launchId)) return true;
  const cmdline = (
    options.readCommandLine ??
    ((id: number): string | undefined => defaultReadProcessCommandLine(id, platform))
  )(pid);
  return cmdline !== undefined && liveIdentityTextHasLaunchId(cmdline, launchId);
}
