// Fixed-argv Git operations for pull request review (ADR-0182 D3, Issue #4133).
//
// Every operation builds its complete argument vector here from validated operands only: a
// positive pull request number, full hexadecimal object ids, a remote alias, an absolute
// server-owned worktree path, a private `refs/keiko-review/` ref, or a tree path read back from
// Git itself and passed after `--`. No operation accepts free-form arguments or configuration. The
// runner a caller passes must be a review runner (`review-runner.ts`), which injects the reviewed
// hardening set and refuses caller configuration.

import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";
import { GIT_BASE_ARGS } from "./runner.js";
import type { GitProcessResult, GitProcessRunner } from "./types.js";

export const GIT_REVIEW_PRIVATE_REF_PREFIX = "refs/keiko-review/";
export const GIT_REVIEW_WORKTREE_LOCK_REASON = "keiko-review";

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PULL_REQUEST_NUMBER_MAX = 2_147_483_647;
const REMOTE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PRIVATE_REF =
  /^refs\/keiko-review\/(?:[1-9]\d{0,9}\/(?:base-)?(?:[a-f0-9]{40}|[a-f0-9]{64})|local\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const SKIP_WORKTREE_ARGV_BYTES = 16 * 1024;
// eslint-disable-next-line no-control-regex -- intentionally matches control characters to reject them
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

export class GitReviewOperandError extends TypeError {
  public constructor(operand: string) {
    super(`invalid review operand: ${operand}`);
    this.name = "GitReviewOperandError";
  }
}

export interface GitReviewOperationContext {
  readonly runner: GitProcessRunner;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}

export type GitReviewOperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly result: GitProcessResult };

function assertObjectId(value: string, operand: string): string {
  if (!OBJECT_ID.test(value)) throw new GitReviewOperandError(operand);
  return value;
}

function assertPullRequestNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > PULL_REQUEST_NUMBER_MAX) {
    throw new GitReviewOperandError("number");
  }
  return value;
}

function assertWorktreePath(value: string): string {
  if (!isAbsolute(value) || value.startsWith("-") || CONTROL_CHARACTER.test(value)) {
    throw new GitReviewOperandError("path");
  }
  return value;
}

function assertPrivateRef(value: string): string {
  if (!PRIVATE_REF.test(value)) throw new GitReviewOperandError("ref");
  return value;
}

function assertTreePath(value: string): string {
  if (value.length === 0 || value.includes("\0")) throw new GitReviewOperandError("tree-path");
  return value;
}

/** The private ref that retains a pull request head after its worktree is gone. */
export function gitReviewPullRequestRef(pullRequestNumber: number, headSha: string): string {
  const number = assertPullRequestNumber(pullRequestNumber);
  return `${GIT_REVIEW_PRIVATE_REF_PREFIX}${String(number)}/${assertObjectId(headSha, "headSha")}`;
}

/** The private ref that retains a pull request base commit Keiko had to fetch. */
export function gitReviewPullRequestBaseRef(pullRequestNumber: number, baseSha: string): string {
  const number = assertPullRequestNumber(pullRequestNumber);
  return `${GIT_REVIEW_PRIVATE_REF_PREFIX}${String(number)}/base-${assertObjectId(baseSha, "baseSha")}`;
}

/** The private ref that retains a local-range head for one run. */
export function gitReviewLocalRangeRef(runId: string): string {
  if (!RUN_ID.test(runId)) throw new GitReviewOperandError("runId");
  return `${GIT_REVIEW_PRIVATE_REF_PREFIX}local/${runId}`;
}

export function isGitReviewPrivateRef(value: string): boolean {
  return PRIVATE_REF.test(value);
}

async function run(
  ctx: GitReviewOperationContext,
  cwd: string,
  args: readonly string[],
  expectedExitCodes?: readonly number[],
): Promise<GitProcessResult> {
  return ctx.runner([...GIT_BASE_ARGS, ...args], {
    cwd,
    timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: ctx.maxBytes ?? DEFAULT_MAX_BYTES,
    abortSignal: ctx.abortSignal,
    expectedExitCodes,
  });
}

function succeeded(result: GitProcessResult): boolean {
  return result.exitCode === 0 && !result.truncated && result.refusal === undefined;
}

async function runUnit(
  ctx: GitReviewOperationContext,
  cwd: string,
  args: readonly string[],
): Promise<GitReviewOperationResult<undefined>> {
  const result = await run(ctx, cwd, args);
  return succeeded(result) ? { ok: true, value: undefined } : { ok: false, result };
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

export interface GitReviewFetchRequest {
  readonly cwd: string;
  readonly remote: string;
}

// `--refmap=` (empty) disables the opportunistic remote-tracking update a configured refspec would
// otherwise make, `--no-write-fetch-head` leaves FETCH_HEAD untouched, and the only destination is
// a private `refs/keiko-review/` ref: the user's branches and remote-tracking refs are never written.
function fetchArgs(remote: string, refspec: string): readonly string[] {
  if (!REMOTE_ALIAS.test(remote)) throw new GitReviewOperandError("remote");
  return [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    "--refmap=",
    "--quiet",
    "--end-of-options",
    remote,
    refspec,
  ];
}

/** Fetches `refs/pull/<n>/head` into its private ref named for the head the provider reported. */
export function fetchGitReviewPullRequestHead(
  ctx: GitReviewOperationContext,
  request: GitReviewFetchRequest & { readonly number: number; readonly headSha: string },
): Promise<GitReviewOperationResult<undefined>> {
  const destination = gitReviewPullRequestRef(request.number, request.headSha);
  const source = `refs/pull/${String(request.number)}/head`;
  return runUnit(ctx, request.cwd, fetchArgs(request.remote, `+${source}:${destination}`));
}

/** Fetches one commit by its full object id into its private base ref. */
export function fetchGitReviewCommit(
  ctx: GitReviewOperationContext,
  request: GitReviewFetchRequest & { readonly number: number; readonly sha: string },
): Promise<GitReviewOperationResult<undefined>> {
  const destination = gitReviewPullRequestBaseRef(request.number, request.sha);
  return runUnit(ctx, request.cwd, fetchArgs(request.remote, `+${request.sha}:${destination}`));
}

// ─── Commit and ref reads ────────────────────────────────────────────────────

/** Resolves a validated ref or object id to a full commit id; `undefined` when it names no commit. */
export async function resolveGitReviewCommit(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly ref: string },
): Promise<GitReviewOperationResult<string | undefined>> {
  if (
    request.ref.startsWith("-") ||
    CONTROL_CHARACTER.test(request.ref) ||
    /\s/u.test(request.ref)
  ) {
    throw new GitReviewOperandError("ref");
  }
  const result = await run(
    ctx,
    request.cwd,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${request.ref}^{commit}`],
    [1],
  );
  if (result.exitCode === 1 && result.refusal === undefined) return { ok: true, value: undefined };
  if (!succeeded(result)) return { ok: false, result };
  const value = result.stdout.trim();
  return OBJECT_ID.test(value) ? { ok: true, value } : { ok: false, result };
}

export async function gitReviewCommitExists(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly sha: string },
): Promise<GitReviewOperationResult<boolean>> {
  const sha = assertObjectId(request.sha, "sha");
  const result = await run(ctx, request.cwd, ["cat-file", "-e", `${sha}^{commit}`], [1, 128]);
  if (result.refusal !== undefined || result.truncated) return { ok: false, result };
  return { ok: true, value: result.exitCode === 0 };
}

export function createGitReviewRef(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly ref: string; readonly sha: string },
): Promise<GitReviewOperationResult<undefined>> {
  const ref = assertPrivateRef(request.ref);
  return runUnit(ctx, request.cwd, [
    "update-ref",
    "--no-deref",
    ref,
    assertObjectId(request.sha, "sha"),
  ]);
}

/** Deletes one private review ref. Any ref outside `refs/keiko-review/` is refused before a spawn. */
export function deleteGitReviewRef(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly ref: string },
): Promise<GitReviewOperationResult<undefined>> {
  return runUnit(ctx, request.cwd, [
    "update-ref",
    "--no-deref",
    "-d",
    assertPrivateRef(request.ref),
  ]);
}

export async function listGitReviewRefs(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string },
): Promise<GitReviewOperationResult<readonly string[]>> {
  const result = await run(ctx, request.cwd, [
    "for-each-ref",
    "--format=%(refname)",
    GIT_REVIEW_PRIVATE_REF_PREFIX,
  ]);
  if (!succeeded(result)) return { ok: false, result };
  const refs = result.stdout.split("\n").filter((line) => isGitReviewPrivateRef(line));
  return { ok: true, value: refs };
}

// ─── Object reads ────────────────────────────────────────────────────────────

/** Reads one blob by object id. `cat-file blob` never applies a filter or textconv. */
export async function readGitReviewBlob(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly oid: string },
): Promise<GitReviewOperationResult<string>> {
  const result = await run(ctx, request.cwd, [
    "cat-file",
    "blob",
    assertObjectId(request.oid, "oid"),
  ]);
  return succeeded(result) ? { ok: true, value: result.stdout } : { ok: false, result };
}

/** Reads one file of a commit. The runner adds `--no-ext-diff --no-textconv` to every `show`. */
export async function showGitReviewFile(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly sha: string; readonly path: string },
): Promise<GitReviewOperationResult<string>> {
  const sha = assertObjectId(request.sha, "sha");
  const spec = `${sha}:${assertTreePath(request.path)}`;
  const result = await run(ctx, request.cwd, ["show", "--end-of-options", spec]);
  return succeeded(result) ? { ok: true, value: result.stdout } : { ok: false, result };
}

export interface GitReviewTreeEntry {
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly oid: string;
  /** Blob size in bytes; `undefined` for a submodule (gitlink) entry. */
  readonly size: number | undefined;
  readonly path: string;
}

const TREE_ENTRY = /^(\d{6}) (blob|commit|tree) ([a-f0-9]{40,64}) +(-|\d+)\t([\s\S]+)$/u;

function parseTreeEntry(record: string): GitReviewTreeEntry | undefined {
  const match = TREE_ENTRY.exec(record);
  if (match === null) return undefined;
  const [, mode, type, oid, size, path] = match;
  if (mode === undefined || oid === undefined || path === undefined || size === undefined) {
    return undefined;
  }
  return {
    mode,
    type: type as GitReviewTreeEntry["type"],
    oid,
    size: size === "-" ? undefined : Number(size),
    path,
  };
}

/** Lists every blob and gitlink of a commit's tree, recursively, with sizes, NUL-separated. */
export async function listGitReviewTree(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly sha: string },
): Promise<GitReviewOperationResult<readonly GitReviewTreeEntry[]>> {
  const sha = assertObjectId(request.sha, "sha");
  const result = await run(ctx, request.cwd, ["ls-tree", "-r", "-z", "--long", "--full-tree", sha]);
  if (!succeeded(result)) return { ok: false, result };
  const entries: GitReviewTreeEntry[] = [];
  for (const record of result.stdout.split("\0")) {
    if (record.length === 0) continue;
    const entry = parseTreeEntry(record);
    if (entry === undefined) return { ok: false, result };
    entries.push(entry);
  }
  return { ok: true, value: entries };
}

/**
 * The paths of a commit's tree that Git's own diff machinery classifies as binary, from one
 * `diff-tree --numstat` against the empty tree. Blobs above the runner's `core.bigFileThreshold`
 * count as binary without being loaded.
 */
export async function listGitReviewBinaryPaths(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly sha: string },
): Promise<GitReviewOperationResult<ReadonlySet<string>>> {
  const sha = assertObjectId(request.sha, "sha");
  const emptyTree = sha.length === 40 ? EMPTY_TREE_SHA1 : EMPTY_TREE_SHA256;
  const result = await run(ctx, request.cwd, [
    "diff-tree",
    "-r",
    "-z",
    "--numstat",
    "--no-renames",
    emptyTree,
    sha,
  ]);
  if (!succeeded(result)) return { ok: false, result };
  const binary = new Set<string>();
  for (const record of result.stdout.split("\0")) {
    if (record.startsWith("-\t-\t")) binary.add(record.slice(4));
  }
  return { ok: true, value: binary };
}

const FILTER_CONFIG_LINE = /^([a-z]+)\tfilter\.(.+)\.(?:smudge|clean|process|required)$/u;

/**
 * The filter driver names the repository's own configuration defines. `--show-scope` lets the
 * listing ignore the `command` scope, which holds the runner's own neutralization overrides.
 */
export async function listGitReviewConfiguredFilterDrivers(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string },
): Promise<GitReviewOperationResult<readonly string[]>> {
  const result = await run(
    ctx,
    request.cwd,
    [
      "config",
      "--show-scope",
      "--name-only",
      "--get-regexp",
      String.raw`^filter\..*\.(smudge|clean|process|required)$`,
    ],
    [1],
  );
  if (result.exitCode === 1 && result.refusal === undefined) return { ok: true, value: [] };
  if (!succeeded(result)) return { ok: false, result };
  const names = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const match = FILTER_CONFIG_LINE.exec(line);
    if (match?.[1] !== undefined && match[1] !== "command" && match[2] !== undefined) {
      names.add(match[2]);
    }
  }
  return { ok: true, value: [...names] };
}

// ─── Worktree lifecycle ──────────────────────────────────────────────────────

/** Adds a detached, locked, not-yet-populated worktree at an exact commit. */
export function addGitReviewWorktree(
  ctx: GitReviewOperationContext,
  request: { readonly repositoryRoot: string; readonly path: string; readonly sha: string },
): Promise<GitReviewOperationResult<undefined>> {
  return runUnit(ctx, request.repositoryRoot, [
    "worktree",
    "add",
    "--detach",
    "--no-checkout",
    "--lock",
    "--reason",
    GIT_REVIEW_WORKTREE_LOCK_REASON,
    "--end-of-options",
    assertWorktreePath(request.path),
    assertObjectId(request.sha, "sha"),
  ]);
}

/** Populates the review worktree's own index from the commit without touching any file. */
export function readGitReviewTreeIntoIndex(
  ctx: GitReviewOperationContext,
  request: { readonly worktreePath: string; readonly sha: string },
): Promise<GitReviewOperationResult<undefined>> {
  const path = assertWorktreePath(request.worktreePath);
  return runUnit(ctx, path, ["read-tree", assertObjectId(request.sha, "sha")]);
}

function skipWorktreeBatches(paths: readonly string[]): readonly (readonly string[])[] {
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(assertTreePath(path), "utf8") + 1;
    if (current.length > 0 && bytes + size > SKIP_WORKTREE_ARGV_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(path);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Marks paths skip-worktree in the review index so the checkout never materializes them. */
export async function skipGitReviewWorktreePaths(
  ctx: GitReviewOperationContext,
  request: { readonly worktreePath: string; readonly paths: readonly string[] },
): Promise<GitReviewOperationResult<undefined>> {
  const cwd = assertWorktreePath(request.worktreePath);
  for (const batch of skipWorktreeBatches(request.paths)) {
    const outcome = await runUnit(ctx, cwd, ["update-index", "--skip-worktree", "--", ...batch]);
    if (!outcome.ok) return outcome;
  }
  return { ok: true, value: undefined };
}

/** Materializes the review worktree at the exact commit, never recursing into submodules. */
export function checkoutGitReviewWorktree(
  ctx: GitReviewOperationContext,
  request: { readonly worktreePath: string; readonly sha: string },
): Promise<GitReviewOperationResult<undefined>> {
  const path = assertWorktreePath(request.worktreePath);
  return runUnit(ctx, path, [
    "checkout",
    "--quiet",
    "--detach",
    "--force",
    "--no-recurse-submodules",
    assertObjectId(request.sha, "sha"),
  ]);
}

export function unlockGitReviewWorktree(
  ctx: GitReviewOperationContext,
  request: { readonly repositoryRoot: string; readonly path: string },
): Promise<GitReviewOperationResult<undefined>> {
  return runUnit(ctx, request.repositoryRoot, [
    "worktree",
    "unlock",
    "--end-of-options",
    assertWorktreePath(request.path),
  ]);
}

/**
 * Removes one review worktree and its administrative entry. Works when the directory is already
 * gone, so it is also the targeted prune for that one entry; `git worktree prune`, which would
 * touch every stale entry of the user's repository, is never used.
 */
export function removeGitReviewWorktree(
  ctx: GitReviewOperationContext,
  request: { readonly repositoryRoot: string; readonly path: string },
): Promise<GitReviewOperationResult<undefined>> {
  return runUnit(ctx, request.repositoryRoot, [
    "worktree",
    "remove",
    "--force",
    "--end-of-options",
    assertWorktreePath(request.path),
  ]);
}

export interface GitReviewWorktreeListEntry {
  readonly path: string;
  readonly lockReason: string | undefined;
}

function parseWorktreeBlock(block: string): GitReviewWorktreeListEntry | undefined {
  let path: string | undefined;
  let lockReason: string | undefined;
  for (const field of block.split("\0")) {
    if (field.startsWith("worktree ")) path = field.slice("worktree ".length);
    else if (field.startsWith("locked")) lockReason = field.slice("locked".length).trim();
  }
  return path === undefined ? undefined : { path, lockReason };
}

/** Lists the repository's worktrees with their lock reasons (`--porcelain -z`). */
export async function listGitReviewWorktrees(
  ctx: GitReviewOperationContext,
  request: { readonly repositoryRoot: string },
): Promise<GitReviewOperationResult<readonly GitReviewWorktreeListEntry[]>> {
  const result = await run(ctx, request.repositoryRoot, ["worktree", "list", "--porcelain", "-z"]);
  if (!succeeded(result)) return { ok: false, result };
  const entries = result.stdout
    .split("\0\0")
    .map(parseWorktreeBlock)
    .filter((entry): entry is GitReviewWorktreeListEntry => entry !== undefined);
  return { ok: true, value: entries };
}
