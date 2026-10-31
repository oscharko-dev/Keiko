import { existsSync, mkdtempSync, realpathSync } from "node:fs";
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

/**
 * Creates a directory the portable root policy admits. It sits beside the working directory when
 * that parent is not the filesystem root, the temporary directory or inside a repository, and in
 * the home directory otherwise. The new path is pushed onto `roots`, which the caller removes.
 */
export function policyAllowedRoot(prefix: string, roots: string[]): string {
  const cwdParent = dirname(process.cwd());
  const parent =
    cwdParent === dirname(cwdParent) ||
    cwdParent.startsWith(REAL_TMPDIR) ||
    pathInsideRepository(cwdParent)
      ? homedir()
      : cwdParent;
  const root = mkdtempSync(join(parent, prefix));
  roots.push(root);
  return root;
}
