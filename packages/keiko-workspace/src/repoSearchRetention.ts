// Private shared retained-result storage; this module is not a package API.
interface RetainedAtomEntry<T> {
  readonly value: T;
  readonly order: number;
}

// Keep the worst retained entry at the root. Inserts/replacements are logarithmic; emission
// sorts only once. Arrival order preserves the former stable ordering for fully equal ranks.
export class RetainedAtomHeap<T> {
  private readonly entries: RetainedAtomEntry<T>[] = [];
  private nextOrder = 0;

  public constructor(
    private readonly limit: number,
    private readonly compareValues: (left: T, right: T) => number,
  ) {}

  private readonly compare = (left: RetainedAtomEntry<T>, right: RetainedAtomEntry<T>): number =>
    this.compareValues(left.value, right.value) || left.order - right.order;

  public retain(value: T): void {
    const entry = { value, order: this.nextOrder++ };
    if (this.entries.length < this.limit) {
      this.entries.push(entry);
      this.siftUp(this.entries.length - 1);
      return;
    }
    const worst = this.entries[0];
    if (worst === undefined || this.compare(entry, worst) >= 0) return;
    this.entries[0] = entry;
    this.siftDown(0);
  }

  public get size(): number {
    return this.entries.length;
  }

  public sorted(): readonly T[] {
    return [...this.entries].sort(this.compare).map((entry) => entry.value);
  }

  private swap(left: number, right: number): void {
    const a = this.entries[left];
    const b = this.entries[right];
    if (a === undefined || b === undefined) return;
    this.entries[left] = b;
    this.entries[right] = a;
  }

  private siftUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const childEntry = this.entries[index];
      const parentEntry = this.entries[parent];
      if (childEntry === undefined || parentEntry === undefined) return;
      if (this.compare(childEntry, parentEntry) <= 0) return;
      this.swap(index, parent);
      index = parent;
    }
  }

  private siftDown(index: number): void {
    for (;;) {
      let child = index * 2 + 1;
      const left = this.entries[child];
      const right = this.entries[child + 1];
      const current = this.entries[index];
      if (left === undefined || current === undefined) return;
      if (right !== undefined && this.compare(left, right) < 0) child += 1;
      const worstChild = this.entries[child];
      if (worstChild === undefined || this.compare(current, worstChild) >= 0) return;
      this.swap(index, child);
      index = child;
    }
  }
}
