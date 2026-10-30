// Token-budget packing of the review diff package (Issue #4134).
//
// Port of PR-Agent v0.49.0 (MIT) `generate_full_patch` with `large_patch_policy = "clip"`, with one
// deliberate difference: a clipped file keeps whole hunks only, never a cut hunk. Files arrive in
// priority order; a file that fits is included whole; one that does not keeps the longest prefix of
// its hunks that fits and is `partial`; one whose first hunk does not fit is unprocessed (`budget`).
// Every decision measures the candidate text with the gateway's own estimator, and the final text
// is measured once more as a whole (the estimator is not additive in general); while it exceeds the
// budget, trailing hunks are dropped, exactly like PR-Agent's verified-prefix check. The included
// content therefore never exceeds the budget as the gateway counts it.

export interface ReviewPackSection {
  readonly header: string;
  readonly hunks: readonly string[];
}

export type ReviewTokenCounter = (text: string) => number;

const REVIEW_PACK_SEPARATOR = "\n";

function sectionText(section: ReviewPackSection, hunkCount: number): string {
  return section.header + section.hunks.slice(0, hunkCount).join("");
}

/** The largest number of leading hunks (at least one) that fits `available`; 0 when none fits. */
function fittingPrefix(
  section: ReviewPackSection,
  available: number,
  count: ReviewTokenCounter,
): number {
  let low = 0;
  let high = section.hunks.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (count(sectionText(section, middle)) <= available) low = middle;
    else high = middle - 1;
  }
  return low;
}

export class ReviewDiffPacker {
  private readonly included: { readonly index: number; hunkCount: number }[] = [];
  private used = 0;

  public constructor(
    private readonly budget: number,
    private readonly count: ReviewTokenCounter,
  ) {}

  /** Whether even the smallest part of this section (its header and one hunk) could still fit. */
  public mightFit(header: string): boolean {
    return this.used + this.count(header) < this.budget;
  }

  /**
   * Decides one section: the number of hunks included, or `undefined` when nothing fits (the file
   * is unprocessed for the budget). A section without hunks (a content-free rename) is all header.
   */
  public offer(index: number, section: ReviewPackSection): number | undefined {
    const available = this.budget - this.used;
    const whole = this.count(sectionText(section, section.hunks.length));
    let hunkCount = section.hunks.length;
    if (whole > available) {
      hunkCount = section.hunks.length === 0 ? 0 : fittingPrefix(section, available, this.count);
      if (hunkCount === 0) return undefined;
    }
    this.used += this.count(sectionText(section, hunkCount));
    this.included.push({ index, hunkCount });
    return hunkCount;
  }

  /**
   * The packed text, verified as a whole, and the final number of hunks per included section
   * (a section whose count drops to 0 is no longer included).
   */
  public finish(sections: ReadonlyMap<number, ReviewPackSection>): {
    readonly text: string;
    readonly usedTokens: number;
    readonly hunkCounts: ReadonlyMap<number, number>;
  } {
    const render = (): string =>
      this.included
        .map((entry) => {
          const section = sections.get(entry.index);
          return section === undefined ? "" : sectionText(section, entry.hunkCount);
        })
        .join(REVIEW_PACK_SEPARATOR);
    let text = render();
    while (this.included.length > 0 && this.count(text) > this.budget) {
      this.dropLastHunk();
      text = render();
    }
    const hunkCounts = new Map(this.included.map((entry) => [entry.index, entry.hunkCount]));
    return { text, usedTokens: text.length === 0 ? 0 : this.count(text), hunkCounts };
  }

  private dropLastHunk(): void {
    const last = this.included.at(-1);
    if (last === undefined) return;
    last.hunkCount -= 1;
    if (last.hunkCount <= 0) this.included.pop();
  }
}
