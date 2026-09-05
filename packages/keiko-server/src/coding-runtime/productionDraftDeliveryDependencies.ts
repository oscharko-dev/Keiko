import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import { canonicalise } from "@oscharko-dev/keiko-security";
import {
  canonicalGitHubPushUrl,
  createNodeGitCiReader,
  createNodeGitJourneyReader,
  createNodeGitPublishAdapter,
  createNodeGitPullRequestAdapter,
  readGitPushRemoteUrls,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import {
  codingWorkbenchRemoteDigest,
  resolveGitHubIssue,
  type GitHubIssueResolution,
} from "../coding-context/githubIssueResolution.js";
import {
  githubIssueReaderRepositoryId,
  githubRemoteOwnerAndRepoFor,
  isGitHubIssueReaderAuthorized,
} from "../coding-context/githubIssueReaderAuthorization.js";
import { describeError } from "../diagnostics-log.js";
import type { UiHandlerDeps } from "../deps.js";
import { redactEvidenceString } from "../deps.js";
import { githubOwnerAndRepoFromRemoteUrl } from "../gitDelivery/branchProtectionPreflight.js";
import {
  DraftDeliveryFailure,
  type DraftDeliveryDependencies,
  type DraftDeliveryRunContext,
  type DraftDeliveryTargetResolution,
} from "../gitDelivery/draftDeliveryTypes.js";
import {
  gitDeliveryTerminationHandler,
  resolveProjectWorkspace,
} from "../gitDelivery/execution.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { ActiveWorkspaceView } from "../task-workspace/types.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import {
  createProductionVerifiedCommitDependencies,
  type VerifiedCommitCompositionDeps,
} from "./productionVerifiedCommitDependencies.js";

export type DraftDeliveryCompositionDeps = VerifiedCommitCompositionDeps &
  Pick<
    UiHandlerDeps,
    "workspaceLifecycle" | "codingContextGitHubPort" | "codingContextGitHubRemoteResolver"
  >;

function snapshotIsDeliverable(state: string): boolean {
  return state === "running" || state === "awaiting-approval";
}

type TargetFailure = Extract<DraftDeliveryTargetResolution, { ok: false }>;

/** Reuses the accepted run, managed workspace, checkout grant and existing Git delivery adapters. */
export function createProductionDraftDeliveryDependencies(
  deps: DraftDeliveryCompositionDeps,
  snapshots: CodingRuntimeSnapshotStore | undefined,
): DraftDeliveryDependencies | undefined {
  const verified = createProductionVerifiedCommitDependencies(deps, snapshots);
  if (verified === undefined || snapshots === undefined || deps.workspaceLifecycle === undefined)
    return undefined;
  const factory = new DraftDeliveryFactory(deps, snapshots);
  return {
    snapshots,
    mutationDeps: verified.mutationDeps,
    ...(verified.execution === undefined ? {} : { execution: verified.execution }),
    resolveTarget: (context) => factory.resolveTarget(context),
    ciReader: (context) => factory.ciReader(context),
    journeyReader: (context) => factory.journeyReader(context),
    inspectionAdapter: (context) =>
      factory.live(context)
        ? createNodeGitPullRequestAdapter(factory.adapterDeps(context))
        : undefined,
    publishSeams: (context) => ({
      activityLog: factory.log,
      beforeRemoteDispatch: () => factory.live(context),
      publishAdapterFactory: (workspace): ReturnType<typeof createNodeGitPublishAdapter> => {
        factory.assertWorkspace(context, workspace);
        return createNodeGitPublishAdapter({
          ...factory.adapterDeps(context),
          verifiedRemoteUrl: factory.checkedPushUrl(context),
          beforeRemoteDispatch: () => factory.live(context),
          onPreparationFailure: (error: unknown): void => {
            factory.preparationFailure(context, error);
          },
        });
      },
    }),
    pullRequestSeams: (context) => ({
      activityLog: factory.log,
      beforeRemoteDispatch: () => factory.live(context),
      prAdapterFactory: (workspace): ReturnType<typeof createNodeGitPullRequestAdapter> => {
        factory.assertWorkspace(context, workspace);
        return createNodeGitPullRequestAdapter(factory.adapterDeps(context));
      },
    }),
  };
}

export type JourneyReadCompositionDeps = Pick<
  UiHandlerDeps,
  "store" | "env" | "managedTaskWorkspaceRoot" | "workspaceProvisioning" | "activityLog"
>;

export interface ProductionJourneyReadRequest {
  readonly repositoryId: string;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}

function journeyReaderWorkspace(root: string): WorkspaceInfo {
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

function journeyReaderRoot(deps: JourneyReadCompositionDeps, repositoryId: string): string | undefined {
  for (const project of deps.store.listProjects()) {
    const resolved = resolveProjectWorkspace(deps, project.path);
    if (resolved !== undefined && githubIssueReaderRepositoryId(resolved.root) === repositoryId) {
      return resolved.root;
    }
  }
  return undefined;
}

/**
 * Builds a read-only journey reader admitted by the per-checkout GitHub-reader grant alone — never
 * the run-bound mutation authority `DraftDeliveryFactory.journeyReader` above wires for an active
 * draft-delivery run. The journey observation route (#3389 AC5/AC6) uses this so refresh and
 * reconciliation keep working after the originating run has terminated, been recovered or the
 * process restarted: a live run's active workspace and snapshot state are never resolved or
 * required, only the same persisted per-checkout read grant `isGitHubIssueReaderAuthorized` already
 * consults per read.
 */
export function createProductionJourneyReader(
  deps: JourneyReadCompositionDeps,
  request: ProductionJourneyReadRequest,
): ReturnType<typeof createNodeGitJourneyReader> | undefined {
  const root = journeyReaderRoot(deps, request.repositoryId);
  if (root === undefined) return undefined;
  const stillAuthorized = (): boolean =>
    journeyReaderRoot(deps, request.repositoryId) === root &&
    isGitHubIssueReaderAuthorized(deps, root, { correlationId: request.correlationId });
  if (!stillAuthorized()) return undefined;
  return createNodeGitJourneyReader({
    workspace: journeyReaderWorkspace(root),
    processEnv: deps.env,
    signal: request.signal,
    onTerminated: gitDeliveryTerminationHandler(
      { activityLog: deps.activityLog ?? processServerLogSink() },
      request.correlationId,
    ),
    stillAuthorized,
  });
}

function activeMatches(active: ActiveWorkspaceView, context: DraftDeliveryRunContext): boolean {
  const { instance, binding, pointer } = active;
  return (
    instance.taskId === context.taskId &&
    binding.taskId === context.taskId &&
    instance.workspaceId === context.workspaceId &&
    binding.workspaceId === context.workspaceId &&
    pointer.workspaceId === context.workspaceId &&
    instance.repositoryId === context.issueBinding.repositoryId &&
    instance.baseBranch === context.baseRef &&
    instance.taskBranch === context.headRef &&
    instance.lifecycleState === "active" &&
    rootsMatch(active, context.workspace.root)
  );
}

function rootsMatch(active: ActiveWorkspaceView, root: string): boolean {
  return [
    active.instance.managedWorktreePath,
    active.binding.activeRoot,
    active.binding.gitDeliveryRoot,
    active.binding.editorProjectRoot,
  ].every((value) => value === root);
}

function resolutionFailure(result: Extract<GitHubIssueResolution, { ok: false }>): TargetFailure {
  if (result.failureReason === "read-failed" || result.failureReason === "reader-unavailable")
    return { ok: false, reason: "provider-failed" };
  switch (result.failure) {
    case "auth-required":
    case "authority-denied":
    case "cancelled":
      return { ok: false, reason: "authority-denied" };
    case "repository-mismatch":
      return { ok: false, reason: "remote-drift" };
    case "clone-failed":
      return { ok: false, reason: "provider-failed" };
    default:
      return { ok: false, reason: "issue-drift" };
  }
}

class DraftDeliveryFactory {
  public readonly log: ServerLogSink;
  // One proof per transient controller effect context; no credential, transport or authority is persisted.
  private readonly destinations = new WeakMap<DraftDeliveryRunContext, string>();
  public constructor(
    private readonly deps: DraftDeliveryCompositionDeps,
    private readonly snapshots: CodingRuntimeSnapshotStore,
  ) {
    this.log = deps.activityLog ?? processServerLogSink();
  }

  public ciReader(
    context: DraftDeliveryRunContext,
  ): ReturnType<typeof createNodeGitCiReader> | undefined {
    return this.live(context)
      ? createNodeGitCiReader({
          ...this.adapterDeps(context),
          stillAuthorized: () => this.live(context),
          redactText: (text) => redactEvidenceString(this.deps.redactor, text),
        })
      : undefined;
  }

  public journeyReader(
    context: DraftDeliveryRunContext,
  ): ReturnType<typeof createNodeGitJourneyReader> | undefined {
    return this.live(context)
      ? createNodeGitJourneyReader({
          ...this.adapterDeps(context),
          stillAuthorized: () => this.live(context),
        })
      : undefined;
  }

  public live(context: DraftDeliveryRunContext, originalRoot?: string): boolean {
    try {
      const root = this.originalRoot(context);
      return root !== undefined && (originalRoot === undefined || root === originalRoot);
    } catch (error) {
      this.record(context, { ok: false, reason: "authority-denied" }, error);
      return false;
    }
  }

  private originalRoot(context: DraftDeliveryRunContext): string | undefined {
    if (context.signal?.aborted === true || !context.stillAuthorized()) return undefined;
    const active = this.deps.workspaceLifecycle?.getActive(context.correlationId);
    if (active === undefined || !activeMatches(active, context) || !this.snapshotMatches(context))
      return undefined;
    const managed = resolveProjectWorkspace(this.deps, context.workspace.root);
    if (managed === undefined || canonicalise(managed) !== canonicalise(context.workspace))
      return undefined;
    return this.registeredRoot(active.instance.repositoryRoot, context);
  }

  private registeredRoot(root: string, context: DraftDeliveryRunContext): string | undefined {
    const registered = this.deps.store.listProjects().some((project) => {
      const original = resolveProjectWorkspace(this.deps, project.path);
      return (
        original !== undefined &&
        githubIssueReaderRepositoryId(original.root) === context.issueBinding.repositoryId
      );
    });
    if (!registered) return undefined;
    if (githubIssueReaderRepositoryId(root) !== context.issueBinding.repositoryId) return undefined;
    return isGitHubIssueReaderAuthorized(this.deps, root, {
      correlationId: context.correlationId,
      activityLog: this.log,
    })
      ? root
      : undefined;
  }

  private snapshotMatches(context: DraftDeliveryRunContext): boolean {
    const snapshot = this.snapshots.get(context.runId);
    return (
      snapshot?.runId === context.runId &&
      snapshotIsDeliverable(snapshot.state) &&
      snapshot.workspaceDigest === context.workspaceDigest &&
      snapshot.authorityDigest === context.runtimeAuthorityDigest &&
      context.repositoryDigest === context.issueBinding.remoteDigest &&
      context.issueBindingDigest === context.issueBinding.bindingDigest &&
      context.baseRef === context.issueBinding.defaultBaseRef &&
      canonicalise(snapshot.issueBinding ?? null) === canonicalise(context.issueBinding)
    );
  }

  public adapterDeps(context: DraftDeliveryRunContext): {
    workspace: WorkspaceInfo;
    processEnv: UiHandlerDeps["env"];
    signal: AbortSignal | undefined;
    onTerminated: ReturnType<typeof gitDeliveryTerminationHandler>;
  } {
    return {
      workspace: context.workspace,
      processEnv: this.deps.env,
      signal: context.signal,
      onTerminated: gitDeliveryTerminationHandler({ activityLog: this.log }, context.correlationId),
    };
  }

  public preparationFailure(context: DraftDeliveryRunContext, error: unknown): void {
    this.log.write({
      category: "security",
      op: "git.draft-push.preparation",
      correlationId: context.correlationId,
      level: "warn",
      errorKind: "internal",
      extra: { runId: context.runId, state: "failed", ...describeError(error) },
    });
  }

  public checkedPushUrl(context: DraftDeliveryRunContext): string {
    const url = this.destinations.get(context);
    if (url !== undefined && this.live(context)) return url;
    this.destinations.delete(context);
    this.record(context, { ok: false, reason: "authority-denied" });
    throw new DraftDeliveryFailure("authority-denied");
  }

  public assertWorkspace(context: DraftDeliveryRunContext, workspace: WorkspaceInfo): void {
    if (canonicalise(workspace) === canonicalise(context.workspace) && this.live(context)) return;
    this.record(context, { ok: false, reason: "authority-denied" });
    throw new DraftDeliveryFailure("authority-denied");
  }

  public async resolveTarget(
    context: DraftDeliveryRunContext,
  ): Promise<DraftDeliveryTargetResolution> {
    this.destinations.delete(context);
    let result: DraftDeliveryTargetResolution;
    try {
      const root = this.originalRoot(context);
      result =
        root === undefined
          ? { ok: false, reason: "authority-denied" }
          : await this.resolveFresh(context, root);
    } catch (error) {
      result = { ok: false, reason: this.live(context) ? "provider-failed" : "authority-denied" };
      this.record(context, result, error);
      return result;
    }
    this.record(context, result);
    return result;
  }

  private async resolveFresh(
    context: DraftDeliveryRunContext,
    root: string,
  ): Promise<DraftDeliveryTargetResolution> {
    const before = await this.readDestination(context, root);
    if (!before.ok) return before;
    const issue = await this.resolveAcceptedIssue(context, root);
    if (!issue.ok) return issue;
    const after = await this.readDestination(context, root);
    if (!after.ok) return after;
    if (before.url !== after.url) return { ok: false, reason: "remote-drift" };
    this.destinations.set(context, after.url);
    return issue;
  }

  private async readDestination(
    context: DraftDeliveryRunContext,
    root: string,
  ): Promise<{ ok: true; url: string } | TargetFailure> {
    const fetchRemote = await githubRemoteOwnerAndRepoFor(
      context.workspace.root,
      this.deps.env,
      this.deps.codingContextGitHubRemoteResolver,
      { activityLog: this.log, correlationId: context.correlationId, signal: context.signal },
    );
    if (!this.live(context, root)) return { ok: false, reason: "authority-denied" };
    if (!this.remoteMatches(fetchRemote, context)) return { ok: false, reason: "remote-drift" };
    const pushUrls = await readGitPushRemoteUrls(this.adapterDeps(context), "origin");
    if (!this.live(context, root)) return { ok: false, reason: "authority-denied" };
    const url = pushUrls.length === 1 ? canonicalGitHubPushUrl(pushUrls[0]) : undefined;
    if (url === undefined || !this.remoteMatches(githubOwnerAndRepoFromRemoteUrl(url), context))
      return { ok: false, reason: "remote-drift" };
    return { ok: true, url };
  }

  private remoteMatches(remote: string | undefined, context: DraftDeliveryRunContext): boolean {
    return (
      remote !== undefined &&
      codingWorkbenchRemoteDigest(remote) === context.issueBinding.remoteDigest
    );
  }

  private async resolveAcceptedIssue(
    context: DraftDeliveryRunContext,
    root: string,
  ): Promise<DraftDeliveryTargetResolution> {
    const result = await resolveGitHubIssue(this.deps, {
      repositoryRoot: root,
      issueRef: `#${String(context.issueBinding.issueNumber)}`,
      correlationId: context.correlationId,
      signal: context.signal,
    });
    if (!this.live(context, root)) return { ok: false, reason: "authority-denied" };
    if (!result.ok) return resolutionFailure(result);
    if (result.binding.remoteDigest !== context.issueBinding.remoteDigest)
      return { ok: false, reason: "remote-drift" };
    if (canonicalise(result.binding) !== canonicalise(context.issueBinding))
      return { ok: false, reason: "issue-drift" };
    return { ok: true, repository: result.preview.provenance.ownerAndRepo };
  }

  private record(
    context: DraftDeliveryRunContext,
    result: DraftDeliveryTargetResolution,
    error?: unknown,
  ): void {
    this.log.write({
      category: "security",
      op: "git.draft-target.resolved",
      correlationId: context.correlationId,
      level: result.ok ? "info" : "warn",
      ...(error === undefined ? {} : { errorKind: "internal" }),
      extra: {
        runId: context.runId,
        state: result.ok ? "ready" : "blocked",
        reason: result.ok ? "completed" : result.reason,
        issueBindingDigest: context.issueBinding.bindingDigest,
        ...(error === undefined ? {} : describeError(error)),
      },
    });
  }
}
