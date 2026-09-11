import { realpathSync } from "node:fs";
import { resolvedLinkedIssueNumbers } from "../coding-context/codingRuntimeIssueIntake.js";
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

// One live-gated provider adapter serves the inspection reads and the Checks refresh's body reads and
// writes (owner review on PR #3452).
function livePullRequestAdapter(
  factory: DraftDeliveryFactory,
  context: Parameters<DraftDeliveryDependencies["inspectionAdapter"]>[0],
): ReturnType<typeof createNodeGitPullRequestAdapter> | undefined {
  return factory.live(context)
    ? createNodeGitPullRequestAdapter(factory.adapterDeps(context))
    : undefined;
}

/** Reuses the accepted run, managed workspace, checkout grant and existing Git delivery adapters. */
export function createProductionDraftDeliveryDependencies(
  deps: DraftDeliveryCompositionDeps,
  snapshots: CodingRuntimeSnapshotStore | undefined,
): DraftDeliveryDependencies | undefined {
  const verified = createProductionVerifiedCommitDependencies(deps, snapshots);
  if (verified === undefined || snapshots === undefined || deps.workspaceLifecycle === undefined)
    return undefined;
  const factory = new DraftDeliveryFactory(deps, snapshots);
  const pullRequestAdapter = (
    context: Parameters<DraftDeliveryDependencies["inspectionAdapter"]>[0],
  ): ReturnType<typeof createNodeGitPullRequestAdapter> | undefined =>
    livePullRequestAdapter(factory, context);
  return {
    snapshots,
    mutationDeps: verified.mutationDeps,
    ...(verified.execution === undefined ? {} : { execution: verified.execution }),
    resolveTarget: (context) => factory.resolveTarget(context),
    resolveRelatedIssues: (context) => factory.resolveRelatedIssues(context),
    ciReader: (context) => factory.ciReader(context),
    journeyReader: (context) => factory.journeyReader(context),
    inspectionAdapter: pullRequestAdapter,
    bodyAdapter: pullRequestAdapter,
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
  | "store"
  | "env"
  | "managedTaskWorkspaceRoot"
  | "workspaceProvisioning"
  | "workspaceLifecycle"
  | "activityLog"
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

function journeyReaderRoot(
  deps: JourneyReadCompositionDeps,
  repositoryId: string,
): string | undefined {
  for (const project of deps.store.listProjects()) {
    const resolved = resolveProjectWorkspace(deps, project.path);
    if (resolved !== undefined && githubIssueReaderRepositoryId(resolved.root) === repositoryId) {
      return resolved.root;
    }
  }
  return undefined;
}

/**
 * The registered checkout root for one content-free repository identity, or undefined when no
 * registered project resolves to it. Shared by `createProductionJourneyReader` and the journey
 * observation route's read-only description-status lookup so both resolve the SAME checkout the
 * per-checkout GitHub-reader grant was evaluated for.
 */
export function resolveJourneyCheckoutRoot(
  deps: JourneyReadCompositionDeps,
  repositoryId: string,
): string | undefined {
  return journeyReaderRoot(deps, repositoryId);
}

/**
 * Every LOCAL checkout that could hold this repository's PR-description receipt (#3389 AC9,
 * epic #3384 issue-to-PR).
 *
 * The receipt store scopes its digest to the EXACT local root the apply actually ran in
 * (`scopeFor` in `prDescriptionReceiptStore.ts` hashes `realpathSync(context.workspace.root)`) —
 * deliberately, so a description generated against one checkout's diff can never be read back as
 * "applied" from an unrelated one. For a worktree-isolated coding run that root is the run's own
 * MANAGED WORKTREE, never the repository root `issueBinding.repositoryId` above is keyed to: that
 * id is captured once, from the ORIGINAL repository the issue was accepted against
 * (`githubIssueReaderRepositoryId(instance.repositoryRoot)`), specifically so it survives the
 * worktree's own eventual archival — but that also means `journeyReaderRoot`'s single-root
 * resolution can only ever land back on the ordinary/original project, never on the worktree the
 * description apply actually used. Reading the receipt therefore needs every plausible LOCAL root,
 * not just the one identity-stable anchor:
 *
 *  1. the ordinary registered-project root `resolveJourneyCheckoutRoot` already resolves (kept
 *     first so an ordinary, non-worktree-isolated deployment is unaffected), and
 *  2. every managed worktree `workspaceLifecycle.list` reports for that SAME root
 *     (`ensureManagedTaskWorkspaceIdentity` registers one project per accepted task), each
 *     re-verified through the SAME strong managed-root prover `resolveProjectWorkspace` already
 *     applies to an ordinary project — never the raw persisted path taken on faith.
 *
 * Trying every candidate mints no authority and fabricates nothing: each root is independently
 * admitted through the existing prover, and the receipt store's own scope/binding check
 * (`statusMatchesScope`) refuses any document that is not genuinely and consistently keyed to the
 * candidate actually queried — a wrong candidate can only ever come back "not found." Step 2 needs
 * no repository-wide store pick of its own: `workspaceLifecycle.list` keys by the SAME canonical
 * root step 1 already proved resolves to `repositoryId`, so it is threaded straight through.
 */
function managedWorktreeCandidates(
  deps: JourneyReadCompositionDeps,
  ordinaryRoot: string,
): readonly WorkspaceInfo[] {
  if (deps.workspaceLifecycle === undefined) return [];
  try {
    const instances = deps.workspaceLifecycle.list(realpathSync(ordinaryRoot));
    return instances
      .map((instance) => resolveProjectWorkspace(deps, instance.managedWorktreePath))
      .filter((resolved) => resolved !== undefined);
  } catch {
    // A vanished ordinary root or an unavailable lifecycle store yields no worktree candidates —
    // never a thrown failure that would take the whole journey refresh down with it (fail closed
    // to "no additional candidates", exactly like an unresolved ordinary root already does).
    return [];
  }
}
export function resolveJourneyDescriptionCheckoutRoots(
  deps: JourneyReadCompositionDeps,
  repositoryId: string,
): readonly string[] {
  const roots = new Set<string>();
  const ordinary = resolveJourneyCheckoutRoot(deps, repositoryId);
  if (ordinary !== undefined) {
    roots.add(ordinary);
    for (const candidate of managedWorktreeCandidates(deps, ordinary)) roots.add(candidate.root);
  }
  return [...roots];
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

/**
 * Builds a read-only journey CI reader admitted by the SAME per-checkout GitHub-reader grant as
 * `createProductionJourneyReader` above — never the run-bound mutation/CI-observation authority a
 * terminated run no longer holds. The journey observation route's readiness resolution uses this so
 * a refresh renews CURRENT CI facts for the confirmed PR after the originating coding run has
 * settled to `succeeded`: the `ReadinessSnapshot` persisted on the coding-runtime snapshot row is
 * written only by the live run's own in-run CI tool call (`DraftDeliveryFactory.ciReader` above,
 * gated on `snapshotIsDeliverable` — `running`/`awaiting-approval`), so it necessarily expires
 * (`observedAt + 60s`) long before a human reaches the issue-handoff stage and nothing else ever
 * renews it. This reader closes that gap from the same read-only boundary
 * `createProductionJourneyReader` already uses for lifecycle facts — never widening authority and
 * never fabricating a check result.
 */
export function createProductionJourneyCiReader(
  deps: JourneyReadCompositionDeps,
  request: ProductionJourneyReadRequest,
): ReturnType<typeof createNodeGitCiReader> | undefined {
  const root = journeyReaderRoot(deps, request.repositoryId);
  if (root === undefined) return undefined;
  const stillAuthorized = (): boolean =>
    journeyReaderRoot(deps, request.repositoryId) === root &&
    isGitHubIssueReaderAuthorized(deps, root, { correlationId: request.correlationId });
  if (!stillAuthorized()) return undefined;
  return createNodeGitCiReader({
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

  // The epic's children for the pull request's related-issue line, read through the same authorized
  // root and reader as the accepted issue itself. The bound issue is re-read and must still be the
  // accepted binding; anything unavailable or drifted answers "no related issues", logged body-free.
  public async resolveRelatedIssues(context: DraftDeliveryRunContext): Promise<readonly number[]> {
    const root = this.originalRoot(context);
    if (root === undefined) return this.relatedIssues(context, "unavailable", []);
    try {
      const bound = await resolveGitHubIssue(this.deps, {
        repositoryRoot: root,
        issueRef: `#${String(context.issueBinding.issueNumber)}`,
        correlationId: context.correlationId,
        signal: context.signal,
      });
      if (!bound.ok || canonicalise(bound.binding) !== canonicalise(context.issueBinding))
        return this.relatedIssues(context, "unavailable", []);
      const related = await resolvedLinkedIssueNumbers(this.deps, {
        repositoryRoot: root,
        body: bound.contextObject.body,
        boundIssue: context.issueBinding.issueNumber,
        correlationId: context.correlationId,
        runId: context.runId,
        signal: context.signal,
      });
      return this.relatedIssues(context, "resolved", related);
    } catch (error) {
      this.log.write({
        category: "process",
        op: "git.draft-related-issues",
        correlationId: context.correlationId,
        level: "warn",
        errorKind: "internal",
        extra: { runId: context.runId, state: "unavailable", count: 0, ...describeError(error) },
      });
      return [];
    }
  }

  private relatedIssues(
    context: DraftDeliveryRunContext,
    state: "resolved" | "unavailable",
    related: readonly number[],
  ): readonly number[] {
    this.log.write({
      category: "process",
      op: "git.draft-related-issues",
      correlationId: context.correlationId,
      extra: { runId: context.runId, state, count: related.length },
    });
    return related;
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
      extra: {
        runId: context.runId,
        state: "failed",
        // The publish view throws closed slugs (`git-publish-metadata-unavailable`, …); the class
        // alone ("Error") did not say which precondition failed (run 18, 2026-09-10).
        ...(publishPreparationReason(error) === undefined
          ? {}
          : { reason: publishPreparationReason(error) }),
        ...describeError(error),
      },
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
    // The REPOSITORY root the issue was read from, never the managed worktree: the worktree lives
    // under the state directory, which the workspace deny list (`.keiko/**`) keeps outside the
    // governed content surface, so evaluating its remote answered `remote-unreadable` and refused
    // every push and pull request of a run that had just committed as `remote-drift` (Coding
    // Workbench run 17, 2026-09-10). A worktree shares its repository's remotes; `originalRoot`
    // already resolved and authorized exactly that root, and `resolveAcceptedIssue` reads the issue
    // through it. The push URL below is still read from the worktree's own Git configuration.
    const fetchRemote = await githubRemoteOwnerAndRepoFor(
      root,
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

// A closed `git-publish-*` slug from the publish view, or undefined for anything else — never free
// text, so the preparation line stays body-free whatever an unexpected error carries.
const PUBLISH_PREPARATION_REASON = /^git-publish-[a-z]+(?:-[a-z]+){0,6}$/u;

function publishPreparationReason(error: unknown): string | undefined {
  return error instanceof Error && PUBLISH_PREPARATION_REASON.test(error.message)
    ? error.message
    : undefined;
}
