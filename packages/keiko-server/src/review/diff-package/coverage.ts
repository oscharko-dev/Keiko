// Coverage assembly of the review diff package (ADR-0182 D6, Issue #4134).
//
// Every changed path lands in exactly one list with its closed reason; the lists are ordered by
// the stored path bytes, so the coverage is identical on every platform and in every locale.

import type {
  ReviewDiffCoverage,
  ReviewDiffFileRef,
  ReviewDiffFilterReason,
  ReviewDiffIncludedFile,
  ReviewDiffUnprocessedReason,
} from "@oscharko-dev/keiko-contracts";
import type { ReviewDiffChangedFile } from "./classify.js";
import { compareReviewPathBytes } from "./paths.js";

type SimpleList = "deletedOnly" | "binary" | "submodule" | "symlink" | "modeOnly";

interface Entry<T> {
  readonly file: ReviewDiffChangedFile;
  readonly value: T;
}

export class ReviewDiffCoverageBuilder {
  private readonly included: Entry<ReviewDiffIncludedFile>[] = [];
  private readonly unprocessed: Entry<
    ReviewDiffFileRef & { reason: ReviewDiffUnprocessedReason }
  >[] = [];
  private readonly filtered: Entry<ReviewDiffFileRef & { reason: ReviewDiffFilterReason }>[] = [];
  private readonly simple: Record<SimpleList, Entry<ReviewDiffFileRef>[]> = {
    deletedOnly: [],
    binary: [],
    submodule: [],
    symlink: [],
    modeOnly: [],
  };

  public add(list: SimpleList, file: ReviewDiffChangedFile): void {
    this.simple[list].push({ file, value: file.ref });
  }

  public addFiltered(file: ReviewDiffChangedFile, reason: ReviewDiffFilterReason): void {
    this.filtered.push({ file, value: { ...file.ref, reason } });
  }

  public addUnprocessed(file: ReviewDiffChangedFile, reason: ReviewDiffUnprocessedReason): void {
    this.unprocessed.push({ file, value: { ...file.ref, reason } });
  }

  public addIncluded(
    file: ReviewDiffChangedFile,
    hunkCount: number,
    includedHunkCount: number,
  ): ReviewDiffIncludedFile {
    const value = {
      ...file.ref,
      hunkCount,
      includedHunkCount,
      partial: includedHunkCount < hunkCount,
    };
    this.included.push({ file, value });
    return value;
  }

  public build(budgetTokens: number, usedTokens: number): ReviewDiffCoverage {
    const included = sorted(this.included);
    const unprocessed = sorted(this.unprocessed);
    const all = [
      ...this.included,
      ...this.unprocessed,
      ...this.filtered,
      ...Object.values(this.simple).flat(),
    ];
    return {
      included,
      unprocessed,
      deletedOnly: sorted(this.simple.deletedOnly),
      filtered: sorted(this.filtered),
      binary: sorted(this.simple.binary),
      submodule: sorted(this.simple.submodule),
      symlink: sorted(this.simple.symlink),
      modeOnly: sorted(this.simple.modeOnly),
      summary: {
        changedFiles: all.length,
        reviewedFiles: included.filter((file) => !file.partial).length,
        partiallyReviewedFiles: included.filter((file) => file.partial).length,
        unprocessedFiles: unprocessed.length,
        addedLines: all.reduce((sum, entry) => sum + entry.file.ref.addedLines, 0),
        removedLines: all.reduce((sum, entry) => sum + entry.file.ref.removedLines, 0),
        budgetTokens,
        usedTokens,
      },
    };
  }
}

function sorted<T>(entries: readonly Entry<T>[]): T[] {
  return [...entries]
    .sort((left, right) => compareReviewPathBytes(left.file.change.path, right.file.change.path))
    .map((entry) => entry.value);
}
