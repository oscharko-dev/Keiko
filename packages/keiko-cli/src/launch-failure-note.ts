import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, win32 } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

/**
 * The closed reasons a `portable launch` can end non-zero (#4358). One vocabulary serves the failure
 * note the native launcher reads and the registered activity-log line, so the person's box and the
 * support report name the same cause.
 */
export const LAUNCH_FAILURE_REASONS = [
  "port-in-use",
  "stale-shutdown-request",
  "invalid-launch-id",
  "missing-child-pid",
  "pid-publication",
  "state-dir",
  "spawn-refused",
  "health-timeout",
  "process-exited",
  "identity-mismatch",
  "stop-failed",
  "browser-handoff",
  "native-runtime-unverified",
  "native-ownership",
  "lifecycle-busy",
  "setup-busy",
  "setup-failed",
  "recovery-required",
  "registration-invalid",
  "upgrade-failed",
  "macos-activation",
  "launch-error",
  "fatal",
] as const;

export type LaunchFailureReason = (typeof LAUNCH_FAILURE_REASONS)[number];

/** The environment variable the Windows launcher sets to the file it reads the reason from. */
export const LAUNCH_FAILURE_NOTE_ENV = "KEIKO_PORTABLE_FAILURE_NOTE";

const NOTE_FILE_NAME = /^keiko-launch-note-\d{1,10}\.txt$/u;

// The launcher names its note inside the user's temporary directory (GetTempPathW) and the CLI
// resolves the same directory (os.tmpdir): the note path is honored only there, compared by real
// path so that a short (8.3) spelling of the same folder is accepted and a link elsewhere is not.
function inTemporaryDirectory(path: string): boolean {
  const parent = dirname(path);
  const temporary = tmpdir();
  if (!existsSync(parent) || !existsSync(temporary)) return false;
  const left = realpathSync.native(parent);
  const right = realpathSync.native(temporary);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Leaves the closed reason token for the native launcher, which shows its own fixed text for it.
 * Only a start the launcher itself began (`KEIKO_PORTABLE_UI_LAUNCH=1`) with a note path of exactly
 * its own shape is honored, and the file is created exclusively: the launcher removed any earlier
 * one before it started this child, so an existing file is never overwritten. Only the token is
 * written, never a message. Throws when the note was requested and cannot be written: the launcher
 * then shows its generic text, and the caller records that rather than hiding it.
 */
export function writeLaunchFailureNote(
  env: EnvSource,
  reason: LaunchFailureReason,
): "written" | "not-requested" {
  const path = env[LAUNCH_FAILURE_NOTE_ENV];
  if (env.KEIKO_PORTABLE_UI_LAUNCH !== "1" || path === undefined || path === "") {
    return "not-requested";
  }
  if (
    path.split(/[\\/]/u).includes("..") ||
    !(isAbsolute(path) || win32.isAbsolute(path)) ||
    !NOTE_FILE_NAME.test(basename(path.replaceAll("\\", "/"))) ||
    !inTemporaryDirectory(path)
  ) {
    throw new Error("launch failure note path is not the launcher's own");
  }
  writeFileSync(path, reason, { flag: "wx", mode: 0o600 });
  return "written";
}
