// The server-owned, ephemeral, detached review worktree (ADR-0182 D3, ADR-0098, Issue #4133).
//
// One worktree per review run at `<review root>/<leaf>`, outside the user's checkout and outside
// the task-workspace managed root, locked with the reason `keiko-review` so a user's
// `git worktree prune` cannot remove it during a run. It is created detached and empty at the exact
// head SHA, scanned from the tree listing before a single file is written (case and normalization
// collisions refuse; large and binary blobs are excluded through skip-worktree), and only then
// checked out by the hardened review runner, which neutralizes hooks, every filter driver named by
// the repository configuration or the head's attributes, LFS smudge, fsmonitor, symbolic links
// and submodules. Removal needs no approval: the worktree holds no user work.
//
// Lifecycle: created → in-use → removing → removed; a worktree found on disk without a live run
// (a crash) is `orphaned` and removed by the startup sweep.

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ReviewWorktreeRefusalReason,
  ReviewWorktreeState,
} from "@oscharko-dev/keiko-contracts";
import {
  REVIEW_WORKTREE_DEFAULT_BLOB_LIMIT_BYTES,
  REVIEW_WORKTREE_MAX_MATERIALIZED_BYTES,
  REVIEW_WORKTREE_MAX_PATHS,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { isReviewRunId } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";
import { isGitObjectId } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import {
  addGitReviewWorktree,
  checkoutGitReviewWorktree,
  GIT_REVIEW_WORKTREE_LOCK_REASON,
  listGitReviewBinaryPaths,
  listGitReviewConfiguredFilterDrivers,
  listGitReviewTree,
  listGitReviewWorktrees,
  readGitReviewTreeIntoIndex,
  removeGitReviewWorktree,
  resolveGitReviewCommit,
  skipGitReviewWorktreePaths,
  unlockGitReviewWorktree,
  isSafeGitFilterDriverName,
  type GitProcessResult,
  type GitProcessRunner,
  type GitReviewOperationContext,
  type GitReviewRunnerOptions,
} from "@oscharko-dev/keiko-git";
import type { ServerLogSink } from "../../observability/index.js";
import {
  logReviewWorktreeCreated,
  logReviewWorktreeOrphanSwept,
  logReviewWorktreeRefused,
  logReviewWorktreeRemoved,
  type ReviewWorktreeRemovalTrigger,
} from "../activity-log.js";
import { ensureReviewRoot, type ReviewRegistry } from "./registry.js";
import { reportReviewFailure } from "../diagnostics.js";
import { REVIEW_RUN_LEAF_PATTERN, reviewRunLeaf } from "./leaf.js";
import {
  preflightReviewTree,
  scanReviewTree,
  type ReviewTreeLimits,
  type ReviewTreeScan,
} from "./treeScan.js";

const GIT_TIMEOUT_MS = 120_000;
const LISTING_MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILTER_DRIVERS = 64;
/** The whole creation, every Git process included, ends by this deadline unless configured. */
const DEFAULT_CREATE_DEADLINE_MS = 10 * 60 * 1000;

export interface ReviewWorktreeManagerDeps {
  readonly reviewRoot: string;
  readonly registry: ReviewRegistry;
  readonly activityLog: ServerLogSink;
  readonly now: () => number;
  /** Builds an OBSERVED review runner for one operation's correlation. */
  readonly runner: (
    options: GitReviewRunnerOptions,
    correlationId: string | undefined,
  ) => GitProcessRunner;
  readonly blobLimitBytes?: number | undefined;
  readonly maxPaths?: number | undefined;
  readonly maxMaterializedBytes?: number | undefined;
  readonly createDeadlineMs?: number | undefined;
  /** Called once a run's worktree is gone (removed or swept). */
  readonly onRemoved?: ((runId: string) => void) | undefined;
}

interface ReviewWorktreeCreateInput {
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly headSha: string;
  readonly correlationId?: string | undefined;
  /** Aborts every Git process of the creation; the worktree is then refused as `cancelled`. */
  readonly abortSignal?: AbortSignal | undefined;
}

interface ReviewWorktree {
  readonly runId: string;
  readonly path: string;
  readonly repositoryRoot: string;
  readonly headSha: string;
  readonly materializedCount: number;
  /** Tree paths not materialized because they exceed the blob limit (`too-large`). */
  readonly skippedLarge: readonly string[];
  /** Tree paths not materialized because Git classifies them as binary (`binary`). */
  readonly skippedBinary: readonly string[];
}

type ReviewWorktreeCreation =
  | { readonly ok: true; readonly worktree: ReviewWorktree }
  | { readonly ok: false; readonly reason: ReviewWorktreeRefusalReason };

export interface ReviewWorktreeManager {
  create(input: ReviewWorktreeCreateInput): Promise<ReviewWorktreeCreation>;
  markInUse(runId: string): void;
  state(runId: string): ReviewWorktreeState | undefined;
  remove(
    runId: string,
    trigger: ReviewWorktreeRemovalTrigger,
    correlationId?: string,
  ): Promise<boolean>;
  removeAll(trigger: ReviewWorktreeRemovalTrigger, correlationId?: string): Promise<void>;
  sweepOrphans(
    correlationId?: string,
  ): Promise<{ readonly removed: number; readonly failed: number }>;
}

interface LiveWorktree {
  state: ReviewWorktreeState;
  readonly worktree: ReviewWorktree;
}

class WorktreeRefusal extends Error {
  public constructor(public readonly reason: ReviewWorktreeRefusalReason) {
    super(reason);
    this.name = "WorktreeRefusal";
  }
}

const DISK_FULL = /no space left on device|disk quota exceeded|ENOSPC/iu;

/** The creation's abort: the caller's cancellation or the creation deadline, told apart. */
interface CreationAbort {
  readonly signal: AbortSignal;
  readonly deadlineReached: () => boolean;
  readonly release: () => void;
}

function refusalFor(result: GitProcessResult, abort?: CreationAbort): WorktreeRefusal {
  if (result.aborted === true) {
    return new WorktreeRefusal(abort?.deadlineReached() === true ? "timeout" : "cancelled");
  }
  if (result.timedOut === true) return new WorktreeRefusal("timeout");
  if (DISK_FULL.test(result.stderr)) return new WorktreeRefusal("disk-full");
  return new WorktreeRefusal("checkout-failed");
}

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly result: GitProcessResult };

function unwrap<T>(outcome: Outcome<T>, abort?: CreationAbort): T {
  if (!outcome.ok) throw refusalFor(outcome.result, abort);
  return outcome.value;
}

/** A listing cut at its byte cap names more paths than any accepted tree can have. */
function unwrapListing<T>(outcome: Outcome<T>, abort: CreationAbort): T {
  if (!outcome.ok && isCapCut(outcome.result)) throw new WorktreeRefusal("tree-too-large");
  return unwrap(outcome, abort);
}

function isCapCut(result: GitProcessResult): boolean {
  return result.truncated && result.timedOut !== true && result.aborted !== true;
}

function context(runner: GitProcessRunner, abortSignal?: AbortSignal): GitReviewOperationContext {
  return { runner, timeoutMs: GIT_TIMEOUT_MS, maxBytes: LISTING_MAX_BYTES, abortSignal };
}

function creationAbort(deadlineMs: number, caller: AbortSignal | undefined): CreationAbort {
  const controller = new AbortController();
  let deadline = false;
  const timer = setTimeout(() => {
    deadline = true;
    controller.abort();
  }, deadlineMs);
  timer.unref();
  const onCaller = (): void => {
    controller.abort();
  };
  if (caller?.aborted === true) controller.abort();
  caller?.addEventListener("abort", onCaller, { once: true });
  return {
    signal: controller.signal,
    deadlineReached: (): boolean => deadline,
    release: (): void => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCaller);
    },
  };
}

/**
 * The filter drivers the repository's own configuration defines. In-tree `.gitattributes` are
 * disabled for every review checkout (`--attr-source` = the empty tree), so an attribute-only
 * `filter=<name>` selects nothing and is neither counted nor neutralized: a head cannot force a
 * refusal by naming many drivers or shipping many attribute files.
 */
async function configuredFilterDrivers(
  ctx: GitReviewOperationContext,
  worktreePath: string,
  abort: CreationAbort,
): Promise<readonly string[]> {
  const listed = await listGitReviewConfiguredFilterDrivers(ctx, { cwd: worktreePath });
  const configured = unwrap(listed, abort);
  if (!configured.every(isSafeGitFilterDriverName)) throw new WorktreeRefusal("checkout-failed");
  if (configured.length > MAX_FILTER_DRIVERS) throw new WorktreeRefusal("checkout-failed");
  return configured;
}

interface Materialized {
  readonly scan: Extract<ReviewTreeScan, { kind: "accepted" }>;
  readonly driverCount: number;
}

class ReviewWorktreeManagerImpl implements ReviewWorktreeManager {
  private readonly live = new Map<string, LiveWorktree>();

  public constructor(private readonly deps: ReviewWorktreeManagerDeps) {}

  private get limits(): ReviewTreeLimits {
    return {
      blobLimitBytes: this.deps.blobLimitBytes ?? REVIEW_WORKTREE_DEFAULT_BLOB_LIMIT_BYTES,
      maxPaths: this.deps.maxPaths ?? REVIEW_WORKTREE_MAX_PATHS,
      maxMaterializedBytes:
        this.deps.maxMaterializedBytes ?? REVIEW_WORKTREE_MAX_MATERIALIZED_BYTES,
    };
  }

  private pathFor(runId: string): string {
    const path = join(this.deps.reviewRoot, reviewRunLeaf(runId));
    if (dirname(path) !== this.deps.reviewRoot) throw new TypeError("review worktree path escaped");
    return path;
  }

  public async create(input: ReviewWorktreeCreateInput): Promise<ReviewWorktreeCreation> {
    if (!isReviewRunId(input.runId) || !isGitObjectId(input.headSha)) {
      throw new TypeError("invalid review worktree request");
    }
    if (this.live.has(input.runId)) throw new TypeError("review worktree already exists for run");
    const startedMs = this.deps.now();
    const path = this.pathFor(input.runId);
    await ensureReviewRoot(this.deps.reviewRoot);
    await this.register(input.runId, input.repositoryRoot);
    const abort = creationAbort(
      this.deps.createDeadlineMs ?? DEFAULT_CREATE_DEADLINE_MS,
      input.abortSignal,
    );
    try {
      const materialized = await this.materialize(input, path, abort);
      return this.accept(input, path, materialized, startedMs);
    } catch (error) {
      const reason = error instanceof WorktreeRefusal ? error.reason : "checkout-failed";
      await this.discard(input.runId, input.repositoryRoot, path, input.correlationId);
      logReviewWorktreeRefused(
        this.deps.activityLog,
        input.correlationId,
        input.runId,
        reason,
        this.elapsed(startedMs),
      );
      return { ok: false, reason };
    } finally {
      abort.release();
    }
  }

  private elapsed(startedMs: number): number {
    return Math.max(0, this.deps.now() - startedMs);
  }

  private async register(runId: string, repositoryRoot: string): Promise<void> {
    const leaf = reviewRunLeaf(runId);
    const createdAtMs = this.deps.now();
    await this.deps.registry.update((snapshot) => ({
      ...snapshot,
      worktrees: [
        ...snapshot.worktrees.filter((entry) => entry.leaf !== leaf),
        { leaf, repositoryRoot, createdAtMs },
      ],
    }));
  }

  private async unregister(leaf: string): Promise<void> {
    await this.deps.registry.update((snapshot) => ({
      ...snapshot,
      worktrees: snapshot.worktrees.filter((entry) => entry.leaf !== leaf),
    }));
  }

  private async materialize(
    input: ReviewWorktreeCreateInput,
    path: string,
    abort: CreationAbort,
  ): Promise<Materialized> {
    const { repositoryRoot, headSha: sha, correlationId } = input;
    const limits = this.limits;
    const runnerOptions = {
      bigFileThresholdBytes: limits.blobLimitBytes,
      neutralizeTreeAttributes: sha.length === 40 ? "sha1" : "sha256",
    } as const;
    const base = context(this.deps.runner(runnerOptions, correlationId), abort.signal);
    unwrap(await addGitReviewWorktree(base, { repositoryRoot, path, sha }), abort);
    const entries = unwrapListing(await listGitReviewTree(base, { cwd: path, sha }), abort);
    // Budget, duplicates and collisions are refused before a single blob is read or written.
    const refusal = preflightReviewTree(entries, limits);
    if (refusal !== undefined) throw new WorktreeRefusal(refusal);
    const binary = unwrap(await listGitReviewBinaryPaths(base, { cwd: path, sha }), abort);
    const scan = scanReviewTree(entries, binary, limits);
    if (scan.kind === "refused") throw new WorktreeRefusal(scan.reason);
    const drivers = await configuredFilterDrivers(base, path, abort);
    const hardened = context(
      this.deps.runner({ ...runnerOptions, filterDrivers: drivers }, correlationId),
      abort.signal,
    );
    await this.checkout(hardened, path, sha, scan, abort);
    return { scan, driverCount: drivers.length };
  }

  private async checkout(
    ctx: GitReviewOperationContext,
    path: string,
    sha: string,
    scan: Extract<ReviewTreeScan, { kind: "accepted" }>,
    abort: CreationAbort,
  ): Promise<void> {
    unwrap(await readGitReviewTreeIntoIndex(ctx, { worktreePath: path, sha }), abort);
    const excluded = [...scan.skippedLarge, ...scan.skippedBinary];
    unwrap(await skipGitReviewWorktreePaths(ctx, { worktreePath: path, paths: excluded }), abort);
    unwrap(await checkoutGitReviewWorktree(ctx, { worktreePath: path, sha }), abort);
    const head = unwrap(await resolveGitReviewCommit(ctx, { cwd: path, ref: "HEAD" }), abort);
    if (head !== sha) throw new WorktreeRefusal("checkout-failed");
  }

  private accept(
    input: ReviewWorktreeCreateInput,
    path: string,
    materialized: Materialized,
    startedMs: number,
  ): ReviewWorktreeCreation {
    const { scan } = materialized;
    const worktree: ReviewWorktree = {
      runId: input.runId,
      path,
      repositoryRoot: input.repositoryRoot,
      headSha: input.headSha,
      materializedCount: scan.materializedCount,
      skippedLarge: scan.skippedLarge,
      skippedBinary: scan.skippedBinary,
    };
    this.live.set(input.runId, { state: "created", worktree });
    logReviewWorktreeCreated(this.deps.activityLog, input.correlationId, {
      runId: input.runId,
      materializedCount: scan.materializedCount,
      skippedLargeCount: scan.skippedLarge.length,
      skippedBinaryCount: scan.skippedBinary.length,
      filterDriverCount: materialized.driverCount,
      durationMs: this.elapsed(startedMs),
    });
    return { ok: true, worktree };
  }

  /** Unlock, remove with its administrative entry, and delete any remaining directory. */
  private async removeAt(
    repositoryRoot: string,
    path: string,
    correlationId: string | undefined,
  ): Promise<boolean> {
    const ctx = context(this.deps.runner({}, correlationId));
    const repositoryPresent = existsSync(repositoryRoot);
    if (repositoryPresent) {
      await unlockGitReviewWorktree(ctx, { repositoryRoot, path });
      await removeGitReviewWorktree(ctx, { repositoryRoot, path });
    }
    if (!existsSync(path)) return true;
    await rm(path, { recursive: true, force: true });
    if (!repositoryPresent) return !existsSync(path);
    const entry = await removeGitReviewWorktree(ctx, { repositoryRoot, path });
    return !existsSync(path) && (entry.ok || !(await this.isListed(ctx, repositoryRoot, path)));
  }

  /** Removal that never throws: a failure is reported with its error class and counted. */
  private async removeOrReport(
    repositoryRoot: string,
    path: string,
    correlationId: string | undefined,
  ): Promise<boolean> {
    try {
      return await this.removeAt(repositoryRoot, path, correlationId);
    } catch (error) {
      reportReviewFailure("review.worktree.remove", correlationId, error);
      return false;
    }
  }

  private async isListed(
    ctx: GitReviewOperationContext,
    repositoryRoot: string,
    path: string,
  ): Promise<boolean> {
    const listed = await listGitReviewWorktrees(ctx, { repositoryRoot });
    return !listed.ok || listed.value.some((entry) => entry.path === path);
  }

  private async discard(
    runId: string,
    repositoryRoot: string,
    path: string,
    correlationId: string | undefined,
  ): Promise<void> {
    const removed = await this.removeOrReport(repositoryRoot, path, correlationId);
    if (removed) await this.unregister(reviewRunLeaf(runId));
  }

  public markInUse(runId: string): void {
    const entry = this.live.get(runId);
    if (entry?.state === "created") entry.state = "in-use";
  }

  public state(runId: string): ReviewWorktreeState | undefined {
    return this.live.get(runId)?.state;
  }

  public async remove(
    runId: string,
    trigger: ReviewWorktreeRemovalTrigger,
    correlationId?: string,
  ): Promise<boolean> {
    const entry = this.live.get(runId);
    if (entry === undefined || entry.state === "removing") return false;
    entry.state = "removing";
    const { repositoryRoot, path } = entry.worktree;
    const removed = await this.removeOrReport(repositoryRoot, path, correlationId);
    if (removed) {
      entry.state = "removed";
      this.live.delete(runId);
      await this.unregister(reviewRunLeaf(runId));
      this.deps.onRemoved?.(runId);
    } else {
      entry.state = "orphaned";
    }
    logReviewWorktreeRemoved(
      this.deps.activityLog,
      correlationId,
      runId,
      trigger,
      removed ? "removed" : "failed",
    );
    return removed;
  }

  public async removeAll(
    trigger: ReviewWorktreeRemovalTrigger,
    correlationId?: string,
  ): Promise<void> {
    // Removal deletes from the map; a Map iterator tolerates that and skips removed entries.
    for (const runId of this.live.keys()) await this.remove(runId, trigger, correlationId);
  }

  public async sweepOrphans(
    correlationId?: string,
  ): Promise<{ readonly removed: number; readonly failed: number }> {
    const liveLeaves = new Set<string>();
    for (const runId of this.live.keys()) liveLeaves.add(reviewRunLeaf(runId));
    const snapshot = await this.deps.registry.read();
    const outcomes = [
      ...(await this.sweepRegisteredWorktrees(snapshot.worktrees, liveLeaves, correlationId)),
    ];
    const repositories = new Set<string>();
    for (const entry of [...snapshot.worktrees, ...snapshot.refs])
      repositories.add(entry.repositoryRoot);
    for (const repositoryRoot of repositories) {
      outcomes.push(...(await this.sweepListedEntries(repositoryRoot, liveLeaves, correlationId)));
    }
    outcomes.push(...(await this.sweepUnregisteredDirectories(liveLeaves)));
    const removed = outcomes.filter(Boolean).length;
    const failed = outcomes.length - removed;
    logReviewWorktreeOrphanSwept(this.deps.activityLog, correlationId, removed, failed);
    return { removed, failed };
  }

  private async sweepRegisteredWorktrees(
    records: readonly { readonly leaf: string; readonly repositoryRoot: string }[],
    liveLeaves: ReadonlySet<string>,
    correlationId: string | undefined,
  ): Promise<readonly boolean[]> {
    const outcomes: boolean[] = [];
    for (const record of records.filter((entry) => !liveLeaves.has(entry.leaf))) {
      const path = join(this.deps.reviewRoot, record.leaf);
      const removed = await this.removeOrReport(record.repositoryRoot, path, correlationId);
      if (removed) await this.unregister(record.leaf);
      outcomes.push(removed);
    }
    return outcomes;
  }

  /** Locked `keiko-review` entries under the review root that no live run owns (a lost registry). */
  private async sweepListedEntries(
    repositoryRoot: string,
    liveLeaves: ReadonlySet<string>,
    correlationId: string | undefined,
  ): Promise<readonly boolean[]> {
    if (!existsSync(repositoryRoot)) return [];
    const ctx = context(this.deps.runner({}, correlationId));
    const listed = await listGitReviewWorktrees(ctx, { repositoryRoot });
    if (!listed.ok) return [false];
    const results: boolean[] = [];
    for (const entry of listed.value) {
      const leaf = entry.path.slice(this.deps.reviewRoot.length + 1);
      const ours =
        entry.lockReason === GIT_REVIEW_WORKTREE_LOCK_REASON &&
        dirname(entry.path) === this.deps.reviewRoot &&
        REVIEW_RUN_LEAF_PATTERN.test(leaf);
      if (!ours || liveLeaves.has(leaf)) continue;
      results.push(await this.removeOrReport(repositoryRoot, entry.path, correlationId));
    }
    return results;
  }

  /** Review directories with no registry record and no live run (a crash before registration). */
  private async sweepUnregisteredDirectories(
    liveLeaves: ReadonlySet<string>,
  ): Promise<readonly boolean[]> {
    if (!existsSync(this.deps.reviewRoot)) return [];
    const entries = await readdir(this.deps.reviewRoot, { withFileTypes: true });
    const results: boolean[] = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !REVIEW_RUN_LEAF_PATTERN.test(entry.name) ||
        liveLeaves.has(entry.name)
      )
        continue;
      const path = join(this.deps.reviewRoot, entry.name);
      await rm(path, { recursive: true, force: true });
      results.push(!existsSync(path));
    }
    return results;
  }
}

export function createReviewWorktreeManager(
  deps: ReviewWorktreeManagerDeps,
): ReviewWorktreeManager {
  return new ReviewWorktreeManagerImpl(deps);
}
