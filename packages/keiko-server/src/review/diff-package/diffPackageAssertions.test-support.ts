// Shared helpers of the review diff package suites (Issue #4134).

import type { ReviewDiffCoverage, ReviewDiffFileRef } from "@oscharko-dev/keiko-contracts";
import { buildReviewDiffPackage } from "./builder.js";
import { realRunnerDeps, type DiffFixtureRepository } from "./diffFixtures.test-support.js";
import type {
  ReviewDiffPackage,
  ReviewDiffPackageConfig,
  ReviewDiffPackageDeps,
  ReviewDiffPackageResult,
} from "./types.js";

const DEFAULT_TEST_CONFIG: ReviewDiffPackageConfig = {
  budgetTokens: 100_000,
  languagePriority: ["typescript"],
};

/** `count` numbered lines, each ending in a newline. */
export function numbered(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1)}\n`).join("");
}

export function build(
  fixture: DiffFixtureRepository,
  baseSha: string,
  headSha: string,
  config: ReviewDiffPackageConfig = DEFAULT_TEST_CONFIG,
  deps: ReviewDiffPackageDeps = realRunnerDeps(),
): Promise<ReviewDiffPackageResult> {
  return buildReviewDiffPackage(deps, {
    repositoryRoot: fixture.repo,
    baseSha,
    headSha,
    config,
  });
}

export async function packaged(
  fixture: DiffFixtureRepository,
  baseSha: string,
  headSha: string,
  config?: ReviewDiffPackageConfig,
  deps?: ReviewDiffPackageDeps,
): Promise<ReviewDiffPackage> {
  const result = await build(fixture, baseSha, headSha, config, deps);
  if (!result.ok) throw new Error(`packaging failed: ${JSON.stringify(result.failure)}`);
  return result.package;
}

/** Every coverage list by name. */
export function coverageLists(
  coverage: ReviewDiffCoverage,
): Readonly<Record<string, readonly ReviewDiffFileRef[]>> {
  const { summary: _summary, ...lists } = coverage;
  return lists;
}

/** The names of the lists that hold `path`. */
export function listNames(coverage: ReviewDiffCoverage, path: string): string[] {
  return Object.entries(coverageLists(coverage))
    .filter(([, entries]) => entries.some((entry) => entry.path === path))
    .map(([name]) => name);
}

/** The identity key (exact bytes) of a reported path. */
export function reportedPathKey(file: ReviewDiffFileRef): string {
  return file.pathBytesBase64 ?? Buffer.from(file.path, "utf8").toString("base64");
}
