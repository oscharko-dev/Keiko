import { lstatSync, statSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, normalize, parse } from "node:path";
import type { UiStore } from "../store/types.js";

/**
 * True for an absolute, normalized directory whose every path segment is a real directory (no
 * symbolic link or reparse point). Shared by the Local checkout and the folder workspace so both
 * bind exactly the directory the operator registered.
 */
export function isCanonicalLocalRoot(root: string): boolean {
  if (!isAbsolute(root) || normalize(root) !== root) return false;
  let current = parse(root).root;
  for (const segment of root
    .slice(current.length)
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) return false;
  }
  return statSync(root).isDirectory();
}

// The closed results that say the selected root does not name a reachable directory right now.
// Any other failure is not an answer about that root and propagates.
const UNREACHABLE_PATH_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ELOOP",
  "ENAMETOOLONG",
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * The selected root propagates an unexpected failure. A registration never does: an offline
 * network drive or a removed folder among the person's registrations is not this request's
 * directory, so it matches nothing and the request is decided by the others. The outcome stays
 * closed either way, because an unreadable registration can only fail to match.
 */
type IdentityFailure = "propagate" | "no-match";

function directoryIdentity(path: string, onFailure: IdentityFailure): BigIntStats | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    // A zero device or file id is a filesystem that cannot name the directory (FAT, some network
    // shares on Windows); identity proves nothing there, so only the exact spelling can match.
    return stats.isDirectory() && stats.dev !== 0n && stats.ino !== 0n ? stats : undefined;
  } catch (error) {
    if (onFailure === "no-match") return undefined;
    const code = errorCode(error);
    if (code !== undefined && UNREACHABLE_PATH_CODES.has(code)) return undefined;
    throw error;
  }
}

/**
 * True when `root` (the native real path the route resolved) is a directory the operator
 * registered. A registration is the same directory when its spelling matches exactly or when it
 * resolves to the same device and file id: Windows keeps the spelling a person typed or a dialog
 * returned (drive-letter case, 8.3 short names, a mapped or `subst` drive, a junction), while the
 * route always passes the native real path, so string equality alone refused registered checkouts
 * (#4404). Identity, not spelling, is the boundary; `isCanonicalLocalRoot` still decides whether
 * the resolved directory may be bound at all.
 */
export function isRegisteredLocalRoot(store: Pick<UiStore, "listProjects">, root: string): boolean {
  const projectPaths = store.listProjects().map((project) => project.path);
  if (projectPaths.includes(root)) return true;
  // Only the native real path the route resolved may be matched by identity; any other spelling
  // of the selected root stays an unregistered request, exactly as before.
  if (!isAbsolute(root) || normalize(root) !== root) return false;
  const rootIdentity = directoryIdentity(root, "propagate");
  if (rootIdentity === undefined) return false;
  return projectPaths.some((path) => {
    const identity = directoryIdentity(path, "no-match");
    return identity?.dev === rootIdentity.dev && identity.ino === rootIdentity.ino;
  });
}
