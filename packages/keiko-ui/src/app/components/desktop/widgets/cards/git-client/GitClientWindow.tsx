"use client";

// Git client window shell (Issue #1574, Epic #1571). The single coherent Git window from the frozen
// layout contract (§5): header toolbar (repository + branch selectors + sync status + open actions),
// a left sidebar (repository search + Changes/History tabs), and a right diff pane with PR/Merge entry
// points. The shell wires the read surface (repositories, branches, status, diff) and reuses the
// existing governed Pull Request / Merge windows via openWindow. Mutation flows (staging, commit,
// branch switch/create, sync execution) are reserved for siblings #1575/#1576/#1577.
//
// Visible product text says "Git" only — never "Governed Git", "Governance", or "Delivery path"
// (contract §7). Styling composes existing globals.css tokens via inline styles (ADR-0051); no new CSS.

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { GitBranchListEntry } from "@/lib/api";
import type { GitRepositoryStatusResponse, ProjectWithAvailability } from "@/lib/types";
import type { WindowCfgValue } from "../../../windows/types";
import { DEFAULT_GIT_CLIENT, formatGitError } from "./git-client-seam";
import type { GitClientSeam } from "./git-client-seam";
import { RepositoryToolbar } from "./RepositoryToolbar";
import { RepositoryListSearch } from "./RepositoryListSearch";
import { AddRepositoryDialog } from "./AddRepositoryDialog";
import { ChangesPane } from "./ChangesPane";
import type { ChangesTab } from "./ChangesPane";
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
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [tab, setTab] = useState<ChangesTab>("changes");
  const [selectedChangePath, setSelectedChangePath] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

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
    if (selectedPath === null) {
      setBranches([]);
      setStatus(null);
      setStatusError(null);
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    setStatusLoading(true);
    setStatusError(null);
    setSelectedChangePath(null);
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
    void client.getStatus(selectedPath).then(
      (res) => {
        if (cancelled) return;
        setStatus(res);
        setStatusLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setStatus(null);
        setStatusLoading(false);
        setStatusError(formatGitError(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, selectedPath]);

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

  const openGovernedWindow = (key: string): void => {
    if (selectedPath === null) return;
    openWindow?.(key, { projectPath: selectedPath });
  };

  return (
    <div style={WORKSPACE_STYLE} aria-label="Git">
      <RepositoryToolbar
        repositories={repositories}
        selectedPath={selectedPath}
        branches={branches}
        branchesLoading={branchesLoading}
        status={status}
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
            status={status}
            statusLoading={statusLoading}
            statusError={statusError}
            selectedChangePath={selectedChangePath}
            onSelectChange={setSelectedChangePath}
          />
        </div>
        <DiffPane
          client={client}
          repositoryRoot={selectedPath}
          selectedChangePath={selectedChangePath}
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
