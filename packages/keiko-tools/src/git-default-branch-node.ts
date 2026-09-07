// Read-only default-branch reader for issue-bound runs (#3385, Epic #3384).
//
// An issue-bound task workspace is provisioned from the server-resolved default branch of the
// bound repository, so the run envelope's base ref, the branch a published pull request targets,
// and the branch GitHub closes the issue against are ONE fact resolved once. This module is that
// resolution: `refs/remotes/<alias>/HEAD` — the symbolic ref `git clone` and `git remote set-head`
// maintain — read through `git rev-parse`, which is already on the dedicated read-only allowlist.
// The allowlist is deliberately not widened to `symbolic-ref`; `rev-parse --abbrev-ref` answers the
// same question without adding a verb whose other spellings can WRITE a symbolic ref.
//
// Fail closed, twice over: anything that is not exactly a branch name under the alias — no such
// ref, an unset remote head, an ambiguous or hostile name, a truncated read — resolves to
// `undefined`, and the caller refuses the binding rather than guessing `main`. The name itself is
// held to `isSafeGitRefName`, the one ref predicate the rest of the product validates against.

import type { CommandResult } from "./types.js";
import { nodeSpawnFn, runCommand, type RunCommandDeps } from "./exec.js";
import { isSafeGitRefName } from "./git-worktree-adapter.js";
import {
  GIT_REMOTE_URL_READ_SANDBOX_POLICY,
  GIT_WORKTREE_READ_COMMAND_RULES,
  GitWorktreeReadError,
  type NodeGitWorktreeReaderDeps,
} from "./git-worktree-snapshot-node.js";

const DEFAULT_REMOTE_ALIAS = "origin";

// The same composition `git-worktree-snapshot-node.ts` performs privately for its own readers.
// Restated here only because that module does not export it; the shape is the read lane's, not a
// new one, and the read policy below is the SAME dedicated policy `readGitRemoteUrl` runs under —
// an isolated HOME with the global and system config scopes switched off, so a user's
// `url.<base>.insteadOf` or `remote.<name>.*` rewrites cannot change which ref this reads, and no
// credential name is forwarded because a local ref read authenticates to nothing.
function runDepsFor(deps: NodeGitWorktreeReaderDeps): RunCommandDeps {
  return {
    workspace: deps.workspace,
    policy: deps.policy ?? GIT_REMOTE_URL_READ_SANDBOX_POLICY,
    commandRules: GIT_WORKTREE_READ_COMMAND_RULES,
    spawn: deps.spawn ?? nodeSpawnFn,
    processEnv: deps.processEnv ?? process.env,
    now: deps.now ?? Date.now,
    ...(deps.resolveExecutable !== undefined ? { resolveExecutable: deps.resolveExecutable } : {}),
    ...(deps.home !== undefined ? { home: deps.home } : {}),
    ...(deps.onTerminated !== undefined ? { onTerminated: deps.onTerminated } : {}),
  };
}

// `--abbrev-ref=strict` prints `origin/main` for the common case and `remotes/origin/main` when a
// local branch named `origin/main` makes the short form ambiguous; loose mode would print the
// short form with a warning and let the ambiguity through. Both spellings name the same remote
// branch, so both prefixes are accepted; anything else — including a literal `HEAD`, which is what
// a remote head that is not a symbolic ref abbreviates to — is not a branch name and is refused.
function defaultBranchFromAbbrevRef(stdout: string, remoteAlias: string): string | undefined {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) return undefined;
  const line = lines[0] ?? "";
  const prefix = [`remotes/${remoteAlias}/`, `${remoteAlias}/`].find((candidate) =>
    line.startsWith(candidate),
  );
  if (prefix === undefined) return undefined;
  const branch = line.slice(prefix.length);
  if (branch.length === 0 || branch === "HEAD" || !isSafeGitRefName(branch)) return undefined;
  return branch;
}

/**
 * The default branch of one trusted remote alias, as the checkout records it in
 * `refs/remotes/<alias>/HEAD`, or `undefined` when the checkout records none.
 *
 * `undefined` covers every "this checkout does not say" case: no such remote, a remote head that
 * was never set (a checkout built by `git init` + `git remote add` rather than `git clone`), an
 * unborn repository, a directory that is not a repository, and a name that is not a safe ref.
 * Only a read that could not RUN — `git` missing, a timeout, an abort — throws, because that is an
 * operational fault the caller must be able to tell apart from an honest absence.
 */
export async function readGitDefaultBranch(
  deps: NodeGitWorktreeReaderDeps,
  remoteAlias: string = DEFAULT_REMOTE_ALIAS,
): Promise<string | undefined> {
  if (!isSafeGitRefName(remoteAlias)) throw new GitWorktreeReadError("remote alias is unsafe");
  const runDeps = { ...runDepsFor(deps), onTerminated: deps.onTerminated };
  let result: CommandResult;
  try {
    result = await runCommand(
      {
        command: "git",
        args: ["rev-parse", "--abbrev-ref=strict", `refs/remotes/${remoteAlias}/HEAD`],
        cwd: undefined,
        timeoutMs: deps.timeoutMs,
        signal: deps.signal ?? new AbortController().signal,
      },
      runDeps,
    );
  } catch {
    throw new GitWorktreeReadError("git rev-parse failed to run");
  }
  // A truncated read replaced stdout with a marker; nothing can be derived from it. A non-zero
  // exit is git saying the ref does not resolve — and it still echoes the operand on stdout, so
  // the exit code must be consulted before the output is.
  if (result.truncated || result.exitCode !== 0) return undefined;
  return defaultBranchFromAbbrevRef(result.stdout, remoteAlias);
}
