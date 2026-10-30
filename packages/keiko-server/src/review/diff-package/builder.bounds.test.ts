// Budget and resource bounds of the review diff package (Issue #4134, AC3 and AC6).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextTokenAccounting } from "@oscharko-dev/keiko-contracts";
import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { reviewDiffCoverageSettlement } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";
import type { GitProcessResult, GitProcessRunner } from "@oscharko-dev/keiko-git";
import { buildReviewDiffPackage } from "./builder.js";
import { DiffFixtureRepository, realRunnerDeps } from "./diffFixtures.test-support.js";
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

const ACCOUNTINGS: readonly (ContextTokenAccounting | undefined)[] = [
  undefined,
  { source: "calibrated", counterId: "test-calibration", scaleMilli: 1_450, offsetTokens: 3 },
];

describe("token budget (AC3)", () => {
  it("never exceeds the budget as the gateway counts it and never splits a hunk", async () => {
    const { base, head } = changeSet();
    const full = await packaged(fixture, base, head, { budgetTokens: 1_000_000 });
    const fullHunks = new Map(full.files.map((file) => [file.coverage.path, file.hunks]));
    for (const tokenAccounting of ACCOUNTINGS) {
      for (const budgetTokens of [1, 20, 60, 90, 150, 240, 400, 700, 1_100, 1_800, 3_000, 9_000]) {
        const result = await packaged(fixture, base, head, { budgetTokens, tokenAccounting });
        const measured =
          result.text.length === 0 ? 0 : countContextTokens(result.text, tokenAccounting);
        expect(measured, `budget ${String(budgetTokens)}`).toBeLessThanOrEqual(budgetTokens);
        expect(result.coverage.summary.usedTokens).toBe(measured);
        for (const file of result.files) {
          // Whole hunks only: each included hunk is the same hunk the unbounded package has, in order.
          const all = fullHunks.get(file.coverage.path) ?? [];
          expect(file.hunks).toEqual(all.slice(0, file.hunks.length));
          for (const hunk of file.hunks) expect(result.text).toContain(renderReviewHunk(hunk));
          expect(file.coverage.partial).toBe(file.hunks.length < all.length);
        }
      }
    }
  });

  it("clips a file to whole leading hunks and settles the run as incomplete", async () => {
    const base = fixture.commit([{ path: "big.ts", content: spaced(6, false) }]);
    const head = fixture.commit([{ path: "big.ts", content: spaced(6, true) }]);
    const full = await packaged(fixture, base, head, { budgetTokens: 1_000_000 });
    const twoHunks = countContextTokens(
      `## File: 'big.ts'\n${(full.files[0]?.hunks ?? []).slice(0, 2).map(renderReviewHunk).join("")}`,
    );
    const clipped = await packaged(fixture, base, head, { budgetTokens: twoHunks + 1 });
    expect(clipped.coverage.included).toMatchObject([
      { path: "big.ts", hunkCount: 6, includedHunkCount: 2, partial: true },
    ]);
    expect(clipped.coverage.summary).toMatchObject({ reviewedFiles: 0, partiallyReviewedFiles: 1 });
    expect(reviewDiffCoverageSettlement(clipped.coverage)).toEqual({
      kind: "incomplete",
      reason: "files-unprocessed",
    });
  });

  it("orders the dominant language first and larger changes first within it", async () => {
    const base = fixture.commit([
      { path: "a.py", content: spaced(1, false, "p") },
      { path: "b.ts", content: spaced(1, false, "t") },
      { path: "c.ts", content: spaced(3, false, "t") },
      { path: "lib/main.py", content: numbered(500, "python weight") },
    ]);
    const head = fixture.commit([
      { path: "a.py", content: spaced(1, true, "p") },
      { path: "b.ts", content: spaced(1, true, "t") },
      { path: "c.ts", content: spaced(3, true, "t") },
      { path: "lib/main.py", content: numbered(500, "python weight") },
    ]);
    const dominant = await packaged(fixture, base, head, { budgetTokens: 100_000 });
    expect(dominant.files.map((file) => file.coverage.path)).toEqual(["a.py", "c.ts", "b.ts"]);
    const configured = await packaged(fixture, base, head, {
      budgetTokens: 100_000,
      languagePriority: ["typescript"],
    });
    expect(configured.files.map((file) => file.coverage.path)).toEqual(["c.ts", "b.ts", "a.py"]);
  });

  it("stops reading contents once files keep missing the budget", async () => {
    const files = Array.from({ length: 150 }, (_, index) => `src/f${String(index)}.ts`);
    const base = fixture.fastCommit(files.map((path) => ({ path, content: spaced(2, false) })));
    const head = fixture.fastCommit(files.map((path) => ({ path, content: spaced(2, true) })));
    let reads = 0;
    const counting = realRunnerDeps({}, (runner): GitProcessRunner => (args, options) => {
      if (args.includes("diff")) reads += 1;
      return runner(args, options);
    });
    const result = await packaged(fixture, base, head, { budgetTokens: 1_500 }, counting);
    const included = result.coverage.included.length;
    expect(included).toBeGreaterThan(0);
    expect(result.coverage.summary.changedFiles).toBe(150);
    expect(result.coverage.unprocessed).toHaveLength(150 - included);
    // Whole files that fit, then at most 32 misses (plus one parallel batch) are read.
    expect(reads).toBeLessThanOrEqual(included + 32 + 4);
  });

  it("reports every file that did not fit as unprocessed for the budget", async () => {
    const { base, head } = changeSet();
    const result = await packaged(fixture, base, head, { budgetTokens: 1 });
    expect(result.text).toBe("");
    expect(result.coverage.unprocessed.map((file) => file.reason)).toEqual(Array(9).fill("budget"));
    expect(reviewDiffCoverageSettlement(result.coverage)).toEqual({
      kind: "skipped",
      reason: "diff-too-large",
    });
  });
});

function failing(
  subcommand: string,
  outcome: Partial<GitProcessResult>,
): (runner: GitProcessRunner) => GitProcessRunner {
  return (runner) => (args, options) =>
    args.includes(subcommand)
      ? Promise.resolve({
          exitCode: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          truncated: true,
          ...outcome,
        })
      : runner(args, options);
}

function hanging(): (runner: GitProcessRunner) => GitProcessRunner {
  return (runner) => (args, options) =>
    args.includes("diff-tree")
      ? new Promise((resolve) => {
          options.abortSignal?.addEventListener("abort", () => {
            resolve({
              exitCode: null,
              signal: "SIGTERM",
              stdout: "",
              stderr: "",
              truncated: true,
              aborted: true,
            });
          });
        })
      : runner(args, options);
}

describe("resource bounds fail closed (AC6)", () => {
  function twoFiles(): { readonly base: string; readonly head: string } {
    const base = fixture.commit([
      { path: "a.ts", content: spaced(2, false) },
      { path: "b.ts", content: spaced(2, false) },
      { path: "c.ts", content: spaced(2, false) },
    ]);
    const head = fixture.commit([
      { path: "a.ts", content: spaced(2, true) },
      { path: "b.ts", content: spaced(2, true) },
      { path: "c.ts", content: spaced(2, true) },
    ]);
    return { base, head };
  }

  it("refuses more changed files than the bound", async () => {
    const { base, head } = twoFiles();
    const result = await build(
      fixture,
      base,
      head,
      undefined,
      realRunnerDeps({ maxChangedFiles: 2 }),
    );
    expect(result).toEqual({
      ok: false,
      failure: { reason: "diff-too-large", detail: "changed-files" },
    });
  });

  it("refuses a listing beyond its byte cap", async () => {
    const { base, head } = twoFiles();
    const result = await build(
      fixture,
      base,
      head,
      undefined,
      realRunnerDeps({ listingMaxBytes: 64 }),
    );
    expect(result).toEqual({
      ok: false,
      failure: { reason: "diff-too-large", detail: "listing-bytes" },
    });
  });

  it("refuses patch reads beyond the total byte bound", async () => {
    const { base, head } = twoFiles();
    const result = await build(
      fixture,
      base,
      head,
      undefined,
      realRunnerDeps({ maxTotalPatchBytes: 100 }),
    );
    expect(result).toEqual({
      ok: false,
      failure: { reason: "diff-too-large", detail: "patch-bytes" },
    });
  });

  it("refuses a packaging that outlives its deadline", async () => {
    const { base, head } = twoFiles();
    const result = await build(
      fixture,
      base,
      head,
      undefined,
      realRunnerDeps({ deadlineMs: 50 }, hanging()),
    );
    expect(result).toEqual({
      ok: false,
      failure: { reason: "diff-too-large", detail: "deadline" },
    });
  });

  it("returns cancelled when the caller aborts", async () => {
    const { base, head } = twoFiles();
    const controller = new AbortController();
    const pending = buildReviewDiffPackage(realRunnerDeps({}, hanging()), {
      repositoryRoot: fixture.repo,
      baseSha: base,
      headSha: head,
      config: { budgetTokens: 1_000 },
      abortSignal: controller.signal,
    });
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: { reason: "cancelled" } });
  });

  it("marks a file whose patch read timed out or hit its cap as unprocessed", async () => {
    const { base, head } = twoFiles();
    const timedOut = await packaged(
      fixture,
      base,
      head,
      undefined,
      realRunnerDeps({}, failing("diff", { timedOut: true })),
    );
    expect(timedOut.coverage.unprocessed.map((file) => file.reason)).toEqual([
      "timeout",
      "timeout",
      "timeout",
    ]);
    const capped = await packaged(
      fixture,
      base,
      head,
      undefined,
      realRunnerDeps({ fileMaxPatchBytes: 64 }),
    );
    expect(capped.coverage.unprocessed.map((file) => file.reason)).toEqual([
      "too-large",
      "too-large",
      "too-large",
    ]);
    expect(reviewDiffCoverageSettlement(capped.coverage).kind).toBe("skipped");
  });

  it("marks a file with more changed lines than the bound as too-large without reading it", async () => {
    const base = fixture.commit([
      { path: "a.ts", content: "a\n" },
      { path: "b.ts", content: spaced(1, false) },
    ]);
    const head = fixture.commit([
      { path: "a.ts", content: numbered(50) },
      { path: "b.ts", content: spaced(1, true) },
    ]);
    const result = await packaged(
      fixture,
      base,
      head,
      undefined,
      realRunnerDeps({ fileMaxChangedLines: 20 }),
    );
    expect(result.coverage.unprocessed).toMatchObject([{ path: "a.ts", reason: "too-large" }]);
    expect(reviewDiffCoverageSettlement(result.coverage)).toEqual({
      kind: "incomplete",
      reason: "files-unprocessed",
    });
  });

  it("fails as git-failed when an object is missing", async () => {
    const base = fixture.commit([{ path: "a.ts", content: "a\n" }]);
    const result = await build(fixture, base, "d".repeat(40));
    expect(result).toEqual({ ok: false, failure: { reason: "git-failed" } });
  });

  it("rejects an invalid target or configuration before any Git process", async () => {
    const base = fixture.commit([{ path: "a.ts", content: "a\n" }]);
    await expect(build(fixture, base, "HEAD")).rejects.toThrow(TypeError);
    await expect(build(fixture, base, base, { budgetTokens: 0 })).rejects.toThrow(TypeError);
    await expect(
      build(fixture, base, base, { budgetTokens: 10, contextLinesBefore: 11 }),
    ).rejects.toThrow(TypeError);
    await expect(
      build(fixture, base, base, { budgetTokens: 10, languagePriority: ["go", "go"] }),
    ).rejects.toThrow(TypeError);
    await expect(
      build(fixture, base, base, { budgetTokens: 10, excludedPaths: [""] }),
    ).rejects.toThrow(TypeError);
  });
});
