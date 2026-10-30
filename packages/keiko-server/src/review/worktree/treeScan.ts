// Pre-checkout scan of a pull request head's tree (ADR-0182 D3, Issue #4133).
//
// Decided from the tree listing alone, before a single file is written:
// - more paths than the path cap, or more bytes than the materialization budget, refuse the
//   worktree as `tree-too-large`; a duplicate path (a malformed tree) refuses it;
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

export interface ReviewTreeLimits {
  /** Blobs above this size are excluded (`too-large`) rather than materialized. */
  readonly blobLimitBytes: number;
  /** More listed paths refuse the worktree (`tree-too-large`). */
  readonly maxPaths: number;
  /** Blobs within the per-file limit summing to more bytes refuse the worktree (`tree-too-large`). */
  readonly maxMaterializedBytes: number;
}

function withinBudget(entries: readonly GitReviewTreeEntry[], limits: ReviewTreeLimits): boolean {
  if (entries.length > limits.maxPaths) return false;
  let total = 0;
  for (const entry of entries) {
    const size = entry.type === "blob" ? (entry.size ?? 0) : 0;
    // Every path is written separately, so a blob reused by many paths counts once per path.
    if (size <= limits.blobLimitBytes) total += size;
    if (total > limits.maxMaterializedBytes) return false;
  }
  return true;
}

/**
 * The refusals decidable from the listing alone, checked BEFORE any blob is read or written:
 * the path and byte budget (a few kilobytes of reused subtrees would otherwise check out
 * gigabytes), duplicate paths (a malformed tree whose last entry would replace a skipped one),
 * undecodable names, and case or normalization collisions.
 */
export function preflightReviewTree(
  entries: readonly GitReviewTreeEntry[],
  limits: ReviewTreeLimits,
): ReviewWorktreeRefusalReason | undefined {
  if (!withinBudget(entries, limits)) return "tree-too-large";
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) return "checkout-failed";
  if (paths.some((path) => path.includes(REPLACEMENT_CHARACTER))) return "checkout-failed";
  return reviewTreeCollision(paths);
}

export function scanReviewTree(
  entries: readonly GitReviewTreeEntry[],
  binaryPaths: ReadonlySet<string>,
  limits: ReviewTreeLimits,
): ReviewTreeScan {
  const refusal = preflightReviewTree(entries, limits);
  if (refusal !== undefined) return { kind: "refused", reason: refusal };
  const skippedLarge: string[] = [];
  const skippedBinary: string[] = [];
  let materializedCount = 0;
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if ((entry.size ?? 0) > limits.blobLimitBytes) skippedLarge.push(entry.path);
    else if (binaryPaths.has(entry.path)) skippedBinary.push(entry.path);
    else materializedCount += 1;
  }
  return { kind: "accepted", materializedCount, skippedLarge, skippedBinary };
}
