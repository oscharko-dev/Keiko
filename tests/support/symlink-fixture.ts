// Link fixtures for package suites that run on Windows hosts as well as POSIX ones (#4068).
//
// Creating a file or directory symlink on Windows needs SeCreateSymbolicLinkPrivilege (or Developer
// Mode); an ordinary account gets EPERM. Planting the link in a shared fixture made every test using
// that fixture fail on such a host, including tests that never touch the link. These helpers keep
// the original link wherever the host allows it and turn only the missing Windows privilege into an
// explicit, reasoned skip of the calling test — never a silent pass. Directory escapes have a
// junction form that needs no privilege, so a Windows host still exercises the reparse boundary
// itself. One owner for every package's suites, like the other modules in tests/support.

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
 * privilege) and a directory symlink elsewhere.
 */
export function plantDirectoryRedirect(absoluteTarget: string, path: string): void {
  symlinkSync(absoluteTarget, path, WINDOWS_HOST ? "junction" : "dir");
}

/**
 * The macOS seatbelt filesystem policy is defined over POSIX roots; a Windows host's temporary
 * directories cannot express them, so the policy is refused before any launch. That refusal is the
 * correct product behavior and is not a Windows qualification of the macOS path.
 */
export function skipSeatbeltRootsOnWindowsHost(context: TestContext): void {
  if (WINDOWS_HOST) {
    context.skip(
      "macOS seatbelt filesystem roots are POSIX paths; not expressible on a Windows host",
    );
  }
}
