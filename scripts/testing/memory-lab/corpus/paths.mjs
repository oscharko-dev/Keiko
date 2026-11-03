// Path guards shared by the lab runner and the corpus tools (#4207, #4208): generated mass and the
// sealed holdout live outside the checkout, so a path that resolves inside it is refused. The check
// follows symbolic links of the deepest existing ancestor; a link that points into the checkout, even
// a dangling one that `mkdir` would fill, must not smuggle an output directory back in.
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { REPO_ROOT } from "../../coding-workbench-lab/lab-common.mjs";

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// The real path of `path`, resolved through its deepest existing ancestor; undefined when a link on
// the way cannot be resolved.
function resolveThroughExistingAncestor(path) {
  const missing = [];
  let current = resolve(path);
  while (!exists(current) && dirname(current) !== current) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  try {
    return join(realpathSync(current), ...missing);
  } catch {
    return undefined;
  }
}

function isInside(root, path) {
  const relativePath = relative(root, path);
  return !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

// True when `path` resolves outside the checkout, links followed; an unresolvable link is not outside.
function outsideCheckout(path) {
  const real = resolveThroughExistingAncestor(path);
  return real !== undefined && !isInside(realpathSync(REPO_ROOT), real);
}

/** Resolves `path` and refuses one inside the checkout; `name` is the flag shown in the error. */
export function assertOutsideCheckout(path, name) {
  const absolute = resolve(path);
  if (!outsideCheckout(absolute)) throw new RangeError(`${name} must lie outside the checkout`);
  return absolute;
}
