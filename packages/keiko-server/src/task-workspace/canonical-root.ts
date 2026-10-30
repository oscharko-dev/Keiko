import { lstatSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, parse } from "node:path";

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
