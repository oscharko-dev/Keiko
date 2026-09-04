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

import { gitEnv } from "@oscharko-dev/keiko-git";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { CommandRule, CommandResult, SandboxPolicy } from "./types.js";
import { DEFAULT_SANDBOX_POLICY, GOVERNED_GIT_IDENTITY_SANDBOX_POLICY } from "./types.js";
import {
  nodeSpawnFn,
  runCommand,
  type ExecutableResolver,
  type HomeProvider,
  type RunCommandDeps,
  type SpawnFn,
  type CommandTerminationEvidence,
} from "./exec.js";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import { isSafeGitRefName } from "./git-worktree-adapter.js";

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

// The `GIT_CONFIG_*` scope switches of keiko-git's `gitEnv` — the product's ONE config-isolated
// local-read git profile — picked by name so the platform null-device primitive behind
// `GIT_CONFIG_GLOBAL` keeps a single owner above the contracts leaf (KEIKO-0717 was exactly a
// hand-copied null device drifting on Windows).
function localReadConfigScopePins(): Readonly<Record<string, string>> {
  const pins: Record<string, string> = {};
  for (const [name, value] of Object.entries(gitEnv({}))) {
    if (name.startsWith("GIT_CONFIG_") && value !== undefined) pins[name] = value;
  }
  return Object.freeze(pins);
}

// The dedicated policy for `readGitRemoteUrl` — see its comment for why neither the default policy
// nor the identity lane is right for that ONE read. Built from the exported lane constants:
//   - the identity lane's `envAllowlist`, so the account names (`USER`, `LOGNAME`, ...) are not in
//     the output scrub set and an owner that contains them survives into the URL;
//   - an ISOLATED home (the default ephemeral one) plus `GIT_CONFIG_GLOBAL` = null device and
//     `GIT_CONFIG_NOSYSTEM`, so no user or host config scope can rewrite the checkout's remote;
//   - NO `credentialEnvAllowlist`: a local read authenticates to nothing, so no token reaches git.
const GIT_REMOTE_URL_READ_SANDBOX_POLICY: SandboxPolicy = Object.freeze({
  ...DEFAULT_SANDBOX_POLICY,
  envAllowlist: GOVERNED_GIT_IDENTITY_SANDBOX_POLICY.envAllowlist,
  credentialEnvAllowlist: undefined,
  homeIsolation: "ephemeral",
  pinnedEnv: Object.freeze({
    ...GOVERNED_GIT_IDENTITY_SANDBOX_POLICY.pinnedEnv,
    ...localReadConfigScopePins(),
  }),
});

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
  // The termination-evidence port for every runCommand this lane performs (RunCommandDeps
  // deps-level seam, exec.ts): production composition boundaries wire it once so no call on the
  // lane is silently unobservable (PR #3354 review, comment 3887021650).
  readonly onTerminated?: ((evidence: CommandTerminationEvidence) => void) | undefined;
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
      ...(deps.onTerminated !== undefined ? { onTerminated: deps.onTerminated } : {}),
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

/**
 * Resolves one configured remote URL for a trusted remote alias. The URL never crosses the tools
 * boundary into a response or evidence document; the server consumes it only to derive the bounded
 * GitHub owner/repository operand used by its branch-protection reader.
 */
export async function readGitRemoteUrl(
  deps: NodeGitWorktreeReaderDeps,
  remoteAlias: string,
): Promise<string> {
  if (!isSafeGitRefName(remoteAlias)) {
    throw new GitWorktreeReadError("remote alias is unsafe");
  }
  // This read is the ONE reader here whose payload is content-bearing: the caller needs the remote
  // URL itself to derive an `owner/repo` operand, and the consumers use that operand for
  // AUTHORIZATION (which repository a checkout may read). Two things follow, and neither the
  // default policy nor the identity lane satisfies both — hence the dedicated policy above.
  //
  // 1. The account names must not be scrubbed. `runCommand` scrubs the value of every env var that
  //    is NOT on the policy's `envAllowlist`, so under the default policy a user whose GitHub owner
  //    contains their OS user name (`USER=alice` owning `alice-dev/App`) got
  //    `https://github.com/[REDACTED]-dev/App` back, and every consumer derived a repository that
  //    does not exist. The identity lane's allowlist names exactly those account variables.
  //
  // 2. The URL must be the one the CHECKOUT configures, so HOME is deliberately NOT inherited and
  //    the global and system config scopes are switched off. The identity lane inherits HOME
  //    because a commit needs the user's signing configuration; this read needs none of it, and
  //    with the user's config in scope `git remote get-url` applies every `url.<base>.insteadOf`
  //    rewrite from `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` or the host's system gitconfig.
  //    An enterprise mirror rule then resolved a non-GitHub URL (every consumer denied) and an
  //    owner-rewriting rule changed the owner the consumers authorized against. An authorization
  //    operand must come from the checkout, never from a global rewrite of it.
  //
  // The policy grants NO credential and NO network: it carries no `credentialEnvAllowlist`, so no
  // token reaches the git child and every token value stays in the scrub set. A caller that passes
  // its own policy keeps it.
  const readDeps =
    deps.policy === undefined ? { ...deps, policy: GIT_REMOTE_URL_READ_SANDBOX_POLICY } : deps;
  const lines = parseLines(
    await runRead(buildReadContext(readDeps), ["remote", "get-url", "--", remoteAlias]),
  );
  if (lines.length !== 1) {
    throw new GitWorktreeReadError("remote URL could not be resolved uniquely");
  }
  return lines[0] ?? "";
}

// Matches git's own "leftover conflict marker" diagnostic line, e.g.
// "src/foo.ts:12: leftover conflict marker". Anchored to git's exact phrase so a `--check` line about
// a DIFFERENT problem (trailing whitespace, space-before-tab) is never mistaken for a conflict marker
// and does not block a commit that has nothing to do with an unresolved merge.
const LEFTOVER_CONFLICT_MARKER_LINE = /^(.+):\d+: leftover conflict marker/;

function countConflictMarkerPaths(checkOutput: string): number {
  const paths = new Set<string>();
  for (const line of checkOutput.split("\n")) {
    const match = LEFTOVER_CONFLICT_MARKER_LINE.exec(line);
    if (match?.[1] !== undefined) paths.add(match[1]);
  }
  return paths.size;
}

/**
 * Counts staged files that still contain an unresolved `<<<<<<<`/`=======`/`>>>>>>>` merge-conflict
 * marker, via `git diff --cached --check` (git's OWN conflict-marker + whitespace-error detector —
 * not a bespoke regex scan of file content, which would either miss git's exact marker-size handling
 * or trip on legitimate `=======` text unrelated to a conflict). `--check` exits non-zero when it
 * finds ANY problem (conflict markers OR whitespace errors); this reader distinguishes the two by
 * matching only git's "leftover conflict marker" line, so a whitespace-only violation never blocks a
 * commit through this path. Returns the COUNT of distinct affected paths only — never the paths
 * themselves, never file content — so the content-free invariant holds even for this read.
 *
 * A `git diff --check` failure that is NOT itself a "no problems" (exit 0) or a recognizable
 * conflict-marker/whitespace report (e.g. "not a git repository") is surfaced as a thrown
 * GitWorktreeReadError — the same fail-closed contract as every other reader in this module — rather
 * than silently reporting "no markers found".
 */
export async function readStagedConflictMarkerFileCount(
  deps: NodeGitWorktreeReaderDeps,
): Promise<number> {
  const ctx = buildReadContext(deps);
  let result: CommandResult;
  try {
    result = await runCommand(
      {
        command: "git",
        args: ["diff", "--cached", "--check"],
        cwd: undefined,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      },
      ctx.runDeps,
    );
  } catch {
    throw new GitWorktreeReadError("git diff --check failed to run");
  }
  // TRUNCATION FIRST, before the exit code is read — this reader FAILED OPEN without it, and it
  // guards whether a commit may proceed.
  //
  // When the output cap trips, `runCommand` kills git and returns `stdout` replaced by the literal
  // "[TRUNCATED OUTPUT REDACTED]". That placeholder is non-empty, so the emptiness check below lets
  // it through, and it matches no `path:line: leftover conflict marker` line, so the count came back
  // as 0 — indistinguishable from "this staged changeset is clean". `conflictMarkerBlockResult` then
  // allowed the commit and baked the marker lines into history.
  //
  // Checked BEFORE `exitCode`, because a truncated run can also report 0: either way the output is
  // incomplete, so no count can be derived from it and the only honest answer is to refuse.
  if (result.truncated) {
    throw new GitWorktreeReadError(
      "git diff --check output was truncated; the conflict-marker count cannot be trusted",
    );
  }
  if (result.exitCode === 0) return 0;
  // `--check` exits non-zero both when it reports a problem (its diagnostic lines go to stdout, e.g.
  // "path:line: leftover conflict marker.") AND on a genuine command/environment failure (e.g. "fatal:
  // not a git repository", which goes to stderr with EMPTY stdout). Only the former is this reader's
  // concern; the latter fails closed like every other reader here rather than silently reporting "no
  // markers found" for a repository this process could not actually inspect.
  if (result.stdout.trim().length === 0) {
    throw new GitWorktreeReadError("git diff --check exited non-zero with no diagnostic output");
  }
  return countConflictMarkerPaths(result.stdout);
}
