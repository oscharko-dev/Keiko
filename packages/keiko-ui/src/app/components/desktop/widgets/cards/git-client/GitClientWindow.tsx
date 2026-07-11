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
import type { Dispatch, MutableRefObject, ReactNode, RefObject, SetStateAction } from "react";
import type { GitBranchListEntry } from "@/lib/api";
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
import { deriveSyncView } from "./SyncControl";
import {
  BODY_STYLE,
  DIFF_HEADER_STYLE,
  PANE_STYLE,
  SECONDARY_BTN,
  SIDEBAR_STYLE,
  WORKSPACE_STYLE,
} from "./git-client-styles";

const EMPTY_BRANCHES: readonly GitBranchListEntry[] = [];
const EMPTY_REMOTES: readonly GitRemoteSummary[] = [];

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
}

type RightPaneMode = "diff" | "pull-request" | "merge";

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

// Resolves the next selected history commit after a history load: honours a pending commit
// deep-link, falls back to keeping the current selection if it still exists, then the newest entry.
function resolveSelectedCommitSha(
  entries: readonly GitHistoryEntry[],
  requestedCommit: string | undefined,
  hasRequestedCommit: boolean,
  current: string | null,
): string | null {
  if (entries.length === 0) return null;
  if (requestedCommit !== undefined) return hasRequestedCommit ? requestedCommit : null;
  if (current !== null && entries.some((entry) => entry.sha === current)) return current;
  return entries[0]?.sha ?? null;
}

// Re-validates the selected change path after a status load and, when it still exists, renormalizes
// the diff scope for the (possibly updated) staged/unstaged state of that change.
function applyChangePathSelection(
  changes: readonly GitChangedFile[],
  prev: string | null,
  setDiffScope: Dispatch<SetStateAction<GitDiffScope>>,
): string | null {
  if (prev === null) return null;
  const selectedChange = changes.find((c) => c.path === prev);
  if (selectedChange === undefined) return null;
  setDiffScope((current) => normalizeDiffScopeForChange(current, selectedChange));
  return prev;
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

// Scopes a per-repository data slice (status/branches/summary/remotes/history) to the currently
// selected repository: a stale response for a previously selected repository must never surface
// under the newly selected one, so each slice carries the project key it was loaded for.
function scopedToSelectedProject<T>(
  selectedPath: string | null,
  loadedForProjectKey: string | null,
  value: T,
  fallback: T,
): T {
  return selectedPath !== null && loadedForProjectKey === selectedPath ? value : fallback;
}

interface PathLanding {
  readonly landingKey: string;
  readonly change: GitChangedFile;
}

// Resolves an Editor/Files/Runtime deep-link landing onto a specific changed file: only fires once
// per (repository, path) pair (guarded by the caller's landedKey ref) and only once that path is
// confirmed present in the freshly loaded status.
function resolvePathLanding(
  selectedPath: string | null,
  initialPath: string | undefined,
  activeStatus: GitRepositoryStatusResponse | null,
  landedKey: string | null,
): PathLanding | null {
  if (selectedPath === null || initialPath === undefined || activeStatus === null) return null;
  const landingKey = `${selectedPath}\u0000${initialPath}`;
  if (landedKey === landingKey) return null;
  const change = activeStatus.changes.find((entry) => entry.path === initialPath);
  if (change === undefined) return null;
  return { landingKey, change };
}

interface CommitLanding {
  readonly landingKey: string;
  readonly commit: string;
}

// Resolves a blame/history deep-link landing onto a specific commit: only fires once per
// (repository, commit) pair, mirroring resolvePathLanding above.
function resolveCommitLanding(
  selectedPath: string | null,
  initialCommit: string | undefined,
  landedKey: string | null,
): CommitLanding | null {
  if (selectedPath === null || initialCommit === undefined) return null;
  const landingKey = `${selectedPath}\u0000${initialCommit}`;
  if (landedKey === landingKey) return null;
  return { landingKey, commit: initialCommit };
}

interface SyncMetrics {
  readonly startedAt: number;
  readonly aheadBefore: number;
  readonly behindBefore: number;
}

interface SyncCallbacks {
  readonly done: (message: string) => void;
  readonly fail: (err: unknown) => void;
}

// GEN-PERF-WIDGET-006 — formats sync duration + the ahead/behind repository-state delta so a slow
// round-trip is observable and the user sees what the sync accomplished. The pre-sync counts come
// from the summary the widget already holds; the post-sync summary refresh updates the panel.
function formatSyncMetrics(metrics: SyncMetrics, label: string): string {
  const elapsedSeconds = Math.round((performance.now() - metrics.startedAt) / 100) / 10;
  const delta =
    metrics.aheadBefore > 0
      ? ` (ahead ${metrics.aheadBefore.toString()})`
      : ` (behind ${metrics.behindBefore.toString()})`;
  return `${label} in ${elapsedSeconds.toString()}s${delta}`;
}

// Builds the done/fail callbacks for a single sync attempt: both are guarded by the stale-sync
// sequence ref so a superseded sync (repository switched, or a newer sync started) cannot surface
// its result after the fact.
function createSyncCallbacks(
  syncSeqRef: MutableRefObject<number>,
  seq: number,
  setSyncBusy: Dispatch<SetStateAction<boolean>>,
  setSyncOutcome: Dispatch<SetStateAction<string | null>>,
  setSyncError: Dispatch<SetStateAction<string | null>>,
  setStatusRevision: Dispatch<SetStateAction<number>>,
): SyncCallbacks {
  return {
    done: (message) => {
      if (syncSeqRef.current !== seq) return;
      setSyncBusy(false);
      setSyncOutcome(message);
      setStatusRevision((r) => r + 1);
    },
    fail: (err) => {
      if (syncSeqRef.current !== seq) return;
      setSyncBusy(false);
      setSyncError(formatGitError(err));
    },
  };
}

// Fetch/Pull sync: preview then execute against the derived sync view's remote alias.
function runFetchOrPullSync(
  client: GitClientSeam,
  selectedPath: string,
  action: "fetch" | "pull",
  remoteAlias: string | undefined,
  metrics: SyncMetrics,
  callbacks: SyncCallbacks,
): void {
  void client
    .syncPreview({ operation: action, projectId: selectedPath, remote: remoteAlias })
    .then((preview) => {
      if (!preview.executable) {
        callbacks.done(`Blocked: ${preview.blockReason ?? "sync unavailable"}`);
        return undefined;
      }
      return client.syncExecute({
        operation: action,
        projectId: selectedPath,
        remote: remoteAlias,
      });
    })
    .then((res) => {
      if (res === undefined) return;
      callbacks.done(
        formatSyncMetrics(metrics, `${action === "fetch" ? "Fetch" : "Pull"}: ${res.status}`),
      );
    }, callbacks.fail);
}

// Push/Publish-upstream sync: preview against governed push policy then execute.
function runPushSync(
  client: GitClientSeam,
  selectedPath: string,
  action: "push" | "publish-upstream",
  remoteAlias: string,
  remoteBranchName: string,
  sourceBranchName: string,
  setUpstreamTracking: boolean,
  metrics: SyncMetrics,
  callbacks: SyncCallbacks,
): void {
  const input = {
    projectId: selectedPath,
    remoteAlias,
    remoteBranchName,
    sourceBranchName,
    forcePush: false,
    setUpstreamTracking,
  };
  void client
    .pushPreview(input)
    .then((preview) => {
      if (preview.policyOutcome !== "allowed" || preview.preflightBlockingCodes.length > 0) {
        callbacks.done(
          `Blocked: ${preview.policyBlockReason ?? preview.preflightBlockingCodes.join(", ")}`,
        );
        return undefined;
      }
      return client.pushExecute(input);
    })
    .then((res) => {
      if (res === undefined) return;
      callbacks.done(
        formatSyncMetrics(
          metrics,
          `${action === "push" ? "Push" : "Publish upstream"}: ${res.status}`,
        ),
      );
    }, callbacks.fail);
}

interface GitClientRightPaneProps {
  readonly rightPaneMode: RightPaneMode;
  readonly diffPaneRef: RefObject<HTMLDivElement>;
  readonly rightPaneRef: RefObject<HTMLDivElement>;
  readonly client: GitClientSeam;
  readonly repositoryRoot: string;
  readonly selectedChangePath: string | null;
  readonly selectedCommit: GitHistoryEntry | null;
  readonly tab: ChangesTab;
  readonly diffScope: GitDiffScope;
  readonly onScopeChange: Dispatch<SetStateAction<GitDiffScope>>;
  readonly revealRequestId: number;
  readonly onRevealFile: (path: string, line: number) => void;
  readonly statusRevision: number;
  readonly onReturnToDiff: () => void;
  readonly currentBranch: string | undefined;
  readonly ownerAndRepo: string | undefined;
  readonly baseBranchName: string;
}

// Right-pane routing: the diff view, or an embedded Pull Request / Merge panel opened from the
// commit composer's entry points (Issue #1576/#1577). Extracted so the diff-vs-panel and
// PR-vs-Merge decisions are scored separately from the GitClientWindow component that owns the
// underlying state.
function GitClientRightPane({
  rightPaneMode,
  diffPaneRef,
  rightPaneRef,
  client,
  repositoryRoot,
  selectedChangePath,
  selectedCommit,
  tab,
  diffScope,
  onScopeChange,
  revealRequestId,
  onRevealFile,
  statusRevision,
  onReturnToDiff,
  currentBranch,
  ownerAndRepo,
  baseBranchName,
}: GitClientRightPaneProps): ReactNode {
  if (rightPaneMode === "diff") {
    return (
      <div ref={diffPaneRef} style={{ minWidth: 0, minHeight: 0, display: "contents" }}>
        <DiffPane
          client={client}
          repositoryRoot={repositoryRoot}
          selectedChangePath={selectedChangePath}
          selectedCommit={tab === "history" ? selectedCommit : null}
          scope={diffScope}
          onScopeChange={onScopeChange}
          revealRequestId={revealRequestId}
          onRevealFile={onRevealFile}
          revision={statusRevision}
        />
      </div>
    );
  }
  return (
    <div
      ref={rightPaneRef}
      style={PANE_STYLE}
      role="region"
      aria-label={rightPaneMode === "pull-request" ? "Pull Request" : "Merge"}
    >
      <div style={DIFF_HEADER_STYLE}>
        <button type="button" style={SECONDARY_BTN} onClick={onReturnToDiff}>
          <Icons.chevronR size={12} style={{ transform: "rotate(180deg)" }} /> Back to diff
        </button>
      </div>
      {rightPaneMode === "pull-request" ? (
        <GovernedPullRequestCard
          projectId={repositoryRoot}
          headBranchName={currentBranch}
          ownerAndRepo={ownerAndRepo}
          baseBranchName={baseBranchName}
          client={client}
        />
      ) : (
        <GovernedMergeCard
          projectId={repositoryRoot}
          headBranchName={currentBranch}
          ownerAndRepo={ownerAndRepo}
          baseBranchName={baseBranchName}
          client={client}
        />
      )}
    </div>
  );
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
}: GitClientWindowProps): ReactNode {
  const [repositories, setRepositories] = useState<readonly ProjectWithAvailability[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    projectId !== undefined && projectId !== "" ? projectId : null,
  );
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
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncOutcome, setSyncOutcome] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>("diff");
  const [rightPaneAnnouncement, setRightPaneAnnouncement] = useState("");
  const syncSeqRef = useRef(0);
  const newBranchReturnFocusRef = useRef<HTMLElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const diffPaneRef = useRef<HTMLDivElement | null>(null);
  const landedPathRef = useRef<string | null>(null);
  const landedCommitRef = useRef<string | null>(null);
  const completedCommitLandingRef = useRef<string | null>(null);

  // Two independent governed-mutation flows: one for staging, one for the commit composer. Each
  // carries its own stale-guard so concurrent stage clicks and a later commit do not cross results.
  const projectKey = selectedPath ?? "";
  const branchActions = useGitActions(client, projectKey);
  const staging = useGitActions(client, projectKey);
  const commit = useGitActions(client, projectKey);
  const resetBranchActions = branchActions.reset;
  const resetStaging = staging.reset;
  const resetCommit = commit.reset;

  const openNewBranchDialog = useCallback((): void => {
    newBranchReturnFocusRef.current =
      typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
    setNewBranchOpen(true);
  }, []);

  const closeNewBranchDialog = useCallback((): void => {
    setNewBranchOpen(false);
    const target = newBranchReturnFocusRef.current;
    newBranchReturnFocusRef.current = null;
    if (target !== null) queueMicrotask(() => target.focus());
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

  useEffect(() => {
    if (projectId !== undefined && projectId !== "") setSelectedPath(projectId);
  }, [projectId]);

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
  }, [rightPaneMode]);

  // Repository change: reset the per-repo view and invalidate any in-flight mutations so a late
  // response from the previous repository cannot surface under the newly selected one.
  useEffect(() => {
    resetStaging();
    resetCommit();
    resetBranchActions();
    syncSeqRef.current += 1;
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
    setSelectedCommitSha(null);
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
    if (selectedPath === null) {
      setHistory(null);
      setHistoryProjectKey(null);
      setHistoryError(null);
      setSelectedCommitSha(null);
      return;
    }
    if (tab !== "history") {
      setHistoryLoading(false);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    void client.getHistory({ root: selectedPath, limit: 50 }).then(
      (res) => {
        if (cancelled) return;
        setHistory(res);
        setHistoryProjectKey(selectedPath);
        setHistoryLoading(false);
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
        setHistoryError(
          hasRequestedCommit ? null : "The requested commit is not available in bounded history.",
        );
        setSelectedCommitSha((current) =>
          resolveSelectedCommitSha(res.entries, requestedCommit, hasRequestedCommit, current),
        );
      },
      (err: unknown) => {
        if (cancelled) return;
        setHistory(null);
        setHistoryProjectKey(null);
        setHistoryLoading(false);
        setHistoryError(formatGitError(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, initialCommit, selectedPath, statusRevision, tab]);

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
        setSelectedChangePath((prev) => applyChangePathSelection(res.changes, prev, setDiffScope));
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

  // Refresh the changed-file list + visible diff after a successful staging mutation.
  const stagingOutcome = staging.flow.outcome;
  useEffect(() => {
    if (stagingOutcome?.status === "succeeded") setStatusRevision((r) => r + 1);
  }, [stagingOutcome]);

  // After a successful commit, refresh status and remount the composer to clear its fields.
  const commitOutcome = commit.flow.outcome;
  useEffect(() => {
    if (commitOutcome?.status === "succeeded") {
      setStatusRevision((r) => r + 1);
      setCommitNonce((n) => n + 1);
    }
  }, [commitOutcome]);

  const branchOutcome = branchActions.flow.outcome;
  useEffect(() => {
    if (branchOutcome?.status === "succeeded") {
      closeNewBranchDialog();
      setStatusRevision((r) => r + 1);
    }
  }, [branchOutcome, closeNewBranchDialog]);

  const selectRepository = useCallback(
    (path: string): void => {
      setSelectedPath(path);
      updateCfg?.({ projectPath: path });
    },
    [updateCfg],
  );

  const onRepositoryAdded = useCallback(
    (project: ProjectWithAvailability): void => {
      loadRepositories();
      selectRepository(project.path);
    },
    [loadRepositories, selectRepository],
  );

  const activeStatus = scopedToSelectedProject(selectedPath, statusProjectKey, status, null);
  const activeBranches = scopedToSelectedProject(
    selectedPath,
    branchesProjectKey,
    branches,
    EMPTY_BRANCHES,
  );
  const activeSummary = scopedToSelectedProject(selectedPath, summaryProjectKey, summary, null);
  const activeRemotes = scopedToSelectedProject(
    selectedPath,
    remotesProjectKey,
    remotes,
    EMPTY_REMOTES,
  );
  const activeHistory = scopedToSelectedProject(selectedPath, historyProjectKey, history, null);
  const selectedCommit: GitHistoryEntry | null =
    activeHistory?.entries.find((entry) => entry.sha === selectedCommitSha) ?? null;

  useEffect(() => {
    const landing = resolvePathLanding(
      selectedPath,
      initialPath,
      activeStatus,
      landedPathRef.current,
    );
    if (landing === null) return;
    landedPathRef.current = landing.landingKey;
    setTab("changes");
    setSelectedCommitSha(null);
    setSelectedChangePath(landing.change.path);
    setDiffScope(preferredDiffScopeForChange(landing.change));
  }, [activeStatus, initialPath, selectedPath]);

  useEffect(() => {
    const landing = resolveCommitLanding(selectedPath, initialCommit, landedCommitRef.current);
    if (landing === null) return;
    landedCommitRef.current = landing.landingKey;
    setTab("history");
    setSelectedCommitSha(landing.commit);
  }, [initialCommit, selectedPath]);

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
    (branchName: string): void => {
      if (selectedPath === null) return;
      branchActions.runMutation(() => client.branchSwitch({ projectId: selectedPath, branchName }));
    },
    [branchActions, client, selectedPath],
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
        return switched.status === "succeeded"
          ? { ...switched, actionKind: "branch-create" }
          : switched;
      });
    },
    [activeBranches, branchActions, client, selectedPath],
  );

  const syncView = deriveSyncView(activeSummary, summaryLoading);

  const runSync = useCallback((): void => {
    if (selectedPath === null || syncView.disabled || syncView.action === "blocked") return;
    const seq = syncSeqRef.current + 1;
    syncSeqRef.current = seq;
    setSyncBusy(true);
    setSyncOutcome(null);
    setSyncError(null);
    const metrics: SyncMetrics = {
      startedAt: performance.now(),
      aheadBefore: activeSummary?.ahead ?? 0,
      behindBefore: activeSummary?.behind ?? 0,
    };
    const callbacks = createSyncCallbacks(
      syncSeqRef,
      seq,
      setSyncBusy,
      setSyncOutcome,
      setSyncError,
      setStatusRevision,
    );
    if (syncView.action === "fetch" || syncView.action === "pull") {
      runFetchOrPullSync(
        client,
        selectedPath,
        syncView.action,
        syncView.remoteAlias,
        metrics,
        callbacks,
      );
      return;
    }
    if (
      (syncView.action === "push" || syncView.action === "publish-upstream") &&
      syncView.remoteAlias !== undefined &&
      syncView.remoteBranchName !== undefined &&
      syncView.sourceBranchName !== undefined
    ) {
      runPushSync(
        client,
        selectedPath,
        syncView.action,
        syncView.remoteAlias,
        syncView.remoteBranchName,
        syncView.sourceBranchName,
        syncView.setUpstreamTracking ?? false,
        metrics,
        callbacks,
      );
    }
  }, [activeSummary, client, selectedPath, syncView]);

  const openRightPane = useCallback(
    (mode: Exclude<RightPaneMode, "diff">): void => {
      if (selectedPath === null) return;
      setRightPaneMode(mode);
      setRightPaneAnnouncement(
        mode === "pull-request" ? "Pull Request panel opened." : "Merge panel opened.",
      );
    },
    [selectedPath],
  );

  const returnToDiff = useCallback((): void => {
    setRightPaneMode("diff");
    setRightPaneAnnouncement("Diff panel opened.");
    window.requestAnimationFrame(() => {
      const diffRegion = diffPaneRef.current?.querySelector('[role="region"][aria-label="Diff"]');
      if (diffRegion instanceof HTMLElement) diffRegion.focus();
    });
  }, []);

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
        statusLoading={statusLoading}
        branchBusy={branchActions.flow.busy}
        syncView={
          summaryError === null
            ? syncView
            : {
                action: "blocked",
                label: "Sync unavailable",
                description: summaryError,
                disabled: true,
              }
        }
        syncBusy={syncBusy}
        syncOutcome={syncOutcome}
        syncError={syncError}
        onSelectRepository={selectRepository}
        onSwitchBranch={switchBranch}
        onCreateBranch={openNewBranchDialog}
        onRunSync={runSync}
        onOpenEditor={onOpenEditor}
        onOpenFiles={onOpenFiles}
      />
      <div style={BODY_STYLE}>
        {selectedPath === null ? (
          <ConnectPanel
            repositories={repositories}
            loading={reposLoading}
            error={reposError}
            onSelect={selectRepository}
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
            <GitClientRightPane
              rightPaneMode={rightPaneMode}
              diffPaneRef={diffPaneRef}
              rightPaneRef={rightPaneRef}
              client={client}
              repositoryRoot={selectedPath}
              selectedChangePath={selectedChangePath}
              selectedCommit={selectedCommit}
              tab={tab}
              diffScope={diffScope}
              onScopeChange={setDiffScope}
              revealRequestId={revealRequestId}
              onRevealFile={revealEditorFile}
              statusRevision={statusRevision}
              onReturnToDiff={returnToDiff}
              currentBranch={currentBranch}
              ownerAndRepo={inferredOwnerAndRepo}
              baseBranchName={inferredBaseBranch}
            />
          </>
        )}
      </div>
      {dialogOpen ? (
        <AddRepositoryDialog
          client={client}
          initialMode={dialogMode}
          onAdded={onRepositoryAdded}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
      {newBranchOpen ? (
        <NewBranchDialog
          branches={activeBranches}
          currentBranch={
            activeStatus?.branch ?? activeBranches.find((branch) => branch.current)?.name ?? ""
          }
          busy={branchActions.flow.busy}
          error={branchActions.flow.error}
          onCreate={createBranch}
          onClose={closeNewBranchDialog}
        />
      ) : null}
    </div>
  );
}
