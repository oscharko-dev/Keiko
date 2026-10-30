// The review-rules reader (ADR-0182 D4, Issue #4135).
//
// The rules come from the BASE commit object only: `<baseSha>:<path>` is resolved and read through
// the hardened review runner, never from the head commit, the review worktree or the user's
// checkout, so a pull request cannot change the rules it is reviewed against. The path is the
// repository's configured review-rules path (default `.keiko/review-rules.md`); `AGENTS.md` is never
// read here. The content is untrusted data: it reaches the Reviewer only inside a fenced data
// block (`reviewPrompt.ts`) and never decides a tool, a permission or the output contract.

import {
  REVIEW_RULES_FILE_DEFAULT_PATH,
  REVIEW_RULES_FILE_MAX_BYTES,
  type ReviewRulesFileOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { isPortableWorkspaceRelativePath } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import { hasControlCharacter } from "@oscharko-dev/keiko-contracts/text-safety";
import {
  readGitReviewBlob,
  readGitReviewPathObject,
  type GitProcessRunner,
} from "@oscharko-dev/keiko-git";

const RULES_READ_TIMEOUT_MS = 10_000;

/** Supplies the repository's configured rules path (child 7 persists it; absent is the default). */
export interface ReviewRulesSettingsPort {
  rulesPath(repositoryRoot: string): string | undefined;
}

export interface ReviewRulesReadInput {
  /** A repository (or one of its worktrees) whose object store holds the base commit. */
  readonly repositoryRoot: string;
  readonly baseSha: string;
  /** The configured path; absent means `REVIEW_RULES_FILE_DEFAULT_PATH`. */
  readonly path?: string | undefined;
  /** A hardened review runner (`createGitReviewProcessRunner`). */
  readonly runner: GitProcessRunner;
  readonly abortSignal?: AbortSignal | undefined;
}

export type ReviewRulesReadResult =
  | { readonly outcome: "loaded"; readonly text: string; readonly byteCount: number }
  | { readonly outcome: Exclude<ReviewRulesFileOutcome, "loaded">; readonly byteCount: number };

/** Thrown when the base commit cannot be read at all; the caller settles the run, never "no rules". */
export class ReviewRulesReadError extends Error {
  public constructor() {
    super("review rules could not be read from the base commit");
    this.name = "ReviewRulesReadError";
  }
}

/**
 * Resolves the configured path: absent is the default, anything that is not a portable,
 * workspace-relative path is `path-invalid` (never a lookup outside the tree).
 */
export function resolveReviewRulesPath(path: string | undefined): string | undefined {
  const candidate = path ?? REVIEW_RULES_FILE_DEFAULT_PATH;
  return isPortableWorkspaceRelativePath(candidate) && !hasControlCharacter(candidate)
    ? candidate
    : undefined;
}

/** A decoded rules text Keiko admits: no replacement character (invalid UTF-8) and no NUL. */
function isAdmissibleText(text: string): boolean {
  return !text.includes("�") && !text.includes("\u0000");
}

/**
 * Reads the review rules of one base commit. `absent` when the base commit has no such file (the
 * run proceeds with no rules), `too-large` above 16 KiB and `not-utf8` for undecodable content (the
 * run settles `skipped/rules-file-invalid`), `path-invalid` for a configured path that cannot name a
 * file in the tree. A path naming a directory or a submodule is `absent`: there is no rules file.
 */
export async function readReviewRulesFromBase(
  input: ReviewRulesReadInput,
): Promise<ReviewRulesReadResult> {
  const path = resolveReviewRulesPath(input.path);
  if (path === undefined) return { outcome: "path-invalid", byteCount: 0 };
  const ctx = {
    runner: input.runner,
    timeoutMs: RULES_READ_TIMEOUT_MS,
    abortSignal: input.abortSignal,
  };
  const object = await readGitReviewPathObject(ctx, {
    cwd: input.repositoryRoot,
    sha: input.baseSha,
    path,
  });
  if (!object.ok) throw new ReviewRulesReadError();
  if (object.value?.type !== "blob") return { outcome: "absent", byteCount: 0 };
  const byteCount = object.value.size;
  if (byteCount > REVIEW_RULES_FILE_MAX_BYTES) return { outcome: "too-large", byteCount };
  const blob = await readGitReviewBlob(
    { ...ctx, maxBytes: REVIEW_RULES_FILE_MAX_BYTES },
    { cwd: input.repositoryRoot, oid: object.value.oid },
  );
  if (!blob.ok) throw new ReviewRulesReadError();
  if (!isAdmissibleText(blob.value)) return { outcome: "not-utf8", byteCount };
  return { outcome: "loaded", text: blob.value, byteCount };
}
