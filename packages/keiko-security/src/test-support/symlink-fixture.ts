// Link fixtures for keiko-security suites that run on Windows hosts as well as POSIX ones (#4068).
//
// Creating a file or directory symlink on Windows needs SeCreateSymbolicLinkPrivilege (or Developer
// Mode); an ordinary account gets EPERM. These helpers keep the original link wherever the host
// allows it and turn only that missing Windows privilege into an explicit, reasoned skip of the
// calling test — never a silent pass. Directory redirections have a junction form that needs no
// privilege, so a Windows host still exercises the reparse boundary itself. This mirrors the
// keiko-server fixture of the same name, which this package may not import (ADR-0019 layering).

import { symlinkSync } from "node:fs";

import type { TestContext } from "vitest";

export const WINDOWS_HOST = process.platform === "win32";

export const WINDOWS_SYMLINK_SKIP =
  "Windows symlink privilege unavailable on this host; junction controls run separately";

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  return WINDOWS_HOST && error instanceof Error && Reflect.get(error, "code") === "EPERM";
}

/**
 * Plants `path -> target` exactly as `symlinkSync` would. Only the missing Windows privilege is
 * reported as a skip of the calling test; every other failure propagates.
 */
export function plantSymlinkOrSkip(
  context: TestContext,
  target: string,
  path: string,
  type?: "file" | "dir",
): void {
  try {
    symlinkSync(target, path, type);
  } catch (error) {
    if (isWindowsSymlinkPrivilegeError(error)) context.skip(WINDOWS_SYMLINK_SKIP);
    throw error;
  }
}

/**
 * A directory redirection every host can create: a junction on Windows (absolute target, no
 * privilege) and a directory symlink elsewhere, where the link type argument is ignored.
 */
export function plantDirectoryRedirect(absoluteTarget: string, path: string): void {
  symlinkSync(absoluteTarget, path, WINDOWS_HOST ? "junction" : "dir");
}
