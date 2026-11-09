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
//
// `ReviewDiffPartPacker` (Issue #4130) fills up to `maxParts` such packers, one per part: a section
// that does not fit what is left of a started part starts the next part when it would fit a part
// whole, and a section larger than one part continues in the next parts, so its hunks stay in order.
// Once every part is open, the rules above apply to the last one exactly as to a single part.

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

  /** Whether nothing has been included yet. */
  public isEmpty(): boolean {
    return this.included.length === 0;
  }

  /** Whether this section fits whole into what is left of the budget. */
  public fitsWhole(section: ReviewPackSection): boolean {
    return this.count(sectionText(section, section.hunks.length)) <= this.budget - this.used;
  }

  /**
   * Takes an included section out again, once offering has ended and before `finish`: a part never
   * shows a file's hunks that do not follow, without a gap, the hunks of the parts before it.
   */
  public withdraw(index: number): void {
    const position = this.included.findIndex((entry) => entry.index === index);
    if (position >= 0) this.included.splice(position, 1);
  }

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

/** One finished part: its verified text, the text's token count and the sections it shows. */
export interface ReviewPackedPart {
  readonly text: string;
  readonly usedTokens: number;
  readonly fileCount: number;
}

/** One part being filled: its packer, its sections and the first hunk of each section it holds. */
interface OpenPart {
  readonly packer: ReviewDiffPacker;
  readonly sections: Map<number, ReviewPackSection>;
  readonly starts: Map<number, number>;
}

export class ReviewDiffPartPacker {
  private readonly parts: OpenPart[] = [];
  private part: OpenPart;

  public constructor(
    private readonly budget: number,
    private readonly maxParts: number,
    private readonly count: ReviewTokenCounter,
  ) {
    this.part = this.openPart();
  }

  private openPart(): OpenPart {
    const part: OpenPart = {
      packer: new ReviewDiffPacker(this.budget, this.count),
      sections: new Map(),
      starts: new Map(),
    };
    this.parts.push(part);
    this.part = part;
    return part;
  }

  private canOpenPart(): boolean {
    return this.parts.length < this.maxParts;
  }

  /** Whether the smallest part of a section could still find room in this or a later part. */
  public mightFit(header: string): boolean {
    return this.canOpenPart() || this.part.packer.mightFit(header);
  }

  /** A section that does not fit what is left of a started part, but would fit a fresh part whole. */
  private startsFreshPart(section: ReviewPackSection): boolean {
    if (this.part.packer.isEmpty() || !this.canOpenPart()) return false;
    if (this.part.packer.fitsWhole(section)) return false;
    return this.count(sectionText(section, section.hunks.length)) <= this.budget;
  }

  /**
   * Places a section's hunks in order across the parts. Returns how many leading hunks were placed,
   * or `undefined` when not even its first hunk found room (a hunkless section is all header).
   */
  public place(index: number, section: ReviewPackSection): number | undefined {
    let start = 0;
    let placedAny = false;
    for (;;) {
      const rest = { header: section.header, hunks: section.hunks.slice(start) };
      if (this.startsFreshPart(rest)) this.openPart();
      const wasEmpty = this.part.packer.isEmpty();
      const kept = this.part.packer.offer(index, rest);
      if (kept !== undefined) {
        this.part.sections.set(index, rest);
        this.part.starts.set(index, start);
        start += kept;
        placedAny = true;
      }
      if (placedAny && start >= section.hunks.length) return start;
      // Nothing more fits: no part is left, or one remaining hunk is larger than a whole part.
      if (!this.canOpenPart() || (kept === undefined && wasEmpty)) {
        return placedAny ? start : undefined;
      }
      this.openPart();
    }
  }

  /**
   * Verifies each part as a whole, in order, and returns the parts that kept anything with each
   * section's final number of leading hunks (a section missing from `covered` kept nothing). A
   * section keeps the hunks that follow each other without a gap from its first hunk: a part whose
   * verification dropped some of a section's hunks ends that section, and later parts no longer
   * show it.
   */
  public finish(): {
    readonly parts: readonly ReviewPackedPart[];
    readonly covered: ReadonlyMap<number, number>;
  } {
    const covered = new Map<number, number>();
    const parts: ReviewPackedPart[] = [];
    for (const part of this.parts) {
      for (const [index, start] of part.starts) {
        if (start > 0 && covered.get(index) !== start) part.packer.withdraw(index);
      }
      const final = part.packer.finish(part.sections);
      for (const [index, kept] of final.hunkCounts) {
        covered.set(index, (part.starts.get(index) ?? 0) + kept);
      }
      if (final.hunkCounts.size > 0) {
        parts.push({
          text: final.text,
          usedTokens: final.usedTokens,
          fileCount: final.hunkCounts.size,
        });
      }
    }
    return { parts, covered };
  }
}
