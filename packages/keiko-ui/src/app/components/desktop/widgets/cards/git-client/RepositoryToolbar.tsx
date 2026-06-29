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
  TOOLBAR_ACTIONS_STYLE,
  TOOLBAR_CELL_LABEL_STYLE,
  TOOLBAR_CELL_STYLE,
  TOOLBAR_EMPTY_STYLE,
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

// Stacked toolbar cell: a tiny mono-caps label over its interactive control, separated from its
// neighbours by hairlines (last cell drops the trailing border).
function ToolbarCell({
  label,
  children,
  minWidth,
  last,
}: {
  readonly label?: string;
  readonly children: ReactNode;
  readonly minWidth: number;
  readonly last?: boolean;
}): ReactNode {
  return (
    <div
      style={{
        ...TOOLBAR_CELL_STYLE,
        minWidth,
        cursor: "default",
        ...(last === true ? { borderRight: "none" } : null),
      }}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        {label !== undefined ? <span style={TOOLBAR_CELL_LABEL_STYLE}>{label}</span> : null}
        {children}
      </span>
    </div>
  );
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

  // Muted toolbar — shown until a repository is connected (body renders the Connect panel).
  if (!hasRepository) {
    return (
      <header style={TOOLBAR_EMPTY_STYLE} aria-label="Repository toolbar">
        <span style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--fg-faint)" }}>
          <Icons.folder size={16} />
          <span style={{ fontSize: 14, color: "var(--fg-muted)" }}>Select a repository</span>
        </span>
        <span style={{ width: 1, height: 26, background: "var(--line-soft)" }} />
        <span style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--fg-faint)" }}>
          <Icons.branch size={16} />
          <span style={{ fontSize: 13, color: "var(--fg-faint)" }}>No branch</span>
        </span>
        <span style={{ flex: 1 }} />
        {onOpenEditor !== undefined ? (
          <button type="button" style={{ ...SECONDARY_BTN, ...disabledStyle(true) }} disabled>
            <span style={{ color: "var(--fg-dim)" }}>
              <Icons.code size={15} />
            </span>
            Open in Editor
          </button>
        ) : null}
      </header>
    );
  }

  return (
    <header style={TOOLBAR_STYLE} aria-label="Repository toolbar">
      <ToolbarCell label="Repository" minWidth={188}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ color: "var(--fg-dim)" }}>
            <Icons.folder size={16} />
          </span>
          <KeikoSelect
            value={selectedPath ?? ""}
            ariaLabel="Repository"
            menuTitle="Repository"
            placeholder="Select a repository"
            triggerStyle={{
              minWidth: 0,
              border: "none",
              background: "transparent",
              padding: 0,
              height: "auto",
              font: "600 14px var(--font-ui)",
              color: "var(--fg)",
            }}
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
        </span>
      </ToolbarCell>

      <ToolbarCell label="Current branch" minWidth={212}>
        <BranchSelector
          branches={branches}
          currentBranch={branchValue}
          loading={branchesLoading}
          disabled={status?.available === false}
          busy={branchBusy}
          onSwitchBranch={onSwitchBranch}
          onCreateBranch={onCreateBranch}
        />
      </ToolbarCell>

      <ToolbarCell minWidth={196} last>
        <SyncControl
          view={syncView}
          busy={syncBusy}
          outcome={syncOutcome}
          error={syncError}
          onRun={onRunSync}
        />
      </ToolbarCell>

      <span style={{ flex: 1 }} />

      {onOpenEditor !== undefined || onOpenFiles !== undefined ? (
        <div style={TOOLBAR_ACTIONS_STYLE}>
          {onOpenEditor !== undefined ? (
            <button
              type="button"
              style={SECONDARY_BTN}
              onClick={() => {
                if (selectedPath !== null) onOpenEditor(selectedPath);
              }}
            >
              <span style={{ color: "var(--fg-dim)" }}>
                <Icons.code size={15} />
              </span>
              Open in Editor
            </button>
          ) : null}
          {onOpenFiles !== undefined ? (
            <button
              type="button"
              style={SECONDARY_BTN}
              onClick={() => {
                if (selectedPath !== null) onOpenFiles(selectedPath);
              }}
            >
              <span style={{ color: "var(--fg-dim)" }}>
                <Icons.files size={15} />
              </span>
              Open Files
            </button>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
