// Budget packing of the review diff package (Issue #4134).

import { describe, expect, it } from "vitest";
import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { ReviewDiffPacker, type ReviewPackSection } from "./pack.js";

function section(name: string, hunks: number, size = 40): ReviewPackSection {
  return {
    header: `## File: '${name}'\n`,
    hunks: Array.from(
      { length: hunks },
      (_, index) => `\n@@ ${String(index)} @@\n${"x".repeat(size)}\n`,
    ),
  };
}

function pack(
  budget: number,
  sections: readonly ReviewPackSection[],
  count: (text: string) => number,
): {
  readonly offers: (number | undefined)[];
  readonly text: string;
  readonly counts: ReadonlyMap<number, number>;
} {
  const packer = new ReviewDiffPacker(budget, count);
  const offers = sections.map((value, index) => packer.offer(index, value));
  const finished = packer.finish(new Map(sections.map((value, index) => [index, value])));
  return { offers, text: finished.text, counts: finished.hunkCounts };
}

describe("ReviewDiffPacker", () => {
  it("includes whole sections while they fit and clips the next to whole leading hunks", () => {
    const count = (text: string): number => text.length;
    const sections = [section("a", 2), section("b", 4), section("c", 1)];
    const hunk = sections[0]?.hunks[0]?.length ?? 0;
    const first = count(sections[0]?.header ?? "") + 2 * hunk;
    // One separator byte joins the two sections; the length counter has no slack to absorb it.
    const budget = first + count("## File: 'b'\n") + 2 * hunk + 1;
    const result = pack(budget, sections, count);
    expect(result.offers).toEqual([2, 2, undefined]);
    expect(result.counts).toEqual(
      new Map([
        [0, 2],
        [1, 2],
      ]),
    );
    expect(result.text.length).toBeLessThanOrEqual(budget);
  });

  it("verifies the whole text, dropping trailing hunks when the estimate is not additive", () => {
    // A counter that charges more for the whole than for its parts: per-section decisions alone
    // would accept every section, and only the final whole-text check keeps the budget.
    const count = (text: string): number =>
      text.length + 100 * (text.match(/## File/gu)?.length ?? 0) ** 2;
    const sections = [section("a", 1), section("b", 1), section("c", 1)];
    const each = count(`${sections[0]?.header ?? ""}${sections[0]?.hunks[0] ?? ""}`);
    const budget = each * 3 + 10;
    const result = pack(budget, sections, count);
    expect(result.offers).toEqual([1, 1, 1]);
    expect(count(result.text)).toBeLessThanOrEqual(budget);
    expect(result.counts.size).toBeLessThan(3);
  });

  it("includes a section without hunks as its header alone", () => {
    const result = pack(1_000, [section("renamed", 0)], countContextTokens);
    expect(result.offers).toEqual([0]);
    expect(result.text).toBe("## File: 'renamed'\n");
  });

  it("includes nothing and measures zero for a budget smaller than any header", () => {
    const packer = new ReviewDiffPacker(1, countContextTokens);
    expect(packer.mightFit("## File: 'a'\n")).toBe(false);
    expect(packer.offer(0, section("a", 1))).toBeUndefined();
    expect(packer.finish(new Map())).toEqual({ text: "", usedTokens: 0, hunkCounts: new Map() });
  });
});
