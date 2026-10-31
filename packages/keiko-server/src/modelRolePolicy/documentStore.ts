// The shared persistence of model-policy documents (Issue #4137): a JSON document in a directory
// Keiko owns, published atomically with `atomicPublishRename`. Quality Intelligence keeps its policy
// in `quality-intelligence/model-policy.json`; Keiko for Quality keeps one review settings document
// per repository in `review-settings/`. The directory must be a real, non-redirected directory
// inside its parent, and the document a regular file; anything else is refused through the
// caller's own error, never followed.

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { atomicPublishRename } from "@oscharko-dev/keiko-security/fs-atomic-rename";

export interface OwnedDocumentLocation {
  readonly dir: string;
  readonly target: string;
}

export interface OwnedDocumentPlace {
  /** The real (already resolved) directory the document directory lives in. */
  readonly parent: string;
  readonly dirName: string;
  readonly fileName: string;
  /** The caller's own refusal for an unsafe directory or document. */
  readonly unsafe: () => Error;
}

function sameNativePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathIsContained(realRoot: string, candidate: string): boolean {
  const root = resolve(realRoot);
  const target = resolve(candidate);
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The document's location, or `undefined` when its directory does not exist and `create` is off.
 * Throws the caller's `unsafe()` error for a symbolic link, a non-directory or a redirected path.
 */
export function locateOwnedDocument(
  place: OwnedDocumentPlace,
  options: { readonly create: boolean },
): OwnedDocumentLocation | undefined {
  const dir = join(place.parent, place.dirName);
  if (options.create) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const dirStats = lstatSync(dir, { throwIfNoEntry: false });
  if (dirStats === undefined) return undefined;
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
    throw place.unsafe();
  }
  const realDir = realpathSync(dir);
  if (!sameNativePath(dir, realDir) || !pathIsContained(place.parent, realDir)) {
    throw place.unsafe();
  }
  return { dir: realDir, target: join(realDir, place.fileName) };
}

/** Whether the document exists; a symbolic link or a non-file in its place is unsafe. */
export function ownedDocumentExists(target: string, unsafe: () => Error): boolean {
  const stats = lstatSync(target, { throwIfNoEntry: false });
  if (stats === undefined) return false;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw unsafe();
  }
  return true;
}

/** Reads and parses the document; `undefined` when it does not exist. JSON errors propagate. */
export function readOwnedJsonDocument(
  location: OwnedDocumentLocation,
  unsafe: () => Error,
): unknown {
  if (!ownedDocumentExists(location.target, unsafe)) return undefined;
  return JSON.parse(readFileSync(location.target, "utf8")) as unknown;
}

/**
 * Writes the document to an exclusive temporary file beside it and publishes it with one atomic
 * rename, so a reader sees either the previous or the new document, never a partial one.
 */
export function publishOwnedJsonDocument(
  location: OwnedDocumentLocation,
  value: unknown,
  unsafe: () => Error,
  mode?: number,
): void {
  const temp = `${location.target}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
    const tempStats = lstatSync(temp);
    if (tempStats.isSymbolicLink() || !tempStats.isFile()) {
      throw unsafe();
    }
    atomicPublishRename(temp, location.target, { rename: renameSync });
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
