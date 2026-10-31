// One seed case as a Git repository (Issue #4137): the synthetic corpus of Issue #4132 is plain
// file trees, the review orchestrator reviews Git commits. Each case is materialized under the
// qualification's own directory in Keiko's state directory as a fresh repository with two commits:
// the base tree on `keiko-seed-base` and the head tree on `keiko-seed-head`, reviewed as a
// `local-range` target and removed afterwards. Every Git call runs through the hardened review
// runner (hooks, filters and fsmonitor neutralized, no caller configuration), with a repository-
// local identity only; no global configuration, signing key or credential is ever read.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ReviewSeedFixture } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import type { GitProcessRunner } from "@oscharko-dev/keiko-git";

import { planReviewSeedTree } from "./seed-corpus/index.js";

export const REVIEW_SEED_BASE_BRANCH = "keiko-seed-base";
export const REVIEW_SEED_HEAD_BRANCH = "keiko-seed-head";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 256 * 1024;

class ReviewSeedRepositoryError extends Error {
  public constructor(step: string) {
    super(`seed repository step failed: ${step}`);
    this.name = "ReviewSeedRepositoryError";
  }
}

async function git(
  runner: GitProcessRunner,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await runner(args, {
    cwd,
    maxBytes: GIT_MAX_BYTES,
    timeoutMs: GIT_TIMEOUT_MS,
    abortSignal: signal,
  });
  if (result.exitCode !== 0) throw new ReviewSeedRepositoryError(args[0] ?? "git");
}

async function writeTree(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const entry of planReviewSeedTree(files)) {
    const target = join(root, ...entry.path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, entry.content, { encoding: "utf8", mode: 0o600 });
  }
}

async function removeAbsent(
  root: string,
  base: Readonly<Record<string, string>>,
  head: Readonly<Record<string, string>>,
): Promise<void> {
  for (const entry of planReviewSeedTree(base)) {
    if (!Object.hasOwn(head, entry.path)) await rm(join(root, ...entry.path.split("/")));
  }
}

async function commitAll(
  runner: GitProcessRunner,
  root: string,
  message: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await git(runner, root, ["add", "-A"], signal);
  await git(runner, root, ["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", message], signal);
}

/** Creates the case's repository at `root` (which must not exist yet) and returns `root`. */
export async function materializeSeedRepository(
  root: string,
  fixture: ReviewSeedFixture,
  runner: GitProcessRunner,
  signal?: AbortSignal,
): Promise<string> {
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { recursive: false, mode: 0o700 });
  const init = ["init", "-q", "--template=", `--initial-branch=${REVIEW_SEED_HEAD_BRANCH}`];
  await git(runner, root, init, signal);
  await git(runner, root, ["config", "user.name", "Keiko seed corpus"], signal);
  await git(runner, root, ["config", "user.email", "seed-corpus@keiko.invalid"], signal);
  await writeTree(root, fixture.baseFiles);
  await commitAll(runner, root, "Seed base", signal);
  await git(runner, root, ["branch", REVIEW_SEED_BASE_BRANCH], signal);
  await removeAbsent(root, fixture.baseFiles, fixture.headFiles);
  await writeTree(root, fixture.headFiles);
  await commitAll(runner, root, "Seed head", signal);
  return root;
}

/** Removes a qualification's directory with every seed repository below it. */
export async function removeSeedRepositories(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
