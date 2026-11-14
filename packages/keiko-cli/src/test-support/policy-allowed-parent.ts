import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REAL_TMPDIR = realpathSync(tmpdir());

function pathInsideRepository(path: string): boolean {
  let cursor = path;
  for (;;) {
    if (existsSync(join(cursor, ".git"))) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

// Whether the current user may create entries in the directory, decided from its mode bits, so the
// answer needs no throwing probe. Where the host reports no user id (Windows) the directory is taken
// as writable, which is what the tests assumed everywhere before this helper existed.
function writableByCurrentUser(directory: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) return true;
  const stats = statSync(directory);
  if ((stats.mode & 0o002) !== 0) return true;
  if (stats.uid === uid && (stats.mode & 0o200) !== 0) return true;
  const groups = process.getgroups?.() ?? [];
  return (stats.mode & 0o020) !== 0 && groups.includes(stats.gid);
}

/**
 * The directory a policy-allowed portable root is created in: beside the working directory, outside
 * the temp directory and outside any repository, which the managed-root policy requires. Two hosts
 * have no such place and fall back to the home directory: a working directory whose parent is the
 * temp directory or a repository checkout (a worktree), and one whose parent the user may not write
 * to (the gates container checks the repository out at /repo, whose parent is the filesystem root).
 */
export function policyAllowedParent(): string {
  const cwdParent = dirname(process.cwd());
  const unusable =
    cwdParent.startsWith(REAL_TMPDIR) ||
    pathInsideRepository(cwdParent) ||
    !writableByCurrentUser(cwdParent);
  return unusable ? homedir() : cwdParent;
}
