// Link fixtures for suites that run on Windows hosts as well as POSIX ones (#4068 W5/W7).
//
// Creating a file symlink on Windows needs SeCreateSymbolicLinkPrivilege (or Developer Mode); an
// ordinary account gets EPERM. Planting the link in a shared fixture made every test using that
// fixture fail on such a host, including tests that never touch the link. These helpers keep the
// original link wherever the host allows it and turn only the missing Windows privilege into an
// explicit, reasoned skip — never a silent pass. Directory escapes have a junction form that needs
// no privilege, so a Windows host still exercises the reparse boundary itself. `.test-support.ts`
// is the package's name for a shared fixture module; the coverage inventory excludes the suffix.

import { symlinkSync } from "node:fs";

import type { TestContext } from "vitest";

export const WINDOWS_HOST = process.platform === "win32";

export const WINDOWS_FILE_SYMLINK_SKIP =
  "Windows file-symlink privilege unavailable on this host; junction controls run separately";

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  return WINDOWS_HOST && error instanceof Error && Reflect.get(error, "code") === "EPERM";
}

/**
 * Plants `path -> target` with the platform's own link type. Only the missing Windows privilege is
 * reported as a skip of the calling test; every other failure propagates.
 */
export function plantSymlinkOrSkip(
  context: TestContext,
  target: string,
  path: string,
  type: "file" | "dir" = "file",
): void {
  try {
    symlinkSync(target, path, type);
  } catch (error) {
    if (isWindowsSymlinkPrivilegeError(error)) context.skip(WINDOWS_FILE_SYMLINK_SKIP);
    throw error;
  }
}

/**
 * A directory redirection every host can create: a junction on Windows (absolute target, no
 * privilege) and a directory symlink elsewhere.
 */
export function plantDirectoryRedirect(absoluteTarget: string, path: string): void {
  symlinkSync(absoluteTarget, path, WINDOWS_HOST ? "junction" : "dir");
}
