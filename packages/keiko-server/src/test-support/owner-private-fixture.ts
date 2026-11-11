// Owner-private fixtures for suites that run on Windows hosts as well as POSIX ones (#4068).
//
// On POSIX a file is owner-private when its mode grants nobody else write access. On Windows the
// answer comes from its security descriptor, and an inherited ACL may already grant other local
// accounts Modify (a profile or a non-system drive often does). A fixture that means "owner-private"
// therefore sets it explicitly on both hosts, and one that means "others may write" grants that
// explicitly. icacls is given SIDs only, so no localized account name is involved.
// Shared fixture modules live under `src/test-support/` (KEIKO-0130): outside the build, coverage
// and Sonar scope.

import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { resolveWindowsSystemBinary } from "@oscharko-dev/keiko-security";

const WINDOWS_HOST = process.platform === "win32";
const EVERYONE = "S-1-1-0";

// System binaries come from the identity-validated System32, never from a raw SystemRoot read.
function icacls(path: string, args: readonly string[]): void {
  const result = spawnSync(resolveWindowsSystemBinary("icacls.exe"), [path, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("icacls fixture setup failed");
}

let userSid: string | undefined;

function currentUserSid(): string {
  userSid ??= queryUserSid();
  return userSid;
}

function queryUserSid(): string {
  const result = spawnSync(
    resolveWindowsSystemBinary("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  const sid = /"(S-1-[\d-]+)"\s*$/u.exec(result.stdout.trim())?.[1];
  if (result.status !== 0 || sid === undefined) throw new Error("current user SID unavailable");
  return sid;
}

/** Owner-private: POSIX 0o600; Windows a protected DACL for the user, SYSTEM and Administrators. */
export function makeOwnerPrivate(path: string): void {
  if (!WINDOWS_HOST) {
    chmodSync(path, 0o600);
    return;
  }
  // /reset drops explicit entries (such as a grant from grantOthersWrite) before the protected DACL.
  icacls(path, ["/reset"]);
  icacls(path, [
    "/inheritance:r",
    "/grant:r",
    `*${currentUserSid()}:(F)`,
    "*S-1-5-18:(F)",
    "*S-1-5-32-544:(F)",
  ]);
}

/**
 * A fixture root whose new files are owner-private: POSIX 0o700 (files keep their own 0o600 mode);
 * Windows a protected, inheritable DACL for the user, SYSTEM and Administrators.
 */
export function makeOwnerPrivateDirectory(path: string): void {
  if (!WINDOWS_HOST) {
    chmodSync(path, 0o700);
    return;
  }
  icacls(path, [
    "/inheritance:r",
    "/grant:r",
    `*${currentUserSid()}:(OI)(CI)(F)`,
    "*S-1-5-18:(OI)(CI)(F)",
    "*S-1-5-32-544:(OI)(CI)(F)",
  ]);
}

/** Writable by others: POSIX adds o+w to 0o600; Windows grants Everyone write. */
export function grantOthersWrite(path: string): void {
  if (!WINDOWS_HOST) {
    chmodSync(path, 0o602);
    return;
  }
  icacls(path, ["/grant", `*${EVERYONE}:(W)`]);
}
