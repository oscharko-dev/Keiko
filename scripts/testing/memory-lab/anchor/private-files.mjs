// Local file handling shared by the anchor tooling (#4208). Real conversation text must never land
// inside a git work tree, where one `git add -A` could publish it, so every path the tooling reads or
// writes is resolved through symlinks and refused when it lies in this checkout or in any other work
// tree. Directories are created owner-private, files are written owner-private, and JSON that holds
// conversation text is parsed without ever quoting it in an error.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { REPO_ROOT } from "../../coding-workbench-lab/lab-common.mjs";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const MAX_LINK_DEPTH = 40;

// The deepest existing entry (a dangling link counts as existing) is resolved through symlinks and
// the missing tail appended, so a symlink cannot carry a path that looks external into the checkout.
// A dangling link is followed to where it points, because `mkdir` would create the directory there;
// a link that cannot be read at all is refused.
function resolveThroughSymlinks(path, flag, depth = 0) {
  const tail = [];
  let probe = resolve(path);
  while (!entryExists(probe) && dirname(probe) !== probe) {
    tail.unshift(basename(probe));
    probe = dirname(probe);
  }
  try {
    return join(realpathSync(probe), ...tail);
  } catch {
    if (depth >= MAX_LINK_DEPTH) throw new RangeError(`${flag} cannot be resolved (link chain)`);
    const target = resolve(dirname(probe), readLinkOrFail(probe, flag));
    return resolveThroughSymlinks(join(target, ...tail), flag, depth + 1);
  }
}

function readLinkOrFail(path, flag) {
  try {
    return readlinkSync(path);
  } catch {
    throw new RangeError(`${flag} cannot be resolved`);
  }
}

function isInside(parent, child) {
  const relativePath = relative(parent, child);
  if (relativePath === "") return true;
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

// A `.git` entry (directory, or the file a linked worktree carries) marks a work tree root.
function enclosingWorkTree(directory) {
  if (existsSync(join(directory, ".git"))) return directory;
  const parent = dirname(directory);
  return parent === directory ? undefined : enclosingWorkTree(parent);
}

/**
 * Resolves `path` and refuses it when it lies in this checkout or inside any git work tree (the main
 * checkout of a linked worktree included). Returns the resolved absolute path.
 */
export function assertOutsideCheckout(path, flag) {
  const resolved = resolveThroughSymlinks(path, flag);
  if (isInside(realpathSync(REPO_ROOT), resolved))
    throw new RangeError(`${flag} must lie outside the checkout`);
  if (enclosingWorkTree(resolved) !== undefined)
    throw new RangeError(`${flag} must lie outside every git work tree`);
  return resolved;
}

/** Creates a directory (and parents) readable by the owner only. */
export function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
}

/** Writes a file owner-private through a temporary sibling, so a crash never leaves half a file. */
export function writePrivateFile(path, data) {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, data, { mode: PRIVATE_FILE_MODE });
  renameSync(temporary, path);
}

/** Writes a new owner-private file and refuses to replace an existing one. */
export function writeNewPrivateFile(path, data) {
  writeFileSync(path, data, { mode: PRIVATE_FILE_MODE, flag: "wx" });
}

/**
 * Reads and parses a JSON file. A parse error of conversation data quotes the text it chokes on, so
 * the error thrown here names `what` and the error code only and deliberately keeps no cause.
 */
export function readJsonFile(path, what) {
  let failure;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failure = error?.code ?? error?.name ?? "error";
  }
  throw new Error(`${what} is not readable JSON (${String(failure)})`);
}
