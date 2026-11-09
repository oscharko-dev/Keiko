// The review diff package in parts (Issue #4130): a change larger than one review task is split
// into parts that each fit the part budget, against real `git` over object-built fixtures.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { REVIEW_RUN_MAX_DIFF_PARTS } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { reviewDiffCoverageSettlement } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";
import { DiffFixtureRepository } from "./diffFixtures.test-support.js";
import { build, numbered, packaged } from "./diffPackageAssertions.test-support.js";
import { renderReviewHunk } from "./render.js";

let fixture: DiffFixtureRepository;

beforeEach(() => {
  fixture = new DiffFixtureRepository();
});

afterEach(() => {
  fixture.cleanup();
});

/** A file of `hunks` changes, each far enough from the next to stay its own hunk. */
function spaced(hunks: number, changed: boolean, tag = "x"): string {
  return Array.from({ length: hunks }, (_, index) => {
    const value = changed ? `${tag} changed ${String(index)}` : `${tag} original ${String(index)}`;
    return `${numbered(9, `${tag}${String(index)}`)}${value}\n`;
  }).join("");
}

/** Eight files of one to eight hunks each, plus a document. */
function changeSet(): { readonly base: string; readonly head: string } {
  const files = Array.from({ length: 8 }, (_, index) => index);
  const base = fixture.commit(
    files.map((index) => ({ path: `src/f${String(index)}.ts`, content: spaced(index + 1, false) })),
  );
  const head = fixture.commit([
    ...files.map((index) => ({
      path: `src/f${String(index)}.ts`,
      content: spaced(index + 1, true),
    })),
    { path: "docs/readme.md", content: numbered(40, "doc") },
  ]);
  return { base, head };
}

describe("diff package parts (Issue #4130)", () => {
  it("keeps every part within the part budget and every file's hunks in order", async () => {
    const { base, head } = changeSet();
    const full = await packaged(fixture, base, head, { budgetTokens: 1_000_000 });
    const fullHunks = new Map(full.files.map((file) => [file.coverage.path, file.hunks]));
    for (const maxParts of [2, 3, REVIEW_RUN_MAX_DIFF_PARTS]) {
      for (const budgetTokens of [60, 150, 240, 400, 700, 1_100]) {
        const label = `${String(maxParts)} parts of ${String(budgetTokens)}`;
        const result = await packaged(fixture, base, head, { budgetTokens, maxParts });
        expect(result.parts.length, label).toBeLessThanOrEqual(maxParts);
        for (const part of result.parts) {
          expect(countContextTokens(part.text), label).toBe(part.usedTokens);
          expect(part.usedTokens, label).toBeLessThanOrEqual(budgetTokens);
        }
        const used = result.parts.reduce((sum, part) => sum + part.usedTokens, 0);
        expect(result.coverage.summary.usedTokens, label).toBe(used);
        for (const file of result.files) {
          const all = fullHunks.get(file.coverage.path) ?? [];
          expect(file.hunks, label).toEqual(all.slice(0, file.hunks.length));
          expect(file.coverage.partial, label).toBe(file.hunks.length < all.length);
          // Each included hunk is in exactly one part, and in order across the parts.
          const where = file.hunks.map((hunk) =>
            result.parts.findIndex((part) => part.text.includes(renderReviewHunk(hunk))),
          );
          expect(
            where.every((index) => index >= 0),
            label,
          ).toBe(true);
          expect(where, label).toEqual([...where].sort((left, right) => left - right));
        }
      }
    }
  });

  it("reviews a change too large for one part completely in several parts", async () => {
    const { base, head } = changeSet();
    const single = await packaged(fixture, base, head, { budgetTokens: 400 });
    expect(reviewDiffCoverageSettlement(single.coverage)).toEqual({
      kind: "incomplete",
      reason: "files-unprocessed",
    });
    const parted = await packaged(fixture, base, head, {
      budgetTokens: 400,
      maxParts: REVIEW_RUN_MAX_DIFF_PARTS,
    });
    expect(parted.parts.length).toBeGreaterThan(1);
    expect(reviewDiffCoverageSettlement(parted.coverage)).toEqual({ kind: "reviewable" });
    expect(parted.coverage.summary).toMatchObject({
      unprocessedFiles: 0,
      partiallyReviewedFiles: 0,
    });
  });

  it("continues a file larger than one part in the next parts", async () => {
    const base = fixture.commit([{ path: "big.ts", content: spaced(6, false) }]);
    const head = fixture.commit([{ path: "big.ts", content: spaced(6, true) }]);
    const full = await packaged(fixture, base, head, { budgetTokens: 1_000_000 });
    const hunks = (full.files[0]?.hunks ?? []).map(renderReviewHunk);
    const twoHunks = countContextTokens(`## File: 'big.ts'\n${hunks.slice(0, 2).join("")}`);
    const result = await packaged(fixture, base, head, { budgetTokens: twoHunks + 1, maxParts: 4 });
    expect(result.coverage.included).toMatchObject([
      { path: "big.ts", hunkCount: 6, includedHunkCount: 6, partial: false },
    ]);
    expect(result.parts.length).toBeGreaterThan(2);
    // Every part repeats the file's header; together they show each hunk once, in order.
    const header = "## File: 'big.ts'\n";
    for (const part of result.parts) expect(part.text.startsWith(header)).toBe(true);
    const shown = result.parts.map((part) => part.text.slice(header.length)).join("");
    expect(shown).toBe(hunks.join(""));
  });

  it("reports what does not fit the last part as unprocessed for the budget", async () => {
    const { base, head } = changeSet();
    const result = await packaged(fixture, base, head, { budgetTokens: 400, maxParts: 2 });
    expect(result.parts).toHaveLength(2);
    expect(result.coverage.unprocessed.length).toBeGreaterThan(0);
    expect(result.coverage.unprocessed.every((file) => file.reason === "budget")).toBe(true);
    expect(reviewDiffCoverageSettlement(result.coverage)).toEqual({
      kind: "incomplete",
      reason: "files-unprocessed",
    });
  });

  it("builds the single-part package when one part is allowed", async () => {
    const { base, head } = changeSet();
    const implicit = await packaged(fixture, base, head, { budgetTokens: 700 });
    const explicit = await packaged(fixture, base, head, { budgetTokens: 700, maxParts: 1 });
    expect(explicit).toEqual(implicit);
    expect(implicit.parts.map((part) => part.text)).toEqual([implicit.text]);
  });

  it("has no parts when nothing fits", async () => {
    const { base, head } = changeSet();
    const result = await packaged(fixture, base, head, { budgetTokens: 1, maxParts: 3 });
    expect(result.parts).toEqual([]);
    expect(result.text).toBe("");
  });

  it("refuses a part count outside one to the contract maximum", async () => {
    const base = fixture.commit([{ path: "a.ts", content: "a\n" }]);
    for (const maxParts of [0, -1, 1.5, REVIEW_RUN_MAX_DIFF_PARTS + 1]) {
      await expect(build(fixture, base, base, { budgetTokens: 10, maxParts })).rejects.toThrow(
        TypeError,
      );
    }
  });
});
