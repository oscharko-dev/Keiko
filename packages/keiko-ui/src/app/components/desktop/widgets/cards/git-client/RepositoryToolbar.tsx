"use client";

import type { ReactNode } from "react";
import type { GitBranchListEntry } from "@/lib/api";
import type { GitRepositoryStatusResponse, ProjectWithAvailability } from "@/lib/types";
import { Icons } from "../../../Icons";
import KeikoSelect from "../../../KeikoSelect";
import { BranchSelector } from "./BranchSelector";
import { SyncControl, type GitSyncView } from "./SyncControl";
import {
  SECONDARY_BTN,
  TOOLBAR_STYLE,
  disabledStyle,
} from "./git-client-styles";

interface RepositoryToolbarProps {
  readonly repositories: readonly ProjectWithAvailability[];
  readonly selectedPath: string | null;
  readonly branches: readonly GitBranchListEntry[];
  readonly branchesLoading: boolean;
  readonly status: GitRepositoryStatusResponse | null;
  readonly statusLoading: boolean;
  readonly branchBusy: boolean;
  readonly syncView: GitSyncView;
  readonly syncBusy: boolean;
  readonly syncOutcome: string | null;
  readonly syncError: string | null;
  readonly onSelectRepository: (path: string) => void;
  readonly onSwitchBranch: (branchName: string) => void;
  readonly onCreateBranch: () => void;
  readonly onRunSync: () => void;
  readonly onOpenEditor?: ((root: string) => void) | undefined;
  readonly onOpenFiles?: ((root: string) => void) | undefined;
}

function currentBranchName(
  branches: readonly GitBranchListEntry[],
  status: GitRepositoryStatusResponse | null,
): string {
  const current = branches.find((branch) => branch.current);
  if (current !== undefined) return current.name;
  return status?.branch ?? "";
}

export function RepositoryToolbar({
  repositories,
  selectedPath,
  branches,
  branchesLoading,
  status,
  branchBusy,
  syncView,
  syncBusy,
  syncOutcome,
  syncError,
  onSelectRepository,
  onSwitchBranch,
  onCreateBranch,
  onRunSync,
  onOpenEditor,
  onOpenFiles,
}: RepositoryToolbarProps): ReactNode {
  const hasRepository = selectedPath !== null;
  const branchValue = currentBranchName(branches, status);

  return (
    <header style={TOOLBAR_STYLE}>
      <span
        style={{
          font: "var(--weight-semibold) var(--text-body) var(--font-ui)",
          color: "var(--text-primary)",
        }}
      >
        Git
      </span>

      <KeikoSelect
        value={selectedPath ?? ""}
        ariaLabel="Repository"
        menuTitle="Repository"
        placeholder="Select a repository"
        leadingVisual={<Icons.git size={13} />}
        triggerStyle={{ minWidth: 180 }}
        sections={[
          {
            options: repositories.map((repo) => ({
              value: repo.path,
              label: repo.name,
              description: repo.path,
            })),
          },
        ]}
        onValueChange={onSelectRepository}
      />

      <BranchSelector
        branches={branches}
        currentBranch={branchValue}
        loading={branchesLoading}
        disabled={!hasRepository || status?.available === false}
        busy={branchBusy}
        onSwitchBranch={onSwitchBranch}
        onCreateBranch={onCreateBranch}
      />

      <SyncControl
        view={syncView}
        busy={syncBusy}
        outcome={syncOutcome}
        error={syncError}
        onRun={onRunSync}
      />

      <span style={{ flex: 1 }} />

      {onOpenEditor !== undefined ? (
        <button
          type="button"
          style={{ ...SECONDARY_BTN, ...disabledStyle(!hasRepository) }}
          disabled={!hasRepository}
          onClick={() => {
            if (selectedPath !== null) onOpenEditor(selectedPath);
          }}
        >
          <Icons.edit size={12} /> Open in Editor
        </button>
      ) : null}
      {onOpenFiles !== undefined ? (
        <button
          type="button"
          style={{ ...SECONDARY_BTN, ...disabledStyle(!hasRepository) }}
          disabled={!hasRepository}
          onClick={() => {
            if (selectedPath !== null) onOpenFiles(selectedPath);
          }}
        >
          <Icons.files size={12} /> Open Files
        </button>
      ) : null}
    </header>
  );
}
