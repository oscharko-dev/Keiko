// Shared resolution of Keiko's runtime state directory and the set of files Keiko
// itself writes there. Consumed by `keiko uninstall` (to reverse them) and
// `keiko repair` (to detect and clean stale ones). Resolution mirrors `lifecycle.ts`
// (`--state-dir` > KEIKO_STATE_DIR > <cwd>/.keiko) so `start`, `uninstall`, and
// `repair` all operate on the same directory.
//
// DELETION SAFETY CONTRACT: callers remove ONLY the explicitly enumerated state
// artifacts below (the fixed `KEIKO_STATE_FILES` plus the launcher's
// `.launcher-state-*` mkdtemp dirs) and then rmdir the state directory when it is
// empty. Nothing here recursively deletes an arbitrary directory, so a mis-pointed
// `--state-dir`/KEIKO_STATE_DIR can never escalate into data loss outside Keiko's
// own files.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

export const DEFAULT_STATE_DIR_NAME = ".keiko";

// Runtime files Keiko writes under the state dir. `ui.pid`/`ui.log` come from
// `lifecycle.ts`; `launcher-state.json` from `launcher-state.ts`.
export const KEIKO_STATE_FILES = ["ui.pid", "ui.log", "launcher-state.json"] as const;

// `launcher-state.ts` writes ephemeral mkdtemp dirs with this prefix during atomic
// state saves; a crash can leave one behind, so uninstall/repair sweep them by prefix.
export const LAUNCHER_STATE_TMP_PREFIX = ".launcher-state-";

// Resolves the state directory the same way `keiko start` does. An explicit
// `--state-dir` argument wins, then `KEIKO_STATE_DIR`, then `<cwd>/.keiko`. Relative
// values resolve against `cwd`.
export function resolveStateDir(cwd: string, env: EnvSource, stateDirArg?: string): string {
  const value =
    stateDirArg !== undefined && stateDirArg.length > 0
      ? stateDirArg
      : (env.KEIKO_STATE_DIR ?? DEFAULT_STATE_DIR_NAME);
  return isAbsolute(value) ? value : resolve(cwd, value);
}

// Reads a pid file written by `lifecycle.ts`. Returns the integer pid, or undefined
// when the file is absent or does not contain a positive integer.
export function readPidFile(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  return Number(raw);
}

// Liveness probe identical in semantics to the lifecycle handler: a successful
// signal-0 means alive; an EPERM error means the process exists but is owned by
// another user (still alive); any other error means it is gone. Kept local to this
// leaf module so uninstall/repair do not pull in lifecycle's heavy spawn/net imports.
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export type PidState = "absent" | "stale" | "running";

export interface PidClassification {
  readonly state: PidState;
  readonly pid: number | undefined;
}

// Classifies the UI pid file: `absent` (missing or malformed), `stale` (a pid is
// recorded but the process is gone), or `running` (recorded and alive).
export function classifyPid(
  pidFilePath: string,
  isAlive: (pid: number) => boolean,
): PidClassification {
  const pid = readPidFile(pidFilePath);
  if (pid === undefined) return { state: "absent", pid: undefined };
  return isAlive(pid) ? { state: "running", pid } : { state: "stale", pid };
}
