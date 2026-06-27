// Narrow managed-worktree adapter for governed task workspaces (Issue #445, Epic #443).
//
// This is the ONLY authority for the `git worktree` lifecycle. It runs strictly through the SAME
// no-shell, allowlist-only spawn boundary as the read snapshot reader and the #470 mutation kernel
// (keiko-tools `runCommand`), but with its OWN dedicated command allowlist that is STRUCTURALLY
// SEPARATE from `GIT_MUTATION_COMMAND_RULES`. Its allowlist permits only the git `worktree` verb plus
// the read-only `rev-parse` / `show-ref` inspection verbs — it can NEVER reach `branch`, `switch`,
// `commit`, `add`, `restore`, `push`, `merge`, `pull`, `fetch`, or any other write subcommand. This
// is the AC5 property: the adapter does not widen terminal Git mutation authority and cannot
// duplicate the #470 branch/commit/publish/PR/merge execution surface.
//
// Every operand (branch name, base ref, worktree path) is validated BEFORE argv construction, so a
// value can never masquerade as a flag or smuggle a shell metacharacter. The worktree path supplied
// by the caller is an ABSOLUTE path the server has already proven realpath-contained inside the
// Keiko-owned managed root; the adapter additionally rejects any operand that begins with `-`.
//
// Output is content-free to the caller: operation results carry exit code / duration / flags only.
// `listWorktrees` parses `--porcelain` output into structured entries whose paths stay in-process for
// idempotency and drift inference and are never persisted into evidence (mirrors `readStagedPaths`).

import { isAbsolute } from "node:path";
import type { CommandResult, CommandRule, SandboxPolicy } from "./types.js";
import { DEFAULT_SANDBOX_POLICY } from "./types.js";
import {
  nodeSpawnFn,
  runCommand,
  type ExecutableResolver,
  type HomeProvider,
  type RunCommandDeps,
  type SpawnFn,
} from "./exec.js";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

// The dedicated worktree-lifecycle allowlist. `worktree` covers add/list/remove/prune (the second
// token is fixed by the builder, never caller-supplied); `rev-parse` and `show-ref` are read-only
// inspection used for repository-root resolution, base-ref resolvability, and branch-conflict
// detection. No write subcommand is reachable. Defense-in-depth `denyFlags` block the global flags
// that would shift git's cwd, git-dir, or config (`-C`, `-c`, `--git-dir`, …) before subcommand
// resolution, and `valueFlags` ensure such a flag's value can never be reinterpreted as the verb.
export const GIT_WORKTREE_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "git",
    // `status` (#448) is the read-only working-tree probe for live dirty detection. Like `rev-parse`
    // and `show-ref` it cannot mutate, so adding it keeps the structural separation from
    // GIT_MUTATION_COMMAND_RULES (no write subcommand is reachable) while letting the cleanup gate see
    // uncommitted/untracked work before removing a worktree.
    allowedSubcommands: Object.freeze(["worktree", "rev-parse", "show-ref", "status"]),
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
    ]),
  },
]);

// Thrown by the pure argv builders when an operand fails validation BEFORE any spawn. The server
// maps this to a content-free `unsafe-path` / `invalid-request` failure rather than leaking the
// offending value.
export class GitWorktreeOperandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitWorktreeOperandError";
  }
}

// Thrown when a worktree command fails to spawn. A non-zero EXIT is NOT an exception — it is returned
// as `{ ok: false, exitCode }` so the caller can classify it (e.g. branch conflict vs. dirty target).
export class GitWorktreeSpawnError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitWorktreeSpawnError";
  }
}

// ─── Operand validation (pure) ───────────────────────────────────────────────────────────────────

function hasControlOrNul(value: string): boolean {
  // Reject NUL and any C0 control character (incl. newline/tab) — none are legal in a git ref or in
  // a path operand we are willing to pass to git. Iterating code points avoids a control-character
  // regex literal.
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

const UNSAFE_REF_PREFIXES: readonly string[] = ["-", "/", "."];
const UNSAFE_REF_SUFFIXES: readonly string[] = ["/", ".", ".lock"];
const UNSAFE_REF_SUBSTRINGS: readonly string[] = ["..", "//", "@{"];

// Conservative git ref-name allowlist. Stricter than `git check-ref-format` on purpose: refs Keiko
// creates are server-derived, so we only need to accept the deterministic shape we emit and reject
// anything that could be an option, a path traversal, or a refspec/glob metacharacter.
export function isSafeGitRefName(value: string): boolean {
  if (value.length === 0 || value.length > 255 || hasControlOrNul(value)) return false;
  if (UNSAFE_REF_PREFIXES.some((prefix) => value.startsWith(prefix))) return false;
  if (UNSAFE_REF_SUFFIXES.some((suffix) => value.endsWith(suffix))) return false;
  if (UNSAFE_REF_SUBSTRINGS.some((part) => value.includes(part))) return false;
  // Allowed: letters, digits, and a bounded punctuation set used by our `keiko/task/<id>` scheme.
  if (!/^[A-Za-z0-9._\-/]+$/u.test(value)) return false;
  // No git ref metacharacters: space ~ ^ : ? * [ \ are excluded by the allowlist above; this also
  // rejects them defensively for readers of this predicate.
  return !/[~^:?*[\\ ]/u.test(value);
}

// A worktree path operand must be an absolute path with no control bytes and must not begin with a
// dash (so it cannot be parsed as an option). Containment inside the managed root is enforced by the
// server BEFORE this adapter is called; this is the last-line argv guard, and it self-documents the
// absolute-path invariant rather than relying on every caller to supply one.
export function isSafeWorktreePathOperand(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (hasControlOrNul(value)) return false;
  if (value.startsWith("-")) return false;
  return isAbsolute(value);
}

function requireSafeRef(value: string, label: string): string {
  if (!isSafeGitRefName(value)) {
    throw new GitWorktreeOperandError(`unsafe ${label}`);
  }
  return value;
}

function requireSafePath(value: string, label: string): string {
  if (!isSafeWorktreePathOperand(value)) {
    throw new GitWorktreeOperandError(`unsafe ${label}`);
  }
  return value;
}

// ─── argv builders (pure) ──────────────────────────────────────────────────────────────────────

export interface AddWorktreeOperands {
  readonly worktreePath: string;
  readonly taskBranch: string;
  readonly baseRef: string;
}

// `git worktree add -b <taskBranch> <path> <baseRef>` — atomically creates the dedicated task branch
// from the approved base ref AND the managed worktree in one governed call. `--no-track` keeps the
// new branch local-only (no implicit upstream); publish/track stays owned by #470.
export function buildAddWorktreeArgv(operands: AddWorktreeOperands): readonly string[] {
  const branch = requireSafeRef(operands.taskBranch, "task branch name");
  const base = requireSafeRef(operands.baseRef, "base ref");
  const path = requireSafePath(operands.worktreePath, "worktree path");
  return ["worktree", "add", "--no-track", "-b", branch, path, base];
}

export interface AddExistingBranchOperands {
  readonly worktreePath: string;
  readonly branch: string;
}

// `git worktree add <path> <branch>` — reattaches an EXISTING managed branch to a fresh worktree
// directory. Used only for retry-safe completion of a partially provisioned workspace whose branch
// already exists but whose worktree directory is missing.
export function buildAddExistingBranchArgv(operands: AddExistingBranchOperands): readonly string[] {
  const branch = requireSafeRef(operands.branch, "branch name");
  const path = requireSafePath(operands.worktreePath, "worktree path");
  return ["worktree", "add", path, branch];
}

export function buildListWorktreesArgv(): readonly string[] {
  return ["worktree", "list", "--porcelain"];
}

export interface RemoveWorktreeOperands {
  readonly worktreePath: string;
  readonly force: boolean;
}

// `git worktree remove [--force] <path>` — removes a managed worktree directory. Used for retry-safe
// rollback of partial provisioning; `--force` is required to remove a worktree that git considers
// dirty (a half-created checkout), and is server-decided, never caller-supplied.
export function buildRemoveWorktreeArgv(operands: RemoveWorktreeOperands): readonly string[] {
  const path = requireSafePath(operands.worktreePath, "worktree path");
  return operands.force ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path];
}

export function buildPruneWorktreesArgv(): readonly string[] {
  return ["worktree", "prune"];
}

// `git status --porcelain` — the read-only working-tree probe (#448). Exit 0 with any output means the
// worktree has uncommitted OR untracked changes (the conservative signal for a deletion gate). The
// porcelain lines themselves never leave the adapter: the caller receives only a `dirty` boolean.
export function buildWorktreeStatusArgv(): readonly string[] {
  return ["status", "--porcelain"];
}

export function buildShowToplevelArgv(): readonly string[] {
  return ["rev-parse", "--show-toplevel"];
}

// `git rev-parse --verify --quiet <ref>^{commit}` — exit 0 iff the ref resolves to a commit. Used to
// confirm the approved base branch exists/resolves before provisioning.
export function buildRefResolvesArgv(ref: string): readonly string[] {
  const safe = requireSafeRef(ref, "base ref");
  return ["rev-parse", "--verify", "--quiet", `${safe}^{commit}`];
}

// `git show-ref --verify --quiet refs/heads/<branch>` — exit 0 iff a LOCAL branch of that exact name
// exists. Used to detect a branch-name conflict before creating the task branch.
export function buildLocalBranchExistsArgv(branch: string): readonly string[] {
  const safe = requireSafeRef(branch, "branch name");
  return ["show-ref", "--verify", "--quiet", `refs/heads/${safe}`];
}

// ─── porcelain parsing (pure) ─────────────────────────────────────────────────────────────────────

export interface WorktreeListEntry {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked: boolean;
}

interface WorktreeBlock {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
}

function blockToEntry(block: WorktreeBlock | null): WorktreeListEntry | undefined {
  if (block === null) return undefined;
  return {
    path: block.path,
    ...(block.head !== undefined ? { head: block.head } : {}),
    ...(block.branch !== undefined ? { branch: block.branch } : {}),
    bare: block.bare,
    detached: block.detached,
    locked: block.locked,
  };
}

// Applies one non-`worktree` attribute line to the current block. Unknown lines are ignored.
function applyAttributeLine(block: WorktreeBlock, line: string): void {
  if (line.startsWith("HEAD ")) block.head = line.slice("HEAD ".length);
  else if (line.startsWith("branch ")) block.branch = line.slice("branch ".length);
  else if (line === "bare") block.bare = true;
  else if (line === "detached") block.detached = true;
  else if (line.startsWith("locked")) block.locked = true;
}

// Parses `git worktree list --porcelain`. Blocks are separated by a blank line; each block starts
// with `worktree <path>` followed by optional `HEAD <sha>`, `branch <ref>`, and the bare/detached/
// locked markers.
export function parseWorktreeListPorcelain(stdout: string): readonly WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let block: WorktreeBlock | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/u, "");
    if (line.startsWith("worktree ")) {
      const previous = blockToEntry(block);
      if (previous !== undefined) entries.push(previous);
      block = { path: line.slice("worktree ".length), bare: false, detached: false, locked: false };
    } else if (line.length === 0) {
      const previous = blockToEntry(block);
      if (previous !== undefined) entries.push(previous);
      block = null;
    } else if (block !== null) {
      applyAttributeLine(block, line);
    }
  }
  const last = blockToEntry(block);
  if (last !== undefined) entries.push(last);
  return entries;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────────────────────────

export interface WorktreeOperationResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

// Content-free working-tree state (#448): `ok` is false when `git status` could not run (e.g. the path
// is not a readable worktree), in which case `dirty` is not meaningful. The adapter never surfaces the
// porcelain lines — only whether the tree has changes.
export interface WorktreeStatusResult {
  readonly ok: boolean;
  readonly dirty: boolean;
}

export interface GitWorktreeAdapter {
  // Resolves the repository top-level directory, or undefined when the root is not a git repository.
  readonly resolveRepositoryRoot: () => Promise<string | undefined>;
  readonly refResolves: (ref: string) => Promise<boolean>;
  readonly localBranchExists: (branch: string) => Promise<boolean>;
  readonly listWorktrees: () => Promise<readonly WorktreeListEntry[]>;
  // Read-only live dirty probe (#448). Run against a worktree-bound adapter; returns only a boolean.
  readonly worktreeStatus: () => Promise<WorktreeStatusResult>;
  readonly addWorktree: (operands: AddWorktreeOperands) => Promise<WorktreeOperationResult>;
  readonly addWorktreeForExistingBranch: (
    operands: AddExistingBranchOperands,
  ) => Promise<WorktreeOperationResult>;
  readonly removeWorktree: (operands: RemoveWorktreeOperands) => Promise<WorktreeOperationResult>;
  readonly pruneWorktrees: () => Promise<WorktreeOperationResult>;
}

export interface NodeGitWorktreeAdapterDeps {
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

interface AdapterContext {
  readonly runDeps: RunCommandDeps;
  readonly signal: AbortSignal;
  readonly timeoutMs: number | undefined;
}

function buildAdapterContext(deps: NodeGitWorktreeAdapterDeps): AdapterContext {
  return {
    runDeps: {
      workspace: deps.workspace,
      policy: deps.policy ?? DEFAULT_SANDBOX_POLICY,
      commandRules: GIT_WORKTREE_COMMAND_RULES,
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

async function runGit(ctx: AdapterContext, argv: readonly string[]): Promise<CommandResult> {
  try {
    return await runCommand(
      { command: "git", args: argv, cwd: undefined, timeoutMs: ctx.timeoutMs, signal: ctx.signal },
      ctx.runDeps,
    );
  } catch (error) {
    throw new GitWorktreeSpawnError(
      `git ${argv[0] ?? "?"} failed to run: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}

function toOperationResult(result: CommandResult): WorktreeOperationResult {
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    truncated: result.truncated,
  };
}

export function createNodeGitWorktreeAdapter(deps: NodeGitWorktreeAdapterDeps): GitWorktreeAdapter {
  const ctx = buildAdapterContext(deps);
  return {
    resolveRepositoryRoot: async (): Promise<string | undefined> => {
      const result = await runGit(ctx, buildShowToplevelArgv());
      if (result.exitCode !== 0) return undefined;
      const top = result.stdout.split(/\r?\n/u)[0]?.trim();
      return top !== undefined && top.length > 0 ? top : undefined;
    },
    refResolves: async (ref: string): Promise<boolean> =>
      (await runGit(ctx, buildRefResolvesArgv(ref))).exitCode === 0,
    localBranchExists: async (branch: string): Promise<boolean> =>
      (await runGit(ctx, buildLocalBranchExistsArgv(branch))).exitCode === 0,
    listWorktrees: async (): Promise<readonly WorktreeListEntry[]> => {
      const result = await runGit(ctx, buildListWorktreesArgv());
      if (result.exitCode !== 0) return [];
      return parseWorktreeListPorcelain(result.stdout);
    },
    worktreeStatus: async (): Promise<WorktreeStatusResult> => {
      const result = await runGit(ctx, buildWorktreeStatusArgv());
      if (result.exitCode !== 0) return { ok: false, dirty: false };
      return { ok: true, dirty: result.stdout.trim().length > 0 };
    },
    addWorktree: async (operands: AddWorktreeOperands): Promise<WorktreeOperationResult> =>
      toOperationResult(await runGit(ctx, buildAddWorktreeArgv(operands))),
    addWorktreeForExistingBranch: async (
      operands: AddExistingBranchOperands,
    ): Promise<WorktreeOperationResult> =>
      toOperationResult(await runGit(ctx, buildAddExistingBranchArgv(operands))),
    removeWorktree: async (operands: RemoveWorktreeOperands): Promise<WorktreeOperationResult> =>
      toOperationResult(await runGit(ctx, buildRemoveWorktreeArgv(operands))),
    pruneWorktrees: async (): Promise<WorktreeOperationResult> =>
      toOperationResult(await runGit(ctx, buildPruneWorktreesArgv())),
  };
}
