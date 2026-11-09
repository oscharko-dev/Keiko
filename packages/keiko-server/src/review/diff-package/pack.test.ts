// Budget packing of the review diff package (Issue #4134) and its parts (Issue #4130).

import { describe, expect, it } from "vitest";
import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { ReviewDiffPacker, ReviewDiffPartPacker, type ReviewPackSection } from "./pack.js";

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

/** Places every section in order and finishes; the placement results and the finished parts. */
function packParts(
  budget: number,
  maxParts: number,
  sections: readonly ReviewPackSection[],
  count: (text: string) => number,
): {
  readonly placed: (number | undefined)[];
  readonly parts: readonly { readonly text: string; readonly fileCount: number }[];
  readonly covered: ReadonlyMap<number, number>;
} {
  const packer = new ReviewDiffPartPacker(budget, maxParts, count);
  const placed = sections.map((value, index) => packer.place(index, value));
  const finished = packer.finish();
  return { placed, parts: finished.parts, covered: finished.covered };
}

describe("ReviewDiffPartPacker", () => {
  const length = (text: string): number => text.length;
  const hunk = section("a", 1).hunks[0]?.length ?? 0;
  const header = (name: string): number => `## File: '${name}'\n`.length;

  it("is the single-part packer when it has one part", () => {
    const sections = [section("a", 2), section("b", 4), section("c", 1)];
    const budget = header("a") + 2 * hunk + header("b") + 2 * hunk + 1;
    const single = pack(budget, sections, length);
    const parted = packParts(budget, 1, sections, length);
    expect(parted.placed).toEqual(single.offers);
    expect(parted.parts.map((part) => part.text)).toEqual([single.text]);
    expect(parted.covered).toEqual(single.counts);
  });

  it("starts the next part for a section that would fit a fresh part whole", () => {
    const sections = [section("a", 2), section("b", 2)];
    const budget = header("a") + 3 * hunk;
    const result = packParts(budget, 3, sections, length);
    expect(result.placed).toEqual([2, 2]);
    expect(result.parts).toHaveLength(2);
    expect(result.parts[1]?.text).toBe(
      `${sections[1]?.header ?? ""}${(sections[1]?.hunks ?? []).join("")}`,
    );
  });

  it("continues a section larger than one part in the next parts, hunks in order", () => {
    const big = section("big", 5);
    const budget = header("big") + 2 * hunk;
    const result = packParts(budget, 4, [big], length);
    expect(result.placed).toEqual([5]);
    expect(result.covered).toEqual(new Map([[0, 5]]));
    expect(result.parts.map((part) => part.text)).toEqual([
      big.header + big.hunks.slice(0, 2).join(""),
      big.header + big.hunks.slice(2, 4).join(""),
      big.header + big.hunks.slice(4).join(""),
    ]);
    for (const part of result.parts) expect(part.text.length).toBeLessThanOrEqual(budget);
  });

  it("keeps the leading hunks that fit once every part is open", () => {
    const result = packParts(
      header("big") + 2 * hunk,
      2,
      [section("big", 5), section("c", 1)],
      length,
    );
    expect(result.placed).toEqual([4, undefined]);
    expect(result.covered).toEqual(new Map([[0, 4]]));
  });

  it("leaves a section whose first remaining hunk is larger than a whole part", () => {
    const sections = [section("a", 1), section("huge", 1, 500), section("c", 1)];
    const result = packParts(header("a") + 2 * hunk, 6, sections, length);
    expect(result.placed).toEqual([1, undefined, 1]);
    // The part opened for the huge hunk stays empty until the next section uses it.
    expect(result.parts.map((part) => part.fileCount)).toEqual([1, 1]);
    expect(result.parts.some((part) => part.text.includes("huge"))).toBe(false);
  });

  it("places a hunkless section in the next part when the current one is full", () => {
    const result = packParts(
      header("a") + hunk,
      2,
      [section("a", 1), section("renamed", 0)],
      length,
    );
    expect(result.placed).toEqual([1, 0]);
    expect(result.parts.map((part) => part.text)).toEqual([
      `## File: 'a'\n${section("a", 1).hunks[0] ?? ""}`,
      "## File: 'renamed'\n",
    ]);
  });

  it("ends a section at the gap a part's whole-text verification leaves", () => {
    // Super-additive like the single-part case: the whole text of a part with two sections costs
    // more than its sections, so verification drops the first part's trailing hunks.
    const count = (text: string): number =>
      text.length + 100 * (text.match(/## File/gu)?.length ?? 0) ** 2;
    const a = section("a", 1);
    // Too large for a fresh part whole, so its first hunk joins `a`'s part and the rest continue.
    const b = section("b", 6);
    const budget =
      count(`${a.header}${a.hunks.join("")}`) + count(`${b.header}${b.hunks[0] ?? ""}`) + 10;
    const result = packParts(budget, 3, [a, b], count);
    expect(result.placed).toEqual([1, 6]);
    // `b` lost its first part's hunks to verification, so its later hunks are no longer shown.
    expect(result.covered.has(1)).toBe(false);
    for (const part of result.parts) {
      expect(part.text).not.toContain("## File: 'b'");
      expect(count(part.text)).toBeLessThanOrEqual(budget);
    }
  });

  it("answers whether a header might still find room in this or a later part", () => {
    const packer = new ReviewDiffPartPacker(header("a") + hunk, 2, length);
    expect(packer.place(0, section("a", 1))).toBe(1);
    expect(packer.mightFit("## File: 'b'\n")).toBe(true);
    expect(packer.place(1, section("b", 1))).toBe(1);
    expect(packer.mightFit("## File: 'c'\n")).toBe(false);
  });
});
