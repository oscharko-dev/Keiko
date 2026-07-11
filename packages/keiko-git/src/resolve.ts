// Repository resolution: the ONE way Keiko decides "is this directory inside a git repository,
// and which repository owns it". Membership is decided by git itself — `rev-parse --show-toplevel
// --show-prefix` in a single invocation — never by comparing path strings we computed ourselves.
// String comparison is what made subfolder recognition flaky: on case-insensitive/normalization-
// insensitive filesystems (macOS APFS, Windows NTFS) a user-typed path and git's on-disk answer
// can differ in letter case or Unicode form (NFC vs NFD) while naming the same directory. The
// containment guard below therefore normalizes before comparing, and is defense-in-depth only.

import { isAbsolute, relative, resolve } from "node:path";
import { GIT_BASE_ARGS } from "./runner.js";
import type { GitProcessResult, GitProcessRunner } from "./types.js";

const RESOLVE_MAX_BYTES = 16 * 1024;

export interface GitRepositoryMembership {
  /** Absolute repository top-level directory exactly as git reports it (on-disk form). */
  readonly repositoryRoot: string;
  /**
   * POSIX-style path of the queried directory relative to the repository root ("" at the root),
   * exactly as git reports it — works for linked worktrees and submodules, where `.git` is a
   * file, and for any depth of subdirectory.
   */
  readonly prefix: string;
}

export interface GitMembershipFailure {
  readonly ok: false;
  readonly result: GitProcessResult;
}

export interface GitMembershipSuccess {
  readonly ok: true;
  readonly membership: GitRepositoryMembership;
}

export type GitMembershipResolution = GitMembershipSuccess | GitMembershipFailure;

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * True when `value` is safe to pass to git as a POSITIONAL argument (a URL, a path). A value
 * beginning with `-` can be re-read by git as an option — e.g. a clone "URL" of
 * `--upload-pack=<cmd>` turns into remote command execution — even when a `--` separator precedes
 * it in some code paths. Callers that hand external input to git as a positional must gate on this
 * at the boundary; it fails closed (rejects) so a hostile value never reaches the spawn.
 */
export function isSafeGitPositional(value: string): boolean {
  return value.length > 0 && !value.startsWith("-");
}

/**
 * Resolve which repository owns `directory` by asking git, in one bounded invocation. Succeeds
 * for the repository root, any subdirectory, linked worktrees, and submodule checkouts. Fails
 * with the raw process result (classify with `classifyGitFailure`) for non-repositories, unsafe
 * ownership, or a missing git binary.
 */
export async function resolveGitMembership(
  directory: string,
  runner: GitProcessRunner,
  options: { readonly timeoutMs: number; readonly abortSignal?: AbortSignal | undefined },
): Promise<GitMembershipResolution> {
  const result = await runner(
    [...GIT_BASE_ARGS, "-C", directory, "rev-parse", "--show-toplevel", "--show-prefix"],
    {
      cwd: directory,
      maxBytes: RESOLVE_MAX_BYTES,
      timeoutMs: options.timeoutMs,
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    },
  );
  if (result.exitCode !== 0) {
    return { ok: false, result };
  }
  const [toplevelLine, prefixLine] = result.stdout.split(/\r?\n/u);
  const toplevel = toplevelLine?.trim() ?? "";
  if (toplevel.length === 0) {
    return { ok: false, result };
  }
  return {
    ok: true,
    membership: {
      repositoryRoot: resolve(toplevel),
      prefix: trimTrailingSlash((prefixLine ?? "").trim()),
    },
  };
}

// Case-insensitive filesystems are the default on darwin (APFS) and win32 (NTFS), and APFS also
// looks paths up normalization-insensitively (NFC vs NFD). Comparing without normalizing makes
// two spellings of the SAME on-disk directory look unrelated — the root cause of "subfolder not
// recognized" reports. Linux default filesystems are byte-sensitive: NFC and NFD spellings are
// genuinely different directories there, so normalizing would make this guard more permissive —
// compare exactly on every other platform.
function comparablePath(value: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? value.normalize("NFC").toLowerCase()
    : value;
}

/**
 * True when `target` is `root` or lives underneath it, under the platform's default filesystem
 * identity rules (case/Unicode-normalization insensitive on darwin and win32). Defense-in-depth
 * for path handling — repository membership itself is decided by `resolveGitMembership`.
 */
export function containsPath(root: string, target: string): boolean {
  const rel = relative(comparablePath(root), comparablePath(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
