// Pre-checkout scan of a pull request head's tree (ADR-0182 D3, Issue #4133).
//
// Decided from the tree listing alone, before a single file is written:
// - two paths (or directory prefixes) that differ only by Unicode normalization, or only by case
//   after normalization, would merge on a case-insensitive or normalizing file system and let one
//   entry overwrite another; the worktree is refused with the closed detail;
// - a path Git reported in bytes that are not UTF-8 cannot be named exactly to the checkout, so the
//   worktree is refused rather than risk materializing a file Keiko meant to skip;
// - blobs above the blob limit and blobs Git classifies as binary are not materialized.
// The same decision is made on every platform, so a review behaves identically on macOS, Linux
// and Windows.

import type { ReviewWorktreeRefusalReason } from "@oscharko-dev/keiko-contracts";
import type { GitReviewTreeEntry } from "@oscharko-dev/keiko-git";

export type ReviewTreeScan =
  | {
      readonly kind: "accepted";
      readonly materializedCount: number;
      readonly skippedLarge: readonly string[];
      readonly skippedBinary: readonly string[];
    }
  | { readonly kind: "refused"; readonly reason: ReviewWorktreeRefusalReason };

const REPLACEMENT_CHARACTER = "\uFFFD";

function caseFold(value: string): string {
  // Upper-then-lower approximates full case folding (`ß` → `ss`, Kelvin sign → `k`) the way
  // case-insensitive file systems compare names; NFC again because case mapping can denormalize.
  return value.toUpperCase().toLowerCase().normalize("NFC");
}

function* pathPrefixes(path: string): Generator<string> {
  let index = path.indexOf("/");
  while (index !== -1) {
    yield path.slice(0, index);
    index = path.indexOf("/", index + 1);
  }
  yield path;
}

function addSpelling(map: Map<string, string>, key: string, spelling: string): boolean {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, spelling);
    return false;
  }
  return existing !== spelling;
}

/** The first collision among the listed paths and their directory prefixes, if any. */
export function reviewTreeCollision(
  paths: readonly string[],
): "case-collision" | "normalization-collision" | undefined {
  const byNormalized = new Map<string, string>();
  const byFolded = new Map<string, string>();
  for (const path of paths) {
    for (const prefix of pathPrefixes(path)) {
      const normalized = prefix.normalize("NFC");
      if (addSpelling(byNormalized, normalized, prefix)) return "normalization-collision";
      if (addSpelling(byFolded, caseFold(normalized), normalized)) return "case-collision";
    }
  }
  return undefined;
}

export function scanReviewTree(
  entries: readonly GitReviewTreeEntry[],
  binaryPaths: ReadonlySet<string>,
  blobLimitBytes: number,
): ReviewTreeScan {
  const paths = entries.map((entry) => entry.path);
  if (paths.some((path) => path.includes(REPLACEMENT_CHARACTER))) {
    return { kind: "refused", reason: "checkout-failed" };
  }
  const collision = reviewTreeCollision(paths);
  if (collision !== undefined) return { kind: "refused", reason: collision };
  const skippedLarge: string[] = [];
  const skippedBinary: string[] = [];
  let materializedCount = 0;
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if ((entry.size ?? 0) > blobLimitBytes) skippedLarge.push(entry.path);
    else if (binaryPaths.has(entry.path)) skippedBinary.push(entry.path);
    else materializedCount += 1;
  }
  return { kind: "accepted", materializedCount, skippedLarge, skippedBinary };
}

const ATTRIBUTE_FILE = /(?:^|\/)\.gitattributes$/u;
const FILTER_ATTRIBUTE = /(?:^|\s)filter=(\S+)/gu;

export function isGitAttributesPath(path: string): boolean {
  return ATTRIBUTE_FILE.test(path);
}

/** Filter driver names an attributes file assigns (`filter=<name>`), comments ignored. */
export function filterDriversInAttributes(content: string): readonly string[] {
  const names = new Set<string>();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    for (const match of trimmed.matchAll(FILTER_ATTRIBUTE)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return [...names];
}
