import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  OwnerPrivateFileRefused,
  ownerPrivateReaderFor,
  type OwnerPrivateReader,
} from "../ownerPrivateStateFile.js";

/**
 * An npm plugin package the operator installed locally (#3903 AC2): the runtime's own `plugin add`
 * installs from the registry, which leaves the machine and stays refused, so the operator installs
 * the package into a directory of their own (`npm install --prefix <dir> <package>`) and registers
 * the directory, its entry module and the SHA-256 of the whole tree. The digest is the one the
 * operator can compute with standard tools, in the directory:
 *
 *   find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256
 *
 * that is, the SHA-256 of the `shasum` listing (`<hex>  ./<path>\n` per regular file, in byte order
 * of the path). Links and other non-regular entries are neither hashed nor copied, as `find -type f`
 * skips them. Every file is read once through the owner-private reader, and the bytes hashed are the
 * bytes copied, so a tree that changed between the two cannot load.
 */
export const PLUGIN_PACKAGE_MAX_FILES = 4_096;
export const PLUGIN_PACKAGE_MAX_BYTES = 33_554_432;
const PLUGIN_PACKAGE_MAX_DEPTH = 32;

export interface PluginPackageFile {
  /** Relative to the package directory, `/`-separated. */
  readonly path: string;
  readonly bytes: Buffer;
}

export type PluginPackageRead =
  | { readonly ok: true; readonly files: readonly PluginPackageFile[]; readonly sha256: string }
  | { readonly ok: false; readonly reason: WalkRefusal | "entry-missing" };

interface Walk {
  readonly paths: string[];
  readonly files: PluginPackageFile[];
  bytes: number;
}

export function readPluginPackage(root: string, entry: string): PluginPackageRead {
  const walk: Walk = { paths: [], files: [], bytes: 0 };
  const listed = walkDirectory(root, "", 0, walk);
  const refusal = readListedFiles(root, walk) ?? listed;
  if (refusal !== undefined) return { ok: false, reason: refusal };
  if (!walk.files.some((file) => file.path === entry))
    return { ok: false, reason: "entry-missing" };
  return { ok: true, files: walk.files, sha256: pluginPackageDigest(walk.files) };
}

/** Why a walk stopped: the tree cannot be listed plainly, or it exceeds the package bounds. */
type WalkRefusal = "unreadable" | "too-large";

// `find -type f`: regular files at any depth, never through a link.
function walkDirectory(
  root: string,
  relative: string,
  depth: number,
  walk: Walk,
): WalkRefusal | undefined {
  if (depth > PLUGIN_PACKAGE_MAX_DEPTH) return "too-large";
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    // `shasum` escapes a name with a backslash or a line break; such a tree has no plain listing.
    if (/[\\\n\r]/u.test(entry.name)) return "unreadable";
    const refusal = walkEntry(root, path, depth, entry, walk);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

// A directory recurses; a regular file is listed; anything else (a link, a device) is skipped, as
// `find -type f` skips it.
function walkEntry(
  root: string,
  path: string,
  depth: number,
  entry: { readonly isDirectory: () => boolean; readonly isFile: () => boolean },
  walk: Walk,
): WalkRefusal | undefined {
  if (entry.isDirectory()) return walkDirectory(root, path, depth + 1, walk);
  return entry.isFile() ? listFile(path, walk) : undefined;
}

function listFile(path: string, walk: Walk): WalkRefusal | undefined {
  if (walk.paths.length >= PLUGIN_PACKAGE_MAX_FILES) return "too-large";
  walk.paths.push(path);
  return undefined;
}

// The listing is complete up to its first refusal; the files listed before it are read in walk
// order, so the first refusal in that order still wins. One owner-private reader covers the whole
// tree, so Windows inspects it with one process instead of one per file (#4068).
function readListedFiles(root: string, walk: Walk): WalkRefusal | undefined {
  const reader = ownerPrivateReaderFor(walk.paths.map((path) => join(root, path)));
  for (const path of walk.paths) {
    const refusal = readFile(reader, root, path, walk);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

function readFile(
  reader: OwnerPrivateReader,
  root: string,
  path: string,
  walk: Walk,
): WalkRefusal | undefined {
  try {
    const bytes = reader.read(join(root, path), PLUGIN_PACKAGE_MAX_BYTES - walk.bytes);
    if (bytes === undefined) return "unreadable";
    walk.bytes += bytes.length;
    walk.files.push({ path, bytes });
    return undefined;
  } catch (error) {
    if (error instanceof OwnerPrivateFileRefused)
      return error.reason === "too-large" ? "too-large" : "unreadable";
    throw error;
  }
}

/** The SHA-256 of the `shasum -a 256` listing of the tree, in byte order of `./<path>`. */
export function pluginPackageDigest(files: readonly PluginPackageFile[]): string {
  const listing = files
    .map((file) => ({ path: Buffer.from(`./${file.path}`, "utf8"), bytes: file.bytes }))
    .sort((left, right) => Buffer.compare(left.path, right.path))
    .map(
      ({ path, bytes }) =>
        `${createHash("sha256").update(bytes).digest("hex")}  ${path.toString("utf8")}\n`,
    )
    .join("");
  return createHash("sha256").update(listing, "utf8").digest("hex");
}

/** Writes the tree below `target`, owner-private, exclusive: nothing already there is replaced. */
export function writePluginPackage(target: string, files: readonly PluginPackageFile[]): void {
  for (const file of files) {
    const destination = join(target, file.path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, file.bytes, { mode: 0o600, flag: "wx" });
    chmodSync(destination, 0o600);
  }
}
