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

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { GitBranchListEntry } from "@/lib/api";
import type {
  GitChangedFile,
  GitDiffScope,
  GitRepositoryStatusResponse,
  ProjectWithAvailability,
} from "@/lib/types";
import type { WindowCfgValue } from "../../../windows/types";
import { DEFAULT_GIT_CLIENT, formatGitError, useGitActions } from "./git-client-seam";
import type { GitClientSeam } from "./git-client-seam";
import { RepositoryToolbar } from "./RepositoryToolbar";
import { RepositoryListSearch } from "./RepositoryListSearch";
import { AddRepositoryDialog } from "./AddRepositoryDialog";
import { ChangesPane } from "./ChangesPane";
import type { ChangesTab } from "./ChangesPane";
import { CommitComposer } from "./CommitComposer";
import { DiffPane } from "./DiffPane";
import { BODY_STYLE, SIDEBAR_STYLE, WORKSPACE_STYLE } from "./git-client-styles";

export interface GitClientWindowProps {
  /** Repository path to preselect when opened from Files, Editor, or Runtime (resolveBoundRoot). */
  readonly projectId?: string | undefined;
  readonly onOpenFiles?: ((root: string) => void) | undefined;
  readonly onOpenEditor?: ((root: string) => void) | undefined;
  /** Opens reused governed PR/Merge windows; carries the selected repository path in cfg. */
  readonly openWindow?: ((key: string, cfg?: Record<string, WindowCfgValue>) => void) | undefined;
  /** Persists the selected repository into cfg.projectPath so resolveBoundRoot re-targets. */
  readonly updateCfg?: ((patch: Record<string, WindowCfgValue>) => void) | undefined;
  /** DI seam; defaults to the real BFF client. */
  readonly client?: GitClientSeam;
}

function preferredDiffScopeForChange(change: GitChangedFile): GitDiffScope {
  return change.staged && !change.unstaged && !change.untracked ? "staged" : "worktree";
}

function normalizeDiffScopeForChange(current: GitDiffScope, change: GitChangedFile): GitDiffScope {
  if (change.staged && !change.unstaged && !change.untracked && current === "worktree") {
    return "staged";
  }
  if (!change.staged && (change.unstaged || change.untracked || change.conflicted) && current === "staged") {
    return "worktree";
  }
  return current;
}

export function GitClientWindow({
  projectId,
  onOpenFiles,
  onOpenEditor,
  openWindow,
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

  // Two independent governed-mutation flows: one for staging, one for the commit composer. Each
  // carries its own stale-guard so concurrent stage clicks and a later commit do not cross results.
  const projectKey = selectedPath ?? "";
  const staging = useGitActions(client, projectKey);
  const commit = useGitActions(client, projectKey);
  const resetStaging = staging.reset;
  const resetCommit = commit.reset;

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

  // Repository change: reset the per-repo view (branches, selection, diff scope) and invalidate any
  // in-flight staging/commit mutation so a late response from the previous repository cannot surface
  // its outcome under the newly selected one.
  useEffect(() => {
    resetStaging();
    resetCommit();
    if (selectedPath === null) {
      setBranches([]);
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    setSelectedChangePath(null);
    setDiffScope("worktree");
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
  }, [client, selectedPath, resetStaging, resetCommit]);

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
    const pathspecs = activeStatus.changes.filter((c) => c.unstaged || c.untracked).map((c) => c.path);
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

  const openGovernedWindow = (key: string): void => {
    if (selectedPath === null) return;
    openWindow?.(key, { projectPath: selectedPath });
  };

  const visibleStagingOutcome = staging.flow.outcome;

  return (
    <div style={WORKSPACE_STYLE} aria-label="Git">
      <RepositoryToolbar
        repositories={repositories}
        selectedPath={selectedPath}
        branches={branches}
        branchesLoading={branchesLoading}
        status={activeStatus}
        statusLoading={statusLoading}
        onSelectRepository={selectRepository}
        onOpenEditor={onOpenEditor}
        onOpenFiles={onOpenFiles}
      />
      <div style={BODY_STYLE}>
        <div style={SIDEBAR_STYLE}>
          <RepositoryListSearch
            repositories={repositories}
            selectedPath={selectedPath}
            loading={reposLoading}
            error={reposError}
            onSelect={selectRepository}
            onAddRepository={() => setDialogOpen(true)}
          />
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
            commitComposer={
              <CommitComposer
                key={`${selectedPath ?? "none"}:${commitNonce.toString()}`}
                projectId={selectedPath}
                stagedFileCount={activeStatus?.stagedCount ?? 0}
                busy={commit.flow.busy}
                outcome={commit.flow.outcome}
                error={commit.flow.error}
                preview={commit.preview}
                previewDraft={commit.previewDraft}
                previewError={commit.previewError}
                onPreview={commit.runPreview}
                onCommit={commitChanges}
              />
            }
          />
        </div>
        <DiffPane
          client={client}
          repositoryRoot={selectedPath}
          selectedChangePath={selectedChangePath}
          scope={diffScope}
          onScopeChange={setDiffScope}
          revision={statusRevision}
          onCreatePullRequest={() => openGovernedWindow("governedPullRequest")}
          onMerge={() => openGovernedWindow("governedMerge")}
        />
      </div>
      {dialogOpen ? (
        <AddRepositoryDialog
          client={client}
          onAdded={onRepositoryAdded}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
