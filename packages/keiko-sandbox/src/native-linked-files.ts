import { lstatSync, readdirSync, type Dirent, type Stats } from "node:fs";
import { join, relative } from "node:path";

// A pathname names exactly one file only while that file has one link (PR #4064 review, #3900
// AC2/AC5). A hard link inside the workspace or an accepted external reference can alias a file
// outside every admitted root, and no path rule the kernel evaluates tells the two names apart:
// the workspace name is inside the allowlist, so every reader the runtime starts (its search, its
// read tool, a shell child) would load the outside file's bytes. The kernel already refuses the run
// every new link to a file it may not read, so such an alias can only predate the run. One scan
// before the launch therefore names every one of them, and the native Seatbelt profile denies
// their contents (`linkedFiles` in the filesystem plan). Nothing here depends on which tools the
// runtime has or how it calls them.

/** The most linked files one native profile denies; a larger set refuses the launch. */
export const NATIVE_LINKED_FILES_MAX = 1_024;
/** The most directory entries one scan visits; a larger tree refuses the launch. */
export const NATIVE_LINKED_FILE_SCAN_ENTRIES_MAX = 2_000_000;

export type NativeLinkedFileScan =
  | {
      readonly outcome: "complete";
      /** Absolute paths of the regular files with more than one link, sorted. */
      readonly linkedFiles: readonly string[];
      readonly scannedFileCount: number;
      /** Of those, files named like Git objects (a local clone's shared objects); denied too. */
      readonly gitObjectLinkCount: number;
    }
  | {
      /** `excessive`: more linked files than one profile denies; `incomplete`: the tree exceeds the walk. */
      readonly outcome: "excessive" | "incomplete";
      readonly scannedFileCount: number;
      readonly gitObjectLinkCount: number;
    };

export interface NativeLinkedFileScanLimits {
  readonly linkedFilesMax?: number | undefined;
  readonly entriesMax?: number | undefined;
}

// `git clone` of a local path hard-links the source repository's object files. A name and a mode
// prove nothing about whose file a link aliases: an outside read-only file linked under an object
// name would read as the object (PR #4064 review). Every linked file is therefore denied, these
// included; they are only counted apart, so the evidence explains a clone whose Git cannot read
// them. Such a clone works once its objects are its own (`git repack -a -d`, or a clone made with
// `--no-hardlinks`).
const GIT_OBJECTS_DIRECTORY = /(?:^|\/)\.git\/(?:[^/]+\/)*objects$/u;
const LOOSE_OBJECT = /^[0-9a-f]{2}\/[0-9a-f]{38,62}$/u;
const PACK_FILE = /^pack\/pack-[0-9a-f]{40,64}\.(?:pack|idx|rev|bitmap|keep|promisor|mtimes)$/u;

function namedLikeGitObject(root: string, path: string): boolean {
  const name = relative(root, path);
  const marker = name.lastIndexOf("objects/");
  if (marker < 0 || !GIT_OBJECTS_DIRECTORY.test(name.slice(0, marker + "objects".length)))
    return false;
  const object = name.slice(marker + "objects/".length);
  return LOOSE_OBJECT.test(object) || PACK_FILE.test(object);
}

// An entry that vanished, or a directory the server itself cannot open, is equally absent for the
// run, whose sandbox only ever narrows what the same user can read. Any other failure is unknown
// and propagates: the caller records it and refuses the launch.
const ABSENT_CODES: ReadonlySet<unknown> = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

function absent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ABSENT_CODES.has((error as { code?: unknown }).code)
  );
}

interface ScanState {
  readonly linked: string[];
  readonly entriesMax: number;
  entries: number;
  files: number;
  gitObjects: number;
}

function directoryEntries(directory: string): readonly Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
}

function linkStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
}

function inspectFile(root: string, path: string, state: ScanState): void {
  state.files += 1;
  const stat = linkStat(path);
  if (stat === undefined || !stat.isFile() || stat.nlink <= 1) return;
  state.linked.push(path);
  if (namedLikeGitObject(root, path)) state.gitObjects += 1;
}

// Symbolic links are not followed: the kernel resolves each one to its target's own path, which is
// either inside a scanned root or under the profile's ordinary rules.
function scanRoot(root: string, state: ScanState): void {
  const pending = [root];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    for (const entry of directoryEntries(directory)) {
      state.entries += 1;
      if (state.entries > state.entriesMax) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) inspectFile(root, path, state);
    }
  }
}

/**
 * Every regular file with more than one hard link below the given roots (the workspace and the
 * accepted external references of one native launch). The result is complete or says why not, and
 * an unknown filesystem failure throws; a caller never launches on a partial list.
 */
export function scanNativeLinkedFiles(
  roots: readonly string[],
  limits: NativeLinkedFileScanLimits = {},
): NativeLinkedFileScan {
  const state: ScanState = {
    linked: [],
    entriesMax: limits.entriesMax ?? NATIVE_LINKED_FILE_SCAN_ENTRIES_MAX,
    entries: 0,
    files: 0,
    gitObjects: 0,
  };
  for (const root of new Set(roots)) {
    scanRoot(root, state);
    if (state.entries > state.entriesMax) break;
  }
  const counts = { scannedFileCount: state.files, gitObjectLinkCount: state.gitObjects };
  if (state.entries > state.entriesMax) return { outcome: "incomplete", ...counts };
  if (state.linked.length > (limits.linkedFilesMax ?? NATIVE_LINKED_FILES_MAX))
    return { outcome: "excessive", ...counts };
  return { outcome: "complete", linkedFiles: [...state.linked].sort(compareStrings), ...counts };
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
