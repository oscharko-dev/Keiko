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
//
// A file with a hunk larger than one part is placed after the files that fit (Issue #4130), in the
// same order, and only when its whole diff fits the windows the unopened parts can hold. Otherwise
// it is unprocessed for the budget, so it never takes a part from a file that fits. Such a file is
// held back only while the unopened parts could still show it beside the files already held; one
// that cannot be shown any more counts as a budget miss like any file that did not fit, so the
// bound on Git processes above holds for oversized files too (R4130-065).

import type { PatchHunk, ReviewDiffLanguage } from "@oscharko-dev/keiko-contracts";
import type { ReviewDiffChangedFile } from "./classify.js";
import type { ReviewDiffCoverageBuilder } from "./coverage.js";
import { throwIfReviewDiffStopped, tooLarge } from "./failure.js";
import { splitReviewHunk, type ReviewDiffContextOptions } from "./hunks.js";
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
/**
 * The share of a part's budget one window of a split hunk may take, in percent (Issue #4130). Two
 * windows then share a part and leave a tenth of it for the file header and for the estimator,
 * which is not additive over joined texts.
 */
const REVIEW_HUNK_WINDOW_BUDGET_PERCENT = 45;
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
  /** The Git hunks shown as windows, counted over the hunks the package holds (Issue #4130). */
  readonly windowedHunks: number;
}

/** A file's hunks as they are offered to the packer (Issue #4130). */
interface Windowed {
  readonly hunks: readonly PatchHunk[];
  /** For each offered hunk the index of the Git hunk it is a window of; `undefined` when whole. */
  readonly windowOf: readonly (number | undefined)[];
}

interface Offered extends Windowed {
  readonly file: ReviewDiffChangedFile;
}

/** A file with a hunk larger than one part, held back until the files that fit are placed. */
interface Deferred {
  readonly index: number;
  readonly file: ReviewDiffChangedFile;
  readonly header: string;
  readonly hunks: readonly PatchHunk[];
  /** The token count of the file's whole diff, measured once when it was held back. */
  readonly tokens: number;
}

/** How many split Git hunks the first `kept` offered hunks belong to. */
function windowedHunksOf(entry: Windowed, kept: number): number {
  const origins = new Set<number>();
  for (const origin of entry.windowOf.slice(0, kept)) {
    if (origin !== undefined) origins.add(origin);
  }
  return origins.size;
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
  /** The tokens one window of a split hunk may take. */
  private readonly windowBudget: number;
  private readonly offered = new Map<number, Offered>();
  private readonly deferred: Deferred[] = [];
  /** The diff tokens of the files held back so far: what they claim of the window capacity. */
  private deferredTokens = 0;
  private patchBytes = 0;
  private budgetMisses = 0;

  public constructor(
    private readonly read: ReviewDiffReadContext,
    private readonly options: ReviewPackOptions,
  ) {
    this.packer = new ReviewDiffPartPacker(options.budgetTokens, options.maxParts, options.count);
    this.windowBudget = Math.floor(
      (options.budgetTokens * REVIEW_HUNK_WINDOW_BUDGET_PERCENT) / 100,
    );
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
      const contents = await Promise.all(batch.map((file) => this.fetch(file))); // NOSONAR typescript:S9382 -- one bounded batch of reads; what its offers leave of the budget decides which later files are read
      throwIfReviewDiffStopped(this.read.abort);
      batch.forEach((file, offset) => {
        this.offer(start + offset, file, contents[offset]);
      });
    }
    this.placeDeferred();
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
    const header = headerOf(file);
    if (content.hunks.some((hunk) => !this.fitsPart(header, hunk))) {
      this.defer(index, file, header, content.hunks);
      return;
    }
    const whole = { hunks: content.hunks, windowOf: content.hunks.map(() => undefined) };
    if (!this.place(index, file, header, whole)) this.missedBudget(file);
  }

  /** Whether one part can hold the hunk beside its file header. */
  private fitsPart(header: string, hunk: PatchHunk): boolean {
    return this.options.count(header + renderReviewHunk(hunk)) <= this.options.budgetTokens;
  }

  /** Places a file's offered hunks; `false` when not even the first found room. */
  private place(
    index: number,
    file: ReviewDiffChangedFile,
    header: string,
    windowed: Windowed,
  ): boolean {
    const section = { header, hunks: windowed.hunks.map(renderReviewHunk) };
    const placed = this.packer.place(index, section);
    if (placed === undefined) return false;
    this.budgetMisses = placed < section.hunks.length ? this.budgetMisses + 1 : 0;
    this.offered.set(index, { file, ...windowed });
    return true;
  }

  /**
   * The files with a hunk larger than one part, after every file that fits is placed (R4130-064),
   * in the same order. Such a file is shown in windows only when its whole diff fits the windows
   * the unopened parts can hold, two per part; otherwise it is left out as before this change
   * (`unprocessed`, `budget`) and nothing of it is split (R4130-063). So a file larger than the
   * parts that are left takes no part from a file that fits, and the work of splitting is bounded
   * by the parts, not by the size of the change.
   */
  private placeDeferred(): void {
    for (const { index, file, header, hunks, tokens } of this.deferred) {
      throwIfReviewDiffStopped(this.read.abort);
      const fits = tokens <= this.windowCapacity();
      if (!fits || !this.place(index, file, header, this.windowed(header, hunks))) {
        this.options.coverage.addUnprocessed(file, "budget");
      }
    }
  }

  /** What the unopened parts can hold in windows, two per part. */
  private windowCapacity(): number {
    return this.packer.unopenedParts() * 2 * this.windowBudget;
  }

  /**
   * Holds a file with a hunk larger than one part back for `placeDeferred`, as long as the unopened
   * parts could still show it beside the files already held. The capacity only shrinks while files
   * are placed, so a file beyond it now cannot be shown later either: it is a budget miss at once,
   * its contents are not kept, and it counts toward the stop of the reads (R4130-065).
   */
  private defer(
    index: number,
    file: ReviewDiffChangedFile,
    header: string,
    hunks: readonly PatchHunk[],
  ): void {
    const capacity = this.windowCapacity() - this.deferredTokens;
    const tokens =
      capacity > 0 ? this.options.count(header + hunks.map(renderReviewHunk).join("")) : 0;
    if (capacity <= 0 || tokens > capacity) {
      this.missedBudget(file);
      return;
    }
    this.deferredTokens += tokens;
    this.deferred.push({ index, file, header, hunks, tokens });
  }

  /**
   * The file's hunks, each hunk that no part can hold as consecutive windows (Issue #4130). A hunk
   * that fits a part beside its file header stays whole.
   */
  private windowed(header: string, hunks: readonly PatchHunk[]): Windowed {
    const { count } = this.options;
    const windowBudget = this.windowBudget;
    const offered: PatchHunk[] = [];
    const windowOf: (number | undefined)[] = [];
    hunks.forEach((hunk, index) => {
      const windows = splitReviewHunk(hunk, {
        whole: (candidate) => this.fitsPart(header, candidate),
        window: (candidate) => count(renderReviewHunk(candidate)) <= windowBudget,
      });
      for (const window of windows) {
        offered.push(window);
        windowOf.push(windows.length > 1 ? index : undefined);
      }
    });
    return { hunks: offered, windowOf };
  }

  private missedBudget(file: ReviewDiffChangedFile): void {
    this.budgetMisses += 1;
    this.options.coverage.addUnprocessed(file, "budget");
  }

  public finish(): Packed {
    const { parts, covered } = this.packer.finish();
    const files: ReviewDiffPackageFile[] = [];
    let windowedHunks = 0;
    for (const [index, entry] of this.offered) {
      const kept = covered.get(index);
      if (kept === undefined) {
        // Dropped by the whole-text verification: the budget, as for any file that did not fit.
        this.options.coverage.addUnprocessed(entry.file, "budget");
        continue;
      }
      const coverage = this.options.coverage.addIncluded(entry.file, entry.hunks.length, kept);
      files.push({ coverage, hunks: entry.hunks.slice(0, kept) });
      windowedHunks += windowedHunksOf(entry, kept);
    }
    const usedTokens = parts.reduce((sum, part) => sum + part.usedTokens, 0);
    const text = parts.map((part) => part.text).join(REVIEW_PART_SEPARATOR);
    return { text, usedTokens, files, parts, windowedHunks };
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
