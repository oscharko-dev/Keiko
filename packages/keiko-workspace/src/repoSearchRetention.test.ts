import { describe, expect, it } from "vitest";
import { RetainedAtomHeap } from "./repoSearchRetention.js";

describe("shared bounded retained-result heap", () => {
  it("keeps bounded storage and logarithmic comparisons for adversarial replacements", (): void => {
    const capacity = 1024;
    const count = 100_000;
    let comparisons = 0;
    const heap = new RetainedAtomHeap<number>(capacity, (left, right) => {
      comparisons += 1;
      return right - left;
    });
    for (let value = 0; value < count; value += 1) {
      heap.retain(value);
      expect(heap.size).toBeLessThanOrEqual(capacity);
    }
    const kept = heap.sorted();
    expect(kept).toHaveLength(capacity);
    expect(kept[0]).toBe(count - 1);
    expect(kept.at(-1)).toBe(count - capacity);
    expect(comparisons).toBeGreaterThan(count);
    expect(comparisons).toBeLessThan(count * 4 * Math.ceil(Math.log2(capacity)));
  });

  it("preserves arrival order for tied values and emits only the accepted capacity", (): void => {
    const heap = new RetainedAtomHeap<{ id: string; score: number }>(
      2,
      (a, b) => b.score - a.score,
    );
    heap.retain({ id: "first", score: 1 });
    heap.retain({ id: "second", score: 1 });
    heap.retain({ id: "third", score: 1 });
    expect(heap.sorted().map((entry) => entry.id)).toEqual(["first", "second"]);
  });
});
