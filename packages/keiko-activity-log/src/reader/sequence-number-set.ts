// Exact membership over the sequence numbers one process lifetime has written. A writer stamps
// consecutive numbers, so the run that starts at the first value is kept as its two bounds and only
// values outside it take a Set entry. A gap-free segment therefore costs constant memory instead of
// one retained entry per line, while any order, gap, duplicate, reset or non-integer value gets
// exactly the answer a plain Set would give. Hostile input never retains more than a plain Set.
export class SequenceNumberSet {
  private low: number | undefined;
  private high = 0;
  private readonly outside = new Set<number>();

  public has(value: number): boolean {
    return this.inRun(value) || this.outside.has(value);
  }

  /** How many values are held individually, outside the contiguous run: the retained memory. */
  public get outsideRunCount(): number {
    return this.outside.size;
  }

  public add(value: number): void {
    if (this.has(value)) return;
    if (!Number.isSafeInteger(value)) {
      this.outside.add(value);
    } else if (this.low === undefined) {
      this.low = value;
      this.high = value;
    } else if (value === this.high + 1) {
      this.extendRun(value);
    } else {
      this.outside.add(value);
    }
  }

  private inRun(value: number): boolean {
    return this.low !== undefined && value >= this.low && value <= this.high;
  }

  // Values that arrived ahead of the run join it once the run reaches them, so the Set only ever
  // holds values the run does not cover.
  private extendRun(value: number): void {
    this.high = value;
    while (this.high < Number.MAX_SAFE_INTEGER && this.outside.delete(this.high + 1)) {
      this.high += 1;
    }
  }
}
