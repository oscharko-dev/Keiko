// Scale and pathological inputs of the review diff package (Issue #4134): a large change set with
// a measured time bound, a rename storm beyond Git's rename limit, a file of thousands of hunks
// and a single hunk larger than the whole budget.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { GIT_REVIEW_RENAME_LIMIT } from "@oscharko-dev/keiko-git";
import { DiffFixtureRepository } from "./diffFixtures.test-support.js";
import {
  coverageLists,
  numbered,
  packaged,
  reportedPathKey,
} from "./diffPackageAssertions.test-support.js";

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

  it("never splits a single hunk larger than the whole budget", async () => {
    const base = fixture.commit([{ path: "one.ts", content: numbered(10) }]);
    const head = fixture.commit([{ path: "one.ts", content: numbered(3_000, "replaced") }]);
    const result = await packaged(fixture, base, head, { budgetTokens: 2_000 });
    expect(result.text).toBe("");
    expect(result.coverage.unprocessed).toMatchObject([{ path: "one.ts", reason: "budget" }]);
  });
});
