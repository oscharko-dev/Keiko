// Types of the review diff package builder (ADR-0182 D6, Issue #4134).

import type {
  ContextTokenAccounting,
  PatchHunk,
  ReviewDiffCoverage,
  ReviewDiffIncludedFile,
  ReviewDiffLanguage,
  ReviewDiffPackageFailure,
} from "@oscharko-dev/keiko-contracts";
import type { GitProcessRunner, GitReviewRunnerOptions } from "@oscharko-dev/keiko-git";

export interface ReviewDiffPackageConfig {
  /** The reviewer model's effective input budget for the diff content, in gateway tokens. */
  readonly budgetTokens: number;
  /** The reviewer model's token accounting, exactly as the gateway applies it at admission. */
  readonly tokenAccounting?: ContextTokenAccounting | undefined;
  /** Languages reviewed first, in order; default: the base commit's dominant languages. */
  readonly languagePriority?: readonly ReviewDiffLanguage[] | undefined;
  /** Paths the repository's review configuration excludes: exact paths, or prefixes ending in `/`. */
  readonly excludedPaths?: readonly string[] | undefined;
  readonly contextLinesBefore?: number | undefined;
  readonly contextLinesAfter?: number | undefined;
  readonly dynamicContextMaxLines?: number | undefined;
}

export interface ReviewDiffPackageInput {
  /** A repository that holds both commits; only its objects are read. */
  readonly repositoryRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly config: ReviewDiffPackageConfig;
  /** Cancels every Git process of the packaging; the result is then `cancelled`. */
  readonly abortSignal?: AbortSignal | undefined;
}

/** Bounds of one packaging; tests lower them, production uses the contract defaults. */
export interface ReviewDiffPackageLimits {
  readonly deadlineMs: number;
  readonly maxChangedFiles: number;
  readonly fileMaxChangedLines: number;
  readonly fileMaxPatchBytes: number;
  readonly maxTotalPatchBytes: number;
  /** Blobs above this size are never diffed; they are sniffed as binary or `too-large`. */
  readonly blobLimitBytes: number;
  readonly listingMaxBytes: number;
}

export interface ReviewDiffPackageDeps {
  /** Builds a hardened review runner (`createGitReviewProcessRunner`, observed in production). */
  readonly runner: (options: GitReviewRunnerOptions) => GitProcessRunner;
  readonly limits?: Partial<ReviewDiffPackageLimits> | undefined;
}

/** One packaged file and the hunks of it the package includes, with base and head line numbers. */
export interface ReviewDiffPackageFile {
  readonly coverage: ReviewDiffIncludedFile;
  readonly hunks: readonly PatchHunk[];
}

export interface ReviewDiffPackage {
  readonly baseSha: string;
  readonly headSha: string;
  /** The reviewer-facing content; its token count is `coverage.summary.usedTokens`. */
  readonly text: string;
  /** Included files in package order (the order of `text`). */
  readonly files: readonly ReviewDiffPackageFile[];
  readonly coverage: ReviewDiffCoverage;
}

export type ReviewDiffPackageResult =
  | { readonly ok: true; readonly package: ReviewDiffPackage }
  | { readonly ok: false; readonly failure: ReviewDiffPackageFailure };
