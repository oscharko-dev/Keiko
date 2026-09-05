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
import { createHash } from "node:crypto";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { CommandRule, CommandResult, SandboxPolicy } from "./types.js";
import {
  DEFAULT_SANDBOX_POLICY,
  GOVERNED_GIT_IDENTITY_SANDBOX_POLICY,
  GOVERNED_GIT_REMOTE_SANDBOX_POLICY,
} from "./types.js";
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
import { CommandCancelledError, CommandTimeoutError } from "./errors.js";
import { isSafeGitRefName } from "./git-worktree-adapter.js";
import { gitIndexTreeDigest, parseGitIndexEntries, type IndexEntry } from "./git-index-identity.js";

// The dedicated READ-ONLY allowlist. Mirrors the mutation rules' defence-in-depth flag denials but
// permits only inspection subcommands — no `branch <name>`, no `add`, no `commit`, no network verb.
export const GIT_WORKTREE_READ_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "git",
    allowedSubcommands: Object.freeze([
      "status",
      "rev-parse",
      "branch",
      "remote",
      "diff",
      "ls-files",
      "ls-tree",
      "cat-file",
    ]),
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
//   - `outputScrub: "credentials-only"`: this read's stdout IS the value the caller needs. The
//     default mode scrubs the value of EVERY non-allowlisted parent variable, and a CI runner
//     exports the checkout's own owner/repo as GITHUB_REPOSITORY — so the URL came back as
//     `https://github.com/[REDACTED].git` and every consumer addressed a repository that does not
//     exist. The first repair only hid that from the tests. Credentials are still scrubbed, by
//     governed name, by credential-shaped name and by shape; a context name is not a secret.
export const GIT_REMOTE_URL_READ_SANDBOX_POLICY: SandboxPolicy = Object.freeze({
  ...DEFAULT_SANDBOX_POLICY,
  envAllowlist: GOVERNED_GIT_IDENTITY_SANDBOX_POLICY.envAllowlist,
  credentialEnvAllowlist: undefined,
  outputScrub: "credentials-only",
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

function immutableReadPolicy(policy: SandboxPolicy): SandboxPolicy {
  return {
    ...policy,
    pinnedEnv: {
      ...policy.pinnedEnv,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
    },
  };
}

function buildReadContext(deps: NodeGitWorktreeReaderDeps): ReadContext {
  return {
    runDeps: {
      workspace: deps.workspace,
      policy: immutableReadPolicy(deps.policy ?? DEFAULT_SANDBOX_POLICY),
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

// ─── lazy-fetch / replace-objects guard: version-gated, fail-closed ────────────────────────────
//
// `immutableReadPolicy` above pins GIT_NO_LAZY_FETCH / GIT_NO_REPLACE_OBJECTS into every read this
// lane performs — the equivalent of the `--no-lazy-fetch --no-replace-objects` CLI flags, per git's
// own docs. But git's environment.c gained the GIT_NO_LAZY_FETCH check in the SAME release that
// added the CLI flag (2.45): on the git 2.43 that `ubuntu-latest` ships, the pinned env var is
// silently IGNORED, not merely a redundant duplicate of an absent flag. That only matters for a
// PROMISOR (partial) clone — an ordinary clone has no promisor remote to lazily fetch from, so the
// guard protects nothing there and must not refuse those reads (every read in this lane's own test
// suite runs against a plain `git init` repository on whatever git the host happens to have). So a
// read here is refused ONLY when BOTH hold: this repository has a promisor remote configured, AND
// the installed git is too old to enforce the pinned env vars — reviewer 3941836280.
export class GitLazyFetchGuardUnsupportedError extends GitWorktreeReadError {
  public constructor(gitVersion: string | undefined) {
    super(
      gitVersion === undefined
        ? "git lazy-fetch guard support could not be determined for a promisor repository; refusing read to fail closed"
        : `git ${gitVersion} does not enforce GIT_NO_LAZY_FETCH on this promisor repository; refusing read to fail closed`,
    );
    this.name = "GitLazyFetchGuardUnsupportedError";
  }
}

// The Git release that added BOTH the `--no-lazy-fetch`/`--no-replace-objects` CLI flags and the
// GIT_NO_(LAZY_FETCH|REPLACE_OBJECTS) environment-variable handling in environment.c.
const GIT_LAZY_FETCH_GUARD_MIN_VERSION = Object.freeze({ major: 2, minor: 45 });

interface ParsedGitVersion {
  readonly major: number;
  readonly minor: number;
}

// Exported so keiko-server's independent GitProcessRunner-based lane (gitChangeSnapshotService.ts)
// can apply the identical version gate against its own `git version` probe without sharing this
// module's spawn/child_process machinery.
export function parseGitVersionOutput(output: string): ParsedGitVersion | undefined {
  const match = /git version (\d+)\.(\d+)/u.exec(output);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function versionAtLeast(version: ParsedGitVersion, min: ParsedGitVersion): boolean {
  return version.major !== min.major ? version.major > min.major : version.minor >= min.minor;
}

export function gitLazyFetchGuardSupportedForVersion(output: string): boolean {
  const version = parseGitVersionOutput(output);
  return version !== undefined && versionAtLeast(version, GIT_LAZY_FETCH_GUARD_MIN_VERSION);
}

interface GitLazyFetchGuardSupport {
  readonly supported: boolean;
  readonly gitVersion: string | undefined;
}

// A dedicated, narrow rule set for the guard's own two probes (git's version banner and a read-only
// effective-config lookup) — STRUCTURALLY SEPARATE from the main read allowlist above (mirrors
// git-mutation-node.ts's GLOBAL_SIGNING_POLICY_COMMAND_RULES) so neither probe widens what an
// ordinary snapshot read may invoke, and "config" here can never reach a value-setting form: every
// scope/write flag is denied, and the only argv this module ever builds for it is a fixed, literal
// `--get-regexp` lookup.
const GIT_LAZY_FETCH_GUARD_PROBE_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "git",
    allowedSubcommands: Object.freeze(["version", "config"]),
    valueFlags: Object.freeze([]),
    denyFlags: Object.freeze([
      "-c",
      "-C",
      "--config-env",
      "--file",
      "--blob",
      "--system",
      "--global",
      "--worktree",
      "--add",
      "--replace-all",
      "--unset",
      "--unset-all",
      "--rename-section",
      "--remove-section",
      "--edit",
    ]),
  },
]);

async function runGuardProbe(ctx: ReadContext, argv: readonly string[]): Promise<CommandResult> {
  const runDeps: RunCommandDeps = {
    ...ctx.runDeps,
    commandRules: GIT_LAZY_FETCH_GUARD_PROBE_COMMAND_RULES,
    onTerminated: ctx.runDeps.onTerminated,
  };
  return runCommand(
    {
      command: "git",
      args: [...argv],
      cwd: undefined,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    },
    runDeps,
  );
}

// A promisor remote is what makes lazy fetch possible at all — a repository without one has
// nothing for GIT_NO_LAZY_FETCH to guard, in any git version. Git treats a remote as a promisor
// remote from EITHER an explicit `remote.<name>.promisor` (true by git's own boolean grammar — a
// bare key with no value at all is true, same as `= true`/`yes`/`on`/`1`) OR from
// `remote.<name>.partialclonefilter` being configured AT ALL, independent of any `promisor` key
// (https://github.com/git/git/blob/v2.43.0/promisor-remote.c). The probe reads git's EFFECTIVE
// configuration — no `--local` scope restriction — so system/global/worktree config and any
// `include.path`/`includeIf` directive are honoured exactly as a real `git` invocation would
// (reviewer 3941943601). Any ambiguity (probe failure, non-zero/truncated exit) is treated as
// "cannot rule out a promisor remote" rather than as "safe", so a broken probe falls through to the
// strict version gate instead of silently skipping it. This is re-evaluated on EVERY call, never
// cached: the repository's own config can change while Keiko runs, and an earlier safe verdict must
// never authorize a later, riskier one (reviewer 3941943603).
async function repositoryHasPromisorRemote(ctx: ReadContext): Promise<boolean> {
  let result: CommandResult;
  try {
    result = await runGuardProbe(ctx, [
      "config",
      "--get-regexp",
      String.raw`^remote\..*\.(promisor|partialclonefilter)$`,
    ]);
  } catch (error) {
    // A cancelled/timed-out probe is not "ambiguous risk" — it is the caller's OWN signal firing,
    // and must reach the real command's cancellation handling unchanged, not be relabelled as a
    // guard failure.
    if (error instanceof CommandCancelledError || error instanceof CommandTimeoutError) throw error;
    return true;
  }
  if (result.exitCode === 1 && result.stdout.trim().length === 0) return false;
  if (result.exitCode !== 0 || result.truncated) return true;
  return gitConfigIndicatesPromisorRemote(result.stdout);
}

// Parses the raw `git config --get-regexp '^remote\..*\.(promisor|partialclonefilter)$'` stdout
// this probe (and keiko-server's independent GitProcessRunner-based gitChangeSnapshotService.ts
// lane) produces, into a single promisor-risk verdict. Exported so BOTH lanes share this ONE
// reading of git's config-value grammar instead of two independent parsers that can silently drift
// apart — exactly reviewer 3941943601's failure mode.
export function gitConfigIndicatesPromisorRemote(getRegexpStdout: string): boolean {
  return getRegexpStdout
    .trim()
    .split("\n")
    .some((line) => isPromisorRiskConfigLine(line));
}

function isPromisorRiskConfigLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  const spaceIndex = trimmed.indexOf(" ");
  const key = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
  // A configured partial-clone filter makes the remote a promisor remote to git on its own, with
  // no `promisor` key required — the filter spec (its value) carries no boolean meaning.
  if (key.endsWith(".partialclonefilter")) return true;
  if (!key.endsWith(".promisor")) return false;
  // git's config boolean grammar (https://git-scm.com/docs/git-config#_values): a variable with no
  // value at all is true; explicit "yes"/"on"/"true"/"1" (case-insensitive) are true; anything else
  // (including "no"/"off"/"false"/"0"/empty) is false.
  if (spaceIndex === -1) return true;
  return /^(?:true|yes|on|1)$/iu.test(trimmed.slice(spaceIndex + 1).trim());
}

// The version probe is MEMOIZED across every future call on this spawn function (below), so it
// must never inherit one particular caller's own cancellation signal or timeout — a caller who
// aborts their own read must not poison this shared, cached probe for every later, unrelated
// caller (reviewer 3941928444). It gets its own short, independent, bounded budget instead.
const GIT_LAZY_FETCH_GUARD_VERSION_PROBE_TIMEOUT_MS = 5_000;

async function runVersionProbe(ctx: ReadContext): Promise<CommandResult> {
  const runDeps: RunCommandDeps = {
    ...ctx.runDeps,
    commandRules: GIT_LAZY_FETCH_GUARD_PROBE_COMMAND_RULES,
    onTerminated: ctx.runDeps.onTerminated,
  };
  return runCommand(
    {
      command: "git",
      args: ["version"],
      cwd: undefined,
      timeoutMs: GIT_LAZY_FETCH_GUARD_VERSION_PROBE_TIMEOUT_MS,
      signal: new AbortController().signal,
    },
    runDeps,
  );
}

async function probeGitVersionGuardSupport(ctx: ReadContext): Promise<GitLazyFetchGuardSupport> {
  let result: CommandResult;
  try {
    result = await runVersionProbe(ctx);
  } catch {
    return { supported: false, gitVersion: undefined };
  }
  if (result.exitCode !== 0) return { supported: false, gitVersion: undefined };
  const version = parseGitVersionOutput(result.stdout);
  if (version === undefined) return { supported: false, gitVersion: undefined };
  return {
    supported: versionAtLeast(version, GIT_LAZY_FETCH_GUARD_MIN_VERSION),
    gitVersion: `${String(version.major)}.${String(version.minor)}`,
  };
}

// The installed git's version is a property of the PROCESS (keyed by the spawn function — one real
// binary in production, a fresh fake per test) and cannot change mid-process, so a DETERMINATE
// reading (git actually answered with a parseable version) is cached for the spawn function's
// lifetime. An INDETERMINATE probe (spawn failure — e.g. a workspace root that briefly is not a
// directory — non-zero exit, the probe's own bounded timeout, or an unparseable banner) is the
// opposite of a durable fact and is never cached: `gitVersion` stays `undefined` for exactly these
// cases, and the eviction below removes the entry the moment it settles, so the very next call
// gets a fresh probe instead of replaying one bad probe as a permanent "guard unsupported" verdict
// for every later, unrelated workspace on the same spawn function (reviewer 3941928444). Promisor-
// remote status is NOT cached the same way — see `repositoryHasPromisorRemote` above.
const gitVersionGuardSupportCache = new WeakMap<SpawnFn, Promise<GitLazyFetchGuardSupport>>();

function cachedVersionGuardSupport(ctx: ReadContext): Promise<GitLazyFetchGuardSupport> {
  const spawn = ctx.runDeps.spawn;
  const cached = gitVersionGuardSupportCache.get(spawn);
  if (cached !== undefined) return cached;
  const probe = probeGitVersionGuardSupport(ctx);
  gitVersionGuardSupportCache.set(spawn, probe);
  void probe.then((support) => {
    if (support.gitVersion === undefined) gitVersionGuardSupportCache.delete(spawn);
  });
  return probe;
}

async function detectGitLazyFetchGuardSupport(ctx: ReadContext): Promise<GitLazyFetchGuardSupport> {
  const atRisk = await repositoryHasPromisorRemote(ctx);
  if (!atRisk) return { supported: true, gitVersion: undefined };
  return cachedVersionGuardSupport(ctx);
}

// Reused by git-mutation-node.ts (a structurally separate command-rule lane) so the SAME
// version-gated fail-closed check protects the write path too, without that lane needing a
// `version`/`config` allowlist entry of its own — this probes through the read-only lane's own
// dedicated rules regardless of which lane's deps are handed in.
export async function ensureGitLazyFetchGuardSupported(
  deps: NodeGitWorktreeReaderDeps,
): Promise<void> {
  // Already cancelled: let the real command's own runCommand call throw CommandCancelledError
  // exactly as it always did, rather than spending a probe spawn on a call that cannot proceed
  // either way.
  if (deps.signal?.aborted === true) return;
  const guard = await detectGitLazyFetchGuardSupport(buildReadContext(deps));
  if (!guard.supported) throw new GitLazyFetchGuardUnsupportedError(guard.gitVersion);
}

async function runRead(ctx: ReadContext, argv: readonly string[]): Promise<string> {
  const result = await runReadResult(ctx, argv);
  if (result.truncated) throw new GitWorktreeReadError("git inspection output was truncated");
  return result.stdout;
}

async function runReadResult(ctx: ReadContext, argv: readonly string[]): Promise<CommandResult> {
  if (!ctx.signal.aborted) {
    const guard = await detectGitLazyFetchGuardSupport(ctx);
    if (!guard.supported) throw new GitLazyFetchGuardUnsupportedError(guard.gitVersion);
  }
  const runDeps: RunCommandDeps = { ...ctx.runDeps, onTerminated: ctx.runDeps.onTerminated };
  let result: CommandResult;
  try {
    // No `--no-lazy-fetch` / `--no-replace-objects` CLI flags here: git's own docs state each is
    // "equivalent to setting the GIT_NO_(LAZY_FETCH|REPLACE_OBJECTS) environment variable", and
    // `immutableReadPolicy` above already pins both env vars into every read this lane performs.
    // The CLI form of `--no-lazy-fetch` is a newer global option (absent on the git 2.43 that
    // `ubuntu-latest` ships): passing it made every read here exit 129 ("unknown option") on CI
    // while the same read stayed green on a workstation with a newer git — the guard itself is
    // unweakened, only its incompatible, redundant CLI duplicate is gone. The check above refuses
    // to reach this spawn at all for an at-risk (promisor) repository whose installed git is too
    // old for the pinned env vars to do anything.
    result = await runCommand(
      {
        command: "git",
        args: [...argv],
        cwd: undefined,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      },
      runDeps,
    );
  } catch {
    throw new GitWorktreeReadError(`git ${argv[0] ?? "?"} failed to run`);
  }
  if (result.exitCode !== 0) {
    throw new GitWorktreeReadError(`git ${argv[0] ?? "?"} exited ${String(result.exitCode)}`);
  }
  return result;
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
  const [statusOut, branchOut, remoteOut, indexOut] = await Promise.all([
    runRead(ctx, ["status", "--porcelain=v2", "--branch"]),
    runRead(ctx, ["branch", "--list", "--format=%(refname:short)"]),
    runRead(ctx, ["remote"]),
    runRead(ctx, ["ls-files", "--stage", "-z"]),
  ]);
  const c = parsePorcelain(statusOut);
  return {
    ...(statusOut.includes("# branch.oid (initial)")
      ? {}
      : { headSha: await readGitRevision(deps, "HEAD") }),
    stagedTreeDigest: gitIndexTreeDigest(indexOut),
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

/** Bounded configured aliases only; this never contacts a remote. */
function metadataReadContext(deps: NodeGitWorktreeReaderDeps): ReadContext {
  const policy = deps.policy ?? DEFAULT_SANDBOX_POLICY;
  return buildReadContext({
    ...deps,
    policy: {
      ...policy,
      maxOutputBytes: Math.min(deps.policy?.maxOutputBytes ?? 4_194_304, 4_194_304),
    },
  });
}

export async function readGitIndexTreeDigest(deps: NodeGitWorktreeReaderDeps): Promise<string> {
  return gitIndexTreeDigest(
    await runRead(metadataReadContext(deps), ["ls-files", "--stage", "-z", "--"]),
  );
}

export async function readGitIndexStat(deps: NodeGitWorktreeReaderDeps): Promise<string> {
  return runRead(metadataReadContext(deps), ["ls-files", "--debug", "-z", "--"]);
}

export async function readGitIndexEntries(
  deps: NodeGitWorktreeReaderDeps,
): Promise<readonly IndexEntry[]> {
  return parseGitIndexEntries(
    await runRead(metadataReadContext(deps), ["ls-files", "--stage", "-z", "--"]),
    false,
  );
}
export async function readGitTreeEntries(
  deps: NodeGitWorktreeReaderDeps,
  sha: string,
): Promise<readonly IndexEntry[]> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) throw new TypeError("git-tree-sha-invalid");
  return parseGitIndexEntries(
    await runRead(metadataReadContext(deps), ["ls-tree", "-r", "-z", "--full-tree", sha]),
    true,
  );
}
export async function readGitUntrackedPaths(
  deps: NodeGitWorktreeReaderDeps,
): Promise<readonly string[]> {
  const output = await runRead(metadataReadContext(deps), [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
  ]);
  if (output === "") return [];
  if (!output.endsWith("\0") || output.includes("\uFFFD"))
    throw new TypeError("git-path-list-incomplete");
  return output.slice(0, -1).split("\0");
}
export async function readGitBlobText(
  deps: NodeGitWorktreeReaderDeps,
  sha: string,
): Promise<string> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) throw new TypeError("git-blob-sha-invalid");
  return runRead(
    buildReadContext({ ...deps, policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 65_536 } }),
    ["cat-file", "blob", sha],
  );
}

export async function readGitRemoteAliases(
  deps: NodeGitWorktreeReaderDeps,
): Promise<readonly string[]> {
  return parseLines(await runRead(buildReadContext(deps), ["remote"]));
}

/** Resolves a caller-validated ref to an exact immutable commit; never permits revision options. */
export async function readGitRevision(
  deps: NodeGitWorktreeReaderDeps,
  ref: string,
): Promise<string> {
  if (!isSafeGitRefName(ref)) throw new GitWorktreeReadError("git revision is unsafe");
  const value = (
    await runRead(buildReadContext(deps), [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ])
  ).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new GitWorktreeReadError("git revision did not resolve uniquely");
  }
  return value;
}

/** Resolves the exact named ref used by a compare-and-swap ref transaction. */
export async function readGitFullRef(
  deps: NodeGitWorktreeReaderDeps,
  ref: string,
): Promise<string> {
  if (!isSafeGitRefName(ref)) throw new GitWorktreeReadError("git revision is unsafe");
  const value = (
    await runRead(buildReadContext(deps), [
      "rev-parse",
      "--symbolic-full-name",
      "--verify",
      "--end-of-options",
      ref,
    ])
  ).trim();
  if (!/^refs\/(?:heads|remotes)\//u.test(value) || !isSafeGitRefName(value))
    throw new GitWorktreeReadError("git named revision is unavailable");
  return value;
}

/** Reads the same full-tree digest from an immutable tree or commit object. */
export async function readGitTreeDigest(
  deps: NodeGitWorktreeReaderDeps,
  objectId: string,
): Promise<string> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(objectId))
    throw new GitWorktreeReadError("git tree identity is invalid");
  return gitIndexTreeDigest(
    await runRead(buildReadContext(deps), ["ls-tree", "-r", "-z", "--full-tree", objectId]),
    true,
  );
}

export interface GitCommitIdentity {
  readonly headSha: string;
  readonly parentShas: readonly string[];
  readonly treeDigest: string;
  readonly messageDigest: string;
}

/** Body-free identity for reconciling an uncertain commit. Raw commit data stays inside this lane. */
export async function readGitCommitIdentity(
  deps: NodeGitWorktreeReaderDeps,
  ref: string,
): Promise<GitCommitIdentity> {
  const headSha = await readGitRevision(deps, ref);
  const output = await runRead(buildReadContext(deps), ["cat-file", "commit", headSha]);
  const boundary = output.indexOf("\n\n");
  if (boundary < 0) throw new GitWorktreeReadError("git commit object is incomplete");
  const parentShas = output
    .slice(0, boundary)
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice(7));
  if (parentShas.some((sha) => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha)))
    throw new GitWorktreeReadError("git commit parent is invalid");
  return {
    headSha,
    parentShas,
    treeDigest: await readGitTreeDigest(deps, headSha),
    messageDigest: createHash("sha256")
      .update(output.slice(boundary + 2))
      .digest("hex"),
  };
}

/**
 * Reads the relative paths currently staged for commit (`git diff --cached --name-only`). Used by the
 * server for commit-intent scope inference; the paths stay in-process and are never persisted.
 */
/** Bounded staged patch for the existing interactive review parser; never evidence or a PR snapshot. */
export async function readGitStagedDiff(deps: NodeGitWorktreeReaderDeps): Promise<string> {
  return runRead(buildReadContext(deps), [
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--unified=3",
    "--",
  ]);
}

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

/**
 * Effective destinations use the publish lane's config scope, including user URL rewrites.
 * This local inspection carries no credential and never contacts a destination. Multiplicity is
 * retained for the caller to refuse; the checkout's isolated fetch-identity reader is unchanged.
 */
export async function readGitPushRemoteUrls(
  deps: NodeGitWorktreeReaderDeps,
  remoteAlias: string,
): Promise<readonly string[]> {
  if (!isSafeGitRefName(remoteAlias)) throw new GitWorktreeReadError("remote alias is unsafe");
  const policy = deps.policy ?? GOVERNED_GIT_REMOTE_SANDBOX_POLICY;
  const ctx = buildReadContext({
    ...deps,
    policy: {
      ...policy,
      credentialEnvAllowlist: undefined,
      outputScrub: "credentials-only",
      maxOutputBytes: Math.min(policy.maxOutputBytes, 8192),
    },
  });
  const output = await runRead(ctx, ["remote", "get-url", "--push", "--all", "--", remoteAlias]);
  if (!output.endsWith("\n"))
    throw new GitWorktreeReadError("push destination metadata incomplete");
  const urls = output.slice(0, -1).split("\n");
  if (urls.length > 32 || urls.some((url) => url.length === 0 || url.includes("\r")))
    throw new GitWorktreeReadError("push destination metadata invalid");
  return urls;
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
