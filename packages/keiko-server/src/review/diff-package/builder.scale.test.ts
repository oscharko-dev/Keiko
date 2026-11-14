// Scale and pathological inputs of the review diff package (Issue #4134): a large change set with
// a measured time bound, a rename storm beyond Git's rename limit, a file of thousands of hunks
// and a single hunk larger than one part (Issue #4130).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { reviewDiffCoverageSettlement } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";
import { GIT_REVIEW_RENAME_LIMIT } from "@oscharko-dev/keiko-git";
import { DiffFixtureRepository } from "./diffFixtures.test-support.js";
import {
  coverageLists,
  numbered,
  numberedBody,
  packaged,
  reportedPathKey,
} from "./diffPackageAssertions.test-support.js";
import { renderReviewHunk } from "./render.js";

let fixture: DiffFixtureRepository;

beforeEach(() => {
  fixture = new DiffFixtureRepository();
});

afterEach(() => {
  fixture.cleanup();
});

function reportedCount(coverage: Parameters<typeof coverageLists>[0]): number {
  return new Set(Object.values(coverageLists(coverage)).flat().map(reportedPathKey)).size;
}

/**
 * The bound for the large fixture (2,000 changed files, 120,000-token budget). Measured on
 * 2026-10-30 at 1.42-1.56 s (Apple M5 Pro, Git 2.54, three runs); the bound leaves roughly ten times
 * that for slower CI hosts. With a budget that takes every file (2,000 patch reads) the same
 * fixture measured 6.2-6.6 s.
 */
const LARGE_FIXTURE_BOUND_MS = 15_000;

describe("scale", () => {
  it("packages 2,000 changed files within the measured bound", async () => {
    const files = Array.from(
      { length: 2_000 },
      (_, index) => `src/m${String(index % 40)}/f${String(index)}.ts`,
    );
    const body = numbered(200, "  const value");
    const base = fixture.fastCommit(files.map((path) => ({ path, content: body })));
    const changed = body
      .replace("value 20\n", "value twenty\n")
      .replace("value 100\n", "value hundred\n")
      .replace("value 180\n", "value eighty\n");
    const head = fixture.fastCommit(files.map((path) => ({ path, content: changed })));
    const started = performance.now();
    const result = await packaged(fixture, base, head, { budgetTokens: 120_000 });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(LARGE_FIXTURE_BOUND_MS);
    expect(result.coverage.summary.changedFiles).toBe(2_000);
    expect(reportedCount(result.coverage)).toBe(2_000);
    expect(countContextTokens(result.text)).toBeLessThanOrEqual(120_000);
    expect(result.coverage.included.length).toBeGreaterThan(100);
    expect(result.coverage.unprocessed.every((file) => file.reason === "budget")).toBe(true);
  }, 120_000);

  it("survives a rename storm beyond the rename limit with exact coverage", async () => {
    const count = GIT_REVIEW_RENAME_LIMIT + 200;
    const base = fixture.fastCommit(
      Array.from({ length: count }, (_, index) => ({
        path: `old/f${String(index)}.txt`,
        content: numbered(6, `file ${String(index)}`),
      })),
    );
    const head = fixture.fastCommit(
      Array.from({ length: count }, (_, index) => ({
        path: `new/g${String(index)}.txt`,
        content: numbered(6, `file ${String(index)}`).replace("1\n", "one\n"),
      })),
    );
    const result = await packaged(fixture, base, head, { budgetTokens: 2_000 });
    const { summary } = result.coverage;
    expect(reportedCount(result.coverage)).toBe(summary.changedFiles);
    // Above the limit Git reports deletions and additions instead of inexact renames.
    expect(summary.changedFiles).toBe(count * 2);
    expect(result.coverage.deletedOnly).toHaveLength(count);
  }, 120_000);
});

describe("pathological hunks", () => {
  it("clips a file of thousands of hunks to whole hunks within the budget", async () => {
    const lines = numbered(16_000, "row");
    const changed = lines.replace(/^row (\d*0)$/gmu, "ROW $1");
    const base = fixture.commit([{ path: "huge.ts", content: lines }]);
    const head = fixture.commit([{ path: "huge.ts", content: changed }]);
    const result = await packaged(fixture, base, head, { budgetTokens: 5_000 });
    const [file] = result.coverage.included;
    expect(file).toMatchObject({ path: "huge.ts", hunkCount: 1_600, partial: true });
    expect(file?.includedHunkCount).toBeGreaterThan(10);
    expect(countContextTokens(result.text)).toBeLessThanOrEqual(5_000);
  }, 60_000);

  // #4134 left a hunk larger than the budget out: the file was unprocessed. A large new file is one
  // hunk, so 5 of the 30 reviews of development iteration 7 left 7 such files unprocessed
  // (#4130). The hunk is now shown as consecutive windows, each within the budget.
  it("shows a single hunk larger than one part as consecutive windows over the parts", async () => {
    const base = fixture.commit([{ path: "one.ts", content: numbered(10) }]);
    const head = fixture.commit([{ path: "one.ts", content: numbered(3_000, "replaced") }]);
    const full = await packaged(fixture, base, head, { budgetTokens: 1_000_000 });
    expect(full.files[0]?.hunks).toHaveLength(1);

    const result = await packaged(fixture, base, head, { budgetTokens: 2_000, maxParts: 12 });

    for (const part of result.parts) expect(part.usedTokens).toBeLessThanOrEqual(2_000);
    const [file] = result.files;
    expect(file?.hunks.length).toBeGreaterThan(1);
    // One Git hunk was split, however many windows it became.
    expect(result.windowedHunks).toBe(1);
    expect(full.windowedHunks).toBe(0);
    // Every line of the one hunk once, in order, on its own line numbers; none dropped.
    expect(numberedBody(file?.hunks ?? [])).toEqual(numberedBody(full.files[0]?.hunks ?? []));
    expect(result.coverage.unprocessed).toEqual([]);
    expect(result.coverage.included).toMatchObject([{ path: "one.ts", partial: false }]);
    expect(reviewDiffCoverageSettlement(result.coverage)).toEqual({ kind: "reviewable" });
    // Each window is in exactly one part, in order.
    const where = (file?.hunks ?? []).map((hunk) =>
      result.parts.findIndex((part) => part.text.includes(renderReviewHunk(hunk))),
    );
    expect(where.every((index) => index >= 0)).toBe(true);
    expect(where).toEqual([...where].sort((left, right) => left - right));
  });

  it("shows the leading windows of such a hunk when the parts run out", async () => {
    const base = fixture.commit([{ path: "one.ts", content: numbered(10) }]);
    const head = fixture.commit([{ path: "one.ts", content: numbered(3_000, "replaced") }]);
    const full = await packaged(fixture, base, head, { budgetTokens: 1_000_000 });

    const result = await packaged(fixture, base, head, { budgetTokens: 2_000 });

    expect(result.parts).toHaveLength(1);
    const shown = numberedBody(result.files[0]?.hunks ?? []);
    const all = numberedBody(full.files[0]?.hunks ?? []);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).toEqual(all.slice(0, shown.length));
    expect(result.windowedHunks).toBe(1);
    expect(result.coverage.included).toMatchObject([{ path: "one.ts", partial: true }]);
    expect(reviewDiffCoverageSettlement(result.coverage)).toEqual({
      kind: "incomplete",
      reason: "files-unprocessed",
    });
  });

  it("keeps a hunk whole that fits one part beside its file header", async () => {
    const base = fixture.commit([{ path: "one.ts", content: numbered(10) }]);
    const head = fixture.commit([{ path: "one.ts", content: numbered(120, "replaced") }]);
    const full = await packaged(fixture, base, head, { budgetTokens: 1_000_000 });
    const whole = countContextTokens(full.text);

    const result = await packaged(fixture, base, head, { budgetTokens: whole });

    expect(result.files[0]?.hunks).toEqual(full.files[0]?.hunks);
    expect(result.windowedHunks).toBe(0);
    expect(result.text).toBe(full.text);
  });
});
