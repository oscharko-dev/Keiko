// Git object reads of the review diff package (Issue #4134).
//
// Every read names objects by id through the hardened review runner: no path, pathspec, working
// tree, index or attribute file is involved, so a hostile name cannot reach an argument and the
// result is the same in any checkout. A step whose failure would leave the package unsound fails
// the whole package; a single file's own timeout or byte cap only makes that file unprocessed.

import type {
  PatchHunk,
  ReviewDiffLanguage,
  ReviewDiffUnprocessedReason,
} from "@oscharko-dev/keiko-contracts";
import { REVIEW_DIFF_LANGUAGES } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import {
  parseUnifiedDiff,
  PatchParseError,
} from "@oscharko-dev/keiko-contracts/runtime/unified-diff";
import {
  diffGitReviewBlobs,
  listGitReviewTree,
  readGitReviewBlob,
  readGitReviewBlobPrefix,
  readGitReviewObjectSizes,
  type GitProcessResult,
  type GitReviewChange,
  type GitReviewOperationContext,
} from "@oscharko-dev/keiko-git";
import type { ReviewDiffChangedFile } from "./classify.js";
import {
  gitFailed,
  isReviewDiffCapCut,
  reviewDiffStepFailure,
  type ReviewDiffPackagingAbort,
} from "./failure.js";
import { reviewDiffLanguage } from "./languages.js";
import { addedFileHunk, shapeReviewHunks, type ReviewDiffContextOptions } from "./hunks.js";

/** Git's own binary sniff: a NUL byte within the first 8,000 bytes. */
const BINARY_SNIFF_BYTES = 8_000;
const ZERO_OID = /^0+$/u;

export interface ReviewDiffReadContext {
  /** Listings and size reads, bounded by the listing byte cap. */
  readonly ctx: GitReviewOperationContext;
  /** One file's blob or patch, bounded by the per-file byte cap. */
  readonly fileCtx: GitReviewOperationContext;
  readonly cwd: string;
  readonly abort: ReviewDiffPackagingAbort;
}

function presentOids(change: GitReviewChange): readonly string[] {
  return [change.oldOid, change.newOid].filter((oid) => !ZERO_OID.test(oid));
}

async function hasNulPrefix(read: ReviewDiffReadContext, oid: string): Promise<boolean> {
  const prefix = await readGitReviewBlobPrefix(read.ctx, {
    cwd: read.cwd,
    oid,
    bytes: BINARY_SNIFF_BYTES,
  });
  if (!prefix.ok) throw reviewDiffStepFailure(prefix.result, read.abort, "listing-bytes");
  return prefix.value.includes("\u0000");
}

/**
 * Resolves Git's binary verdict without diffing a giant blob: a pair whose blobs are all within
 * the blob limit is `binary` (Git examined them); a pair with a larger blob is `binary` only when
 * such a blob's leading bytes hold a NUL byte, and `too-large` otherwise (a big text file must
 * never pass as an unreviewable binary).
 */
export async function resolveSizedFiles(
  read: ReviewDiffReadContext,
  files: readonly ReviewDiffChangedFile[],
  blobLimitBytes: number,
): Promise<ReadonlyMap<ReviewDiffChangedFile, "binary" | "too-large">> {
  const verdicts = new Map<ReviewDiffChangedFile, "binary" | "too-large">();
  const oids = [...new Set(files.flatMap((file) => presentOids(file.change)))];
  const sizes = await readGitReviewObjectSizes(read.ctx, { cwd: read.cwd, oids });
  if (!sizes.ok) throw reviewDiffStepFailure(sizes.result, read.abort, "listing-bytes");
  for (const file of files) {
    const large: string[] = [];
    for (const oid of presentOids(file.change)) {
      const info = sizes.value.get(oid);
      if (info?.type !== "blob") throw gitFailed();
      if (info.size > blobLimitBytes) large.push(oid);
    }
    let binary = large.length === 0;
    for (const oid of large) if (!binary) binary = await hasNulPrefix(read, oid);
    verdicts.set(file, binary ? "binary" : "too-large");
  }
  return verdicts;
}

/**
 * The repository's dominant languages, from the BASE commit's tree (the head cannot reorder the
 * review by adding files): recognized languages by total blob bytes, largest first, ties by name.
 * A tree too large to list falls back to the canonical language order.
 */
export async function dominantLanguages(
  read: ReviewDiffReadContext,
  baseSha: string,
): Promise<readonly ReviewDiffLanguage[]> {
  const listed = await listGitReviewTree(read.ctx, { cwd: read.cwd, sha: baseSha });
  if (!listed.ok) {
    if (isReviewDiffCapCut(listed.result)) return REVIEW_DIFF_LANGUAGES;
    throw reviewDiffStepFailure(listed.result, read.abort, "listing-bytes");
  }
  const bytes = new Map<ReviewDiffLanguage, number>();
  for (const entry of listed.value) {
    const language = reviewDiffLanguage(entry.path);
    if (entry.type !== "blob" || language === "other") continue;
    bytes.set(language, (bytes.get(language) ?? 0) + (entry.size ?? 0));
  }
  return [...bytes.entries()]
    .sort(([a, left], [b, right]) => right - left || (a < b ? -1 : 1))
    .map(([language]) => language);
}

export type ReviewDiffFileContent =
  | { readonly kind: "hunks"; readonly hunks: readonly PatchHunk[]; readonly bytes: number }
  | { readonly kind: "unprocessed"; readonly reason: ReviewDiffUnprocessedReason };

function fileOutcome(result: GitProcessResult, read: ReviewDiffReadContext): ReviewDiffFileContent {
  if (result.aborted === true || read.abort.signal.aborted) {
    throw reviewDiffStepFailure(result, read.abort, "patch-bytes");
  }
  if (result.timedOut === true) return { kind: "unprocessed", reason: "timeout" };
  if (isReviewDiffCapCut(result)) return { kind: "unprocessed", reason: "too-large" };
  throw gitFailed();
}

async function addedContent(
  read: ReviewDiffReadContext,
  change: GitReviewChange,
): Promise<ReviewDiffFileContent> {
  const blob = await readGitReviewBlob(read.fileCtx, { cwd: read.cwd, oid: change.newOid });
  if (!blob.ok) return fileOutcome(blob.result, read);
  const hunk = addedFileHunk(blob.value);
  const bytes = Buffer.byteLength(blob.value);
  return { kind: "hunks", hunks: hunk === undefined ? [] : [hunk], bytes };
}

function parsedHunks(patch: string): readonly PatchHunk[] {
  try {
    return parseUnifiedDiff(patch).files[0]?.hunks ?? [];
  } catch (error) {
    // Git's own patch must parse; one that does not is an untrustworthy read, never a skip.
    if (error instanceof PatchParseError) throw gitFailed();
    throw error;
  }
}

async function patchContent(
  read: ReviewDiffReadContext,
  file: ReviewDiffChangedFile,
  context: ReviewDiffContextOptions,
): Promise<ReviewDiffFileContent> {
  const { oldOid, newOid } = file.change;
  const contextLines = Math.max(context.before, context.after, context.dynamicMax);
  const patch = await diffGitReviewBlobs(read.fileCtx, {
    cwd: read.cwd,
    oldOid,
    newOid,
    contextLines,
  });
  if (!patch.ok) return fileOutcome(patch.result, read);
  const parsed = parsedHunks(patch.value);
  // Git counted changed lines for this pair, so a patch without hunks is not a trustworthy read.
  if (parsed.length === 0) throw gitFailed();
  const hunks = shapeReviewHunks(parsed, { ...context, language: file.ref.language });
  return { kind: "hunks", hunks, bytes: Buffer.byteLength(patch.value) };
}

/** The packaged hunks of one candidate file, or why it stays unprocessed. */
export function readCandidateContent(
  read: ReviewDiffReadContext,
  file: ReviewDiffChangedFile,
  context: ReviewDiffContextOptions,
): Promise<ReviewDiffFileContent> {
  if (file.placement.list !== "candidate" || file.placement.content === "empty") {
    return Promise.resolve({ kind: "hunks", hunks: [], bytes: 0 });
  }
  return file.placement.content === "added"
    ? addedContent(read, file.change)
    : patchContent(read, file, context);
}
