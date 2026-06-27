// Bounded fetch/pull sync execution core (Issue #1573, Epic #1572).
//
// fetch/pull are NOT governed mutations: they have no `GitDeliveryActionKind` and do NOT enter the
// #472 `runGitMutation` kernel. That taxonomy is frozen (#1572 reuse contract §3); widening it to add
// fetch/pull would weaken the governed control plane. Instead this module mirrors the push route
// STRUCTURE while reusing the hardened, fixed-arg process runner (`defaultGitProcessRunner`) and the
// shared porcelain-v2 parser. Two operations:
//
//   * buildSyncPreview — READ-ONLY readiness: parse `status --porcelain=v2 --branch` + remote names to
//       compute branch/detached/upstream/ahead/behind/hasRemote/hasUpstream/dirty + an executable gate
//       and a typed blockReason.
//   * runSyncExecute — runs the bounded fetch/pull command and classifies the outcome from
//       exitCode/stderr/stdout/truncated; re-reads ahead/behind after a successful op (best-effort).
//
// Pure parsing lives in gitPorcelainStatus.ts; this module owns only the bounded process effect and
// the deterministic outcome classifier. Both are seam-injectable for tests.

import type {
  GitSyncBlockReason,
  GitSyncOperation,
  GitSyncOutcome,
  GitUpstreamSummary,
} from "@oscharko-dev/keiko-contracts";
import { GIT_SYNC_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import type { GitSyncPreview } from "@oscharko-dev/keiko-contracts";
import {
  defaultGitNetworkProcessRunner,
  defaultGitProcessRunner,
  type GitProcessResult,
  type GitProcessRunner,
} from "../gitRoutes.js";
import { parsePorcelainV2Branch, type PorcelainV2Status } from "../gitPorcelainStatus.js";

const DEFAULT_SYNC_MAX_BYTES = 128 * 1024;
const DEFAULT_SYNC_TIMEOUT_MS = 30_000;

export interface GitDeliverySyncSeams {
  readonly runner?: GitProcessRunner | undefined;
  readonly now?: (() => number) | undefined;
  readonly maxBytes?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

interface NormalizedSyncSeams {
  // Local config-isolated reads (status / remote / post-op re-read): never authenticate.
  readonly readRunner: GitProcessRunner;
  // The actual `git fetch` / `git pull` network command: credential-capable, still fail-closed.
  readonly networkRunner: GitProcessRunner;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

// An injected `seams.runner` overrides BOTH runners so tests stay deterministic; in production the
// local reads use the hardened `defaultGitProcessRunner` while the fetch/pull command uses the
// credential-capable `defaultGitNetworkProcessRunner` (see networkGitEnv in gitRoutes.ts).
function normalizeSeams(seams: GitDeliverySyncSeams): NormalizedSyncSeams {
  return {
    readRunner: seams.runner ?? defaultGitProcessRunner,
    networkRunner: seams.runner ?? defaultGitNetworkProcessRunner,
    maxBytes: seams.maxBytes ?? DEFAULT_SYNC_MAX_BYTES,
    timeoutMs: seams.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS,
  };
}

function runWith(
  runner: GitProcessRunner,
  repoRoot: string,
  seams: NormalizedSyncSeams,
  args: readonly string[],
): Promise<GitProcessResult> {
  return runner(["--no-pager", "--no-optional-locks", "-C", repoRoot, ...args], {
    cwd: repoRoot,
    maxBytes: seams.maxBytes,
    timeoutMs: seams.timeoutMs,
  });
}

// Local read (status / remote / post-op re-read): config-isolated, never authenticates.
function runGit(
  repoRoot: string,
  seams: NormalizedSyncSeams,
  args: readonly string[],
): Promise<GitProcessResult> {
  return runWith(seams.readRunner, repoRoot, seams, args);
}

// The actual fetch/pull network command: credential-capable env, still GIT_TERMINAL_PROMPT=0.
function runNetworkGit(
  repoRoot: string,
  seams: NormalizedSyncSeams,
  args: readonly string[],
): Promise<GitProcessResult> {
  return runWith(seams.networkRunner, repoRoot, seams, args);
}

// `git remote` (names only — never URLs) tells us whether a fetch target exists at all.
function parseRemoteNames(stdout: string): readonly string[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// --- preview ---------------------------------------------------------------

function previewBlockReason(
  operation: GitSyncOperation,
  status: PorcelainV2Status,
  hasRemote: boolean,
): GitSyncBlockReason | undefined {
  if (!hasRemote) return "no-remote";
  if (operation === "fetch") return undefined;
  if (status.detached) return "detached-head";
  if (status.upstream === undefined) return "no-upstream";
  return undefined;
}

function previewFor(
  operation: GitSyncOperation,
  status: PorcelainV2Status,
  remote: string | undefined,
  hasRemote: boolean,
): GitSyncPreview {
  const blockReason = previewBlockReason(operation, status, hasRemote);
  return {
    schemaVersion: GIT_SYNC_SCHEMA_VERSION,
    operation,
    available: true,
    state: "available",
    branch: status.branch,
    detached: status.detached,
    upstream: status.upstream,
    remote,
    ahead: status.ahead,
    behind: status.behind,
    hasRemote,
    hasUpstream: status.upstream !== undefined,
    dirty: status.dirty,
    executable: blockReason === undefined,
    blockReason,
  };
}

/**
 * Read-only fetch/pull readiness. Runs `status --porcelain=v2 --branch -z` + `git remote` (names only)
 * and projects a content-free preview with an executable gate. Throws only when the status read fails
 * (not a repository / unsafe owner); the caller maps that to a 409.
 */
export async function buildSyncPreview(
  operation: GitSyncOperation,
  repoRoot: string,
  remote: string | undefined,
  seams: GitDeliverySyncSeams = {},
): Promise<GitSyncPreview> {
  const normalized = normalizeSeams(seams);
  const status = await runGit(repoRoot, normalized, [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.exitCode !== 0) {
    throw new Error("git status failed for the sync preview");
  }
  const parsed = parsePorcelainV2Branch(status.stdout);
  const remotesResult = await runGit(repoRoot, normalized, ["remote"]);
  const remoteNames = remotesResult.exitCode === 0 ? parseRemoteNames(remotesResult.stdout) : [];
  return previewFor(operation, parsed, remote, remoteNames.length > 0);
}

// --- execute ---------------------------------------------------------------

export interface SyncExecuteResult {
  readonly outcome: GitSyncOutcome;
  readonly branch?: string | undefined;
  readonly upstream?: GitUpstreamSummary | undefined;
  readonly ahead?: number | undefined;
  readonly behind?: number | undefined;
  readonly truncated: boolean;
}

function syncArgs(operation: GitSyncOperation, remote: string | undefined): readonly string[] {
  const remoteArgs = remote === undefined ? [] : [remote];
  return operation === "fetch"
    ? ["fetch", "--no-tags", ...remoteArgs]
    : ["pull", "--ff-only", "--no-edit", ...remoteArgs];
}

// Classifies the most-specific failure the stderr surfaces. Order matters: ownership and auth checks
// precede the generic remote/repository checks so a credential failure is never mislabeled.
function classifyStderr(stderr: string): GitSyncOutcome | undefined {
  const text = stderr.toLowerCase();
  if (text.includes("dubious ownership") || text.includes("safe.directory")) {
    return "unsafe-repository";
  }
  if (
    text.includes("could not read username") ||
    text.includes("authentication failed") ||
    text.includes("permission denied") ||
    text.includes("could not read from remote") ||
    text.includes("terminal prompts disabled")
  ) {
    return "auth-failed";
  }
  if (text.includes("no such remote") || text.includes("does not appear to be a git repository")) {
    return "no-remote";
  }
  return undefined;
}

// Pull-only refusal reasons layered on top of the shared classifier.
function classifyPullStderr(stderr: string): GitSyncOutcome | undefined {
  const text = stderr.toLowerCase();
  // A pull on a detached HEAD aborts with "You are not currently on a branch." — the execute-side
  // mirror of the preview block reason, keeping the 12-member taxonomy fully live from execute.
  if (text.includes("not currently on a branch")) return "detached-head";
  if (
    text.includes("there is no tracking information") ||
    text.includes("no tracking information for the current branch")
  ) {
    return "no-upstream";
  }
  if (text.includes("not possible to fast-forward")) return "not-fast-forward";
  if (text.includes("local changes") || text.includes("would be overwritten")) {
    return "dirty-worktree";
  }
  return undefined;
}

function isAlreadyUpToDate(stdout: string): boolean {
  return stdout.toLowerCase().includes("already up to date");
}

function classifyOutcome(operation: GitSyncOperation, result: GitProcessResult): GitSyncOutcome {
  if (result.truncated) return "timeout";
  if (result.exitCode === 127) return "git-missing";
  const shared = classifyStderr(result.stderr);
  if (shared !== undefined) return shared;
  if (operation === "pull") {
    const pullReason = classifyPullStderr(result.stderr);
    if (pullReason !== undefined) return pullReason;
  }
  if (result.exitCode === 0) {
    if (operation === "pull" && isAlreadyUpToDate(result.stdout)) return "up-to-date";
    return "succeeded";
  }
  return "git-error";
}

function isSettledOk(outcome: GitSyncOutcome): boolean {
  return outcome === "succeeded" || outcome === "up-to-date";
}

// Re-reads branch/upstream/ahead/behind after a settled op so the response reflects the post-sync
// position. Best-effort: any failure tolerates and omits the counts.
async function readPostState(
  repoRoot: string,
  seams: NormalizedSyncSeams,
): Promise<Pick<SyncExecuteResult, "branch" | "upstream" | "ahead" | "behind">> {
  try {
    const status = await runGit(repoRoot, seams, [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
    ]);
    if (status.exitCode !== 0) return {};
    const parsed = parsePorcelainV2Branch(status.stdout);
    return {
      branch: parsed.branch,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
    };
  } catch {
    return {};
  }
}

/**
 * Runs ONE bounded fetch/pull and classifies the outcome. Never governs (no kernel, no policy) — the
 * control surface is the fixed argv + hardened env of the reused runner. After a settled op the
 * branch/upstream/ahead/behind are re-read best-effort for the response.
 */
export async function runSyncExecute(
  operation: GitSyncOperation,
  repoRoot: string,
  remote: string | undefined,
  seams: GitDeliverySyncSeams = {},
): Promise<SyncExecuteResult> {
  const normalized = normalizeSeams(seams);
  // ONLY the network fetch/pull uses the credential-capable runner; the post-state re-read below
  // stays on the hardened local read runner.
  const result = await runNetworkGit(repoRoot, normalized, syncArgs(operation, remote));
  const outcome = classifyOutcome(operation, result);
  if (!isSettledOk(outcome)) {
    return { outcome, truncated: result.truncated };
  }
  const post = await readPostState(repoRoot, normalized);
  return { outcome, ...post, truncated: result.truncated };
}
