// Candidate ordering, content reads and budget packing of the review diff package (Issue #4134).
//
// The package has up to `maxParts` parts (Issue #4130), each within the budget, filled in priority
// order by `ReviewDiffPartPacker`: one Reviewer session reviews one part.
//
// Port of PR-Agent v0.49.0 (MIT) `sort_files_by_main_languages` and `pr_generate_compressed_diff`:
// files of the repository's dominant languages first, larger changes first within a language,
// then the stored path bytes for a total, platform-independent order. Contents are read in
// priority order in small parallel batches and only while the budget can still take a file: once
// `MAX_BUDGET_MISSES` files in a row did not fit whole, every later file is unprocessed for the
// budget without being read, so a change set far beyond the budget costs a bounded number of Git
// processes. Such files are reported exactly like any other file that did not fit.

import type { PatchHunk, ReviewDiffLanguage } from "@oscharko-dev/keiko-contracts";
import type { ReviewDiffChangedFile } from "./classify.js";
import type { ReviewDiffCoverageBuilder } from "./coverage.js";
import { throwIfReviewDiffStopped, tooLarge } from "./failure.js";
import type { ReviewDiffContextOptions } from "./hunks.js";
import { ReviewDiffPartPacker, type ReviewTokenCounter } from "./pack.js";
import { compareReviewPathBytes } from "./paths.js";
import {
  readCandidateContent,
  type ReviewDiffFileContent,
  type ReviewDiffReadContext,
} from "./reads.js";
import { renderReviewFileHeader, renderReviewHunk } from "./render.js";
import type { ReviewDiffPackageFile, ReviewDiffPackagePart } from "./types.js";

const READ_CONCURRENCY = 4;
const MAX_BUDGET_MISSES = 32;
/** Joins the parts' texts into the whole package text (tests and digests; never one prompt). */
const REVIEW_PART_SEPARATOR = "\n";

export interface ReviewPackOptions {
  readonly ranks: ReadonlyMap<ReviewDiffLanguage, number>;
  readonly context: ReviewDiffContextOptions;
  /** The budget of each part. */
  readonly budgetTokens: number;
  readonly maxParts: number;
  readonly maxTotalPatchBytes: number;
  readonly count: ReviewTokenCounter;
  readonly coverage: ReviewDiffCoverageBuilder;
}

interface Packed {
  readonly text: string;
  readonly usedTokens: number;
  readonly files: readonly ReviewDiffPackageFile[];
  readonly parts: readonly ReviewDiffPackagePart[];
}

interface Offered {
  readonly file: ReviewDiffChangedFile;
  readonly hunks: readonly PatchHunk[];
}

function changeSize(file: ReviewDiffChangedFile): number {
  return file.ref.addedLines + file.ref.removedLines;
}

function orderReviewCandidates(
  candidates: readonly ReviewDiffChangedFile[],
  ranks: ReadonlyMap<ReviewDiffLanguage, number>,
): ReviewDiffChangedFile[] {
  const rank = (file: ReviewDiffChangedFile): number => ranks.get(file.ref.language) ?? ranks.size;
  return [...candidates].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      changeSize(right) - changeSize(left) ||
      compareReviewPathBytes(left.change.path, right.change.path),
  );
}

function headerOf(file: ReviewDiffChangedFile): string {
  return renderReviewFileHeader({
    path: file.ref.path,
    previousPath: file.ref.previousPath,
    status: file.ref.status,
  });
}

class PackingRun {
  private readonly packer: ReviewDiffPartPacker;
  private readonly offered = new Map<number, Offered>();
  private patchBytes = 0;
  private budgetMisses = 0;

  public constructor(
    private readonly read: ReviewDiffReadContext,
    private readonly options: ReviewPackOptions,
  ) {
    this.packer = new ReviewDiffPartPacker(options.budgetTokens, options.maxParts, options.count);
  }

  private fetch(file: ReviewDiffChangedFile): Promise<ReviewDiffFileContent | undefined> {
    const empty = file.placement.list === "candidate" && file.placement.content === "empty";
    const exhausted = this.budgetMisses >= MAX_BUDGET_MISSES;
    if (!empty && (exhausted || !this.packer.mightFit(headerOf(file)))) {
      return Promise.resolve(undefined);
    }
    return readCandidateContent(this.read, file, this.options.context);
  }

  public async run(ordered: readonly ReviewDiffChangedFile[]): Promise<void> {
    for (let start = 0; start < ordered.length; start += READ_CONCURRENCY) {
      const batch = ordered.slice(start, start + READ_CONCURRENCY);
      const contents = await Promise.all(batch.map((file) => this.fetch(file)));
      throwIfReviewDiffStopped(this.read.abort);
      batch.forEach((file, offset) => {
        this.offer(start + offset, file, contents[offset]);
      });
    }
  }

  private offer(
    index: number,
    file: ReviewDiffChangedFile,
    content: ReviewDiffFileContent | undefined,
  ): void {
    if (content === undefined) {
      this.missedBudget(file);
      return;
    }
    if (content.kind === "unprocessed") {
      this.options.coverage.addUnprocessed(file, content.reason);
      return;
    }
    this.patchBytes += content.bytes;
    if (this.patchBytes > this.options.maxTotalPatchBytes) throw tooLarge("patch-bytes");
    const section = { header: headerOf(file), hunks: content.hunks.map(renderReviewHunk) };
    const placed = this.packer.place(index, section);
    if (placed === undefined) {
      this.missedBudget(file);
      return;
    }
    this.budgetMisses = placed < section.hunks.length ? this.budgetMisses + 1 : 0;
    this.offered.set(index, { file, hunks: content.hunks });
  }

  private missedBudget(file: ReviewDiffChangedFile): void {
    this.budgetMisses += 1;
    this.options.coverage.addUnprocessed(file, "budget");
  }

  public finish(): Packed {
    const { parts, covered } = this.packer.finish();
    const files: ReviewDiffPackageFile[] = [];
    for (const [index, entry] of this.offered) {
      const kept = covered.get(index);
      if (kept === undefined) {
        // Dropped by the whole-text verification: the budget, as for any file that did not fit.
        this.options.coverage.addUnprocessed(entry.file, "budget");
        continue;
      }
      const coverage = this.options.coverage.addIncluded(entry.file, entry.hunks.length, kept);
      files.push({ coverage, hunks: entry.hunks.slice(0, kept) });
    }
    const usedTokens = parts.reduce((sum, part) => sum + part.usedTokens, 0);
    const text = parts.map((part) => part.text).join(REVIEW_PART_SEPARATOR);
    return { text, usedTokens, files, parts };
  }
}

/** Orders the candidates, reads their contents and packs them into the parts. */
export async function packReviewCandidates(
  read: ReviewDiffReadContext,
  candidates: readonly ReviewDiffChangedFile[],
  options: ReviewPackOptions,
): Promise<Packed> {
  const run = new PackingRun(read, options);
  await run.run(orderReviewCandidates(candidates, options.ranks));
  return run.finish();
}
