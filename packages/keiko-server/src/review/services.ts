// Composition of the review target and review worktree services (ADR-0182 D3, Issue #4133).
//
// One instance per server: the read-only pull request reads, the target resolver, the worktree
// manager and the private-ref retention, sharing one owner-private review root, one registry and
// the observed hardened review runners. `startup()` removes every orphaned review worktree and
// sweeps the private refs; a daily timer sweeps the refs again; `dispose()` removes every live
// review worktree on server shutdown.

import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  createGitReviewNetworkProcessRunner,
  createGitReviewProcessRunner,
  type GitProcessRunner,
  type GitReviewRunnerOptions,
} from "@oscharko-dev/keiko-git";
import {
  createNodeGitReviewPullRequestReader,
  type GitReviewPullRequestReader,
  readGitRemoteAliases,
  readGitRemoteUrl,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { githubOwnerAndRepoFromRemoteUrl } from "../gitDelivery/branchProtectionPreflight.js";
import { observedGitRunner } from "../gitProcessActivity.js";
import type { ServerLogSink } from "../observability/index.js";
import {
  createReviewPullRequestReads,
  type ReviewGitHubRepositoryPort,
  type ReviewPullRequestReads,
} from "./target/pullRequestReads.js";
import { sweepReviewRefs, type ReviewRefSweepResult } from "./target/refRetention.js";
import {
  resolveReviewTarget,
  REVIEW_FETCH_REMOTE,
  type ReviewTargetResolution,
  type ReviewTargetResolveInput,
} from "./target/resolver.js";
import { createReviewWorktreeManager, type ReviewWorktreeManager } from "./worktree/manager.js";
import { createReviewRegistry, type ReviewRegistry } from "./worktree/registry.js";
import { reportReviewFailure } from "./diagnostics.js";
import { newCorrelationId } from "../correlation.js";
import {
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  defaultServerDiagnosticSink,
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import type { ReviewRefSweepTrigger } from "./activity-log.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The review root's directory name under the server state directory. */
export const REVIEW_WORKTREE_ROOT_NAME = "review-worktrees";

export interface ReviewServicesDeps {
  readonly reviewRoot: string;
  readonly activityLog: ServerLogSink;
  readonly now?: (() => number) | undefined;
  readonly github?: ReviewGitHubRepositoryPort | undefined;
  /** Builds the UNOBSERVED local review runner; tests substitute it, production uses keiko-git's. */
  readonly localRunner?: ((options: GitReviewRunnerOptions) => GitProcessRunner) | undefined;
  readonly networkRunner?: (() => GitProcessRunner) | undefined;
  /** Refs a retained review run still references (the run store, Issue #4136). Default: none. */
  readonly retainedRunRefs?: ((repositoryRoot: string) => ReadonlySet<string>) | undefined;
  readonly blobLimitBytes?: number | undefined;
  readonly maxPaths?: number | undefined;
  readonly maxMaterializedBytes?: number | undefined;
  readonly createDeadlineMs?: number | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

export interface ReviewServices {
  readonly reviewRoot: string;
  readonly namespace: string;
  readonly pullRequests: ReviewPullRequestReads;
  readonly worktrees: ReviewWorktreeManager;
  resolveTarget(input: ReviewTargetResolveInput): Promise<ReviewTargetResolution>;
  sweepRefs(trigger: ReviewRefSweepTrigger, correlationId?: string): Promise<ReviewRefSweepResult>;
  startup(correlationId?: string): Promise<void>;
  dispose(correlationId?: string): Promise<void>;
}

function workspaceFor(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

/** The production GitHub port: the verified `origin` owner/repo and the fixed-document reader. */
export function productionReviewGitHubPort(): ReviewGitHubRepositoryPort {
  return {
    ownerAndRepo: async (repositoryRoot): Promise<string | undefined> => {
      const deps = { workspace: workspaceFor(repositoryRoot) };
      const aliases = await readGitRemoteAliases(deps);
      if (!aliases.includes(REVIEW_FETCH_REMOTE)) return undefined;
      return githubOwnerAndRepoFromRemoteUrl(await readGitRemoteUrl(deps, REVIEW_FETCH_REMOTE));
    },
    readerFor: (repositoryRoot, correlationId): GitReviewPullRequestReader =>
      createNodeGitReviewPullRequestReader({
        workspace: workspaceFor(repositoryRoot),
        processEnv: process.env,
        failureSink: {
          record: (_failure, error): void => {
            reportReviewFailure("review.target.provider-read", correlationId, error);
          },
        },
      }),
  };
}

/**
 * One installation's private ref namespace: a digest of its canonical review root, so two Keiko
 * installations (two state directories) reviewing the same repository never sweep each other's
 * refs.
 */
export function reviewRefNamespace(canonicalReviewRoot: string): string {
  return `k${sha256Hex(`keiko-review/namespace:${canonicalReviewRoot}`).slice(0, 16)}`;
}

/** Creates the owner-private review root (0700) and returns its canonical path. */
function preparedReviewRoot(reviewRoot: string): string {
  mkdirSync(reviewRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(reviewRoot, 0o700);
  return realpathSync(reviewRoot);
}

interface PinnedRefs {
  readonly repositoryRoot: string;
  readonly refs: readonly string[];
}

class ReviewServicesImpl implements ReviewServices {
  public readonly reviewRoot: string;
  /** This installation's private ref namespace, derived from its canonical review root. */
  public readonly namespace: string;
  public readonly pullRequests: ReviewPullRequestReads;
  public readonly worktrees: ReviewWorktreeManager;
  private readonly registry: ReviewRegistry;
  private readonly github: ReviewGitHubRepositoryPort;
  private readonly now: () => number;
  // A resolved target's private refs stay pinned until its worktree is removed; afterwards they
  // follow the retention rule like every other review ref.
  private readonly pinned = new Map<string, PinnedRefs>();
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly deps: ReviewServicesDeps) {
    this.reviewRoot = preparedReviewRoot(deps.reviewRoot);
    this.namespace = reviewRefNamespace(this.reviewRoot);
    this.now = deps.now ?? Date.now;
    this.registry = createReviewRegistry(this.reviewRoot);
    this.github = deps.github ?? productionReviewGitHubPort();
    this.pullRequests = createReviewPullRequestReads({
      github: this.github,
      activityLog: deps.activityLog,
      now: this.now,
    });
    this.worktrees = createReviewWorktreeManager({
      reviewRoot: this.reviewRoot,
      registry: this.registry,
      activityLog: deps.activityLog,
      now: this.now,
      runner: (options, correlationId) => this.localRunner(options, correlationId),
      blobLimitBytes: deps.blobLimitBytes,
      maxPaths: deps.maxPaths,
      maxMaterializedBytes: deps.maxMaterializedBytes,
      createDeadlineMs: deps.createDeadlineMs,
      onRemoved: (runId) => {
        this.pinned.delete(runId);
      },
    });
  }

  private localRunner(
    options: GitReviewRunnerOptions,
    correlationId: string | undefined,
  ): GitProcessRunner {
    const build = this.deps.localRunner ?? createGitReviewProcessRunner;
    return observedGitRunner(build(options), this.deps.activityLog, correlationId);
  }

  private networkRunner(correlationId: string | undefined): GitProcessRunner {
    const build = this.deps.networkRunner ?? createGitReviewNetworkProcessRunner;
    return observedGitRunner(build(), this.deps.activityLog, correlationId);
  }

  private retainedRefs(repositoryRoot: string): ReadonlySet<string> {
    const refs = new Set(this.deps.retainedRunRefs?.(repositoryRoot) ?? []);
    for (const pin of this.pinned.values()) {
      if (pin.repositoryRoot !== repositoryRoot) continue;
      for (const ref of pin.refs) refs.add(ref);
    }
    return refs;
  }

  public async resolveTarget(input: ReviewTargetResolveInput): Promise<ReviewTargetResolution> {
    const resolution = await resolveReviewTarget(
      {
        github: this.github,
        namespace: this.namespace,
        localRunner: (id) => this.localRunner({}, id),
        networkRunner: (id) => this.networkRunner(id),
        registry: this.registry,
        activityLog: this.deps.activityLog,
        now: this.now,
      },
      input,
    );
    if (resolution.ok) {
      this.pinned.set(input.runId, {
        repositoryRoot: input.repositoryRoot,
        refs: resolution.privateRefs,
      });
    }
    return resolution;
  }

  public sweepRefs(
    trigger: ReviewRefSweepTrigger,
    correlationId?: string,
  ): Promise<ReviewRefSweepResult> {
    return sweepReviewRefs(
      {
        registry: this.registry,
        namespace: this.namespace,
        runner: (id) => this.localRunner({}, id),
        activityLog: this.deps.activityLog,
        now: this.now,
        retainedRefs: (repositoryRoot) => this.retainedRefs(repositoryRoot),
        openPullRequests: (repositoryRoot) =>
          this.pullRequests.openNumbers(repositoryRoot, correlationId),
      },
      trigger,
      correlationId,
    );
  }

  public async startup(correlationId?: string): Promise<void> {
    await this.worktrees.sweepOrphans(correlationId);
    await this.sweepRefs("startup", correlationId);
    this.timer ??= setInterval(() => {
      this.dailySweep();
    }, DAY_MS);
    this.timer.unref();
  }

  private dailySweep(): void {
    const correlationId = newCorrelationId();
    void this.sweepRefs("daily", correlationId).catch((error: unknown) => {
      emitServerDiagnostic(
        this.deps.diagnostics ?? defaultServerDiagnosticSink,
        serverDiagnosticFromError({
          correlationId,
          operation: "review.worktree.refs-sweep",
          source: "review.retention",
          error,
          summary: DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
          redact: (message): string => message,
        }),
      );
    });
  }

  public async dispose(correlationId?: string): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.worktrees.removeAll("shutdown", correlationId);
  }
}

export function createReviewServices(deps: ReviewServicesDeps): ReviewServices {
  return new ReviewServicesImpl(deps);
}
