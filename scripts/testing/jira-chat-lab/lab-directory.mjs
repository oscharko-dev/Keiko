// Lab data never lives in a temporary directory (#4369, owner rule): the system wipes it, and a
// session holds a Jira data volume reference, private tokens and run evidence. Refuses a path that
// resolves under a temporary root; the creation and fixture commands call it before touching disk.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";

const TEMPORARY_ROOTS = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];

/** The path with its deepest existing ancestor resolved, so a symlinked alias is seen through. */
function resolvedPath(path) {
  const absolute = resolve(path);
  const tail = [];
  let current = absolute;
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" || dirname(current) === current) return absolute;
      tail.push(current.slice(dirname(current).length + 1));
      current = dirname(current);
    }
  }
}

const under = (path, root) => path === root || path.startsWith(root + sep);

export function assertLabDirectoryOutsideTemporary(path, temporaryRoots = defaultRoots()) {
  const target = resolvedPath(path);
  const roots = temporaryRoots.flatMap((root) => [resolve(root), resolvedPath(root)]);
  if (roots.some((root) => under(target, root)))
    throw new TypeError("Lab data must not live in a temporary directory");
  return path;
}

function defaultRoots() {
  return [...TEMPORARY_ROOTS, tmpdir()];
}
