"use client";

import type { CSSProperties, ReactNode } from "react";
import type { GitBranchListEntry } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import type { GitRepositoryStatusResponse, ProjectWithAvailability } from "@/lib/types";
import { Icons } from "../../../Icons";
import KeikoSelect, { type KeikoSelectProps } from "../../../KeikoSelect";
import { BranchSelector } from "./BranchSelector";
import { SyncControl, type GitSyncView } from "./SyncControl";
import type { SyncOutcomeView } from "./sync-outcome";
import {
  SECONDARY_BTN,
  TOOLBAR_ICON_BTN,
  TOOLBAR_ACTIONS_STYLE,
  TOOLBAR_CELL_LABEL_STYLE,
  TOOLBAR_CELL_STYLE,
  TOOLBAR_EMPTY_STYLE,
  TOOLBAR_STYLE,
  disabledStyle,
} from "./git-client-styles";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const FolderIcon = Icons.folder;
const BranchIcon = Icons.branch;
const CodeIcon = Icons.code;
const FilesIcon = Icons.files;
const ChatIcon = Icons.newChat;

export interface RepositoryToolbarProps {
  readonly repositories: readonly ProjectWithAvailability[];
  readonly selectedPath: string | null;
  readonly repositorySelectionLocked?: boolean | undefined;
  readonly branches: readonly GitBranchListEntry[];
  readonly branchesLoading: boolean;
  readonly status: GitRepositoryStatusResponse | null;
  readonly branchBusy: boolean;
  readonly syncView: GitSyncView;
  readonly syncBusy: boolean;
  readonly syncOutcome: SyncOutcomeView | null;
  readonly syncError: string | null;
  readonly onSelectRepository: (path: string) => void;
  readonly onSwitchBranch: (branchName: string, trigger: HTMLButtonElement) => void;
  readonly onCreateBranch: (trigger: HTMLButtonElement) => void;
  readonly onRunSync: () => void;
  readonly onOpenEditor?: ((root: string) => void) | undefined;
  readonly onOpenFiles?: ((root: string) => void) | undefined;
  /** Issue #3400 — opens the "Connect to Chat" dialog for the active repository comparison. */
  readonly onConnectToChat?: () => void;
  /** #3390 — opens the Add repository dialog from the connected toolbar's Repository menu. Until
   * this existed the dialog was reachable only from the connect panel, i.e. only while NO
   * repository was bound: an operator with one connected repository had no way to add another
   * local checkout the desktop had not registered yet. */
  readonly onAddRepository?: (() => void) | undefined;
}

/** The value of the Repository menu's one action entry. Every repository option's value is an
 * absolute path, so this sentinel can never collide with one. Module-private: the menu and its
 * handler are the only two readers. */
const ADD_REPOSITORY_OPTION = "__add-repository__";

type RepositorySection = KeikoSelectProps["sections"][number];

/** The Repository menu's action entry, present only when the toolbar can add a repository. */
interface AddRepositoryEntry {
  readonly label: string;
  readonly onSelect: () => void;
}

// The dialog this entry opens names itself from the optional widget catalog; the entry uses the
// SAME key so menu and dialog can never drift apart.
function useAddRepositoryEntry(
  onAddRepository: (() => void) | undefined,
): AddRepositoryEntry | undefined {
  const optionalT = useOptionalWidgetTranslate();
  return onAddRepository === undefined
    ? undefined
    : { label: optionalT("gitClientWindow.addRepository.title"), onSelect: onAddRepository };
}

function repositorySections(
  repositories: readonly ProjectWithAvailability[],
  addRepositoryLabel: string | undefined,
  selectedPath: string | null,
  repositorySelectionLocked: boolean,
): RepositorySection[] {
  const sections: RepositorySection[] = [
    {
      options: repositories.map((repo) => ({
        value: repo.path,
        label: repo.name,
        description:
          repositorySelectionLocked && repo.path === selectedPath
            ? "Bound active workspace"
            : repo.path,
      })),
    },
  ];
  if (addRepositoryLabel !== undefined) {
    sections.push({ options: [{ value: ADD_REPOSITORY_OPTION, label: addRepositoryLabel }] });
  }
  return sections;
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

interface ToolbarActionsProps {
  readonly selectedPath: string | null;
  readonly onOpenEditor: ((root: string) => void) | undefined;
  readonly onOpenFiles: ((root: string) => void) | undefined;
  readonly onConnectToChat: (() => void) | undefined;
  readonly connectToChatLabel: string;
}

// One icon-only toolbar action button. Extracted so each of the three optional actions in
// ToolbarActions is a single call, keeping every function under the max-lines-per-function bar.
function ToolbarIconButton({
  label,
  icon,
  onClick,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      style={TOOLBAR_ICON_BTN}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <span style={{ color: "var(--fg-dim)" }}>{icon}</span>
    </button>
  );
}

// Extracted from RepositoryToolbar so the parent stays under the complexity bar: each button is
// an independent optional action, gated only on its own callback being supplied.
function ToolbarActions({
  selectedPath,
  onOpenEditor,
  onOpenFiles,
  onConnectToChat,
  connectToChatLabel,
}: ToolbarActionsProps): ReactNode {
  if (onOpenEditor === undefined && onOpenFiles === undefined && onConnectToChat === undefined) {
    return null;
  }
  return (
    <div style={TOOLBAR_ACTIONS_STYLE}>
      {onConnectToChat !== undefined ? (
        <ToolbarIconButton
          label={connectToChatLabel}
          icon={<ChatIcon size={15} />}
          onClick={onConnectToChat}
        />
      ) : null}
      {onOpenEditor !== undefined ? (
        <ToolbarIconButton
          label="Open in Editor"
          icon={<CodeIcon size={15} />}
          onClick={() => {
            if (selectedPath !== null) onOpenEditor(selectedPath);
          }}
        />
      ) : null}
      {onOpenFiles !== undefined ? (
        <ToolbarIconButton
          label="Open Files"
          icon={<FilesIcon size={15} />}
          onClick={() => {
            if (selectedPath !== null) onOpenFiles(selectedPath);
          }}
        />
      ) : null}
    </div>
  );
}

// The muted header shown until a repository is connected (body renders the Connect panel).
// Extracted so RepositoryToolbar itself stays under the max-lines-per-function bar.
function EmptyRepositoryToolbar({
  onOpenEditor,
}: {
  readonly onOpenEditor: ((root: string) => void) | undefined;
}): ReactNode {
  return (
    <header style={TOOLBAR_EMPTY_STYLE} aria-label="Repository toolbar">
      <span style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--fg-faint)" }}>
        <FolderIcon size={16} />
        <span style={{ fontSize: 14, color: "var(--fg-muted)" }}>Select a repository</span>
      </span>
      <span style={{ width: 1, height: 26, background: "var(--line-soft)" }} />
      <span style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--fg-faint)" }}>
        <BranchIcon size={16} />
        <span style={{ fontSize: 13, color: "var(--fg-faint)" }}>No branch</span>
      </span>
      <span style={{ flex: 1 }} />
      {onOpenEditor !== undefined ? (
        <button type="button" style={{ ...SECONDARY_BTN, ...disabledStyle(true) }} disabled>
          <span style={{ color: "var(--fg-dim)" }}>
            <CodeIcon size={15} />
          </span>{" "}
          Open in Editor
        </button>
      ) : null}
    </header>
  );
}

interface ConnectedToolbarCellsProps {
  readonly repositories: readonly ProjectWithAvailability[];
  readonly selectedPath: string | null;
  readonly repositorySelectionLocked: boolean;
  readonly branches: readonly GitBranchListEntry[];
  readonly branchesLoading: boolean;
  readonly status: GitRepositoryStatusResponse | null;
  readonly branchBusy: boolean;
  readonly branchValue: string;
  readonly syncView: GitSyncView;
  readonly syncBusy: boolean;
  readonly syncOutcome: SyncOutcomeView | null;
  readonly syncError: string | null;
  readonly onSelectRepository: (path: string) => void;
  readonly addRepository: AddRepositoryEntry | undefined;
  readonly onSwitchBranch: (branchName: string, trigger: HTMLButtonElement) => void;
  readonly onCreateBranch: (trigger: HTMLButtonElement) => void;
  readonly onRunSync: () => void;
  readonly t: ReturnType<typeof useTranslate>;
}

// The Repository / Current branch / Sync cells of the connected toolbar. Extracted so
// RepositoryToolbar itself stays under the max-lines-per-function bar.
// The Repository picker cell. Extracted so ConnectedToolbarCells stays under the
// max-lines-per-function bar.
const REPOSITORY_TRIGGER_STYLE: CSSProperties = {
  minWidth: 0,
  border: "none",
  background: "transparent",
  padding: 0,
  height: "auto",
  font: "600 14px var(--font-ui)",
  color: "var(--fg)",
};

function RepositoryCell({
  repositories,
  selectedPath,
  repositorySelectionLocked,
  addRepository,
  onSelectRepository,
}: {
  readonly repositories: readonly ProjectWithAvailability[];
  readonly selectedPath: string | null;
  readonly repositorySelectionLocked: boolean;
  readonly addRepository: AddRepositoryEntry | undefined;
  readonly onSelectRepository: (path: string) => void;
}): ReactNode {
  // The Repository menu is disabled in the locked state, so the "Add repository" option it
  // carries is unclickable there. Only put the option in the menu when the picker is enabled;
  // when locked, `LockedAddRepositoryButton` below exposes the action as a separate control that
  // stays clickable without changing the bound project.
  const menuAddRepositoryLabel = repositorySelectionLocked ? undefined : addRepository?.label;
  return (
    <ToolbarCell label="Repository" minWidth={248}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span style={{ color: "var(--fg-dim)" }}>
          <FolderIcon size={16} />
        </span>
        <KeikoSelect
          value={selectedPath ?? ""}
          ariaLabel="Repository"
          menuTitle="Repository"
          placeholder="Select a repository"
          disabled={repositorySelectionLocked}
          triggerStyle={REPOSITORY_TRIGGER_STYLE}
          sections={repositorySections(
            repositories,
            menuAddRepositoryLabel,
            selectedPath,
            repositorySelectionLocked,
          )}
          onValueChange={(value) => {
            if (value === ADD_REPOSITORY_OPTION) addRepository?.onSelect();
            else if (value !== selectedPath) onSelectRepository(value);
          }}
        />
        {repositorySelectionLocked && addRepository !== undefined ? (
          <LockedAddRepositoryButton addRepository={addRepository} />
        ) : null}
      </span>
    </ToolbarCell>
  );
}

// A separate, always-clickable Add repository control for the locked-workspace state. It stays
// inside RepositoryCell so operators see the affordance next to the disabled picker, and its
// caller is expected to register the repository without reconnecting the current window —
// switching `selectedPath`/`projectPath` here would violate `lockedToActiveRoot`.
function LockedAddRepositoryButton({
  addRepository,
}: {
  readonly addRepository: AddRepositoryEntry;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={addRepository.label}
      title={addRepository.label}
      style={TOOLBAR_ICON_BTN}
      onClick={addRepository.onSelect}
    >
      <span aria-hidden="true" style={{ color: "var(--fg-dim)", fontWeight: 600 }}>
        +
      </span>
    </button>
  );
}

function BranchCell({
  branches,
  branchesLoading,
  status,
  branchBusy,
  branchValue,
  onSwitchBranch,
  onCreateBranch,
}: {
  readonly branches: readonly GitBranchListEntry[];
  readonly branchesLoading: boolean;
  readonly status: GitRepositoryStatusResponse | null;
  readonly branchBusy: boolean;
  readonly branchValue: string;
  readonly onSwitchBranch: (branchName: string, trigger: HTMLButtonElement) => void;
  readonly onCreateBranch: (trigger: HTMLButtonElement) => void;
}): ReactNode {
  return (
    <ToolbarCell label="Current branch" minWidth={190}>
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
  );
}

function SyncCell({
  label,
  syncView,
  syncBusy,
  syncOutcome,
  syncError,
  onRunSync,
}: {
  readonly label: string;
  readonly syncView: GitSyncView;
  readonly syncBusy: boolean;
  readonly syncOutcome: SyncOutcomeView | null;
  readonly syncError: string | null;
  readonly onRunSync: () => void;
}): ReactNode {
  return (
    <ToolbarCell label={label} minWidth={196} last>
      <SyncControl
        view={syncView}
        busy={syncBusy}
        outcome={syncOutcome}
        error={syncError}
        onRun={onRunSync}
      />
    </ToolbarCell>
  );
}

function ConnectedToolbarCells(props: ConnectedToolbarCellsProps): ReactNode {
  return (
    <>
      <RepositoryCell
        repositories={props.repositories}
        selectedPath={props.selectedPath}
        repositorySelectionLocked={props.repositorySelectionLocked}
        addRepository={props.addRepository}
        onSelectRepository={props.onSelectRepository}
      />
      <BranchCell
        branches={props.branches}
        branchesLoading={props.branchesLoading}
        status={props.status}
        branchBusy={props.branchBusy}
        branchValue={props.branchValue}
        onSwitchBranch={props.onSwitchBranch}
        onCreateBranch={props.onCreateBranch}
      />
      <SyncCell
        label={props.t("gitClientWindow.toolbar.sync")}
        syncView={props.syncView}
        syncBusy={props.syncBusy}
        syncOutcome={props.syncOutcome}
        syncError={props.syncError}
        onRunSync={props.onRunSync}
      />
    </>
  );
}

interface ConnectedToolbarDerivedProps {
  readonly repositorySelectionLocked: boolean;
  readonly addRepository: AddRepositoryEntry | undefined;
  readonly branchValue: string;
  readonly t: ReturnType<typeof useTranslate>;
}

interface ConnectedRepositoryToolbarProps {
  readonly cells: ConnectedToolbarCellsProps;
  readonly actions: ToolbarActionsProps;
}

function connectedToolbarCellsProps(
  props: RepositoryToolbarProps,
  derived: ConnectedToolbarDerivedProps,
): ConnectedToolbarCellsProps {
  return {
    repositories: props.repositories,
    selectedPath: props.selectedPath,
    repositorySelectionLocked: derived.repositorySelectionLocked,
    branches: props.branches,
    branchesLoading: props.branchesLoading,
    status: props.status,
    branchBusy: props.branchBusy,
    branchValue: derived.branchValue,
    syncView: props.syncView,
    syncBusy: props.syncBusy,
    syncOutcome: props.syncOutcome,
    syncError: props.syncError,
    onSelectRepository: props.onSelectRepository,
    addRepository: derived.addRepository,
    onSwitchBranch: props.onSwitchBranch,
    onCreateBranch: props.onCreateBranch,
    onRunSync: props.onRunSync,
    t: derived.t,
  };
}

function toolbarActionsProps(
  props: RepositoryToolbarProps,
  connectToChatLabel: string,
): ToolbarActionsProps {
  return {
    selectedPath: props.selectedPath,
    onOpenEditor: props.onOpenEditor,
    onOpenFiles: props.onOpenFiles,
    onConnectToChat: props.onConnectToChat,
    connectToChatLabel,
  };
}

function ConnectedRepositoryToolbar({
  cells,
  actions,
}: ConnectedRepositoryToolbarProps): ReactNode {
  return (
    <header style={TOOLBAR_STYLE} aria-label="Repository toolbar">
      <ConnectedToolbarCells {...cells} />
      <span style={{ flex: 1 }} />
      <ToolbarActions {...actions} />
    </header>
  );
}

export function RepositoryToolbar(props: RepositoryToolbarProps): ReactNode {
  const t = useTranslate();
  const addRepository = useAddRepositoryEntry(props.onAddRepository);

  if (props.selectedPath === null)
    return <EmptyRepositoryToolbar onOpenEditor={props.onOpenEditor} />;

  const derived = {
    repositorySelectionLocked: props.repositorySelectionLocked ?? false,
    addRepository,
    branchValue: currentBranchName(props.branches, props.status),
    t,
  };

  return (
    <ConnectedRepositoryToolbar
      cells={connectedToolbarCellsProps(props, derived)}
      actions={toolbarActionsProps(props, t("gitChangeScope.connect.openButton"))}
    />
  );
}
