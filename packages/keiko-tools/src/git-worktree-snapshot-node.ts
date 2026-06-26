// Read-only worktree snapshot reader for governed local Git flows (Issue #475, Epic #470).
//
// The #472 mutation kernel is PURE over an injected `GitWorktreeSnapshot`: it never reads the live
// repository itself. For the end-user-visible local flows (#475) the SERVER must build a TRUSTWORTHY
// snapshot from the real worktree before driving the kernel — a client must not be able to assert,
// e.g., a staged-file count that would slip a commit past preflight. This module is that reader.
//
// It runs ONLY read-only `git` inspection (status / rev-parse / branch / remote / diff) through the
// SAME no-shell spawn boundary as the mutation adapter, but with its OWN dedicated allowlist that is
// STRUCTURALLY SEPARATE from `GIT_MUTATION_COMMAND_RULES` — it can never reach a write subcommand, and
// the mutation rules can never reach a read subcommand. No generic exec, no shell, no direct FS.
//
// Output is content-free by construction (counts, flags, branch/remote NAMES only) for the snapshot;
// `readStagedPaths` additionally returns the staged relative paths, which stay inside the server for
// scope inference and are never persisted into evidence.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { CommandRule, CommandResult, SandboxPolicy } from "./types.js";
import { DEFAULT_SANDBOX_POLICY } from "./types.js";
import {
  nodeSpawnFn,
  runCommand,
  type ExecutableResolver,
  type HomeProvider,
  type RunCommandDeps,
  type SpawnFn,
} from "./exec.js";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";

// The dedicated READ-ONLY allowlist. Mirrors the mutation rules' defence-in-depth flag denials but
// permits only inspection subcommands — no `branch <name>`, no `add`, no `commit`, no network verb.
export const GIT_WORKTREE_READ_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "git",
    allowedSubcommands: Object.freeze(["status", "rev-parse", "branch", "remote", "diff"]),
    valueFlags: Object.freeze([
      "-C",
      "-c",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--exec-path",
    ]),
    denyFlags: Object.freeze([
      "-C",
      "-c",
      "--config-env",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--exec-path",
      "--ext-diff",
      "--textconv",
      "--no-index",
      "--contents",
      "--output",
    ]),
  },
]);

export interface NodeGitWorktreeReaderDeps {
  readonly workspace: WorkspaceInfo;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: SpawnFn | undefined;
  readonly policy?: SandboxPolicy | undefined;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly home?: HomeProvider | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

interface ReadContext {
  readonly runDeps: RunCommandDeps;
  readonly signal: AbortSignal;
  readonly timeoutMs: number | undefined;
}

function buildReadContext(deps: NodeGitWorktreeReaderDeps): ReadContext {
  return {
    runDeps: {
      workspace: deps.workspace,
      policy: deps.policy ?? DEFAULT_SANDBOX_POLICY,
      commandRules: GIT_WORKTREE_READ_COMMAND_RULES,
      spawn: deps.spawn ?? nodeSpawnFn,
      processEnv: deps.processEnv ?? process.env,
      now: deps.now ?? Date.now,
      ...(deps.resolveExecutable !== undefined
        ? { resolveExecutable: deps.resolveExecutable }
        : {}),
      ...(deps.home !== undefined ? { home: deps.home } : {}),
    },
    signal: deps.signal ?? new AbortController().signal,
    timeoutMs: deps.timeoutMs,
  };
}

// Thrown when a read-only inspection command exits non-zero (e.g. not a git repository). The caller
// translates this into a content-free server error rather than leaking git's stderr.
export class GitWorktreeReadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitWorktreeReadError";
  }
}

async function runRead(ctx: ReadContext, argv: readonly string[]): Promise<string> {
  let result: CommandResult;
  try {
    result = await runCommand(
      { command: "git", args: argv, cwd: undefined, timeoutMs: ctx.timeoutMs, signal: ctx.signal },
      ctx.runDeps,
    );
  } catch {
    throw new GitWorktreeReadError(`git ${argv[0] ?? "?"} failed to run`);
  }
  if (result.exitCode !== 0) {
    throw new GitWorktreeReadError(`git ${argv[0] ?? "?"} exited ${String(result.exitCode)}`);
  }
  return result.stdout;
}

// ─── porcelain=v2 parsing ───────────────────────────────────────────────────────────────────

interface PorcelainCounts {
  headDetached: boolean;
  currentBranchName: string | undefined;
  staged: number;
  unstaged: number;
  untracked: number;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
}

function parseAheadBehind(value: string, counts: PorcelainCounts): void {
  // Format: "+<ahead> -<behind>"
  for (const token of value.trim().split(/\s+/)) {
    const n = Number.parseInt(token.slice(1), 10);
    if (token.startsWith("+") && Number.isFinite(n)) counts.ahead = Math.max(0, n);
    if (token.startsWith("-") && Number.isFinite(n)) counts.behind = Math.max(0, n);
  }
}

function applyHeaderLine(line: string, counts: PorcelainCounts): void {
  if (line.startsWith("# branch.head ")) {
    const head = line.slice("# branch.head ".length).trim();
    if (head === "(detached)") counts.headDetached = true;
    else counts.currentBranchName = head;
  } else if (line.startsWith("# branch.upstream ")) {
    counts.hasUpstream = true;
  } else if (line.startsWith("# branch.ab ")) {
    parseAheadBehind(line.slice("# branch.ab ".length), counts);
  }
}

// A "1"/"2" entry carries a two-char XY status field after the type token: X = index (staged), Y =
// worktree (unstaged). A "." in a slot means "unmodified there".
function applyChangedEntry(line: string, counts: PorcelainCounts): void {
  const xy = line.slice(2, 4);
  const staged = xy[0] ?? ".";
  const worktree = xy[1] ?? ".";
  if (staged !== ".") counts.staged += 1;
  if (worktree !== ".") counts.unstaged += 1;
}

function parsePorcelain(stdout: string): PorcelainCounts {
  const counts: PorcelainCounts = {
    headDetached: false,
    currentBranchName: undefined,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    hasUpstream: false,
    ahead: 0,
    behind: 0,
  };
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith("# ")) applyHeaderLine(line, counts);
    else if (line.startsWith("1 ") || line.startsWith("2 ")) applyChangedEntry(line, counts);
    else if (line.startsWith("u "))
      counts.unstaged += 1; // unmerged path: needs resolution
    else if (line.startsWith("? ")) counts.untracked += 1;
  }
  return counts;
}

function parseLines(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ─── Public reader ───────────────────────────────────────────────────────────────────────────

/**
 * Reads the live worktree into a content-free `GitWorktreeSnapshot` via read-only git inspection.
 * `operationInProgress` is not probed by this reader (it affects only advisory preflight findings for
 * the local branch/stage/commit flow); abort/recovery flows that require it are out of #475 scope.
 */
export async function readGitWorktreeSnapshot(
  deps: NodeGitWorktreeReaderDeps,
): Promise<GitWorktreeSnapshot> {
  const ctx = buildReadContext(deps);
  const [statusOut, branchOut, remoteOut] = await Promise.all([
    runRead(ctx, ["status", "--porcelain=v2", "--branch"]),
    runRead(ctx, ["branch", "--list", "--format=%(refname:short)"]),
    runRead(ctx, ["remote"]),
  ]);
  const c = parsePorcelain(statusOut);
  return {
    headDetached: c.headDetached,
    ...(c.currentBranchName !== undefined ? { currentBranchName: c.currentBranchName } : {}),
    stagedFileCount: c.staged,
    unstagedFileCount: c.unstaged,
    untrackedFileCount: c.untracked,
    hasUpstream: c.hasUpstream,
    aheadCount: c.ahead,
    behindCount: c.behind,
    existingLocalBranchNames: parseLines(branchOut),
    remoteAliases: parseLines(remoteOut),
  };
}

/**
 * Reads the relative paths currently staged for commit (`git diff --cached --name-only`). Used by the
 * server for commit-intent scope inference; the paths stay in-process and are never persisted.
 */
export async function readStagedPaths(deps: NodeGitWorktreeReaderDeps): Promise<readonly string[]> {
  const ctx = buildReadContext(deps);
  const out = await runRead(ctx, ["diff", "--cached", "--name-only"]);
  return parseLines(out);
}
