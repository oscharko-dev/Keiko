import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";

// The existing streamed-search worst-first heap algorithm, specialized for metadata paths.
// Membership covers retained paths only; directory visitation owns observation deduplication.
export class BoundedMetadataPaths {
  private readonly paths: string[] = [];
  private readonly members = new Set<string>();

  constructor(
    private readonly limit: number,
    private readonly compare: (left: string, right: string) => number = compareStrings,
  ) {}

  retain(path: string): string | undefined {
    if (this.members.has(path)) return undefined;
    if (this.limit === 0) return path;
    if (this.paths.length < this.limit) {
      this.paths.push(path);
      this.members.add(path);
      this.siftUp(this.paths.length - 1);
      return undefined;
    }
    const worst = this.paths[0];
    if (worst === undefined || this.compare(path, worst) >= 0) return path;
    this.members.delete(worst);
    this.members.add(path);
    this.paths[0] = path;
    this.siftDown(0);
    return worst;
  }

  sorted(): readonly string[] {
    return [...this.paths].sort(this.compare);
  }

  private swap(left: number, right: number): void {
    const a = this.paths[left];
    const b = this.paths[right];
    if (a === undefined || b === undefined) return;
    this.paths[left] = b;
    this.paths[right] = a;
  }

  private siftUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const child = this.paths[index];
      const ancestor = this.paths[parent];
      if (child === undefined || ancestor === undefined || this.compare(child, ancestor) <= 0)
        return;
      this.swap(index, parent);
      index = parent;
    }
  }

  private siftDown(index: number): void {
    for (;;) {
      let child = index * 2 + 1;
      const left = this.paths[child];
      const right = this.paths[child + 1];
      const current = this.paths[index];
      if (left === undefined || current === undefined) return;
      if (right !== undefined && this.compare(left, right) < 0) child += 1;
      const worst = this.paths[child];
      if (worst === undefined || this.compare(current, worst) >= 0) return;
      this.swap(index, child);
      index = child;
    }
  }
}

export interface MetadataRetentionObservation {
  readonly observedCount: number;
  readonly retainedCount: number;
  readonly discardedCount: number;
  readonly omittedDetailCount: number;
  readonly limit: number;
}

export class MetadataRetention {
  private readonly kept: BoundedMetadataPaths;
  private readonly omitted: BoundedMetadataPaths;
  private readonly preferredRootPaths: Set<string>;
  private readonly observedPreferredRoots = new Set<string>();
  discardedCount = 0;

  constructor(
    private readonly limit: number,
    omittedLimit: number,
    roots: readonly string[],
    preferredNames: readonly string[],
  ) {
    const rootDirectories = new Set(roots);
    const preferred = new Map(preferredNames.map((name, index) => [name, index]));
    this.preferredRootPaths = new Set(
      roots.flatMap((root) =>
        preferredNames.map((name) => (root === "" ? name : `${root}/${name}`)),
      ),
    );
    const priority = (path: string): number => {
      const index = path.lastIndexOf("/");
      if (!rootDirectories.has(path.slice(0, Math.max(0, index)))) return preferred.size + 1;
      return preferred.get(path.slice(index + 1)) ?? preferred.size;
    };
    this.kept = new BoundedMetadataPaths(
      limit,
      (left, right) => priority(left) - priority(right) || compareStrings(left, right),
    );
    this.omitted = new BoundedMetadataPaths(omittedLimit);
  }

  observe(path: string): void {
    if (this.preferredRootPaths.has(path)) this.observedPreferredRoots.add(path);
    const discarded = this.kept.retain(path);
    if (discarded === undefined) return;
    this.discardedCount += 1;
    this.omitted.retain(discarded);
  }

  observeRootFallback(path: string): void {
    if (!this.observedPreferredRoots.has(path)) this.observe(path);
  }

  observation(): MetadataRetentionObservation {
    const retainedCount = this.kept.sorted().length;
    return {
      observedCount: retainedCount + this.discardedCount,
      retainedCount,
      discardedCount: this.discardedCount,
      omittedDetailCount: this.omitted.sorted().length,
      limit: this.limit,
    };
  }

  retainedPaths(): readonly string[] {
    return this.kept.sorted();
  }

  omittedPaths(): readonly string[] {
    return this.omitted.sorted();
  }
}
