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

  // #4134's rule holds unchanged for a package of one part: no part is unopened, so nothing is
  // split and the file is left out.
  it("never splits a single hunk larger than the whole budget of a single part", async () => {
    const base = fixture.commit([{ path: "one.ts", content: numbered(10) }]);
    const head = fixture.commit([{ path: "one.ts", content: numbered(3_000, "replaced") }]);
    const result = await packaged(fixture, base, head, { budgetTokens: 2_000 });
    expect(result.text).toBe("");
    expect(result.windowedHunks).toBe(0);
    expect(result.coverage.unprocessed).toMatchObject([{ path: "one.ts", reason: "budget" }]);
  });

  // R4130-063, R4130-064: a hunk is split only when its file fits the windows the unopened parts
  // can hold. A file larger than that is left out whole, as before the split existed.
  it("leaves a hunk out that is larger than the parts that are left, and shows no window of it", async () => {
    const base = fixture.commit([{ path: "one.ts", content: numbered(10) }]);
    const head = fixture.commit([{ path: "one.ts", content: numbered(3_000, "replaced") }]);
    const result = await packaged(fixture, base, head, { budgetTokens: 2_000, maxParts: 3 });
    expect(result.text).toBe("");
    expect(result.parts).toEqual([]);
    expect(result.windowedHunks).toBe(0);
    expect(result.coverage.unprocessed).toMatchObject([{ path: "one.ts", reason: "budget" }]);
  });

  const SMALL = ["s1.ts", "s2.ts", "s3.ts"];
  function withSmallFiles(bigLines: number): { readonly base: string; readonly head: string } {
    const small = (text: string): { path: string; content: string }[] =>
      SMALL.map((path) => ({ path, content: `export const value = "${text}";\n` }));
    const base = fixture.commit([{ path: "big.ts", content: numbered(10) }, ...small("before")]);
    const head = fixture.commit([
      { path: "big.ts", content: numbered(bigLines, "replaced") },
      ...small("after"),
    ]);
    return { base, head };
  }

  // R4130-064: larger changes sort first, so before this rule the big file's windows took the
  // parts and the small files that fit were left out.
  it("places a file with an oversized hunk after the files that fit, although it sorts first", async () => {
    const { base, head } = withSmallFiles(600);
    const result = await packaged(fixture, base, head, { budgetTokens: 2_000, maxParts: 12 });

    expect(result.files.map((file) => file.coverage.path)).toEqual([...SMALL, "big.ts"]);
    expect(result.coverage.unprocessed).toEqual([]);
    expect(result.coverage.included.every((file) => !file.partial)).toBe(true);
    expect(result.windowedHunks).toBe(1);
    for (const path of SMALL) expect(result.parts[0]?.text).toContain(path);
  });

  it("leaves a file larger than all parts out and still shows the files that fit whole", async () => {
    const { base, head } = withSmallFiles(8_000);
    const result = await packaged(fixture, base, head, { budgetTokens: 2_000, maxParts: 12 });

    expect(result.parts).toHaveLength(1);
    expect(result.files.map((file) => file.coverage.path)).toEqual(SMALL);
    expect(result.coverage.included.every((file) => !file.partial)).toBe(true);
    expect(result.coverage.unprocessed).toMatchObject([{ path: "big.ts", reason: "budget" }]);
    expect(result.windowedHunks).toBe(0);
  });

  // R4130-063: four files of about 1.8 MB each. Splitting them took 37 s on one thread, for windows
  // that no part could take. They are measured once and left out; the bound is the large
  // fixture's, which this fixture stays far below.
  it("splits nothing of files far larger than the parts, within the measured bound", async () => {
    const line = (index: number): string => `const v${String(index)} = "${"x".repeat(170)}";`;
    const large = (salt: string): string =>
      Array.from({ length: 9_500 }, (_, index) => `${line(index)} // ${salt}`).join("\n") + "\n";
    const names = ["a1.ts", "a2.ts", "a3.ts", "a4.ts"];
    const base = fixture.commit([
      ...names.map((path) => ({ path, content: large("before") })),
      { path: "s1.ts", content: "export const value = 1;\n" },
    ]);
    const head = fixture.commit([
      ...names.map((path) => ({ path, content: large("after") })),
      { path: "s1.ts", content: "export const value = 2;\n" },
    ]);

    const started = performance.now();
    const result = await packaged(fixture, base, head, { budgetTokens: 13_832, maxParts: 12 });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(LARGE_FIXTURE_BOUND_MS);
    expect(result.windowedHunks).toBe(0);
    expect(result.files.map((file) => file.coverage.path)).toEqual(["s1.ts"]);
    expect(result.coverage.unprocessed.map((file) => file.path).sort()).toEqual(names);
  }, 120_000);

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
