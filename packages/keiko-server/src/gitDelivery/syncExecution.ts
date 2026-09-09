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
//   * runSyncExecute — requires an executable preview before running the bounded fetch/pull command,
//       classifies exitCode/stderr/stdout/truncated, and re-reads ahead/behind after success.
//
// Pure parsing lives in gitPorcelainStatus.ts; this module owns only the bounded process effect and
// the deterministic outcome classifier. Both are seam-injectable for tests.

import type {
  GitSyncBlockReason,
  GitSyncOperation,
  GitSyncOutcome,
  GitSyncPreview,
  GitUpstreamSummary,
} from "@oscharko-dev/keiko-contracts";
import { GIT_SYNC_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-sync";
import {
  classifyGitRemoteFailure,
  GIT_BASE_ARGS,
  type GitRemoteFailureReason,
} from "@oscharko-dev/keiko-git";
import {
  defaultGitNetworkProcessRunner,
  defaultGitProcessRunner,
  type GitProcessResult,
  type GitProcessRunner,
} from "../gitRoutes.js";
import { parsePorcelainV2Branch, type PorcelainV2Status } from "../gitPorcelainStatus.js";
import { observedGitRunner } from "../gitProcessActivity.js";
import type { ServerLogSink } from "../observability/index.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { GitDeliveryApprovalStore } from "./approvalStore.js";

const DEFAULT_SYNC_MAX_BYTES = 128 * 1024;
const DEFAULT_SYNC_TIMEOUT_MS = 30_000;

export interface GitDeliverySyncSeams {
  readonly runner?: GitProcessRunner | undefined;
  readonly now?: (() => number) | undefined;
  readonly maxBytes?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly beforeRemoteDispatch?: (() => boolean) | undefined;
  /**
   * The request's correlation id, supplied per request by the route handlers (AGENTS.md §8 Rule 1).
   * Unlike the other members this is not a test seam: a fetch/pull answers a failure with a
   * content-free typed code, so without the activity-log lines below an auth failure, an
   * unreachable remote, a non-fast-forward or a spawn-boundary refusal on this path left no trace
   * at all — and a line that cannot be joined to the request that caused it answers nothing.
   */
  readonly correlationId?: string | undefined;
  /** Activity-log sink, defaulting to the shared process log. A test seam like `runner`. */
  readonly activityLog?: ServerLogSink | undefined;
  // Final-audit F2 repair (#3390): the approval store fetch/pull's own admission redemption (a
  // non-consuming peek, then a single real consume — see syncRoutes.ts) reads/writes. Defaults to
  // `DEFAULT_GIT_DELIVERY_APPROVAL_STORE` (approvalStore.ts) the same way pushExecution.ts's
  // `GitDeliveryPublishSeams.approvalStore` does, so a mint issued into the default store is
  // redeemable by execute without the caller wiring an explicit instance.
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
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
  // Both runners are observed here, at the one place they are resolved, so every git run this
  // module makes — the local status/remote reads AND the credential-capable fetch/pull — reports
  // its own failure without any of the four call sites below opting in. Same helper the read-only
  // git routes use; this is not a second logging mechanism (AGENTS.md §5).
  const observe = (runner: GitProcessRunner): GitProcessRunner =>
    observedGitRunner(runner, seams.activityLog ?? processServerLogSink(), seams.correlationId);
  return {
    readRunner: observe(seams.runner ?? defaultGitProcessRunner),
    networkRunner: observe(seams.runner ?? defaultGitNetworkProcessRunner),
    maxBytes: seams.maxBytes ?? DEFAULT_SYNC_MAX_BYTES,
    timeoutMs: seams.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS,
  };
}

function runWith(
  runner: GitProcessRunner,
  repoRoot: string,
  seams: NormalizedSyncSeams,
  args: readonly string[],
  classifyFailure?: (result: GitProcessResult) => string | undefined,
): Promise<GitProcessResult> {
  return runner([...GIT_BASE_ARGS, "-C", repoRoot, ...args], {
    cwd: repoRoot,
    maxBytes: seams.maxBytes,
    timeoutMs: seams.timeoutMs,
    ...(classifyFailure === undefined ? {} : { classifyFailure }),
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
//
// `classifyOutcome` (below) layers `classifyPullStderr` on top of the generic remote classifier to
// tell a non-fast-forward pull from a dirty worktree from a missing upstream — Keiko-side
// vocabulary the shared `classifyGitRemoteFailure` cannot express. Without threading the SAME
// function into the observed runner's `classifyFailure` override, the activity log reported the
// generic remote kind for all of them while the response and evidence already named the specific
// one — the log unable to reconstruct the exact outcome its own caller had already determined.
function runNetworkGit(
  repoRoot: string,
  seams: NormalizedSyncSeams,
  args: readonly string[],
  operation: GitSyncOperation,
): Promise<GitProcessResult> {
  const classifyFailure =
    operation === "pull"
      ? (result: GitProcessResult): string | undefined => classifyPullStderr(result.stderr)
      : undefined;
  return runWith(seams.networkRunner, repoRoot, seams, args, classifyFailure);
}

// `git remote` (names only — never URLs) tells us whether a fetch target exists at all.
function parseRemoteNames(stdout: string): readonly string[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// --- preview ---------------------------------------------------------------

function hasRequestedRemote(remoteNames: readonly string[], remote: string | undefined): boolean {
  return remote === undefined ? remoteNames.length > 0 : remoteNames.includes(remote);
}

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
  return previewFor(operation, parsed, remote, hasRequestedRemote(remoteNames, remote));
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

// The remote-access half of the taxonomy is NOT re-derived here. `classifyGitRemoteFailure`
// (keiko-git) owns the single phrase table and the single precedence order shared with clone and any
// other remote-facing surface, and it is the one place that keeps the runner's two self-imposed stops
// apart: `timedOut` (the wall clock fired) versus `truncated` (the byte cap fired). This module only
// projects that reason onto the sync wire vocabulary. The Record is TOTAL: a new remote reason is a
// compile error here rather than a silent fall-through into "succeeded" or "timeout".
const SYNC_OUTCOME_FOR_REMOTE_FAILURE: Readonly<
  Record<GitRemoteFailureReason, GitSyncOutcome | undefined>
> = {
  // `undefined` = not a remote-access verdict; the operation-level classifier below decides.
  none: undefined,
  "git-error": undefined,
  "output-truncated": undefined,
  // A caller-aborted run is neither a byte-cap event nor a timeout — flow through to the
  // unresolved-remote fallback so it lands as "git-error" on the wire outcome without ever
  // being misreported as an output-cap or wall-clock stop. The typed reason survives in the
  // classifier for anyone reading the underlying process result directly.
  cancelled: undefined,
  "git-missing": "git-missing",
  timeout: "timeout",
  "unsafe-repository": "unsafe-repository",
  "untrusted-host-key": "untrusted-host-key",
  "auth-failed": "auth-failed",
  // Sync has no separate authorization member; an authorization denial is still a credential problem
  // the user must fix, and this preserves the pre-existing mapping for "permission denied".
  "permission-denied": "auth-failed",
  // A remote alias that resolves to nothing and a URL that is not a repository are the same thing to
  // fetch/pull: there is no remote to sync with.
  "repository-not-found": "no-remote",
  "not-a-repository": "no-remote",
  "remote-unavailable": "remote-unavailable",
};

// The stop the byte cap imposes is a real, distinct outcome — it must never be reported as a timeout
// and must never be reported as success.
function unresolvedRemoteOutcome(reason: GitRemoteFailureReason): GitSyncOutcome {
  return reason === "output-truncated" ? "output-truncated" : "git-error";
}

// Pull-only refusal reasons layered on top of the shared classifier.
function classifyPullStderr(stderr: string): GitSyncOutcome | undefined {
  const text = stderr.toLowerCase();
  // A pull on a detached HEAD aborts with "You are not currently on a branch." — the execute-side
  // mirror of the preview block reason, keeping the sync taxonomy fully live from execute.
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
  const remote = classifyGitRemoteFailure(result);
  const remoteOutcome = SYNC_OUTCOME_FOR_REMOTE_FAILURE[remote];
  if (remoteOutcome !== undefined) return remoteOutcome;
  if (operation === "pull") {
    const pullReason = classifyPullStderr(result.stderr);
    if (pullReason !== undefined) return pullReason;
  }
  if (result.exitCode === 0) {
    if (operation === "pull" && isAlreadyUpToDate(result.stdout)) return "up-to-date";
    return "succeeded";
  }
  return unresolvedRemoteOutcome(remote);
}

function isSettledOk(outcome: GitSyncOutcome): boolean {
  return outcome === "succeeded" || outcome === "up-to-date";
}

function blockedOutcomeFor(preview: GitSyncPreview): GitSyncOutcome {
  switch (preview.blockReason) {
    case "no-remote":
      return "no-remote";
    case "no-upstream":
      return "no-upstream";
    case "detached-head":
      return "detached-head";
    case "git-missing":
      return "git-missing";
    case "unsafe-repository":
      return "unsafe-repository";
    case "unavailable":
    case undefined:
      return "git-error";
  }
}

function blockedResultFor(preview: GitSyncPreview): SyncExecuteResult {
  return {
    outcome: blockedOutcomeFor(preview),
    branch: preview.branch,
    upstream: preview.upstream,
    ahead: preview.ahead,
    behind: preview.behind,
    truncated: false,
  };
}

function authorityStoppedResultFor(preview: GitSyncPreview): SyncExecuteResult {
  return {
    outcome: "authority-denied",
    branch: preview.branch,
    upstream: preview.upstream,
    ahead: preview.ahead,
    behind: preview.behind,
    truncated: false,
  };
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
  preflight?: GitSyncPreview,
): Promise<SyncExecuteResult> {
  const normalized = normalizeSeams(seams);
  const preview = preflight ?? (await buildSyncPreview(operation, repoRoot, remote, seams));
  if (!preview.executable) return blockedResultFor(preview);
  if (!(seams.beforeRemoteDispatch?.() ?? true)) return authorityStoppedResultFor(preview);
  // ONLY the network fetch/pull uses the credential-capable runner; the post-state re-read below
  // stays on the hardened local read runner.
  const result = await runNetworkGit(repoRoot, normalized, syncArgs(operation, remote), operation);
  const outcome = classifyOutcome(operation, result);
  if (!isSettledOk(outcome)) {
    return { outcome, truncated: result.truncated };
  }
  const post = await readPostState(repoRoot, normalized);
  return { outcome, ...post, truncated: result.truncated };
}
