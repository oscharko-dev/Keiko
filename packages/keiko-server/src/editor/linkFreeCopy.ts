// The one copy of a workspace into a disposable root that every sandboxed copy uses: the assured
// pre-filter's mutation-testing root (#4429) and the private execution root of a Windows step
// (#4496). It skips every link (a symbolic link or, on Windows, a directory junction) instead of
// copying it. Node's `cpSync` copies a link differently by path and platform: its native copy turns
// a junction into a real directory holding the target's files, which copies outside content into the
// sandbox; the filtered copy re-creates it as an absolute link out of the root, EPERM without the
// symbolic-link privilege. `lstat` classifies a junction like a symbolic link, so the filter skips
// each link before `cpSync` acts on it, on every platform; an entry that vanished mid-copy throws.

import { cpSync, lstatSync } from "node:fs";

export interface LinkFreeCopyCounts {
  readonly copiedEntryCount: number;
  readonly skippedLinkCount: number;
  /** Entries the caller's exclusion left out, a directory counted once for all it holds. */
  readonly excludedEntryCount: number;
}

/** Copies `realRoot` into `root` without links and without what `excluded` names. */
export function copyWithoutLinks(
  realRoot: string,
  root: string,
  excluded: (source: string) => boolean,
): LinkFreeCopyCounts {
  let copiedEntryCount = 0;
  let skippedLinkCount = 0;
  let excludedEntryCount = 0;
  cpSync(realRoot, root, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      if (source !== realRoot && excluded(source)) {
        excludedEntryCount += 1;
        return false;
      }
      if (lstatSync(source).isSymbolicLink()) {
        skippedLinkCount += 1;
        return false;
      }
      copiedEntryCount += 1;
      return true;
    },
  });
  return { copiedEntryCount, skippedLinkCount, excludedEntryCount };
}
