// The evaluation repository of the offline review gate (Issue #4138, ADR-0182 D9): a local clone
// of Keiko that holds the commits every replayed pull request and every consumer seed needs. The
// review service reviews `local-range` targets between two local branches, so this module creates
// them: for a pull request, its merge base and its final head; for a consumer seed, a pinned base
// commit and one commit on top of it with the seeded file. Every Git call ignores the system and
// global configuration and runs no hook; nothing here pushes or changes a remote.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const SEED_IDENTITY = {
  GIT_AUTHOR_NAME: "Keiko review gate",
  GIT_AUTHOR_EMAIL: "review-gate@keiko.invalid",
  GIT_COMMITTER_NAME: "Keiko review gate",
  GIT_COMMITTER_EMAIL: "review-gate@keiko.invalid",
  GIT_AUTHOR_DATE: "2026-10-30T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-30T00:00:00Z",
} as const;

export class EvaluationRepositoryError extends Error {
  public constructor(step: string, detail: string) {
    super(`evaluation repository: ${step} failed (${detail})`);
    this.name = "EvaluationRepositoryError";
  }
}

interface GitOptions {
  readonly input?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function runGit(repository: string, args: readonly string[], options: GitOptions = {}): GitResult {
  const result = spawnSync(
    "git",
    ["-C", repository, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    {
      encoding: "utf8",
      input: options.input,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...options.env,
      },
    },
  );
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr.trim().slice(0, 200),
  };
}

/** Runs one Git command and returns its trimmed output; a failure throws with its first stderr. */
export function git(repository: string, args: readonly string[], options?: GitOptions): string {
  const result = runGit(repository, args, options);
  if (!result.ok) throw new EvaluationRepositoryError(args[0] ?? "git", result.stderr);
  return result.stdout.trim();
}

export function hasCommit(repository: string, sha: string): boolean {
  return runGit(repository, ["cat-file", "-e", `${sha}^{commit}`]).ok;
}

/** The two branches a replayed pull request is reviewed between. */
export interface EvaluationRefs {
  readonly baseRef: string;
  readonly headRef: string;
}

export function pullRequestRefs(pullRequest: number): EvaluationRefs {
  return {
    baseRef: `keiko-eval/pr-${String(pullRequest)}/base`,
    headRef: `keiko-eval/pr-${String(pullRequest)}/head`,
  };
}

export function seedRefs(seedId: string): EvaluationRefs {
  return { baseRef: `keiko-eval/seed-${seedId}/base`, headRef: `keiko-eval/seed-${seedId}/head` };
}

/** Fetches a missing commit from `origin`: by the given ref when there is one, else by its id. */
function ensureCommit(repository: string, sha: string, ref: string | undefined): boolean {
  if (hasCommit(repository, sha)) return true;
  runGit(repository, ["fetch", "--no-tags", "--quiet", "origin", ref ?? sha]);
  return hasCommit(repository, sha);
}

export interface PullRequestCommits {
  readonly number: number;
  readonly baseCommit: string | null;
  readonly headCommit: string | null;
}

/**
 * Creates the pull request's two branches, fetching its commits from `origin` when the clone lacks
 * them. Returns `undefined` when a commit is not recorded or cannot be obtained; the caller reports
 * such a pull request as unavailable instead of reviewing something else.
 */
export function preparePullRequest(
  repository: string,
  pullRequest: PullRequestCommits,
): EvaluationRefs | undefined {
  const { baseCommit, headCommit } = pullRequest;
  if (baseCommit === null || headCommit === null) return undefined;
  const headRef = `refs/pull/${String(pullRequest.number)}/head`;
  if (!ensureCommit(repository, headCommit, headRef)) return undefined;
  if (!ensureCommit(repository, baseCommit, undefined)) return undefined;
  const mergeBase = runGit(repository, ["merge-base", baseCommit, headCommit]);
  if (!mergeBase.ok) return undefined;
  const refs = pullRequestRefs(pullRequest.number);
  git(repository, ["branch", "--force", "--no-track", refs.baseRef, mergeBase.stdout.trim()]);
  git(repository, ["branch", "--force", "--no-track", refs.headRef, headCommit]);
  return refs;
}

function existingMode(repository: string, commit: string, path: string): string {
  const entry = runGit(repository, ["ls-tree", commit, "--", path]);
  const mode = entry.ok ? entry.stdout.trim().split(" ")[0] : undefined;
  return mode !== undefined && mode !== "" ? mode : "100644";
}

/**
 * Creates the consumer seed's branches: the base branch at `baseCommit` and the head branch at one
 * new commit that replaces the given files. The commit is built with Git's plumbing in a private
 * index, so the clone's working tree and index are never touched.
 */
export function prepareOverlay(
  repository: string,
  seedId: string,
  baseCommit: string,
  files: Readonly<Record<string, string>>,
): EvaluationRefs {
  const indexDir = mkdtempSync(join(tmpdir(), "keiko-review-gate-index-"));
  const env = { GIT_INDEX_FILE: join(indexDir, "index") };
  try {
    git(repository, ["read-tree", baseCommit], { env });
    for (const [path, content] of Object.entries(files)) {
      const blob = git(repository, ["hash-object", "-w", "--stdin"], { input: content });
      const mode = existingMode(repository, baseCommit, path);
      git(repository, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`], { env });
    }
    const tree = git(repository, ["write-tree"], { env });
    const message = `Review gate seed ${seedId}`;
    const commit = git(repository, ["commit-tree", tree, "-p", baseCommit, "-m", message], {
      env: { ...env, ...SEED_IDENTITY },
    });
    const refs = seedRefs(seedId);
    git(repository, ["branch", "--force", "--no-track", refs.baseRef, baseCommit]);
    git(repository, ["branch", "--force", "--no-track", refs.headRef, commit]);
    return refs;
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

/** The exact content of a file at a commit, or `undefined` when the commit has no such file. */
export function fileAt(repository: string, commit: string, path: string): string | undefined {
  const result = runGit(repository, ["cat-file", "blob", `${commit}:${path}`]);
  return result.ok ? result.stdout : undefined;
}
