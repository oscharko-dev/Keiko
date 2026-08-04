"use client";

// Git client window (Issue #1574 shell + Issue #1575 Changes/Diff/Staging/Commit, Epic #1571). The
// single coherent Git window from the frozen layout contract (§5): header toolbar (repository +
// branch selectors + sync status + open actions), a left sidebar (repository search + Changes/History
// tabs with explicit staging and a pinned commit composer), and a right diff pane with staged/worktree
// scope controls and PR/Merge entry points. Reads use the #1574 read surface; staging and commit run
// through the existing governed mutation routes via the injected seam (stage/unstage/commit*).
//
// Visible product text says "Git" only — never "Governed Git", "Governance", or "Delivery path"
// (contract §7). Styling composes existing globals.css tokens via inline styles (ADR-0051); no new CSS.
// See ADR-0098 for the git-client window conventions (layout contract, vocabulary, seam boundaries).

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import type { GitBranchListEntry } from "@/lib/api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import type {
  GitChangedFile,
  GitDiffScope,
  GitHistoryEntry,
  GitHistoryResponse,
  GitRemoteSummary,
  GitRepositorySummary,
  GitRepositoryStatusResponse,
  ProjectWithAvailability,
} from "@/lib/types";
import type { WindowCfgValue } from "../../../windows/types";
import type { OpenEditorFileRequest } from "../../../hooks/useWorkspace.types";
import { DEFAULT_GIT_CLIENT, formatGitError, useGitActions } from "./git-client-seam";
import type { GitClientSeam } from "./git-client-seam";
import { MutationOutcome } from "./git-client-ui";
import { GovernedMergeCard } from "../GovernedMergeCard";
import { GovernedPullRequestCard } from "../GovernedPullRequestCard";
import { Icons } from "../../../Icons";
import { RepositoryToolbar } from "./RepositoryToolbar";
import { ConnectPanel } from "./ConnectPanel";
import { AddRepositoryDialog } from "./AddRepositoryDialog";
import { ChangesPane } from "./ChangesPane";
import type { ChangesTab } from "./ChangesPane";
import { CommitComposer } from "./CommitComposer";
import { DiffPane } from "./DiffPane";
import { NewBranchDialog } from "./NewBranchDialog";
import {
  WorktreeMutationConfirmDialog,
  type WorktreeMutationConfirmation,
} from "./WorktreeMutationConfirmDialog";
import { deriveSyncView } from "./SyncControl";
import {
  pushOutcomePresentation,
  syncOutcomePresentation,
  type SyncOutcomeView,
} from "./sync-outcome";
import {
  GIT_REPOSITORY_STATE_INVALIDATED_EVENT,
  gitRepositoryStateInvalidationRoots,
  notifyGitRepositoryStateInvalidated,
} from "../git-repository-state-events";
import { WORKSPACE_FILE_MUTATED_EVENT, workspaceFileMutationRoots } from "../workspace-file-events";
import { requestEditorBufferReconciliation } from "../editor-buffer-reconciliation-events";
import { restoreModalTriggerFocus } from "../../../hooks/useModalInteractionLock";
import {
  BODY_STYLE,
  DIFF_HEADER_STYLE,
  PANE_STYLE,
  SECONDARY_BTN,
  SIDEBAR_STYLE,
  WORKSPACE_STYLE,
} from "./git-client-styles";

const EMPTY_BRANCHES: readonly GitBranchListEntry[] = [];
const HISTORY_PAGE_SIZE = 50;
const ChevronRightIcon = Icons.chevronR;

export interface GitClientWindowProps {
  /** Repository path to preselect when opened from Files, Editor, or Runtime (resolveBoundRoot). */
  readonly projectId?: string | undefined;
  readonly initialPath?: string | undefined;
  readonly initialCommit?: string | undefined;
  readonly onOpenFiles?: ((root: string) => void) | undefined;
  readonly onOpenEditor?: ((root: string) => void) | undefined;
  readonly onOpenEditorFile?: ((request: OpenEditorFileRequest) => void) | undefined;
  /** Persists the selected repository into cfg.projectPath so resolveBoundRoot re-targets. */
  readonly updateCfg?: ((patch: Record<string, WindowCfgValue>) => void) | undefined;
  /** DI seam; defaults to the real BFF client. */
  readonly client?: GitClientSeam;
  /** Reconciles open editor buffers after a successful working-tree mutation. */
  readonly reconcileEditorBuffers?: ((root: string) => Promise<void>) | undefined;
}

type RightPaneMode = "diff" | "pull-request" | "merge";
type SyncView = ReturnType<typeof deriveSyncView>;

function preferredDiffScopeForChange(change: GitChangedFile): GitDiffScope {
  return change.staged && !change.unstaged && !change.untracked ? "staged" : "worktree";
}

function normalizeDiffScopeForChange(current: GitDiffScope, change: GitChangedFile): GitDiffScope {
  if (change.staged && !change.unstaged && !change.untracked && current === "worktree") {
    return "staged";
  }
  if (
    !change.staged &&
    (change.unstaged || change.untracked || change.conflicted) &&
    current === "staged"
  ) {
    return "worktree";
  }
  return current;
}

function ownerRepoFromRemoteUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const trimmed = value.replace(/\.git$/u, "");
  const sshMatch = /^git@github\.com:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/u.exec(trimmed);
  if (sshMatch?.[1] !== undefined) return sshMatch[1];
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch {
    return undefined;
  }
  return undefined;
}

function inferOwnerAndRepo(remotes: readonly GitRemoteSummary[]): string | undefined {
  for (const remote of remotes) {
    const ownerRepo =
      ownerRepoFromRemoteUrl(remote.fetchUrl) ?? ownerRepoFromRemoteUrl(remote.pushUrl);
    if (ownerRepo !== undefined) return ownerRepo;
  }
  return undefined;
}

function inferBaseBranch(
  currentBranch: string | undefined,
  summary: GitRepositorySummary | null,
): string {
  const upstreamBranch = summary?.upstream?.branch;
  if (
    currentBranch !== undefined &&
    upstreamBranch !== undefined &&
    upstreamBranch !== currentBranch
  ) {
    return upstreamBranch;
  }
  if (currentBranch !== undefined && currentBranch !== "main") return "main";
  return upstreamBranch ?? currentBranch ?? "main";
}

function useRightPaneFocus(
  rightPaneMode: RightPaneMode,
  rightPaneRef: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    if (rightPaneMode === "diff") return;
    const frame = window.requestAnimationFrame(() => {
      const heading = rightPaneRef.current?.querySelector("h2");
      if (heading instanceof HTMLElement) {
        heading.tabIndex = -1;
        heading.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [rightPaneMode, rightPaneRef]);
}

interface InitialChangeLandingOptions {
  readonly selectedPath: string | null;
  readonly initialPath: string | undefined;
  readonly activeStatus: GitRepositoryStatusResponse | null;
  readonly landedPathRef: RefObject<string | null>;
  readonly setTab: Dispatch<SetStateAction<ChangesTab>>;
  readonly setSelectedCommitSha: Dispatch<SetStateAction<string | null>>;
  readonly setSelectedChangePath: Dispatch<SetStateAction<string | null>>;
  readonly setDiffScope: Dispatch<SetStateAction<GitDiffScope>>;
}

function useInitialChangeLanding(options: InitialChangeLandingOptions): void {
  const {
    selectedPath,
    initialPath,
    activeStatus,
    landedPathRef,
    setTab,
    setSelectedCommitSha,
    setSelectedChangePath,
    setDiffScope,
  } = options;
  useEffect(() => {
    if (selectedPath === null || initialPath === undefined || activeStatus === null) return;
    const landingKey = `${selectedPath}\u0000${initialPath}`;
    if (landedPathRef.current === landingKey) return;
    const change = activeStatus.changes.find((entry) => entry.path === initialPath);
    if (change === undefined) return;
    landedPathRef.current = landingKey;
    setTab("changes");
    setSelectedCommitSha(null);
    setSelectedChangePath(change.path);
    setDiffScope(preferredDiffScopeForChange(change));
  }, [
    activeStatus,
    initialPath,
    landedPathRef,
    selectedPath,
    setDiffScope,
    setSelectedChangePath,
    setSelectedCommitSha,
    setTab,
  ]);
}

interface InitialCommitLandingOptions {
  readonly selectedPath: string | null;
  readonly initialCommit: string | undefined;
  readonly landedCommitRef: RefObject<string | null>;
  readonly setTab: Dispatch<SetStateAction<ChangesTab>>;
  readonly setSelectedCommitSha: Dispatch<SetStateAction<string | null>>;
}

function useInitialCommitLanding(options: InitialCommitLandingOptions): void {
  const { selectedPath, initialCommit, landedCommitRef, setTab, setSelectedCommitSha } = options;
  useEffect(() => {
    if (selectedPath === null || initialCommit === undefined) return;
    const landingKey = `${selectedPath}\u0000${initialCommit}`;
    if (landedCommitRef.current === landingKey) return;
    landedCommitRef.current = landingKey;
    setTab("history");
    setSelectedCommitSha(initialCommit);
  }, [initialCommit, landedCommitRef, selectedPath, setSelectedCommitSha, setTab]);
}

function selectedHistoryCommitResolver(
  entries: readonly GitHistoryEntry[],
  requestedCommit: string | undefined,
  hasRequestedCommit: boolean,
): (current: string | null) => string | null {
  return (current: string | null): string | null => {
    if (entries.length === 0) return null;
    if (requestedCommit !== undefined) return hasRequestedCommit ? requestedCommit : null;
    if (current !== null && entries.some((entry) => entry.sha === current)) return current;
    return entries[0]?.sha ?? null;
  };
}

function appendHistoryPage(
  current: GitHistoryResponse,
  page: GitHistoryResponse,
): GitHistoryResponse {
  const seen = new Set(current.entries.map((entry) => entry.sha));
  const appended = page.entries.filter((entry) => {
    if (seen.has(entry.sha)) return false;
    seen.add(entry.sha);
    return true;
  });
  return {
    ...current,
    entries: [...current.entries, ...appended],
    truncated: page.entries.length > 0 && page.truncated,
  };
}

function diffScopeNormalizer(change: GitChangedFile): (current: GitDiffScope) => GitDiffScope {
  return (current: GitDiffScope): GitDiffScope => normalizeDiffScopeForChange(current, change);
}

function selectedChangeResolver(
  changes: readonly GitChangedFile[],
  setDiffScope: Dispatch<SetStateAction<GitDiffScope>>,
): (previous: string | null) => string | null {
  return (previous: string | null): string | null => {
    if (previous === null) return null;
    const selectedChange = changes.find((change) => change.path === previous);
    if (selectedChange === undefined) return null;
    setDiffScope(diffScopeNormalizer(selectedChange));
    return previous;
  };
}

interface SyncExecutionContext {
  readonly sequence: number;
  readonly startedAt: number;
  readonly aheadBefore: number;
  readonly behindBefore: number;
  readonly projectId: string;
  readonly repositoryRoot: string | undefined;
  readonly sequenceRef: RefObject<number>;
  readonly setBusy: Dispatch<SetStateAction<boolean>>;
  readonly setOutcome: Dispatch<SetStateAction<SyncOutcomeView | null>>;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly reconcileEditorBuffers: (root: string) => Promise<void>;
}

function syncOutcomeWithMetrics(
  context: SyncExecutionContext,
  outcome: SyncOutcomeView,
  t: I18nTranslate,
): SyncOutcomeView {
  const elapsedSeconds = Math.round((performance.now() - context.startedAt) / 100) / 10;
  const delta =
    context.aheadBefore > 0
      ? t("gitClientWindow.sync.aheadSuffix", { count: context.aheadBefore })
      : t("gitClientWindow.sync.behindSuffix", { count: context.behindBefore });
  return {
    message: t("gitClientWindow.sync.outcome", {
      label: outcome.message,
      seconds: elapsedSeconds,
      delta,
    }),
    failed: outcome.failed,
  };
}

// A preview block is already worded as a refusal ("Blocked: …"), so it keeps the neutral pill; what
// must never be neutral is a settled EXECUTION that failed, which is what pushOutcomePresentation /
// syncOutcomePresentation decide.
function blockedOutcome(message: string): SyncOutcomeView {
  return { message, failed: false };
}

function completeSync(
  context: SyncExecutionContext,
  outcome: SyncOutcomeView,
  repositoryMayHaveChanged: boolean,
): void {
  if (repositoryMayHaveChanged) {
    notifyGitRepositoryStateInvalidated(context.projectId, context.repositoryRoot);
  }
  if (context.sequenceRef.current !== context.sequence) return;
  context.setBusy(false);
  context.setOutcome(outcome);
}

function failSync(context: SyncExecutionContext, error: unknown): void {
  if (context.sequenceRef.current !== context.sequence) return;
  context.setBusy(false);
  context.setError(formatGitError(error));
}

function runFetchOrPullSync(
  client: GitClientSeam,
  projectId: string,
  syncView: SyncView,
  context: SyncExecutionContext,
  t: I18nTranslate,
  optionalT: OptionalWidgetTranslate,
): void {
  if (syncView.action !== "fetch" && syncView.action !== "pull") return;
  const operation = syncView.action;
  void client
    .syncPreview({ operation, projectId, remote: syncView.remoteAlias })
    .then((preview) => {
      if (!preview.executable) {
        completeSync(
          context,
          blockedOutcome(
            t("gitClientWindow.sync.blocked", {
              reason: preview.blockReason ?? t("gitClientWindow.sync.unavailableLower"),
            }),
          ),
          false,
        );
        return undefined;
      }
      return client.syncExecute({ operation, projectId, remote: syncView.remoteAlias });
    })
    .then(
      (result) => {
        if (result === undefined) return;
        const label =
          operation === "fetch" ? t("gitClientWindow.sync.fetch") : t("gitClientWindow.sync.pull");
        const outcome = syncOutcomeWithMetrics(
          context,
          syncOutcomePresentation(label, result.status, t),
          t,
        );
        if (operation !== "pull" || result.status !== "succeeded") {
          completeSync(context, outcome, true);
          return;
        }
        return context.reconcileEditorBuffers(projectId).then(
          () => completeSync(context, outcome, true),
          () =>
            completeSync(
              context,
              {
                message: optionalT("gitClientWindow.sync.editorReconciliationFailed"),
                failed: true,
              },
              true,
            ),
        );
      },
      (error: unknown) => failSync(context, error),
    );
}

type PushInput = Parameters<GitClientSeam["pushPreview"]>[0];

function pushInput(projectId: string, syncView: SyncView): PushInput | null {
  if (syncView.action !== "push" && syncView.action !== "publish-upstream") return null;
  if (
    syncView.remoteAlias === undefined ||
    syncView.remoteBranchName === undefined ||
    syncView.sourceBranchName === undefined
  )
    return null;
  return {
    projectId,
    remoteAlias: syncView.remoteAlias,
    remoteBranchName: syncView.remoteBranchName,
    sourceBranchName: syncView.sourceBranchName,
    forcePush: false,
    setUpstreamTracking: syncView.setUpstreamTracking ?? false,
  };
}

function runPushSync(
  client: GitClientSeam,
  projectId: string,
  syncView: SyncView,
  context: SyncExecutionContext,
  t: I18nTranslate,
): void {
  const input = pushInput(projectId, syncView);
  if (input === null) return;
  void client
    .pushPreview(input)
    .then((preview) => {
      if (preview.policyOutcome !== "allowed" || preview.preflightBlockingCodes.length > 0) {
        completeSync(
          context,
          blockedOutcome(
            t("gitClientWindow.sync.blocked", {
              reason: preview.policyBlockReason ?? preview.preflightBlockingCodes.join(", "),
            }),
          ),
          false,
        );
        return undefined;
      }
      return client.pushExecute(input);
    })
    .then(
      (result) => {
        if (result === undefined) return;
        const label =
          syncView.action === "push"
            ? t("gitClientWindow.sync.push")
            : t("gitClientWindow.sync.publishUpstream");
        completeSync(
          context,
          syncOutcomeWithMetrics(context, pushOutcomePresentation(label, result, t), t),
          true,
        );
      },
      (error: unknown) => failSync(context, error),
    );
}

interface GitSyncActionOptions {
  readonly activeSummary: GitRepositorySummary | null;
  readonly client: GitClientSeam;
  readonly repositoryRoot: string | undefined;
  readonly selectedPath: string | null;
  readonly syncView: SyncView;
  readonly sequenceRef: RefObject<number>;
  readonly setBusy: Dispatch<SetStateAction<boolean>>;
  readonly setOutcome: Dispatch<SetStateAction<SyncOutcomeView | null>>;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly reconcileEditorBuffers: (root: string) => Promise<void>;
  readonly t: I18nTranslate;
  readonly optionalT: OptionalWidgetTranslate;
}

function useGitSyncAction(options: GitSyncActionOptions): () => void {
  const {
    activeSummary,
    client,
    repositoryRoot,
    selectedPath,
    syncView,
    sequenceRef,
    setBusy,
    setOutcome,
    setError,
    reconcileEditorBuffers,
    t,
    optionalT,
  } = options;
  return useCallback((): void => {
    if (selectedPath === null || syncView.disabled || syncView.action === "blocked") return;
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    setBusy(true);
    setOutcome(null);
    setError(null);
    const context: SyncExecutionContext = {
      sequence,
      startedAt: performance.now(),
      aheadBefore: activeSummary?.ahead ?? 0,
      behindBefore: activeSummary?.behind ?? 0,
      projectId: selectedPath,
      repositoryRoot,
      sequenceRef,
      setBusy,
      setOutcome,
      setError,
      reconcileEditorBuffers,
    };
    runFetchOrPullSync(client, selectedPath, syncView, context, t, optionalT);
    runPushSync(client, selectedPath, syncView, context, t);
  }, [
    activeSummary,
    client,
    repositoryRoot,
    reconcileEditorBuffers,
    optionalT,
    selectedPath,
    sequenceRef,
    setBusy,
    setError,
    setOutcome,
    syncView,
    t,
  ]);
}

interface ActiveGitClientState {
  readonly status: GitRepositoryStatusResponse | null;
  readonly branches: readonly GitBranchListEntry[];
  readonly summary: GitRepositorySummary | null;
  readonly remotes: readonly GitRemoteSummary[];
  readonly history: GitHistoryResponse | null;
}

interface ActiveGitClientStateInput {
  readonly selectedPath: string | null;
  readonly statusProjectKey: string | null;
  readonly status: GitRepositoryStatusResponse | null;
  readonly branchesProjectKey: string | null;
  readonly branches: readonly GitBranchListEntry[];
  readonly summaryProjectKey: string | null;
  readonly summary: GitRepositorySummary | null;
  readonly remotesProjectKey: string | null;
  readonly remotes: readonly GitRemoteSummary[];
  readonly historyProjectKey: string | null;
  readonly history: GitHistoryResponse | null;
}

function activeGitClientState(input: ActiveGitClientStateInput): ActiveGitClientState {
  const path = input.selectedPath;
  return {
    status: path !== null && input.statusProjectKey === path ? input.status : null,
    branches: path !== null && input.branchesProjectKey === path ? input.branches : EMPTY_BRANCHES,
    summary: path !== null && input.summaryProjectKey === path ? input.summary : null,
    remotes: path !== null && input.remotesProjectKey === path ? input.remotes : [],
    history: path !== null && input.historyProjectKey === path ? input.history : null,
  };
}

function selectedHistoryEntry(
  history: GitHistoryResponse | null,
  selectedCommitSha: string | null,
): GitHistoryEntry | null {
  return history?.entries.find((entry) => entry.sha === selectedCommitSha) ?? null;
}

function syncViewForDisplay(
  syncView: SyncView,
  summaryError: string | null,
  t: I18nTranslate,
): SyncView {
  if (summaryError === null) return syncView;
  return {
    action: "blocked",
    label: t("gitClientWindow.sync.unavailable"),
    description: summaryError,
    disabled: true,
  };
}

interface GitRightPaneContentProps {
  readonly mode: RightPaneMode;
  readonly diffPane: ReactNode;
  readonly pullRequestPane: ReactNode;
  readonly mergePane: ReactNode;
  readonly rightPaneRef: RefObject<HTMLDivElement | null>;
  readonly returnToDiff: () => void;
  readonly t: I18nTranslate;
}

function GitRightPaneContent(props: GitRightPaneContentProps): ReactNode {
  if (props.mode === "diff") return props.diffPane;
  const label =
    props.mode === "pull-request"
      ? props.t("gitClientWindow.panel.pullRequest")
      : props.t("gitClientWindow.panel.merge");
  const content = props.mode === "pull-request" ? props.pullRequestPane : props.mergePane;
  return (
    <section ref={props.rightPaneRef} style={PANE_STYLE} aria-label={label}>
      <div style={DIFF_HEADER_STYLE}>
        <button type="button" style={SECONDARY_BTN} onClick={props.returnToDiff}>
          <ChevronRightIcon size={12} style={{ transform: "rotate(180deg)" }} />{" "}
          {props.t("gitClientWindow.action.backToDiff")}
        </button>
      </div>
      {content}
    </section>
  );
}

interface OptionalContentProps {
  readonly visible: boolean;
  readonly children: ReactNode;
}

function OptionalContent({ visible, children }: OptionalContentProps): ReactNode {
  return visible ? children : null;
}

export function GitClientWindow({
  projectId,
  initialPath,
  initialCommit,
  onOpenFiles,
  onOpenEditor,
  onOpenEditorFile,
  updateCfg,
  client = DEFAULT_GIT_CLIENT,
  reconcileEditorBuffers = requestEditorBufferReconciliation,
}: GitClientWindowProps): ReactNode {
  const t = useTranslate();
  const optionalT = useOptionalWidgetTranslate();
  const [repositories, setRepositories] = useState<readonly ProjectWithAvailability[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [reposError, setReposError] = useState<string | null>(null);
  // A persisted project path is only a reconnect candidate. Do not dispatch Git operations until
  // the current project projection proves that it still has live workspace-manifest membership.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [branches, setBranches] = useState<readonly GitBranchListEntry[]>([]);
  const [branchesProjectKey, setBranchesProjectKey] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [summary, setSummary] = useState<GitRepositorySummary | null>(null);
  const [summaryProjectKey, setSummaryProjectKey] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<readonly GitRemoteSummary[]>([]);
  const [remotesProjectKey, setRemotesProjectKey] = useState<string | null>(null);
  const [history, setHistory] = useState<GitHistoryResponse | null>(null);
  const [historyProjectKey, setHistoryProjectKey] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyNextSkip, setHistoryNextSkip] = useState(0);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyLoadMoreError, setHistoryLoadMoreError] = useState<string | null>(null);
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null);
  const [status, setStatus] = useState<GitRepositoryStatusResponse | null>(null);
  const [statusProjectKey, setStatusProjectKey] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusRevision, setStatusRevision] = useState(0);
  const [tab, setTab] = useState<ChangesTab>("changes");
  const [selectedChangePath, setSelectedChangePath] = useState<string | null>(null);
  const [revealRequestId, setRevealRequestId] = useState(0);
  const [diffScope, setDiffScope] = useState<GitDiffScope>("worktree");
  const [commitNonce, setCommitNonce] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"clone" | "open">("clone");
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [worktreeConfirmation, setWorktreeConfirmation] =
    useState<WorktreeMutationConfirmation | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncOutcome, setSyncOutcome] = useState<SyncOutcomeView | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>("diff");
  const [rightPaneAnnouncement, setRightPaneAnnouncement] = useState("");
  const syncSeqRef = useRef(0);
  const historyRequestSequenceRef = useRef(0);
  const repositoryConnectSeqRef = useRef(0);
  const newBranchReturnFocusRef = useRef<HTMLElement | null>(null);
  const worktreeConfirmationReturnFocusRef = useRef<HTMLElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const diffPaneRef = useRef<HTMLDivElement | null>(null);
  const landedPathRef = useRef<string | null>(null);
  const landedCommitRef = useRef<string | null>(null);
  const completedCommitLandingRef = useRef<string | null>(null);

  // Two independent governed-mutation flows: one for staging, one for the commit composer. Each
  // carries its own stale-guard so concurrent stage clicks and a later commit do not cross results.
  const projectKey = selectedPath ?? "";
  const mutationRepositoryRoot =
    statusProjectKey === selectedPath && status?.available === true
      ? (status.repositoryRoot ?? status.root)
      : undefined;
  const branchActions = useGitActions(client, projectKey, mutationRepositoryRoot);
  const staging = useGitActions(client, projectKey, mutationRepositoryRoot);
  const commit = useGitActions(client, projectKey, mutationRepositoryRoot);
  const resetBranchActions = branchActions.reset;
  const resetStaging = staging.reset;
  const resetCommit = commit.reset;

  const openNewBranchDialog = useCallback((trigger: HTMLButtonElement): void => {
    newBranchReturnFocusRef.current = trigger;
    setNewBranchOpen(true);
  }, []);

  const closeNewBranchDialog = useCallback((): void => {
    setNewBranchOpen(false);
    const target = newBranchReturnFocusRef.current;
    newBranchReturnFocusRef.current = null;
    restoreModalTriggerFocus(target);
  }, []);

  const loadRepositories = useCallback((): void => {
    setReposLoading(true);
    setReposError(null);
    void client.listRepositories().then(
      (res) => {
        setRepositories(res.projects);
        setReposLoading(false);
      },
      (err: unknown) => {
        setRepositories([]);
        setReposLoading(false);
        setReposError(formatGitError(err));
      },
    );
  }, [client]);

  useEffect(() => {
    loadRepositories();
  }, [loadRepositories]);

  useRightPaneFocus(rightPaneMode, rightPaneRef);

  // Repository change: reset the per-repo view and invalidate any in-flight mutations so a late
  // response from the previous repository cannot surface under the newly selected one.
  useEffect(() => {
    resetStaging();
    resetCommit();
    resetBranchActions();
    syncSeqRef.current += 1;
    historyRequestSequenceRef.current += 1;
    setSyncOutcome(null);
    setSyncError(null);
    setSyncBusy(false);
    setSelectedChangePath(null);
    setDiffScope("worktree");
    setRightPaneMode("diff");
    setRightPaneAnnouncement("");
    setHistory(null);
    setHistoryProjectKey(null);
    setHistoryLoading(false);
    setHistoryError(null);
    setHistoryNextSkip(0);
    setHistoryLoadingMore(false);
    setHistoryLoadMoreError(null);
    setSelectedCommitSha(null);
    setWorktreeConfirmation(null);
  }, [selectedPath, resetStaging, resetCommit, resetBranchActions]);

  useEffect(() => {
    if (selectedPath === null) {
      setBranches([]);
      setBranchesProjectKey(null);
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    void client.listBranches(selectedPath).then(
      (res) => {
        if (cancelled) return;
        setBranches(res.available ? res.branches : []);
        setBranchesProjectKey(selectedPath);
        setBranchesLoading(false);
      },
      () => {
        if (cancelled) return;
        setBranches([]);
        setBranchesProjectKey(selectedPath);
        setBranchesLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, selectedPath, statusRevision]);

  // Repository summary carries upstream/ahead/behind/remotes for the #1576 sync control.
  useEffect(() => {
    if (selectedPath === null) {
      setSummary(null);
      setSummaryProjectKey(null);
      setSummaryError(null);
      return;
    }
    let cancelled = false;
    setSummaryLoading(true);
    setSummaryError(null);
    void client.getSummary(selectedPath).then(
      (res) => {
        if (cancelled) return;
        setSummary(res);
        setSummaryProjectKey(selectedPath);
        setSummaryLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setSummary(null);
        setSummaryProjectKey(null);
        setSummaryLoading(false);
        setSummaryError(formatGitError(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, selectedPath, statusRevision]);

  // Dedicated remotes data may contain provider URLs for safe owner/repo inference. The compact
  // summary remains alias-only so sync state never needs URL metadata.
  useEffect(() => {
    if (selectedPath === null) {
      setRemotes([]);
      setRemotesProjectKey(null);
      return;
    }
    let cancelled = false;
    void client.getRemotes(selectedPath).then(
      (res) => {
        if (cancelled) return;
        setRemotes(res.available ? res.remotes : []);
        setRemotesProjectKey(selectedPath);
      },
      () => {
        if (cancelled) return;
        setRemotes([]);
        setRemotesProjectKey(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, selectedPath]);

  // History loads independently from status; selecting the first commit gives the detail pane a
  // deterministic populated state while preserving user selection when it still exists.
  useEffect(() => {
    historyRequestSequenceRef.current += 1;
    const requestSequence = historyRequestSequenceRef.current;
    if (selectedPath === null) {
      setHistory(null);
      setHistoryProjectKey(null);
      setHistoryError(null);
      setSelectedCommitSha(null);
      setHistoryNextSkip(0);
      setHistoryLoadingMore(false);
      setHistoryLoadMoreError(null);
      return;
    }
    if (tab !== "history") {
      setHistoryLoading(false);
      setHistoryLoadingMore(false);
      setHistoryLoadMoreError(null);
      return;
    }
    let cancelled = false;
    setHistory(null);
    setHistoryProjectKey(null);
    setHistoryLoading(true);
    setHistoryError(null);
    setHistoryNextSkip(0);
    setHistoryLoadingMore(false);
    setHistoryLoadMoreError(null);
    void client.getHistory({ root: selectedPath, limit: HISTORY_PAGE_SIZE, skip: 0 }).then(
      (res) => {
        if (cancelled || historyRequestSequenceRef.current !== requestSequence) return;
        setHistory(res);
        setHistoryProjectKey(selectedPath);
        setHistoryLoading(false);
        setHistoryNextSkip(res.entries.length);
        const commitLandingKey =
          initialCommit === undefined ? null : `${selectedPath}\u0000${initialCommit}`;
        const requestedCommit =
          commitLandingKey !== null && completedCommitLandingRef.current !== commitLandingKey
            ? initialCommit
            : undefined;
        const hasRequestedCommit =
          requestedCommit === undefined ||
          res.entries.some((entry) => entry.sha === requestedCommit);
        if (commitLandingKey !== null) completedCommitLandingRef.current = commitLandingKey;
        setHistoryError(hasRequestedCommit ? null : t("gitClientWindow.history.commitUnavailable"));
        setSelectedCommitSha(
          selectedHistoryCommitResolver(res.entries, requestedCommit, hasRequestedCommit),
        );
      },
      () => {
        if (cancelled || historyRequestSequenceRef.current !== requestSequence) return;
        setHistory(null);
        setHistoryProjectKey(null);
        setHistoryLoading(false);
        setHistoryError(t("gitClientWindow.history.loadFailed"));
      },
    );
    return () => {
      cancelled = true;
      if (historyRequestSequenceRef.current === requestSequence) {
        historyRequestSequenceRef.current += 1;
      }
    };
  }, [client, initialCommit, selectedPath, statusRevision, t, tab]);

  const loadMoreHistory = useCallback((): void => {
    if (selectedPath === null || history === null || !history.truncated || historyLoadingMore) {
      return;
    }
    const requestSequence = historyRequestSequenceRef.current;
    const skip = historyNextSkip;
    setHistoryLoadingMore(true);
    setHistoryLoadMoreError(null);
    void client.getHistory({ root: selectedPath, limit: HISTORY_PAGE_SIZE, skip }).then(
      (page) => {
        if (historyRequestSequenceRef.current !== requestSequence) return;
        if (!page.available) {
          setHistoryLoadingMore(false);
          setHistoryLoadMoreError(t("gitClientWindow.history.loadMoreFailed"));
          return;
        }
        setHistory((current) => (current === null ? null : appendHistoryPage(current, page)));
        setHistoryNextSkip(skip + page.entries.length);
        setHistoryLoadingMore(false);
      },
      () => {
        if (historyRequestSequenceRef.current !== requestSequence) return;
        setHistoryLoadingMore(false);
        setHistoryLoadMoreError(t("gitClientWindow.history.loadMoreFailed"));
      },
    );
  }, [client, history, historyLoadingMore, historyNextSkip, selectedPath, t]);

  // Status load, re-run on every mutation (statusRevision bump). Prunes a selected change that no
  // longer exists (e.g. after a commit) so the diff pane returns to its empty state.
  useEffect(() => {
    if (selectedPath === null) {
      setStatus(null);
      setStatusProjectKey(null);
      setStatusError(null);
      return;
    }
    let cancelled = false;
    setStatusLoading(true);
    setStatusError(null);
    void client.getStatus(selectedPath).then(
      (res) => {
        if (cancelled) return;
        setStatus(res);
        setStatusProjectKey(selectedPath);
        setStatusLoading(false);
        setSelectedChangePath(selectedChangeResolver(res.changes, setDiffScope));
      },
      (err: unknown) => {
        if (cancelled) return;
        setStatus(null);
        setStatusProjectKey(null);
        setStatusLoading(false);
        setStatusError(formatGitError(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, selectedPath, statusRevision]);

  useEffect((): (() => void) => {
    const onRepositoryStateInvalidated = (event: Event): void => {
      const invalidatedRoots = gitRepositoryStateInvalidationRoots(event);
      const repositoryRoot = mutationRepositoryRoot ?? null;
      if (
        !invalidatedRoots.some(
          (root): boolean =>
            root === selectedPath || (repositoryRoot !== null && root === repositoryRoot),
        )
      ) {
        return;
      }
      setStatusRevision((revision): number => revision + 1);
    };
    window.addEventListener(GIT_REPOSITORY_STATE_INVALIDATED_EVENT, onRepositoryStateInvalidated);
    return (): void =>
      window.removeEventListener(
        GIT_REPOSITORY_STATE_INVALIDATED_EVENT,
        onRepositoryStateInvalidated,
      );
  }, [mutationRepositoryRoot, selectedPath]);

  useEffect((): (() => void) => {
    const onWorkspaceFileMutated = (event: Event): void => {
      const mutationRoots = workspaceFileMutationRoots(event);
      const repositoryRoot = mutationRepositoryRoot ?? null;
      if (
        !mutationRoots.some(
          (root): boolean =>
            root === selectedPath || (repositoryRoot !== null && root === repositoryRoot),
        )
      ) {
        return;
      }
      setStatusRevision((revision): number => revision + 1);
    };
    window.addEventListener(WORKSPACE_FILE_MUTATED_EVENT, onWorkspaceFileMutated);
    return (): void =>
      window.removeEventListener(WORKSPACE_FILE_MUTATED_EVENT, onWorkspaceFileMutated);
  }, [mutationRepositoryRoot, selectedPath]);

  // After a successful commit, refresh status and remount the composer to clear its fields.
  const commitOutcome = commit.flow.outcome;
  useEffect(() => {
    if (commitOutcome?.status === "succeeded") {
      setCommitNonce((n) => n + 1);
    }
  }, [commitOutcome]);

  const branchOutcome = branchActions.flow.outcome;
  useEffect(() => {
    if (branchOutcome?.status === "succeeded") {
      closeNewBranchDialog();
    }
  }, [branchOutcome, closeNewBranchDialog]);

  const applyRepositorySelection = useCallback(
    (path: string): void => {
      setSelectedPath(path);
      updateCfg?.({ projectPath: path });
    },
    [updateCfg],
  );

  const applyConnectedRepository = useCallback(
    (project: ProjectWithAvailability): boolean => {
      if (project.workspaceAvailable !== true) {
        setReposLoading(false);
        setReposError(optionalT("gitClientWindow.repository.workspaceUnavailable"));
        return false;
      }
      setReposError(null);
      applyRepositorySelection(project.path);
      return true;
    },
    [applyRepositorySelection, optionalT],
  );

  const reconnectRepository = useCallback(
    (path: string): void => {
      const requestSequence = repositoryConnectSeqRef.current + 1;
      repositoryConnectSeqRef.current = requestSequence;
      setReposLoading(true);
      setReposError(null);
      void client.reconnectRepository(path).then(
        (response): void => {
          if (requestSequence !== repositoryConnectSeqRef.current) return;
          if (applyConnectedRepository(response.project)) loadRepositories();
        },
        (error: unknown): void => {
          if (requestSequence !== repositoryConnectSeqRef.current) return;
          setReposLoading(false);
          setReposError(
            optionalT("gitClientWindow.repository.reconnectFailed", {
              detail: formatGitError(error),
            }),
          );
        },
      );
    },
    [applyConnectedRepository, client, loadRepositories, optionalT],
  );

  const onRepositoryAdded = useCallback(
    (project: ProjectWithAvailability): void => {
      // Create/clone owns manifest establishment. Reconnect through the existing-project route
      // before selection so the Git window consumes a fresh server membership projection rather
      // than trusting the mutation response or attempting duplicate project creation.
      reconnectRepository(project.path);
    },
    [reconnectRepository],
  );

  useEffect(() => {
    if (reposLoading || reposError !== null) return;
    const configuredPath = projectId !== undefined && projectId !== "" ? projectId : null;
    const requestedPath = selectedPath ?? configuredPath;
    if (requestedPath === null) return;
    const selected = repositories.find((repository) => repository.path === requestedPath);
    if (selected?.workspaceAvailable === true) {
      if (selectedPath !== requestedPath) setSelectedPath(requestedPath);
      return;
    }
    setSelectedPath(null);
    updateCfg?.({ projectPath: "" });
    setReposError(optionalT("gitClientWindow.repository.workspaceUnavailable"));
  }, [optionalT, projectId, repositories, reposError, reposLoading, selectedPath, updateCfg]);

  const active = activeGitClientState({
    selectedPath,
    statusProjectKey,
    status,
    branchesProjectKey,
    branches,
    summaryProjectKey,
    summary,
    remotesProjectKey,
    remotes,
    historyProjectKey,
    history,
  });
  const activeStatus = active.status;
  const activeBranches = active.branches;
  const activeSummary = active.summary;
  const activeRemotes = active.remotes;
  const activeHistory = active.history;
  const selectedCommit = selectedHistoryEntry(activeHistory, selectedCommitSha);

  useInitialChangeLanding({
    selectedPath,
    initialPath,
    activeStatus,
    landedPathRef,
    setTab,
    setSelectedCommitSha,
    setSelectedChangePath,
    setDiffScope,
  });
  useInitialCommitLanding({
    selectedPath,
    initialCommit,
    landedCommitRef,
    setTab,
    setSelectedCommitSha,
  });

  const selectChange = useCallback(
    (path: string): void => {
      setSelectedChangePath(path);
      setRevealRequestId((value) => value + 1);
      const change = activeStatus?.changes.find((c) => c.path === path);
      if (change !== undefined) setDiffScope(preferredDiffScopeForChange(change));
    },
    [activeStatus],
  );

  const revealEditorFile = useCallback(
    (path: string, line: number): void => {
      if (selectedPath === null || onOpenEditorFile === undefined) return;
      onOpenEditorFile({
        root: selectedPath,
        path,
        lineStart: line,
        lineEnd: line,
      });
    },
    [onOpenEditorFile, selectedPath],
  );

  const stageFile = useCallback(
    (change: GitChangedFile): void => {
      if (selectedPath === null) return;
      staging.runMutation(() =>
        client.stage({
          projectId: selectedPath,
          pathspecs: [change.path],
          includeUntracked: change.untracked,
        }),
      );
    },
    [client, selectedPath, staging],
  );

  const unstageFile = useCallback(
    (change: GitChangedFile): void => {
      if (selectedPath === null) return;
      staging.runMutation(() =>
        client.unstage({ projectId: selectedPath, pathspecs: [change.path] }),
      );
    },
    [client, selectedPath, staging],
  );

  const stageAll = useCallback((): void => {
    if (selectedPath === null || activeStatus === null || activeStatus.truncated) return;
    const pathspecs = activeStatus.changes
      .filter((c) => c.unstaged || c.untracked)
      .map((c) => c.path);
    if (pathspecs.length === 0) return;
    const includeUntracked = activeStatus.changes.some((c) => c.untracked);
    staging.runMutation(() =>
      client.stage({ projectId: selectedPath, pathspecs, includeUntracked }),
    );
  }, [activeStatus, client, selectedPath, staging]);

  const unstageAll = useCallback((): void => {
    if (selectedPath === null || activeStatus === null || activeStatus.truncated) return;
    const pathspecs = activeStatus.changes.filter((c) => c.staged).map((c) => c.path);
    if (pathspecs.length === 0) return;
    staging.runMutation(() => client.unstage({ projectId: selectedPath, pathspecs }));
  }, [activeStatus, client, selectedPath, staging]);

  const commitChanges = useCallback(
    (message: string): void => {
      if (selectedPath === null) return;
      commit.runMutation(() => client.commitExecute({ projectId: selectedPath, message }));
    },
    [client, commit, selectedPath],
  );

  const switchBranch = useCallback(
    (branchName: string, trigger: HTMLButtonElement): void => {
      if (selectedPath === null) return;
      worktreeConfirmationReturnFocusRef.current = trigger;
      setWorktreeConfirmation({ kind: "branch-switch", branchName });
    },
    [selectedPath],
  );

  const runConfirmedBranchSwitch = useCallback(
    (branchName: string): void => {
      if (selectedPath === null) return;
      branchActions.runMutation(async () => {
        const result = await client.branchSwitch({ projectId: selectedPath, branchName });
        if (result.status !== "succeeded") return result;
        try {
          await reconcileEditorBuffers(selectedPath);
          return result;
        } catch {
          return {
            ...result,
            status: "recovery-required",
            executionErrorCode: "editor-buffer-reconciliation-failed",
          };
        }
      });
    },
    [branchActions, client, reconcileEditorBuffers, selectedPath],
  );

  const createBranch = useCallback(
    ({
      branchName,
      baseBranchName,
    }: {
      readonly branchName: string;
      readonly baseBranchName: string;
    }): void => {
      if (selectedPath === null) return;
      const baseBranch = activeBranches.find((branch) => branch.name === baseBranchName);
      if (baseBranch === undefined) return;
      branchActions.runMutation(async () => {
        const created = await client.branchCreate({
          projectId: selectedPath,
          branchName,
          baseBranchName,
          startPointRefHash: baseBranch.headRefHash,
        });
        if (created.status !== "succeeded") return created;
        const switched = await client.branchSwitch({ projectId: selectedPath, branchName });
        if (switched.status !== "succeeded") return switched;
        try {
          await reconcileEditorBuffers(selectedPath);
          return { ...switched, actionKind: "branch-create" };
        } catch {
          return {
            ...switched,
            status: "recovery-required",
            actionKind: "branch-create",
            executionErrorCode: "editor-buffer-reconciliation-failed",
          };
        }
      });
    },
    [activeBranches, branchActions, client, reconcileEditorBuffers, selectedPath],
  );

  const syncView = deriveSyncView(activeSummary, summaryLoading);

  const runSync = useGitSyncAction({
    activeSummary,
    client,
    repositoryRoot:
      activeStatus?.available === true
        ? (activeStatus.repositoryRoot ?? activeStatus.root)
        : undefined,
    selectedPath,
    syncView,
    sequenceRef: syncSeqRef,
    setBusy: setSyncBusy,
    setOutcome: setSyncOutcome,
    setError: setSyncError,
    reconcileEditorBuffers,
    t,
    optionalT,
  });

  const requestSync = useCallback((): void => {
    if (syncView.action === "pull") {
      worktreeConfirmationReturnFocusRef.current = document.activeElement as HTMLElement | null;
      setWorktreeConfirmation({ kind: "pull" });
      return;
    }
    runSync();
  }, [runSync, syncView.action]);

  const closeWorktreeConfirmation = useCallback((): void => {
    setWorktreeConfirmation(null);
    const target = worktreeConfirmationReturnFocusRef.current;
    worktreeConfirmationReturnFocusRef.current = null;
    restoreModalTriggerFocus(target);
  }, []);

  const confirmWorktreeMutation = useCallback((): void => {
    const request = worktreeConfirmation;
    closeWorktreeConfirmation();
    if (request?.kind === "branch-switch") {
      runConfirmedBranchSwitch(request.branchName);
    } else if (request?.kind === "pull") {
      runSync();
    }
  }, [closeWorktreeConfirmation, runConfirmedBranchSwitch, runSync, worktreeConfirmation]);

  const openRightPane = useCallback(
    (mode: Exclude<RightPaneMode, "diff">): void => {
      if (selectedPath === null) return;
      setRightPaneMode(mode);
      setRightPaneAnnouncement(
        mode === "pull-request"
          ? t("gitClientWindow.panel.pullRequestOpened")
          : t("gitClientWindow.panel.mergeOpened"),
      );
    },
    [selectedPath, t],
  );

  const returnToDiff = useCallback((): void => {
    setRightPaneMode("diff");
    setRightPaneAnnouncement(t("gitClientWindow.panel.diffOpened"));
    window.requestAnimationFrame(() => {
      // The diff pane's scroll region is a native <section> (#2721): its region role is
      // implicit, so a [role="region"] attribute selector no longer matches it.
      const diffRegion = diffPaneRef.current?.querySelector('section[aria-label="Diff"]');
      if (diffRegion instanceof HTMLElement) diffRegion.focus();
    });
  }, [t]);

  const visibleStagingOutcome = staging.flow.outcome;
  const currentBranch = activeStatus?.branch ?? activeSummary?.branch;
  const inferredOwnerAndRepo = inferOwnerAndRepo(activeRemotes);
  const inferredBaseBranch = inferBaseBranch(currentBranch, activeSummary);

  return (
    <div style={WORKSPACE_STYLE} aria-label="Git">
      <h2 className="rv-sr-only">Git</h2>
      <p
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
        }}
      >
        {rightPaneAnnouncement}
      </p>
      <RepositoryToolbar
        repositories={repositories}
        selectedPath={selectedPath}
        branches={activeBranches}
        branchesLoading={branchesLoading}
        status={activeStatus}
        branchBusy={branchActions.flow.busy}
        syncView={syncViewForDisplay(syncView, summaryError, t)}
        syncBusy={syncBusy}
        syncOutcome={syncOutcome}
        syncError={syncError}
        onSelectRepository={reconnectRepository}
        onSwitchBranch={switchBranch}
        onCreateBranch={openNewBranchDialog}
        onRunSync={requestSync}
        onOpenEditor={onOpenEditor}
        onOpenFiles={onOpenFiles}
      />
      {/* A rejected branch switch must never render as silent success: the New Branch dialog
          shows its own copy of this outcome while it is open (the create-then-switch chain runs
          under the same flow), so this banner is suppressed then to avoid showing the same
          rejection twice. */}
      {!newBranchOpen &&
      (branchActions.flow.error !== null ||
        (branchOutcome !== null && branchOutcome.status !== "succeeded")) ? (
        <div style={{ padding: "10px 18px" }}>
          <MutationOutcome
            outcome={branchOutcome}
            error={branchActions.flow.error}
            testid="git-branch-outcome"
          />
        </div>
      ) : null}
      <div style={BODY_STYLE}>
        {selectedPath === null ? (
          <ConnectPanel
            repositories={repositories}
            loading={reposLoading}
            error={reposError}
            onSelect={reconnectRepository}
            onConnect={() => {
              setDialogMode("open");
              setDialogOpen(true);
            }}
            onClone={() => {
              setDialogMode("clone");
              setDialogOpen(true);
            }}
          />
        ) : (
          <>
            <div style={SIDEBAR_STYLE}>
              <ChangesPane
                tab={tab}
                onTabChange={setTab}
                status={activeStatus}
                statusLoading={statusLoading}
                statusError={statusError}
                selectedChangePath={selectedChangePath}
                onSelectChange={selectChange}
                onStageFile={stageFile}
                onUnstageFile={unstageFile}
                onStageAll={stageAll}
                onUnstageAll={unstageAll}
                stagingBusy={staging.flow.busy}
                stagingOutcome={visibleStagingOutcome}
                stagingError={staging.flow.error}
                history={activeHistory}
                historyLoading={historyLoading}
                historyError={historyError}
                historyLoadingMore={historyLoadingMore}
                historyLoadMoreError={historyLoadMoreError}
                onLoadMoreHistory={loadMoreHistory}
                selectedCommitSha={selectedCommitSha}
                onSelectCommit={(entry) => setSelectedCommitSha(entry.sha)}
                commitComposer={
                  <CommitComposer
                    key={`${selectedPath}:${commitNonce.toString()}`}
                    projectId={selectedPath}
                    branchName={currentBranch}
                    stagedFileCount={activeStatus?.stagedCount ?? 0}
                    busy={commit.flow.busy}
                    outcome={commit.flow.outcome}
                    error={commit.flow.error}
                    preview={commit.preview}
                    previewDraft={commit.previewDraft}
                    previewError={commit.previewError}
                    onPreview={commit.runPreview}
                    onCommit={commitChanges}
                    onCreatePullRequest={() => openRightPane("pull-request")}
                    onMerge={() => openRightPane("merge")}
                  />
                }
              />
            </div>
            <GitRightPaneContent
              mode={rightPaneMode}
              rightPaneRef={rightPaneRef}
              returnToDiff={returnToDiff}
              t={t}
              diffPane={
                <div ref={diffPaneRef} style={{ minWidth: 0, minHeight: 0, display: "contents" }}>
                  <DiffPane
                    client={client}
                    repositoryRoot={selectedPath}
                    selectedChangePath={selectedChangePath}
                    selectedCommit={tab === "history" ? selectedCommit : null}
                    scope={diffScope}
                    onScopeChange={setDiffScope}
                    revealRequestId={revealRequestId}
                    onRevealFile={revealEditorFile}
                    revision={statusRevision}
                  />
                </div>
              }
              pullRequestPane={
                <GovernedPullRequestCard
                  projectId={selectedPath}
                  headBranchName={currentBranch}
                  ownerAndRepo={inferredOwnerAndRepo}
                  baseBranchName={inferredBaseBranch}
                  client={client}
                />
              }
              mergePane={
                <GovernedMergeCard
                  projectId={selectedPath}
                  headBranchName={currentBranch}
                  ownerAndRepo={inferredOwnerAndRepo}
                  baseBranchName={inferredBaseBranch}
                  client={client}
                />
              }
            />
          </>
        )}
      </div>
      <OptionalContent visible={dialogOpen}>
        <AddRepositoryDialog
          client={client}
          initialMode={dialogMode}
          onAdded={onRepositoryAdded}
          onClose={() => setDialogOpen(false)}
        />
      </OptionalContent>
      <OptionalContent visible={newBranchOpen}>
        <NewBranchDialog
          branches={activeBranches}
          currentBranch={
            activeStatus?.branch ?? activeBranches.find((branch) => branch.current)?.name ?? ""
          }
          busy={branchActions.flow.busy}
          outcome={branchOutcome}
          error={branchActions.flow.error}
          onCreate={createBranch}
          onClose={closeNewBranchDialog}
        />
      </OptionalContent>
      {worktreeConfirmation === null ? null : (
        <WorktreeMutationConfirmDialog
          request={worktreeConfirmation}
          onCancel={closeWorktreeConfirmation}
          onConfirm={confirmWorktreeMutation}
        />
      )}
    </div>
  );
}
