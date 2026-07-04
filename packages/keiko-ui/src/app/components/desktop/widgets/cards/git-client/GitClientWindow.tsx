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
import type { ReactNode } from "react";
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

export interface GitClientWindowProps {
  /** Repository path to preselect when opened from Files, Editor, or Runtime (resolveBoundRoot). */
  readonly projectId?: string | undefined;
  readonly onOpenFiles?: ((root: string) => void) | undefined;
  readonly onOpenEditor?: ((root: string) => void) | undefined;
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

export function GitClientWindow({
  projectId,
  onOpenFiles,
  onOpenEditor,
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
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    void client.listBranches(selectedPath).then(
      (res) => {
        if (cancelled) return;
        setBranches(res.available ? res.branches : []);
        setBranchesLoading(false);
      },
      () => {
        if (cancelled) return;
        setBranches([]);
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
        setSelectedCommitSha((current) => {
          if (res.entries.length === 0) return null;
          if (current !== null && res.entries.some((entry) => entry.sha === current))
            return current;
          return res.entries[0]?.sha ?? null;
        });
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
  }, [client, selectedPath, statusRevision, tab]);

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
        setSelectedChangePath((prev) => {
          if (prev === null) return null;
          const selectedChange = res.changes.find((c) => c.path === prev);
          if (selectedChange === undefined) return null;
          setDiffScope((current) => normalizeDiffScopeForChange(current, selectedChange));
          return prev;
        });
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

  const activeStatus = selectedPath !== null && statusProjectKey === selectedPath ? status : null;
  const activeSummary =
    selectedPath !== null && summaryProjectKey === selectedPath ? summary : null;
  const activeRemotes = selectedPath !== null && remotesProjectKey === selectedPath ? remotes : [];
  const activeHistory =
    selectedPath !== null && historyProjectKey === selectedPath ? history : null;
  const selectedCommit: GitHistoryEntry | null =
    activeHistory?.entries.find((entry) => entry.sha === selectedCommitSha) ?? null;

  const selectChange = useCallback(
    (path: string): void => {
      setSelectedChangePath(path);
      const change = activeStatus?.changes.find((c) => c.path === path);
      if (change !== undefined) setDiffScope(preferredDiffScopeForChange(change));
    },
    [activeStatus],
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
      const baseBranch = branches.find((branch) => branch.name === baseBranchName);
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
    [branchActions, branches, client, selectedPath],
  );

  const syncView = deriveSyncView(activeSummary, summaryLoading);

  const runSync = useCallback((): void => {
    if (selectedPath === null || syncView.disabled || syncView.action === "blocked") return;
    const seq = syncSeqRef.current + 1;
    syncSeqRef.current = seq;
    setSyncBusy(true);
    setSyncOutcome(null);
    setSyncError(null);
    // GEN-PERF-WIDGET-006 — surface sync duration + the ahead/behind repository-state
    // delta in the outcome so a slow round-trip is observable and the user sees what the
    // sync accomplished. The pre-sync counts come from the summary the widget already
    // holds; the post-sync summary refresh (statusRevision bump below) updates the panel.
    const startedAt = performance.now();
    const aheadBefore = activeSummary?.ahead ?? 0;
    const behindBefore = activeSummary?.behind ?? 0;
    const withMetrics = (label: string): string => {
      const elapsedSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
      const delta =
        aheadBefore > 0
          ? ` (ahead ${aheadBefore.toString()})`
          : ` (behind ${behindBefore.toString()})`;
      return `${label} in ${elapsedSeconds.toString()}s${delta}`;
    };
    const done = (message: string): void => {
      if (syncSeqRef.current !== seq) return;
      setSyncBusy(false);
      setSyncOutcome(message);
      setStatusRevision((r) => r + 1);
    };
    const fail = (err: unknown): void => {
      if (syncSeqRef.current !== seq) return;
      setSyncBusy(false);
      setSyncError(formatGitError(err));
    };
    if (syncView.action === "fetch" || syncView.action === "pull") {
      const operation = syncView.action;
      void client
        .syncPreview({
          operation,
          projectId: selectedPath,
          remote: syncView.remoteAlias,
        })
        .then((preview) => {
          if (!preview.executable) {
            done(`Blocked: ${preview.blockReason ?? "sync unavailable"}`);
            return undefined;
          }
          return client.syncExecute({
            operation,
            projectId: selectedPath,
            remote: syncView.remoteAlias,
          });
        })
        .then((res) => {
          if (res === undefined) return;
          done(withMetrics(`${operation === "fetch" ? "Fetch" : "Pull"}: ${res.status}`));
        }, fail);
      return;
    }
    if (
      (syncView.action === "push" || syncView.action === "publish-upstream") &&
      syncView.remoteAlias !== undefined &&
      syncView.remoteBranchName !== undefined &&
      syncView.sourceBranchName !== undefined
    ) {
      const input = {
        projectId: selectedPath,
        remoteAlias: syncView.remoteAlias,
        remoteBranchName: syncView.remoteBranchName,
        sourceBranchName: syncView.sourceBranchName,
        forcePush: false,
        setUpstreamTracking: syncView.setUpstreamTracking ?? false,
      };
      void client
        .pushPreview(input)
        .then((preview) => {
          if (preview.policyOutcome !== "allowed" || preview.preflightBlockingCodes.length > 0) {
            done(
              `Blocked: ${preview.policyBlockReason ?? preview.preflightBlockingCodes.join(", ")}`,
            );
            return undefined;
          }
          return client.pushExecute(input);
        })
        .then((res) => {
          if (res === undefined) return;
          done(
            withMetrics(
              `${syncView.action === "push" ? "Push" : "Publish upstream"}: ${res.status}`,
            ),
          );
        }, fail);
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
        branches={branches}
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
            {rightPaneMode === "diff" ? (
              <div ref={diffPaneRef} style={{ minWidth: 0, minHeight: 0, display: "contents" }}>
                <DiffPane
                  client={client}
                  repositoryRoot={selectedPath}
                  selectedChangePath={selectedChangePath}
                  selectedCommit={tab === "history" ? selectedCommit : null}
                  scope={diffScope}
                  onScopeChange={setDiffScope}
                  revision={statusRevision}
                />
              </div>
            ) : (
              <div
                ref={rightPaneRef}
                style={PANE_STYLE}
                role="region"
                aria-label={rightPaneMode === "pull-request" ? "Pull Request" : "Merge"}
              >
                <div style={DIFF_HEADER_STYLE}>
                  <button type="button" style={SECONDARY_BTN} onClick={returnToDiff}>
                    <Icons.chevronR size={12} style={{ transform: "rotate(180deg)" }} /> Back to
                    diff
                  </button>
                </div>
                {rightPaneMode === "pull-request" ? (
                  <GovernedPullRequestCard
                    projectId={selectedPath}
                    headBranchName={currentBranch}
                    ownerAndRepo={inferredOwnerAndRepo}
                    baseBranchName={inferredBaseBranch}
                    client={client}
                  />
                ) : (
                  <GovernedMergeCard
                    projectId={selectedPath}
                    headBranchName={currentBranch}
                    ownerAndRepo={inferredOwnerAndRepo}
                    baseBranchName={inferredBaseBranch}
                    client={client}
                  />
                )}
              </div>
            )}
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
          branches={branches}
          currentBranch={
            activeStatus?.branch ?? branches.find((branch) => branch.current)?.name ?? ""
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
