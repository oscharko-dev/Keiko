// Fixed-argv Git operations for pull request review (ADR-0182 D3, Issue #4133).
//
// Every operation builds its complete argument vector here from validated operands only: a
// positive pull request number, full hexadecimal object ids, a remote alias, an absolute
// server-owned worktree path, a private `refs/keiko-review/` ref, or a tree path read back from
// Git itself and passed after `--`. No operation accepts free-form arguments or configuration. The
// runner a caller passes must be a review runner (`review-runner.ts`), which injects the reviewed
// hardening set and refuses caller configuration.

import { isAbsolute } from "node:path";
import { GIT_BASE_ARGS } from "./runner.js";
import type { GitProcessResult, GitProcessRunner } from "./types.js";

export const GIT_REVIEW_PRIVATE_REF_PREFIX = "refs/keiko-review/";
export const GIT_REVIEW_WORKTREE_LOCK_REASON = "keiko-review";

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PULL_REQUEST_NUMBER_MAX = 2_147_483_647;
const REMOTE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
// One installation's private refs live under `refs/keiko-review/<namespace>/`, so a sweep never
// touches the refs another Keiko installation (another state directory) keeps in the same
// repository.
const NAMESPACE = /^k[a-f0-9]{16}$/u;
// Two simple patterns rather than one alternation: a pull request ref (head, or `base-` for a
// fetched base) and a local-range ref, both below one namespace.
const PRIVATE_PULL_REQUEST_REF =
  /^refs\/keiko-review\/k[a-f0-9]{16}\/[1-9]\d{0,9}\/(?:base-)?[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const PRIVATE_LOCAL_REF =
  /^refs\/keiko-review\/k[a-f0-9]{16}\/local\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function matchesPrivateRef(value: string): boolean {
  return PRIVATE_PULL_REQUEST_REF.test(value) || PRIVATE_LOCAL_REF.test(value);
}
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
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

function assertNamespace(value: string): string {
  if (!NAMESPACE.test(value)) throw new GitReviewOperandError("namespace");
  return value;
}

/** Whether a value is a valid private ref namespace (`k` + 16 hex digits). */
export function isGitReviewRefNamespace(value: string): boolean {
  return NAMESPACE.test(value);
}

function assertPrivateRef(value: string): string {
  if (!matchesPrivateRef(value)) throw new GitReviewOperandError("ref");
  return value;
}

function assertTreePath(value: string): string {
  if (value.length === 0 || value.includes("\0")) throw new GitReviewOperandError("tree-path");
  return value;
}

/** The private ref that retains a pull request head after its worktree is gone. */
export function gitReviewPullRequestRef(
  namespace: string,
  pullRequestNumber: number,
  headSha: string,
): string {
  const number = assertPullRequestNumber(pullRequestNumber);
  const prefix = `${GIT_REVIEW_PRIVATE_REF_PREFIX}${assertNamespace(namespace)}/`;
  return `${prefix}${String(number)}/${assertObjectId(headSha, "headSha")}`;
}

/** The private ref that retains a pull request base commit Keiko had to fetch. */
export function gitReviewPullRequestBaseRef(
  namespace: string,
  pullRequestNumber: number,
  baseSha: string,
): string {
  const number = assertPullRequestNumber(pullRequestNumber);
  const prefix = `${GIT_REVIEW_PRIVATE_REF_PREFIX}${assertNamespace(namespace)}/`;
  return `${prefix}${String(number)}/base-${assertObjectId(baseSha, "baseSha")}`;
}

/** The private ref that retains a local-range head for one run. */
export function gitReviewLocalRangeRef(namespace: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new GitReviewOperandError("runId");
  return `${GIT_REVIEW_PRIVATE_REF_PREFIX}${assertNamespace(namespace)}/local/${runId}`;
}

export function isGitReviewPrivateRef(value: string): boolean {
  return matchesPrivateRef(value);
}

async function run(
  ctx: GitReviewOperationContext,
  cwd: string,
  args: readonly string[],
  expectedExitCodes?: readonly number[],
  input?: string,
): Promise<GitProcessResult> {
  return ctx.runner([...GIT_BASE_ARGS, ...args], {
    cwd,
    timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: ctx.maxBytes ?? DEFAULT_MAX_BYTES,
    abortSignal: ctx.abortSignal,
    expectedExitCodes,
    ...(input === undefined ? {} : { input }),
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
  readonly namespace: string;
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
  const destination = gitReviewPullRequestRef(request.namespace, request.number, request.headSha);
  const source = `refs/pull/${String(request.number)}/head`;
  return runUnit(ctx, request.cwd, fetchArgs(request.remote, `+${source}:${destination}`));
}

/** Fetches one commit by its full object id into its private base ref. */
export function fetchGitReviewCommit(
  ctx: GitReviewOperationContext,
  request: GitReviewFetchRequest & { readonly number: number; readonly sha: string },
): Promise<GitReviewOperationResult<undefined>> {
  const destination = gitReviewPullRequestBaseRef(request.namespace, request.number, request.sha);
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

/** The private refs of ONE namespace; another installation's refs are never listed. */
export async function listGitReviewRefs(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly namespace: string },
): Promise<GitReviewOperationResult<readonly string[]>> {
  const result = await run(ctx, request.cwd, [
    "for-each-ref",
    "--format=%(refname)",
    `${GIT_REVIEW_PRIVATE_REF_PREFIX}${assertNamespace(request.namespace)}/`,
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

export interface GitReviewPathObject {
  readonly oid: string;
  readonly type: "blob" | "tree" | "commit" | "tag";
  readonly size: number;
}

const PATH_OBJECT_RECORD = /^([a-f0-9]{40}|[a-f0-9]{64}) (blob|tree|commit|tag) (\d+)$/u;
// A gitlink resolves to the commit it names, which the superproject does not hold.
const PATH_SUBMODULE_RECORD = /^(?:[a-f0-9]{40}|[a-f0-9]{64}) submodule$/u;

function pathObjectRecord(line: string): GitReviewPathObject | undefined | "malformed" {
  if (line.endsWith(" missing") || PATH_SUBMODULE_RECORD.test(line)) return undefined;
  const match = PATH_OBJECT_RECORD.exec(line);
  if (match === null) return "malformed";
  const [, oid = "", type, size = "0"] = match;
  return { oid, type: type as GitReviewPathObject["type"], size: Number(size) };
}

/**
 * The object one path names in one commit's tree, without reading its content: `cat-file
 * --batch-check` resolves `<sha>:<path>` (a tree lookup, never a pathspec, so no magic applies).
 * `undefined` when the commit exists and has no such path (or names a submodule there); a commit
 * the repository does not hold fails the read. A path with a control character is refused before a
 * spawn, so it cannot split the batch line.
 */
export async function readGitReviewPathObject(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly sha: string; readonly path: string },
): Promise<GitReviewOperationResult<GitReviewPathObject | undefined>> {
  const sha = assertObjectId(request.sha, "sha");
  const path = assertTreePath(request.path);
  if (CONTROL_CHARACTER.test(path)) throw new GitReviewOperandError("tree-path");
  const format = "--batch-check=%(objectname) %(objecttype) %(objectsize)";
  const input = `${sha}\n${sha}:${path}\n`;
  const result = await run(ctx, request.cwd, ["cat-file", format], [], input);
  if (!succeeded(result)) return { ok: false, result };
  const [commitLine = "", pathLine = ""] = result.stdout.split("\n");
  const commit = pathObjectRecord(commitLine);
  if (commit === undefined || commit === "malformed" || commit.type !== "commit") {
    return { ok: false, result };
  }
  const object = pathObjectRecord(pathLine);
  return object === "malformed" ? { ok: false, result } : { ok: true, value: object };
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

export interface GitReviewGrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface GitReviewGrepResult {
  readonly matches: readonly GitReviewGrepMatch[];
  /** The output bound cut the listing: more matches may exist. */
  readonly truncated: boolean;
}

const GREP_LITERAL_MAX_CHARS = 200;
const GREP_MAX_COUNT_PER_FILE_MAX = 100;

function assertGrepLiteral(value: string): string {
  if (
    value.length === 0 ||
    value.length > GREP_LITERAL_MAX_CHARS ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new GitReviewOperandError("literal");
  }
  return value;
}

function parseGrepRecords(stdout: string, sha: string, complete: boolean): GitReviewGrepMatch[] {
  const prefix = `${sha}:`;
  const records = stdout.split("\n");
  // A cut listing ends in a partial record; only complete lines are reported.
  if (!complete || records.at(-1) === "") records.pop();
  const matches: GitReviewGrepMatch[] = [];
  for (const record of records) {
    const [name = "", line = "", ...rest] = record.split("\0");
    if (!name.startsWith(prefix) || !/^[1-9]\d*$/u.test(line)) continue;
    matches.push({ path: name.slice(prefix.length), line: Number(line), text: rest.join("\0") });
  }
  return matches;
}

/**
 * Searches one commit's tree for a fixed string (`git grep -F` over the commit object, never a
 * working tree or index): no pattern language, no pathspec, binary files skipped, at most
 * `maxCountPerFile` matches per file. A listing cut by the byte bound returns its complete records
 * with `truncated`.
 */
export async function grepGitReviewTree(
  ctx: GitReviewOperationContext,
  request: {
    readonly cwd: string;
    readonly sha: string;
    readonly literal: string;
    readonly maxCountPerFile: number;
  },
): Promise<GitReviewOperationResult<GitReviewGrepResult>> {
  const sha = assertObjectId(request.sha, "sha");
  const literal = assertGrepLiteral(request.literal);
  const perFile = assertGrepCount(request.maxCountPerFile);
  const args = ["grep", "--no-color", "-I", "-F", "-n", "-z", "--full-name"];
  const result = await ctx.runner(
    [...GIT_BASE_ARGS, ...args, `--max-count=${String(perFile)}`, "-e", literal, sha, "--"],
    {
      cwd: request.cwd,
      timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: ctx.maxBytes ?? DEFAULT_MAX_BYTES,
      abortSignal: ctx.abortSignal,
      expectedExitCodes: [0, 1],
      expectedTruncation: true,
    },
  );
  return grepListing(result, sha);
}

function assertGrepCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > GREP_MAX_COUNT_PER_FILE_MAX) {
    throw new GitReviewOperandError("maxCountPerFile");
  }
  return value;
}

/** A complete listing, or a listing the byte bound cut (complete records only, `truncated`). */
function grepListing(
  result: GitProcessResult,
  sha: string,
): GitReviewOperationResult<GitReviewGrepResult> {
  const cut = result.truncated && result.timedOut !== true && result.aborted !== true;
  const complete = (result.exitCode === 0 || result.exitCode === 1) && !result.truncated;
  if (result.refusal !== undefined || !(cut || complete)) return { ok: false, result };
  return {
    ok: true,
    value: { matches: parseGrepRecords(result.stdout, sha, complete), truncated: cut },
  };
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

/**
 * Marks paths skip-worktree in the review index so the checkout never materializes them. One
 * process for every path: the paths travel NUL-separated on standard input, so the index is
 * rewritten once, no argv length limit applies, and macOS never precomposes a decomposed name.
 */
export async function skipGitReviewWorktreePaths(
  ctx: GitReviewOperationContext,
  request: { readonly worktreePath: string; readonly paths: readonly string[] },
): Promise<GitReviewOperationResult<undefined>> {
  const cwd = assertWorktreePath(request.worktreePath);
  if (request.paths.length === 0) return { ok: true, value: undefined };
  const input = request.paths.map((path) => `${assertTreePath(path)}\0`).join("");
  const result = await run(
    ctx,
    cwd,
    ["update-index", "-z", "--skip-worktree", "--stdin"],
    [],
    input,
  );
  return succeeded(result) ? { ok: true, value: undefined } : { ok: false, result };
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

// ─── Change listing and patches (Issue #4134) ────────────────────────────────

/** Rename detection gives up its exhaustive pass above this many candidates (a rename storm). */
export const GIT_REVIEW_RENAME_LIMIT = 1000;
const GIT_REVIEW_MAX_CONTEXT_LINES = 64;

export type GitReviewChangeStatus = "A" | "M" | "D" | "R" | "T";

/** One changed path of a commit pair, with its names as the exact bytes Git stores. */
export interface GitReviewChange {
  readonly status: GitReviewChangeStatus;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldOid: string;
  readonly newOid: string;
  /** The head path (the base path of a deletion). */
  readonly path: Uint8Array;
  /** The base path of a rename. */
  readonly previousPath: Uint8Array | undefined;
  /** Git's line counts; `undefined` when Git counts the pair as binary. */
  readonly addedLines: number | undefined;
  readonly removedLines: number | undefined;
}

export class GitReviewOutputError extends TypeError {
  public constructor(what: string) {
    super(`unexpected review Git output: ${what}`);
    this.name = "GitReviewOutputError";
  }
}

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

function unquoteEscape(text: string, index: number, bytes: number[]): number {
  const next = text.charAt(index + 1);
  const named = C_ESCAPES[next];
  if (named !== undefined) {
    bytes.push(named);
    return index + 2;
  }
  const octal = text.slice(index + 1, index + 4);
  if (!/^[0-3][0-7]{2}$/u.test(octal)) throw new GitReviewOutputError("path escape");
  bytes.push(Number.parseInt(octal, 8));
  return index + 4;
}

/**
 * The exact bytes of one path as Git prints it under `core.quotePath=true`: a plain token is
 * ASCII, a quoted one is a C string with octal escapes for every byte above 0x7f. Anything else
 * means the output cannot be trusted to name the path exactly, so it throws.
 */
export function unquoteGitReviewPath(text: string): Uint8Array {
  if (!text.startsWith('"')) {
    if (text.length === 0 || NOT_PRINTABLE_ASCII.test(text)) throw new GitReviewOutputError("path");
    return Buffer.from(text, "latin1");
  }
  if (text.length < 3 || !text.endsWith('"')) throw new GitReviewOutputError("path quote");
  return unquoteBody(text.slice(1, -1));
}

const NOT_PRINTABLE_ASCII = /[^ -~]/u;

function unquoteBody(body: string): Uint8Array {
  const bytes: number[] = [];
  let index = 0;
  while (index < body.length) {
    const char = body.charAt(index);
    if (char === "\\") {
      index = unquoteEscape(body, index, bytes);
      continue;
    }
    if (char === '"' || NOT_PRINTABLE_ASCII.test(char))
      throw new GitReviewOutputError("path quote");
    bytes.push(char.codePointAt(0) ?? 0);
    index += 1;
  }
  return Uint8Array.from(bytes);
}

const RAW_RECORD =
  /^:(\d{6}) (\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([AMDT]|R\d{1,3})$/u;
const NUMSTAT_RECORD = /^(\d{1,10}|-)\t(\d{1,10}|-)\t./u;

type RawChange = Omit<GitReviewChange, "addedLines" | "removedLines">;

function rawNames(fields: readonly string[], status: GitReviewChangeStatus): Uint8Array[] {
  const names = fields.slice(1).map(unquoteGitReviewPath);
  if (names.length !== (status === "R" ? 2 : 1)) throw new GitReviewOutputError("raw paths");
  return names;
}

function parseRawRecord(line: string): RawChange {
  const fields = line.split("\t");
  const match = RAW_RECORD.exec(fields[0] ?? "");
  if (match === null) throw new GitReviewOutputError("raw record");
  const [oldMode, newMode, oldOid, newOid, code] = match.slice(1).map(String);
  const status = String(code).charAt(0) as GitReviewChangeStatus;
  const [first, second] = rawNames(fields, status);
  if (first === undefined) throw new GitReviewOutputError("raw paths");
  return {
    status,
    oldMode: String(oldMode),
    newMode: String(newMode),
    oldOid: String(oldOid),
    newOid: String(newOid),
    path: second ?? first,
    previousPath: second === undefined ? undefined : first,
  };
}

function parseCount(value: string | undefined): number | undefined {
  return value === undefined || value === "-" ? undefined : Number(value);
}

/**
 * Pairs `--raw` records with the `--numstat` records Git prints after them in the same order.
 * The numstat path (which Git rewrites for renames) is never read: only the counts, so a hostile
 * name cannot shift the pairing.
 */
function parseChangeListing(stdout: string): readonly GitReviewChange[] {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  const raw = lines.filter((line) => line.startsWith(":")).map(parseRawRecord);
  const counts = lines.filter((line) => !line.startsWith(":"));
  if (counts.length !== raw.length) throw new GitReviewOutputError("numstat pairing");
  return raw.map((change, index) => {
    const match = NUMSTAT_RECORD.exec(counts[index] ?? "");
    if (match === null) throw new GitReviewOutputError("numstat record");
    return { ...change, addedLines: parseCount(match[1]), removedLines: parseCount(match[2]) };
  });
}

export type GitReviewChangeListing =
  | GitReviewOperationResult<readonly GitReviewChange[]>
  | { readonly ok: false; readonly malformed: true; readonly result: GitProcessResult };

/**
 * Every changed path between two commits, read from the objects alone (no working tree, no
 * index): recursive, with rename detection bounded by `GIT_REVIEW_RENAME_LIMIT`, full object ids,
 * no color, and paths in Git's quoted form (the review runner forces `core.quotePath=true`).
 */
export async function listGitReviewChanges(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly baseSha: string; readonly headSha: string },
): Promise<GitReviewChangeListing> {
  const result = await run(ctx, request.cwd, [
    "diff-tree",
    "-r",
    "-M",
    `-l${String(GIT_REVIEW_RENAME_LIMIT)}`,
    "--raw",
    "--numstat",
    "--no-abbrev",
    "--no-color",
    assertObjectId(request.baseSha, "baseSha"),
    assertObjectId(request.headSha, "headSha"),
  ]);
  if (!succeeded(result)) return { ok: false, result };
  try {
    return { ok: true, value: parseChangeListing(result.stdout) };
  } catch (error) {
    if (error instanceof GitReviewOutputError) return { ok: false, malformed: true, result };
    throw error;
  }
}

export interface GitReviewObjectInfo {
  readonly type: string;
  readonly size: number;
}

const BATCH_CHECK_RECORD =
  /^([a-f0-9]{40}|[a-f0-9]{64}) (?:(blob|tree|commit|tag) (\d+)|missing)$/u;

/**
 * The type and size of each object, without reading any content (`cat-file --batch-check`, ids on
 * standard input). A missing object has no entry.
 */
export async function readGitReviewObjectSizes(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly oids: readonly string[] },
): Promise<GitReviewOperationResult<ReadonlyMap<string, GitReviewObjectInfo>>> {
  const sizes = new Map<string, GitReviewObjectInfo>();
  if (request.oids.length === 0) return { ok: true, value: sizes };
  const input = request.oids.map((oid) => `${assertObjectId(oid, "oid")}\n`).join("");
  const format = "--batch-check=%(objectname) %(objecttype) %(objectsize)";
  const result = await run(ctx, request.cwd, ["cat-file", format], [], input);
  if (!succeeded(result)) return { ok: false, result };
  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) continue;
    const match = BATCH_CHECK_RECORD.exec(line);
    if (match === null) return { ok: false, result };
    const [, oid = "", type, size] = match;
    if (type !== undefined && size !== undefined) sizes.set(oid, { type, size: Number(size) });
  }
  return { ok: true, value: sizes };
}

/**
 * At most `bytes` leading bytes of one blob: the process is stopped at the cap, so a giant blob is
 * never read past it. Used for Git's own binary sniff (a NUL byte in the first 8,000 bytes).
 */
export async function readGitReviewBlobPrefix(
  ctx: GitReviewOperationContext,
  request: { readonly cwd: string; readonly oid: string; readonly bytes: number },
): Promise<GitReviewOperationResult<string>> {
  const oid = assertObjectId(request.oid, "oid");
  if (!Number.isSafeInteger(request.bytes) || request.bytes < 1) {
    throw new GitReviewOperandError("bytes");
  }
  const result = await ctx.runner([...GIT_BASE_ARGS, "cat-file", "blob", oid], {
    cwd: request.cwd,
    timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: request.bytes,
    abortSignal: ctx.abortSignal,
    expectedTruncation: true,
  });
  const cut = result.truncated && result.timedOut !== true && result.aborted !== true;
  const complete = result.exitCode === 0 && !result.truncated;
  if (result.refusal === undefined && (cut || complete)) return { ok: true, value: result.stdout };
  return { ok: false, result };
}

/**
 * The unified diff of two blobs by object id, so no path, attribute or pathspec is involved. The
 * runner adds `--no-ext-diff --no-textconv`; the context, hunk merging and algorithm are fixed
 * here so the repository's configuration cannot change the hunks.
 */
export async function diffGitReviewBlobs(
  ctx: GitReviewOperationContext,
  request: {
    readonly cwd: string;
    readonly oldOid: string;
    readonly newOid: string;
    readonly contextLines: number;
  },
): Promise<GitReviewOperationResult<string>> {
  const lines = request.contextLines;
  if (!Number.isSafeInteger(lines) || lines < 0 || lines > GIT_REVIEW_MAX_CONTEXT_LINES) {
    throw new GitReviewOperandError("contextLines");
  }
  const result = await run(ctx, request.cwd, [
    "diff",
    `-U${String(lines)}`,
    "--no-color",
    "--inter-hunk-context=0",
    "--diff-algorithm=myers",
    "--indent-heuristic",
    assertObjectId(request.oldOid, "oldOid"),
    assertObjectId(request.newOid, "newOid"),
  ]);
  return succeeded(result) ? { ok: true, value: result.stdout } : { ok: false, result };
}
