"use client";

import type { ReactNode } from "react";
import type { GitBranchListEntry } from "@/lib/api";
import type { GitRepositoryStatusResponse, ProjectWithAvailability } from "@/lib/types";
import { Icons } from "../../../Icons";
import KeikoSelect from "../../../KeikoSelect";
import {
  SECONDARY_BTN,
  STATUS_PILL_STYLE,
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
  readonly onSelectRepository: (path: string) => void;
  readonly onOpenEditor?: ((root: string) => void) | undefined;
  readonly onOpenFiles?: ((root: string) => void) | undefined;
}

// The Sync control is a read-only status pill in the shell (#1574). Fetch/Pull/Push execution and
// ahead/behind counts are reserved for #1576; the pill reflects the current repository's cleanliness.
function syncLabel(status: GitRepositoryStatusResponse | null, statusLoading: boolean): string {
  if (statusLoading && status === null) return "Sync: checking";
  if (status === null) return "Sync";
  if (!status.available) return "Sync unavailable";
  if (status.clean) return "Sync: up to date";
  const count = status.changes.length;
  return `Sync: ${count.toString()} pending ${count === 1 ? "change" : "changes"}`;
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
  statusLoading,
  onSelectRepository,
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

      {/* Read-only display of the current branch in the #1574 shell. Branch switching (an
          operable selector that calls branchSwitch) is reserved for #1576; rendering this
          control as always-disabled keeps it honest — it shows the current branch but cannot
          be operated, so a user is never offered a no-op interaction. */}
      <KeikoSelect
        value={branchValue}
        ariaLabel="Branch"
        menuTitle="Branch"
        placeholder={branchesLoading ? "Loading branches" : "No branch"}
        disabled
        leadingVisual={<Icons.branch size={13} />}
        mono
        triggerStyle={{ minWidth: 160 }}
        sections={[
          {
            options: branches.map((branch) => ({
              value: branch.name,
              label: branch.name,
              ...(branch.current ? { badge: "current" } : {}),
            })),
          },
        ]}
        onValueChange={() => undefined}
      />

      <span style={STATUS_PILL_STYLE} aria-label={syncLabel(status, statusLoading)}>
        <Icons.reset size={11} />
        {syncLabel(status, statusLoading)}
      </span>

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
