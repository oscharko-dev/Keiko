// The review diff package builder (ADR-0182 D6, Epic #4130, Issue #4134).
//
// Computes what a review target changed from the Git OBJECTS of its base and head commits, never
// from a working tree, and returns a compact, budget-bounded, prioritized package for the
// Reviewer together with complete coverage lists: every changed path appears in exactly one list
// with a closed reason, and any unprocessed or partially included file keeps the run from
// settling `complete` (`reviewDiffCoverageSettlement`). The packaging is a port of PR-Agent
// v0.49.0 (MIT) `pr_processing.py` and `git_patch_processing.py` onto Keiko's hardened review
// runner: no hook, filter, textconv, external diff or in-tree attribute runs, every object is
// named by id, and every exceeded time or byte bound fails the package closed (`diff-too-large`).
//
// This builder has no Activity Log emitter of its own: its Git processes are observed by the runner
// the caller supplies, and child 6 (#4136) records its counts and reason codes, never its paths, on
// the review run's phase and settlement operations.

import { isAbsolute } from "node:path";
import type { ReviewDiffLanguage } from "@oscharko-dev/keiko-contracts";
import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { isGitObjectId } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import {
  REVIEW_DIFF_CONTEXT_LINES_AFTER,
  REVIEW_DIFF_CONTEXT_LINES_BEFORE,
  REVIEW_DIFF_CONTEXT_LINES_MAX,
  REVIEW_DIFF_DEFAULT_DEADLINE_MS,
  REVIEW_DIFF_DYNAMIC_CONTEXT_MAX_LINES,
  REVIEW_DIFF_FILE_MAX_CHANGED_LINES,
  REVIEW_DIFF_FILE_MAX_PATCH_BYTES,
  REVIEW_DIFF_LANGUAGES,
  REVIEW_DIFF_MAX_CHANGED_FILES,
  REVIEW_DIFF_MAX_TOTAL_PATCH_BYTES,
  REVIEW_WORKTREE_DEFAULT_BLOB_LIMIT_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { listGitReviewChanges, type GitReviewOperationContext } from "@oscharko-dev/keiko-git";
import { classifyReviewChange, type ReviewDiffChangedFile } from "./classify.js";
import { ReviewDiffCoverageBuilder } from "./coverage.js";
import {
  gitFailed,
  ReviewDiffPackagingFailure,
  reviewDiffPackagingAbort,
  reviewDiffStepFailure,
  throwIfReviewDiffStopped,
  tooLarge,
  type ReviewDiffPackagingAbort,
} from "./failure.js";
import type { ReviewDiffContextOptions } from "./hunks.js";
import { packReviewCandidates } from "./packing.js";
import { reviewPathKey } from "./paths.js";
import { dominantLanguages, resolveSizedFiles, type ReviewDiffReadContext } from "./reads.js";
import type {
  ReviewDiffPackageConfig,
  ReviewDiffPackageDeps,
  ReviewDiffPackageInput,
  ReviewDiffPackageLimits,
  ReviewDiffPackageResult,
} from "./types.js";

const LISTING_TIMEOUT_MS = 120_000;
const FILE_TIMEOUT_MS = 60_000;
const DEFAULT_LISTING_MAX_BYTES = 64 * 1024 * 1024;
const MAX_BUDGET_TOKENS = 10_000_000;
const MAX_EXCLUDED_PATHS = 1_000;

const DEFAULT_LIMITS: ReviewDiffPackageLimits = {
  deadlineMs: REVIEW_DIFF_DEFAULT_DEADLINE_MS,
  maxChangedFiles: REVIEW_DIFF_MAX_CHANGED_FILES,
  fileMaxChangedLines: REVIEW_DIFF_FILE_MAX_CHANGED_LINES,
  fileMaxPatchBytes: REVIEW_DIFF_FILE_MAX_PATCH_BYTES,
  maxTotalPatchBytes: REVIEW_DIFF_MAX_TOTAL_PATCH_BYTES,
  blobLimitBytes: REVIEW_WORKTREE_DEFAULT_BLOB_LIMIT_BYTES,
  listingMaxBytes: DEFAULT_LISTING_MAX_BYTES,
};

function contextLines(value: number | undefined, fallback: number): number {
  const lines = value ?? fallback;
  if (!Number.isSafeInteger(lines) || lines < 0 || lines > REVIEW_DIFF_CONTEXT_LINES_MAX) {
    throw new TypeError("invalid review diff context lines");
  }
  return lines;
}

function contextOptions(config: ReviewDiffPackageConfig): ReviewDiffContextOptions {
  return {
    before: contextLines(config.contextLinesBefore, REVIEW_DIFF_CONTEXT_LINES_BEFORE),
    after: contextLines(config.contextLinesAfter, REVIEW_DIFF_CONTEXT_LINES_AFTER),
    dynamicMax: contextLines(config.dynamicContextMaxLines, REVIEW_DIFF_DYNAMIC_CONTEXT_MAX_LINES),
  };
}

function validateTarget(input: ReviewDiffPackageInput): void {
  const { baseSha, headSha } = input;
  if (!isAbsolute(input.repositoryRoot) || !isGitObjectId(baseSha) || !isGitObjectId(headSha)) {
    throw new TypeError("invalid review diff package target");
  }
  if (baseSha.length !== headSha.length) throw new TypeError("mixed review object formats");
}

const KNOWN_LANGUAGES: ReadonlySet<string> = new Set(REVIEW_DIFF_LANGUAGES);

function validateConfig(config: ReviewDiffPackageConfig): void {
  const budget = config.budgetTokens;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_BUDGET_TOKENS) {
    throw new TypeError("invalid review diff budget");
  }
  const excluded = config.excludedPaths ?? [];
  if (excluded.length > MAX_EXCLUDED_PATHS || excluded.some((path) => path.length === 0)) {
    throw new TypeError("invalid review diff exclusions");
  }
  const priority = config.languagePriority ?? [];
  const unique = new Set(priority).size === priority.length;
  if (!unique || priority.some((language) => !KNOWN_LANGUAGES.has(language))) {
    throw new TypeError("invalid review diff language priority");
  }
  contextOptions(config);
}

/** Language rank: the priority order first, then every other language, `other` last. */
function languageRanks(priority: readonly ReviewDiffLanguage[]): Map<ReviewDiffLanguage, number> {
  const ranks = new Map<ReviewDiffLanguage, number>();
  for (const language of [...priority, ...REVIEW_DIFF_LANGUAGES]) {
    if (!ranks.has(language) && language !== "other") ranks.set(language, ranks.size);
  }
  ranks.set("other", ranks.size);
  return ranks;
}

function operationContext(
  deps: ReviewDiffPackageDeps,
  sha: string,
  abort: ReviewDiffPackagingAbort,
  limits: ReviewDiffPackageLimits,
): Pick<ReviewDiffReadContext, "ctx" | "fileCtx"> {
  const runner = deps.runner({
    bigFileThresholdBytes: limits.blobLimitBytes,
    neutralizeTreeAttributes: sha.length === 40 ? "sha1" : "sha256",
  });
  const base: GitReviewOperationContext = { runner, abortSignal: abort.signal };
  return {
    ctx: { ...base, timeoutMs: LISTING_TIMEOUT_MS, maxBytes: limits.listingMaxBytes },
    fileCtx: { ...base, timeoutMs: FILE_TIMEOUT_MS, maxBytes: limits.fileMaxPatchBytes },
  };
}

async function listChangedFiles(
  read: ReviewDiffReadContext,
  input: ReviewDiffPackageInput,
  limits: ReviewDiffPackageLimits,
): Promise<readonly ReviewDiffChangedFile[]> {
  const { baseSha, headSha } = input;
  const listed = await listGitReviewChanges(read.ctx, { cwd: read.cwd, baseSha, headSha });
  if (!listed.ok) {
    if ("malformed" in listed) throw gitFailed();
    throw reviewDiffStepFailure(listed.result, read.abort, "listing-bytes");
  }
  if (listed.value.length > limits.maxChangedFiles) throw tooLarge("changed-files");
  const options = {
    excludedPaths: input.config.excludedPaths ?? [],
    fileMaxChangedLines: limits.fileMaxChangedLines,
  };
  const files = listed.value.map((change) => classifyReviewChange(change, options));
  // A path listed twice comes only from a malformed tree; coverage could not be exact.
  if (new Set(files.map((file) => reviewPathKey(file.change.path))).size !== files.length) {
    throw gitFailed();
  }
  return files;
}

async function placeSizedFiles(
  read: ReviewDiffReadContext,
  files: readonly ReviewDiffChangedFile[],
  limits: ReviewDiffPackageLimits,
  coverage: ReviewDiffCoverageBuilder,
): Promise<void> {
  const sized = files.filter((file) => file.placement.list === "sized");
  const verdicts = await resolveSizedFiles(read, sized, limits.blobLimitBytes);
  for (const file of sized) {
    if (verdicts.get(file) === "binary") coverage.add("binary", file);
    else coverage.addUnprocessed(file, "too-large");
  }
}

function placeListedFiles(
  files: readonly ReviewDiffChangedFile[],
  coverage: ReviewDiffCoverageBuilder,
): ReviewDiffChangedFile[] {
  const candidates: ReviewDiffChangedFile[] = [];
  for (const file of files) {
    const placement = file.placement;
    if (placement.list === "candidate") candidates.push(file);
    else if (placement.list === "filtered") coverage.addFiltered(file, placement.reason);
    else if (placement.list === "too-large") coverage.addUnprocessed(file, "too-large");
    else if (placement.list !== "sized") coverage.add(placement.list, file);
  }
  return candidates;
}

async function buildPackage(
  deps: ReviewDiffPackageDeps,
  input: ReviewDiffPackageInput,
  limits: ReviewDiffPackageLimits,
  abort: ReviewDiffPackagingAbort,
): Promise<ReviewDiffPackageResult> {
  const { config } = input;
  const read: ReviewDiffReadContext = {
    ...operationContext(deps, input.headSha, abort, limits),
    cwd: input.repositoryRoot,
    abort,
  };
  const files = await listChangedFiles(read, input, limits);
  const coverage = new ReviewDiffCoverageBuilder();
  const candidates = placeListedFiles(files, coverage);
  await placeSizedFiles(read, files, limits, coverage);
  throwIfReviewDiffStopped(abort);
  const priority = config.languagePriority ?? (await dominantLanguages(read, input.baseSha));
  const count = (text: string): number => countContextTokens(text, config.tokenAccounting);
  const packed = await packReviewCandidates(read, candidates, {
    ranks: languageRanks(priority),
    context: contextOptions(config),
    budgetTokens: config.budgetTokens,
    maxTotalPatchBytes: limits.maxTotalPatchBytes,
    count,
    coverage,
  });
  const { baseSha, headSha } = input;
  const result = coverage.build(config.budgetTokens, packed.usedTokens);
  return {
    ok: true,
    package: { baseSha, headSha, text: packed.text, files: packed.files, coverage: result },
  };
}

/**
 * Builds the review diff package of `baseSha..headSha`. Throws `TypeError` for an invalid target
 * or configuration (a caller defect); every runtime failure is a typed result.
 */
export async function buildReviewDiffPackage(
  deps: ReviewDiffPackageDeps,
  input: ReviewDiffPackageInput,
): Promise<ReviewDiffPackageResult> {
  validateTarget(input);
  validateConfig(input.config);
  const limits: ReviewDiffPackageLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const abort = reviewDiffPackagingAbort(limits.deadlineMs, input.abortSignal);
  try {
    throwIfReviewDiffStopped(abort);
    return await buildPackage(deps, input, limits, abort);
  } catch (error) {
    if (error instanceof ReviewDiffPackagingFailure) return { ok: false, failure: error.failure };
    throw error;
  }
}
