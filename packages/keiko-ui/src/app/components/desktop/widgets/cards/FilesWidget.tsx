"use client";

import {
  useOptionalWidgetTranslate as useTranslate,
  type OptionalWidgetTranslate as I18nTranslate,
} from "@/lib/optional-widget-i18n";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
  SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import {
  ApiError,
  copyFilesEntry,
  createFilesEntry,
  deleteFilesEntry,
  fetchFilesTree,
  fetchGitDiff,
  fetchGitStatus,
  fetchProjects,
  renameFilesEntry,
} from "../../../../../lib/api";
import { formatBytesPrecise as formatBytes } from "../../../../../lib/format";
import type {
  FilesMutationResponse,
  FilesTreeEntry,
  FilesTreeResponse,
  GitChangedFile,
  GitRepositoryDiffResponse,
  GitRepositoryStatusResponse,
} from "../../../../../lib/types";
import { isExpandableDirectory } from "../../../../../lib/types";

import { useDialogTabTrap } from "../../hooks/useDialogTabTrap";
import { Icons } from "../../Icons";
import { NATIVE_BLOCK_STYLE } from "../../native-element-styles";
import { FileIcon } from "../shared/projectTree";
import { FilePreview } from "./FilePreview";
import {
  observeFilesDirectoryRead,
  type FilesNavigationRead,
} from "@/lib/files-navigation-evidence";
import { FilesRootBar } from "./FilesRootBar";
import { SupportReportButton } from "../../SupportReportButton";
import { correlationIdOf } from "@/lib/client-error-summary";
import { useFilesNavigation } from "./useFilesNavigation";
import {
  GIT_REPOSITORY_STATE_INVALIDATED_EVENT,
  gitRepositoryStateInvalidationRoots,
} from "./git-repository-state-events";
import {
  useFilesWidgetTranslate,
  type FilesWidgetMessageKey,
  type FilesWidgetTranslate,
} from "./files-widget-i18n";
import { useWorkspaceWatch } from "./useWorkspaceWatch";
import { WORKSPACE_FILE_MUTATED_EVENT, workspaceFileMutationDetail } from "./workspace-file-events";
import selectableTextStyles from "./shared/selectableText.module.css";
import presentationStyles from "./FilesPresentation.module.css";
import { ProjectTreeRoot } from "./ProjectTreeRoot";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const FolderIcon = Icons.folder;
const ChevronRIcon = Icons.chevronR;
const DiffIcon = Icons.diff;
const BackIcon = Icons.back;
const CloseIcon = Icons.close;
const GitIcon = Icons.git;
const BranchIcon = Icons.branch;
const FileGlyphIcon = Icons.file;
const ResetIcon = Icons.reset;
const EditIcon = Icons.edit;
const CopyIcon = Icons.copy;
const TrashIcon = Icons.trash;

interface FilesWidgetProps {
  readonly presentation?: "directory" | "project";
  readonly openingRoot?: boolean;
  readonly root?: string;
  readonly activeFilePath?: string | undefined;
  readonly openFilesDirectly?: boolean | undefined;
  readonly watchActive?: boolean | undefined;
  readonly onActiveFileChange?: (
    path: string | null,
    root: string | null,
    activeDirectoryPath?: string | null,
  ) => void;
  // Called when the user opens a different machine path from the root bar. The window host
  // persists it into cfg.root so the new root survives reload (widgets/index.tsx). When omitted,
  // the root bar is hidden (the widget is then locked to its configured/fallback root).
  readonly onRootChange?: (root: string) => void;
  readonly onOpenFile?: ((root: string, path: string) => void) | undefined;
  readonly onOpenGitDelivery?: ((root: string) => void) | undefined;
  // Notified after a successful create/rename/delete so the host can re-home open editor tabs (rename)
  // or close them (delete). Omitted in read-only contexts; its presence does not gate the affordances.
  readonly onFilesMutated?: ((event: FilesMutationEvent) => void) | undefined;
  // Consulted BEFORE a rename, drag-move, or delete reaches the server — the pre-flight counterpart
  // of `onFilesMutated`. The host owns the open buffers, so only it can tell whether the path (or,
  // for a directory, anything beneath it) has unsaved changes; resolving `false` vetoes the mutation
  // so the buffer is never orphaned by a path that no longer exists. Omitted where no editor host
  // owns buffers for this root, which reads as "nothing to veto".
  readonly onBeforeEntryMutation?: ((path: string) => Promise<boolean>) | undefined;
}

export interface FilesMutationEvent {
  readonly op: "create" | "rename" | "delete";
  readonly mutation: FilesMutationResponse;
}

// Strip trailing separator characters via plain backward scanning instead of a `+$` regex. An
// unanchored trailing-quantifier pattern (no `^`) lets the engine retry the match at every start
// position when the string does not actually end in a separator, which is O(n^2) on adversarial
// input such as a long run of separators followed by one non-separator character (S8786).
function trimTrailingSeparators(path: string, separators: string): string {
  let end = path.length;
  while (end > 0 && separators.includes(path.charAt(end - 1))) end -= 1;
  return path.slice(0, end);
}

// Parent directory of an absolute POSIX/Windows path, or null at the filesystem root. Pure string
// math (no IO) so the root bar can offer "up" without a round-trip; the BFF still validates.
function parentDir(path: string): string | null {
  const trimmed = trimTrailingSeparators(path, "/\\");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return null;
  if (idx === 0) return "/"; // POSIX root
  // Windows drive root e.g. "C:" → keep the backslash form "C:\"
  if (/^[A-Za-z]:$/.test(trimmed.slice(0, idx))) return `${trimmed.slice(0, idx)}\\`;
  return trimmed.slice(0, idx);
}

function parentRelativePath(path: string): string | null {
  const trimmed = trimTrailingSeparators(path, "/");
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  return parent.length > 0 ? parent : null;
}

function displayPath(root: string, relativePath: string | null): string {
  if (relativePath === null || relativePath.length === 0) return root;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const normalizedRelativePath = relativePath.replaceAll("/", separator);
  return `${trimTrailingSeparators(root, "/\\")}${separator}${normalizedRelativePath}`;
}

function treePathFromGitPath(visibleDirectoryPath: string | null, path: string): string {
  return visibleDirectoryPath === null ? path : joinRelative(visibleDirectoryPath, path);
}

function gitPathFromTreePath(visibleDirectoryPath: string | null, path: string): string {
  if (visibleDirectoryPath === null || visibleDirectoryPath.length === 0) return path;
  if (path === visibleDirectoryPath) return "";
  const prefix = `${visibleDirectoryPath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function markedGitPath(path: string, markedPaths: ReadonlySet<string>): boolean {
  if (markedPaths.has("")) return true;
  let candidate: string | null = path;
  while (candidate !== null) {
    if (markedPaths.has(candidate) || markedPaths.has(`${candidate}/`)) return true;
    candidate = entryParent(candidate);
  }
  return false;
}

interface DirectoryState {
  readonly correlationId?: string | undefined;
  readonly expectedRefusal?: boolean;
  readonly entries: readonly FilesTreeEntry[];
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  // Non-error empty state ("no folder is open"): rendered as a plain note WITHOUT the Retry
  // button — retrying cannot change anything when no root is configured (audit C021).
  readonly notice: "no-root" | null;
}

interface GitStatusState {
  readonly loading: boolean;
  readonly status: GitRepositoryStatusResponse | null;
  readonly error: string | null;
}

interface GitDiffState {
  readonly path: string;
  readonly loading: boolean;
  readonly response: GitRepositoryDiffResponse | null;
  readonly error: string | null;
}

interface GitDirectoryAggregate {
  readonly count: number;
  readonly conflicted: boolean;
  readonly deleted: boolean;
}

interface GitDecoration {
  readonly badge: string;
  readonly labelKey: FilesWidgetMessageKey;
  readonly state: "changed" | "conflicted";
}

interface EntryVisibility {
  readonly hidden: boolean;
  readonly ignored: boolean;
  readonly unversioned: boolean;
  readonly muted: boolean;
  readonly label: string | undefined;
  readonly tooltip: string | undefined;
}

function entryVisibilityLabels(
  entry: FilesTreeEntry,
  flags: Pick<EntryVisibility, "hidden" | "ignored" | "unversioned">,
  t: FilesWidgetTranslate,
): string[] {
  return [
    flags.hidden ? t("tree.hidden") : "",
    flags.ignored ? t("git.ignored") : "",
    flags.unversioned ? t("git.change.untracked", { path: entry.path }) : "",
    !entry.readable && entry.kind === "directory" ? t("tree.unavailable") : "",
  ].filter(Boolean);
}

// The inline editor reused for all three create/rename flows. `parentPath` is the root-relative
// directory the new entry lands in (null = root); `path`/`name` identify the entry being renamed.
type PendingEntry =
  | { readonly kind: "new-file" | "new-folder"; readonly parentPath: string | null }
  | { readonly kind: "rename"; readonly path: string; readonly name: string };

function pendingEntryDraftLabel(kind: PendingEntry["kind"], t: I18nTranslate): string {
  return kind === "new-folder"
    ? t("filesWidget.tree.newFolderName")
    : t("filesWidget.tree.newFileName");
}

function pendingEntryDraftIcon(kind: PendingEntry["kind"], entryDraft: string): ReactNode {
  if (kind === "new-folder") {
    return (
      <span className="fi-fallback" style={{ color: "var(--accent)" }}>
        <FolderIcon size={14} />
      </span>
    );
  }
  return <FileIcon name={entryDraft.length > 0 ? entryDraft : "new-file"} />;
}

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  // The row the menu was opened on, or null for the empty tree background (new file/folder at root).
  readonly entry: FilesTreeEntry | null;
}

interface TreeTooltipState {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

const TREE_TOOLTIP_DELAY_MS = 650;
const TREE_TOOLTIP_MAX_WIDTH = 240;
const DIRECTORY_RENDER_BATCH_SIZE = 200;
// GEN-PERF-MEMORY-005 — cap the loaded-directory cache. Beyond this many cached directories
// the least-recently-loaded ones are dropped (re-expanding simply re-fetches), except the
// currently-expanded chain and its ancestors, which are always pinned so visible state never
// evicts. Chosen well above a typical open tree depth/breadth so day-to-day nav never evicts.
const DIRECTORY_CACHE_MAX = 50;

// The set of directory paths that must never be evicted: every expanded directory plus all of
// its ancestor directories (root "" included), so the visible tree is always fully cached.
function pinnedDirectoryPaths(expanded: ReadonlySet<string>): Set<string> {
  const pinned = new Set<string>([""]);
  for (const path of expanded) {
    pinned.add(path);
    let parent = entryParent(path);
    while (parent !== null) {
      pinned.add(parent);
      parent = entryParent(parent);
    }
    pinned.add("");
  }
  return pinned;
}

// Evict least-recently-accessed directories beyond the cap. `accessOrder` is oldest-first.
// Pinned paths are retained regardless of age. Returns the pruned map (or the original when
// nothing was evicted) so callers can no-op an unchanged state.
function pruneDirectoryCache(
  directories: Record<string, DirectoryState>,
  accessOrder: readonly string[],
  pinned: ReadonlySet<string>,
): Record<string, DirectoryState> {
  const keys = Object.keys(directories);
  if (keys.length <= DIRECTORY_CACHE_MAX) return directories;
  const evictable = accessOrder.filter(
    (path) => directories[path] !== undefined && !pinned.has(path),
  );
  let toEvict = keys.length - DIRECTORY_CACHE_MAX;
  if (toEvict <= 0 || evictable.length === 0) return directories;
  const next = { ...directories };
  for (const path of evictable) {
    if (toEvict <= 0) break;
    delete next[path];
    toEvict -= 1;
  }
  return toEvict === keys.length - DIRECTORY_CACHE_MAX ? directories : next;
}

export const filesWidgetTestInternals = {
  DIRECTORY_CACHE_MAX,
  DIRECTORY_RENDER_BATCH_SIZE,
  pinnedDirectoryPaths,
  pruneDirectoryCache,
  trimTrailingSeparators,
  parentDir,
  parentRelativePath,
  displayPath,
  contextMenuParentPath,
  gitDirectoryLabelKey,
} as const;

// Parent directory (root-relative) of a tree entry, for scoping a new sibling or a rename target.
function entryParent(path: string): string | null {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? null : path.slice(0, idx);
}

function joinRelative(parent: string | null, name: string): string {
  return parent === null || parent.length === 0 ? name : `${parent}/${name}`;
}

// The directory a new-entry action targets when launched from the context menu: the current
// directory for the empty-background menu, the entry itself for a directory row, or the entry's
// parent for a file row.
function contextMenuParentPath(
  entry: FilesTreeEntry | null,
  currentDirectoryPath: string | null,
): string | null {
  if (entry === null) return currentDirectoryPath;
  // #2906 review (comment 3865167721): a readable symlink-to-directory is expandable/navigable
  // like a real directory (see isExpandableDirectory), so a "New File"/"New Folder" launched from
  // its context-menu row targets ITS path too, not its parent.
  if (isExpandableDirectory(entry)) return entry.path;
  return entryParent(entry.path);
}

function parentDirectoryForWatchPath(relativePath: string | undefined): string {
  if (relativePath === undefined || relativePath.length === 0) return "";
  const idx = relativePath.lastIndexOf("/");
  return idx < 0 ? "" : relativePath.slice(0, idx);
}

// A collision-free "<base> copy<.ext>" name for a duplicate, given the sibling names already present.
function nextCopyName(name: string, existing: ReadonlySet<string>): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = `${base} copy${ext}`;
  let counter = 2;
  while (existing.has(candidate)) {
    candidate = `${base} copy ${String(counter)}${ext}`;
    counter += 1;
  }
  return candidate;
}

// A new entry's name must be a single, safe path segment. The BFF enforces this too; rejecting early
// keeps the inline editor responsive and the error message specific.
function invalidEntryName(name: string, t: I18nTranslate): string | null {
  if (name.length === 0) return t("filesWidget.error.enterName");
  if (name === "." || name === "..") return t("filesWidget.error.reservedName");
  if (/[/\\]/u.test(name)) return t("filesWidget.error.nameContainsSlash");
  return null;
}

function errorMessage(error: unknown, t: I18nTranslate): string {
  return error instanceof Error ? error.message : t("filesWidget.error.unableToReadFolder");
}

function directoryRefusalMessage(error: unknown, t: FilesWidgetTranslate): string | null {
  const cause = error instanceof Error ? error.cause : undefined;
  const apiError = error instanceof ApiError ? error : cause;
  if (!(apiError instanceof ApiError)) return null;
  switch (apiError.code) {
    case "BAD_ROOT":
      return t("tree.absolutePathRequired");
    case "INVALID_DIRECTORY":
    case "NOT_FOUND":
      return t("tree.folderMissing");
    case "DENIED":
      return t("tree.folderDenied");
    default:
      return null;
  }
}

// CSS.escape with a fallback for environments without the CSSOM utility (older jsdom):
// escaping quotes/backslashes is enough for an attribute-value selector.
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}

function fileTreeItemLabelId(prefix: string, path: string): string {
  return `${prefix}-file-${encodeURIComponent(path)}`;
}

// Indent per tree depth. The step equals the caret column (11px caret + 7px row gap), so a
// child level nests exactly one caret width and file rows (which render an invisible caret
// placeholder) align with sibling folders (audit C143/C216).
function treeIndent(depth: number): number {
  return 8 + depth * 18;
}

function treeTooltipPosition(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(12, Math.min(x + 12, window.innerWidth - TREE_TOOLTIP_MAX_WIDTH - 12)),
    y: Math.max(12, Math.min(y + 18, window.innerHeight - 44)),
  };
}

const TREE_NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"]);

// Arrow-key traversal for the file tree (APG tree pattern subset, audit C215). Directory rows use
// a separate caret button for expansion, so Right/Left dispatch to that caret while Enter/Space on
// the row enters the folder.
function focusParentRow(rows: readonly HTMLElement[], index: number): void {
  const level = Number(rows[index]?.getAttribute("aria-level") ?? "1");
  for (let i = index - 1; i >= 0; i -= 1) {
    if (Number(rows[i]?.getAttribute("aria-level") ?? "1") < level) {
      rows[i]?.focus();
      return;
    }
  }
}

function treeAdjacentIndex(index: number, length: number, key: string): number | undefined {
  return new Map([
    ["ArrowDown", index + 1],
    ["ArrowUp", index - 1],
    ["Home", 0],
    ["End", length - 1],
  ]).get(key);
}

function handleTreeExpansionKey(rows: readonly HTMLElement[], index: number, key: string): void {
  const row = rows[index];
  if (row === undefined) return;
  const toggle = row
    .closest(".tr-row-wrap")
    ?.querySelector<HTMLButtonElement>("button.tr-caret-btn");
  const expanded = row.getAttribute("aria-expanded");
  if (key === "ArrowRight") {
    if (expanded === "false") toggle?.click();
    else if (expanded === "true") rows[index + 1]?.focus();
  } else if (key === "ArrowLeft") {
    if (expanded === "true") toggle?.click();
    else focusParentRow(rows, index);
  }
}

function handleTreeNavKey(rows: readonly HTMLElement[], index: number, key: string): void {
  const next = treeAdjacentIndex(index, rows.length, key);
  if (next !== undefined) rows[next]?.focus();
  else handleTreeExpansionKey(rows, index, key);
}

// GEN-UI-KEYBOARD-003 — arrow/Home/End roving among role="menuitem" buttons in the context menu
// (APG menu pattern). Enter/Space activate natively on the focused button.
function handleMenuNavKey(container: HTMLElement, event: ReactKeyboardEvent): void {
  const keys = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);
  if (!keys.has(event.key)) return;
  const items = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'),
  );
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  event.preventDefault();
  const positions = new Map([
    ["ArrowDown", (index + 1 + items.length) % items.length],
    ["ArrowUp", (index - 1 + items.length) % items.length],
    ["Home", 0],
    ["End", items.length - 1],
  ]);
  const next = positions.get(event.key);
  if (next !== undefined) items[next]?.focus();
}

function gitStatusSummary(state: GitStatusState, t: I18nTranslate): string | null {
  if (state.loading && state.status === null) return t("filesWidget.gitStatus.loading");
  if (state.error !== null) return t("filesWidget.gitStatus.unavailable");
  const status = state.status;
  if (status === null) return null;
  if (!status.available) {
    if (status.reason === "not-a-repository") return null;
    return status.state === "unsafe"
      ? t("filesWidget.gitStatus.unsafe")
      : t("filesWidget.gitStatus.repoUnavailable");
  }
  return availableGitSummary(status, t);
}

function availableGitSummary(status: GitRepositoryStatusResponse, t: I18nTranslate): string {
  const branch = status.detached
    ? t("filesWidget.gitStatus.detachedHead")
    : (status.branch ?? t("filesWidget.gitStatus.unknownBranch"));
  if (status.clean) return t("filesWidget.gitStatus.clean", { branch });
  // Audit F-12 — this widget fetches status with includeIgnored so the tree can dim ignored
  // entries, but an ignored entry is not a worktree change. Counting them made the header
  // contradict `git status` (and the Git window, which fetches without includeIgnored).
  const count = status.changes.filter((change) => !isIgnoredGitChange(change)).length;
  // Defensive boundary (#2843 review): the server excludes ignored entries from `clean`, so a
  // not-clean response normally carries at least one visible change. If filtering still removes
  // every entry, the tree shows no changed file either — report that instead of a degenerate
  // "0 changed files".
  if (count === 0) return t("filesWidget.gitStatus.clean", { branch });
  return count === 1
    ? t("filesWidget.gitStatus.changedOne", { branch, count })
    : t("filesWidget.gitStatus.changedMany", { branch, count });
}

function isIgnoredGitChange(change: GitChangedFile): boolean {
  return change.indexStatus === "!" || change.worktreeStatus === "!";
}

function gitChangeDecoration(change: GitChangedFile): GitDecoration {
  if (change.conflicted) {
    return { badge: "U", labelKey: "git.change.conflicted", state: "conflicted" };
  }
  if (change.untracked) {
    return { badge: "?", labelKey: "git.change.untracked", state: "changed" };
  }
  const status = change.indexStatus !== " " ? change.indexStatus : change.worktreeStatus;
  if (status === "M") return { badge: "M", labelKey: "git.change.modified", state: "changed" };
  if (status === "A") return { badge: "A", labelKey: "git.change.added", state: "changed" };
  if (status === "D") return { badge: "D", labelKey: "git.change.deleted", state: "changed" };
  if (status === "R") return { badge: "R", labelKey: "git.change.renamed", state: "changed" };
  if (status === "C") return { badge: "C", labelKey: "git.change.copied", state: "changed" };
  return { badge: status, labelKey: "git.change.unknown", state: "changed" };
}

function addDirectoryAggregate(
  aggregates: Map<string, GitDirectoryAggregate>,
  directoryPath: string,
  change: GitChangedFile,
): void {
  const current = aggregates.get(directoryPath);
  aggregates.set(directoryPath, {
    count: (current?.count ?? 0) + 1,
    conflicted: (current?.conflicted ?? false) || change.conflicted,
    deleted:
      (current?.deleted ?? false) || change.indexStatus === "D" || change.worktreeStatus === "D",
  });
}

function aggregateGitDirectories(
  changes: readonly GitChangedFile[],
): Map<string, GitDirectoryAggregate> {
  // Deleted paths have no tree row, so their nearest visible parent carries the decoration.
  // Renames affect both old and new ancestor chains; a Set avoids double-counting shared parents.
  const aggregates = new Map<string, GitDirectoryAggregate>();
  for (const change of changes) {
    const affectedDirectories = new Set<string>();
    for (const path of [change.path, change.oldPath]) {
      if (path === undefined) continue;
      let parent = entryParent(path);
      while (parent !== null) {
        affectedDirectories.add(parent);
        parent = entryParent(parent);
      }
    }
    for (const parent of affectedDirectories) {
      addDirectoryAggregate(aggregates, parent, change);
    }
  }
  return aggregates;
}

function gitDirectoryLabelKey(aggregate: GitDirectoryAggregate): FilesWidgetMessageKey {
  if (aggregate.conflicted) return "git.folder.conflicted";
  if (aggregate.deleted) return "git.folder.deleted";
  return "git.folder.changed";
}

function gitDirectoryLabel(aggregate: GitDirectoryAggregate, t: FilesWidgetTranslate): string {
  return t(gitDirectoryLabelKey(aggregate), { count: aggregate.count });
}

const filesTreeRequests = new Map<string, Promise<FilesTreeResponse>>();
const gitStatusRequests = new Map<string, Promise<GitRepositoryStatusResponse>>();

function readSharedFilesTree(
  root: string,
  path: string,
  navigation?: FilesNavigationRead,
): Promise<FilesTreeResponse> {
  const key = `${root}\u0000${path}\u0000${navigation?.correlationId ?? ""}`;
  const existing = filesTreeRequests.get(key);
  if (existing !== undefined) return existing;
  const request = observeFilesDirectoryRead(
    (correlationId) => fetchFilesTree(root, path, correlationId),
    navigation,
  ).finally(() => {
    filesTreeRequests.delete(key);
  });
  filesTreeRequests.set(key, request);
  return request;
}

function readSharedGitStatus(root: string): Promise<GitRepositoryStatusResponse> {
  const existing = gitStatusRequests.get(root);
  if (existing !== undefined) return existing;
  const request = fetchGitStatus(root, { includeIgnored: true }).finally(() => {
    gitStatusRequests.delete(root);
  });
  gitStatusRequests.set(root, request);
  return request;
}

interface TreeMutationKeyOptions {
  readonly enabled: boolean;
  readonly findEntry: (path: string) => FilesTreeEntry | null;
  readonly startRename: (entry: FilesTreeEntry) => void;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly setOperationError: Dispatch<SetStateAction<string | null>>;
  readonly setConfirmDelete: Dispatch<SetStateAction<FilesTreeEntry | null>>;
}

function handleTreeMutationKey(
  event: ReactKeyboardEvent<HTMLDivElement>,
  options: TreeMutationKeyOptions,
): boolean {
  if (!options.enabled || (event.key !== "F2" && event.key !== "Delete")) return false;
  const focusedRow =
    event.target instanceof HTMLElement &&
    event.target.matches("[role='treeitem'].tr-row[data-readable='true']")
      ? event.target
      : null;
  const path = focusedRow?.dataset.path;
  const entry = path === undefined ? null : options.findEntry(path);
  if (entry === null) return true;
  event.preventDefault();
  if (event.key === "F2") {
    options.startRename(entry);
    return true;
  }
  options.setOperationError(null);
  options.returnFocusRef.current = focusedRow;
  options.setConfirmDelete(entry);
  return true;
}

function diffLineRecords(diff: string): readonly { readonly key: string; readonly line: string }[] {
  const occurrences = new Map<string, number>();
  return diff.split("\n").map((line) => {
    const occurrence = (occurrences.get(line) ?? 0) + 1;
    occurrences.set(line, occurrence);
    return { line, key: `${line}:${occurrence}` };
  });
}

function configuredFilesRoot(root: string | undefined): string | null {
  const trimmed = root?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}
function fallbackString(primary: string | null, secondary?: string | null): string {
  return primary ?? secondary ?? "";
}
function rootForCache(cacheRoot: string, apiRoot: string, resolved: string | null): string | null {
  return cacheRoot === apiRoot ? resolved : null;
}
function nonemptyRoot(root: string): string | null {
  return root.length > 0 ? root : null;
}
function deliveryRoot(state: GitStatusState): string {
  return state.status?.available === true ? (state.status.repositoryRoot ?? state.status.root) : "";
}
function deliveryAvailable(callback: unknown, state: GitStatusState, root: string): boolean {
  return callback !== undefined && state.status?.available === true && root.length > 0;
}
function visibleFilePath(selected: string | null, active?: string | null): string | null {
  return selected ?? active ?? null;
}
function canMoveEntry(source: string, target: string | null, next: string): boolean {
  return (
    next !== source &&
    entryParent(source) !== target &&
    target !== source &&
    target?.startsWith(`${source}/`) !== true
  );
}
function directoryPath(path: string | null): string {
  return path ?? "";
}
function directoryEntryLabel(
  visibility: EntryVisibility,
  aggregate: GitDirectoryAggregate | undefined,
  t: FilesWidgetTranslate,
): string | undefined {
  if (visibility.label === undefined) return undefined;
  return [visibility.label, aggregate === undefined ? undefined : gitDirectoryLabel(aggregate, t)]
    .filter(Boolean)
    .join(" ");
}
function unreadableDescription(entry: FilesTreeEntry, id: string): string | undefined {
  return entry.readable || entry.kind === "directory" ? undefined : id;
}
function fileVisibilityLabel(
  visibility: EntryVisibility,
  entry: FilesTreeEntry,
  decoration: ReturnType<typeof gitChangeDecoration> | null,
  t: I18nTranslate,
  tGit: FilesWidgetTranslate,
): string | undefined {
  if (visibility.label === undefined) return undefined;
  return [
    visibility.label,
    entry.kind === "symlink" ? t("filesWidget.tree.symlinkBadge") : undefined,
    decoration === null ? undefined : tGit(decoration.labelKey, { path: entry.path }),
    formatBytes(entry.sizeBytes ?? 0),
  ]
    .filter(Boolean)
    .join(" ");
}
function deleteDialogCopy(
  entry: FilesTreeEntry,
  t: I18nTranslate,
): { title: string; body: string } {
  return entry.kind === "directory"
    ? {
        title: t("filesWidget.deleteDialog.titleFolder"),
        body: t("filesWidget.deleteDialog.bodyFolder", { name: entry.name }),
      }
    : {
        title: t("filesWidget.deleteDialog.titleFile"),
        body: t("filesWidget.deleteDialog.bodyFile", { name: entry.name }),
      };
}
function emptyDirectory(state: DirectoryState | undefined): boolean {
  return (
    state !== undefined &&
    !state.loading &&
    state.error === null &&
    state.notice === null &&
    state.entries.length === 0
  );
}

export function FilesWidget({
  root,
  presentation = "directory",
  openingRoot = false,
  activeFilePath,
  openFilesDirectly = false,
  watchActive = true,
  onActiveFileChange,
  onRootChange,
  onOpenFile,
  onOpenGitDelivery,
  onFilesMutated,
  onBeforeEntryMutation,
}: FilesWidgetProps): ReactNode {
  const t = useTranslate();
  const tGit = useFilesWidgetTranslate();
  const configuredRoot = configuredFilesRoot(root);
  const [fallbackRoot, setFallbackRoot] = useState<string | null>(null);
  const apiRoot = fallbackString(configuredRoot, fallbackRoot);
  const apiRootRef = useRef(apiRoot);
  apiRootRef.current = apiRoot;
  const [resolvedRootValue, setResolvedRootValue] = useState<string | null>(null);
  const [directoryRoot, setDirectoryRoot] = useState(apiRoot);
  const resolvedRoot = rootForCache(directoryRoot, apiRoot, resolvedRootValue);
  const effectiveRoot = fallbackString(resolvedRoot, apiRoot);
  // Root bar draft: what the user is typing as the next folder to open. Synced to the resolved
  // (real) root whenever the widget loads a folder, so it always shows where we are.
  const [rootDraft, setRootDraft] = useState<string>("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const navigation = useFilesNavigation(apiRoot, onRootChange);
  const currentDirectoryPath = navigation.path;
  const takeNavigationRead = navigation.takeRead;
  const selectNavigationRoot = navigation.selectRoot;
  const visitDirectory = navigation.visit;
  const previousDirectoryRef = useRef<string | null>(null);
  const currentDirectoryRef = useRef(currentDirectoryPath);
  currentDirectoryRef.current = currentDirectoryPath;
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [directoryRenderLimits, setDirectoryRenderLimits] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([""]));
  const [treeTooltip, setTreeTooltip] = useState<TreeTooltipState | null>(null);
  const activeFileChangeRef = useRef(onActiveFileChange);
  activeFileChangeRef.current = onActiveFileChange;
  // Focus restore (WCAG 2.4.3): closing the preview re-mounts the whole tree, which would drop
  // focus onto document.body. Remember the previewed path on close and put focus back onto its
  // tree row once the tree is rendered again (fallback: the widget container).
  const filesRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusPathRef = useRef<string | null>(null);
  const treeTooltipTimerRef = useRef<number | null>(null);
  const treeTooltipPointerRef = useRef({ x: 0, y: 0 });
  const directoryLoadSeqRef = useRef(0);
  // GEN-PERF-MEMORY-005 — LRU access order (oldest-first) for the directories cache, and a
  // live mirror of `expanded` so the pruning step (run inside loadDirectory) can pin the
  // visible chain without adding `expanded` to loadDirectory's dependency list.
  const directoryAccessOrderRef = useRef<string[]>([]);
  const expandedRef = useRef<ReadonlySet<string>>(new Set([""]));
  expandedRef.current = expanded;
  const touchDirectoryAccess = useCallback((path: string): void => {
    const order = directoryAccessOrderRef.current;
    const existing = order.indexOf(path);
    if (existing >= 0) order.splice(existing, 1);
    order.push(path);
  }, []);
  // Shared ARIA description for unreadable symlink rows (audit C196): the rows stay focusable
  // via aria-disabled, and this single hidden span explains WHY they cannot be opened.
  const unreadableReasonId = useId();
  const fileTreeItemLabelPrefix = useId();
  const [gitStatusState, setGitStatusState] = useState<GitStatusState>({
    loading: false,
    status: null,
    error: null,
  });
  const gitStatusRootRef = useRef<string | null>(null);
  const [gitStatusRevision, setGitStatusRevision] = useState(0);
  const [gitDiffState, setGitDiffState] = useState<GitDiffState | null>(null);
  // File-operation state (new file/folder, rename, delete). `pendingEntry` drives the single inline
  // input reused for all three create/rename flows; `menu` is the right-click context menu; `confirm`
  // gates a destructive delete. All three are mutually exclusive in practice.
  const [pendingEntry, setPendingEntry] = useState<PendingEntry | null>(null);
  const [entryDraft, setEntryDraft] = useState("");
  const [opBusy, setOpBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FilesTreeEntry | null>(null);
  // GEN-UI-FOCUS-002 / GEN-UI-KEYBOARD-003 — the overlay menu and delete dialog render inside the
  // still-mounted tree, so the row that opened them keeps existing; remember it and put focus back
  // there on close (WCAG 2.4.3). `deleteDialogRef` / `menuRef` scope the focus trap and roving.
  const deleteDialogRef = useRef<HTMLDialogElement | null>(null);
  // GEN-UI-FOCUS-002 — containment comes from the shared seam rather than a local copy of the wrap.
  // The dialog disables BOTH of its buttons while the delete is in flight, which drops focus to
  // <body>; a React onKeyDown on the dialog can no longer see the next Tab from there, so the old
  // per-dialog handler let focus escape exactly while the destructive action ran. The shared hook
  // listens on the document and re-enters the dialog instead (Issue #2617).
  useDialogTabTrap(deleteDialogRef);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const confirmDeleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  // Root-relative path of the entry currently being dragged in the tree (null when not dragging).
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const onFilesMutatedRef = useRef(onFilesMutated);
  onFilesMutatedRef.current = onFilesMutated;
  // Read through a ref for the same reason as `onFilesMutated`: the mutation callbacks below would
  // otherwise take a new identity whenever the host's dirty state changes.
  const onBeforeEntryMutationRef = useRef(onBeforeEntryMutation);
  onBeforeEntryMutationRef.current = onBeforeEntryMutation;

  const invalidateGitStatus = useCallback((): void => {
    setGitStatusRevision((revision) => revision + 1);
  }, []);

  // Ask the host whether `path` may be renamed, moved, or deleted. `true` when no host is attached:
  // absence of an owner of open buffers is not a veto. A host that prompts resolves only after the
  // user decides, so the caller must hold its busy flag across the await.
  const mayMutateEntry = useCallback(async (path: string): Promise<boolean> => {
    const consult = onBeforeEntryMutationRef.current;
    return consult === undefined ? true : await consult(path);
  }, []);

  const clearTreeTooltipTimer = useCallback((): void => {
    if (treeTooltipTimerRef.current === null) return;
    window.clearTimeout(treeTooltipTimerRef.current);
    treeTooltipTimerRef.current = null;
  }, []);

  const hideTreeTooltip = useCallback((): void => {
    clearTreeTooltipTimer();
    setTreeTooltip(null);
  }, [clearTreeTooltipTimer]);

  const scheduleTreeTooltip = useCallback(
    (event: ReactPointerEvent<HTMLElement>, text: string): void => {
      clearTreeTooltipTimer();
      setTreeTooltip(null);
      const name = event.currentTarget.querySelector<HTMLElement>(".tr-name");
      if (name === null || name.scrollWidth <= name.clientWidth + 1) return;

      treeTooltipPointerRef.current = { x: event.clientX, y: event.clientY };
      treeTooltipTimerRef.current = window.setTimeout(() => {
        treeTooltipTimerRef.current = null;
        const position = treeTooltipPosition(
          treeTooltipPointerRef.current.x,
          treeTooltipPointerRef.current.y,
        );
        setTreeTooltip({ text, ...position });
      }, TREE_TOOLTIP_DELAY_MS);
    },
    [clearTreeTooltipTimer],
  );

  // GEN-PERF-WIDGET-004 — while a tooltip is visible, pointer motion fired setTreeTooltip on
  // every pointermove (60–120Hz), committing a full FilesWidget re-render (the whole tree,
  // every windowed row). Instead, move the tooltip imperatively: write the portal element's
  // left/top directly and only keep text/visibility in React state. No commit per move.
  const treeTooltipElRef = useRef<HTMLDivElement | null>(null);
  const moveTreeTooltip = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    treeTooltipPointerRef.current = { x: event.clientX, y: event.clientY };
    const el = treeTooltipElRef.current;
    if (el === null) return;
    const position = treeTooltipPosition(event.clientX, event.clientY);
    el.style.left = `${String(position.x)}px`;
    el.style.top = `${String(position.y)}px`;
  }, []);

  useEffect(() => {
    if (selectedPath !== null || gitDiffState !== null) return;
    const path = restoreFocusPathRef.current;
    if (path === null) return;
    restoreFocusPathRef.current = null;
    const row = filesRef.current?.querySelector<HTMLElement>(
      `.tr-file[data-path="${cssEscape(path)}"]`,
    );
    (row ?? filesRef.current)?.focus({ preventScroll: true });
  }, [gitDiffState, selectedPath]);

  useEffect(
    () => () => {
      clearTreeTooltipTimer();
    },
    [clearTreeTooltipTimer],
  );

  useEffect(() => {
    if (configuredRoot !== null) return;
    let cancelled = false;
    void fetchProjects()
      .then((payload) => {
        if (cancelled) return;
        const first = payload.projects.find((project) => project.available)?.path;
        setFallbackRoot(first ?? null);
      })
      .catch(() => {
        if (!cancelled) setFallbackRoot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [configuredRoot]);

  const loadDirectory = useCallback(
    async (path: string): Promise<void> => {
      const requestSeq = directoryLoadSeqRef.current;
      const requestRoot = apiRoot;
      const isStale = (): boolean =>
        requestSeq !== directoryLoadSeqRef.current || requestRoot !== apiRootRef.current;
      if (apiRoot.length === 0) {
        setDirectories((current) => ({
          ...current,
          [path]: {
            entries: [],
            truncated: false,
            loading: false,
            error: null,
            notice: "no-root",
          },
        }));
        return;
      }
      setDirectories((current) => ({
        ...current,
        [path]: {
          entries: current[path]?.entries ?? [],
          truncated: current[path]?.truncated ?? false,
          loading: true,
          error: null,
          notice: null,
        },
      }));
      try {
        const response = await readSharedFilesTree(apiRoot, path, takeNavigationRead(path));
        if (isStale()) return;
        if (path === "") {
          setResolvedRootValue(response.root);
          activeFileChangeRef.current?.(null, response.root, currentDirectoryRef.current);
        }
        touchDirectoryAccess(path);
        setDirectories((current) => {
          const next = {
            ...current,
            [path]: {
              entries: response.entries,
              truncated: response.truncated,
              loading: false,
              error: null,
              notice: null,
            },
          };
          // GEN-PERF-MEMORY-005 — bound the cache, pinning the visible expanded chain.
          return pruneDirectoryCache(
            next,
            directoryAccessOrderRef.current,
            pinnedDirectoryPaths(
              new Set([...expandedRef.current, currentDirectoryRef.current ?? ""]),
            ),
          );
        });
      } catch (error: unknown) {
        if (isStale()) return;
        const refusal = directoryRefusalMessage(error, tGit);
        setDirectories((current) => ({
          ...current,
          [path]: {
            entries: current[path]?.entries ?? [],
            truncated: current[path]?.truncated ?? false,
            loading: false,
            error: refusal ?? t("filesWidget.error.unableToReadFolder"),
            expectedRefusal: refusal !== null,
            correlationId: correlationIdOf(error),
            notice: null,
          },
        }));
      }
    },
    [apiRoot, takeNavigationRead, t, tGit, touchDirectoryAccess],
  );

  useEffect(() => {
    directoryLoadSeqRef.current += 1;
    setDirectoryRoot(apiRoot);
    setSelectedPath(null);
    setGitDiffState(null);
    previousDirectoryRef.current = null;
    activeFileChangeRef.current?.(null, null, null);
    setResolvedRootValue(null);
    setExpanded(new Set([""]));
    setDirectories({});
    setDirectoryRenderLimits({});
    directoryAccessOrderRef.current = [];
    void loadDirectory("");
  }, [apiRoot, loadDirectory]);

  const visibleBaseRoot = effectiveRoot;
  const visibleRootPath = displayPath(visibleBaseRoot, currentDirectoryPath);
  const gitStatusTargetRoot = nonemptyRoot(visibleRootPath);

  useEffect(() => {
    if (gitStatusTargetRoot === null) {
      gitStatusRootRef.current = null;
      setGitStatusState({ loading: false, status: null, error: null });
      return;
    }
    const previousRoot = gitStatusRootRef.current;
    gitStatusRootRef.current = gitStatusTargetRoot;
    let cancelled = false;
    setGitStatusState((current) => ({
      loading: true,
      status: previousRoot === gitStatusTargetRoot ? current.status : null,
      error: null,
    }));
    void readSharedGitStatus(gitStatusTargetRoot)
      .then((status) => {
        if (!cancelled) {
          setGitStatusState({ loading: false, status, error: null });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setGitStatusState({
            loading: false,
            status: null,
            error: errorMessage(error, t),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [gitStatusRevision, gitStatusTargetRoot, t]);

  useEffect(() => {
    const onFocus = (): void => invalidateGitStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [invalidateGitStatus]);

  useEffect((): (() => void) => {
    const onRepositoryStateInvalidated = (event: Event): void => {
      const invalidatedRoots = gitRepositoryStateInvalidationRoots(event);
      const boundRoot = resolvedRoot ?? (apiRoot.length > 0 ? apiRoot : null);
      const repositoryRoot =
        gitStatusState.status?.available === true
          ? (gitStatusState.status.repositoryRoot ?? gitStatusState.status.root)
          : null;
      if (
        !invalidatedRoots.some(
          (root): boolean =>
            root === boundRoot || (repositoryRoot !== null && root === repositoryRoot),
        )
      ) {
        return;
      }
      invalidateGitStatus();
    };
    window.addEventListener(GIT_REPOSITORY_STATE_INVALIDATED_EVENT, onRepositoryStateInvalidated);
    return (): void =>
      window.removeEventListener(
        GIT_REPOSITORY_STATE_INVALIDATED_EVENT,
        onRepositoryStateInvalidated,
      );
  }, [apiRoot, gitStatusState.status, invalidateGitStatus, resolvedRoot]);

  useEffect(() => {
    const onMutation = (event: Event): void => {
      const boundRoot = resolvedRoot ?? (apiRoot.length > 0 ? apiRoot : null);
      const detail = workspaceFileMutationDetail(event);
      if (boundRoot === null || detail?.root !== boundRoot) return;
      invalidateGitStatus();
      void loadDirectory(parentDirectoryForWatchPath(detail.relativePath));
    };
    window.addEventListener(WORKSPACE_FILE_MUTATED_EVENT, onMutation);
    return () => window.removeEventListener(WORKSPACE_FILE_MUTATED_EVENT, onMutation);
  }, [apiRoot, invalidateGitStatus, loadDirectory, resolvedRoot]);

  // Keep the root-bar input showing where we actually are (resolved root + current folder).
  useEffect(() => {
    setRootDraft(visibleRootPath);
  }, [visibleRootPath]);

  const openRoot = useCallback(
    (next: string): void => {
      const target = next.trim();
      if (onRootChange === undefined || target.length === 0) return;
      if (target === apiRoot || target === effectiveRoot) {
        visitDirectory(null);
        setRootDraft(effectiveRoot);
        return;
      }
      if (target === visibleRootPath) return;
      selectNavigationRoot(target);
    },
    [apiRoot, effectiveRoot, selectNavigationRoot, visitDirectory, onRootChange, visibleRootPath],
  );

  const goToDirectory = navigation.visit;
  useEffect((): void => {
    if (directoryRoot !== apiRoot || previousDirectoryRef.current === currentDirectoryPath) return;
    previousDirectoryRef.current = currentDirectoryPath;
    setSelectedPath(null);
    activeFileChangeRef.current?.(null, effectiveRoot, currentDirectoryPath);
    const path = currentDirectoryPath ?? "";
    void loadDirectory(path);
  }, [
    apiRoot,
    currentDirectoryPath,
    directories,
    directoryRoot,
    effectiveRoot,
    loadDirectory,
    resolvedRoot,
  ]);

  const refreshCurrentDirectory = useCallback((): void => {
    setSelectedPath(null);
    invalidateGitStatus();
    void loadDirectory(currentDirectoryPath ?? "");
  }, [currentDirectoryPath, invalidateGitStatus, loadDirectory]);

  const watchRoot = watchActive ? (nonemptyRoot(effectiveRoot) ?? undefined) : undefined;
  const refreshVisibleDirectories = useCallback((): void => {
    const paths = new Set([...expandedRef.current, currentDirectoryRef.current ?? ""]);
    invalidateGitStatus();
    setDirectories((current) =>
      Object.fromEntries(Object.entries(current).filter(([path]) => paths.has(path))),
    );
    for (const path of paths) void loadDirectory(path);
  }, [invalidateGitStatus, loadDirectory]);
  const workspaceWatch = useWorkspaceWatch(
    watchRoot,
    useCallback(
      (event): void => {
        // Rescan/overflow set the consumable snapshot flag; its effect refreshes each visible path.
        if (event.kind === "rescan" || event.kind === "overflow") return;
        if (event.relativePath === "") {
          refreshVisibleDirectories();
          return;
        }
        invalidateGitStatus();
        void loadDirectory(parentDirectoryForWatchPath(event.relativePath));
      },
      [invalidateGitStatus, loadDirectory, refreshVisibleDirectories],
    ),
  );

  const { snapshotRequired, acknowledgeSnapshot } = workspaceWatch;
  useEffect(() => {
    if (!snapshotRequired) return;
    acknowledgeSnapshot();
    refreshVisibleDirectories();
  }, [snapshotRequired, acknowledgeSnapshot, refreshVisibleDirectories]);

  // The root every mutation targets — the resolved real root, or the configured one before it loads.
  const mutationRoot = effectiveRoot;
  const mutationsEnabled = mutationRoot.length > 0;

  const startNewEntry = useCallback(
    (kind: "new-file" | "new-folder", parentPath: string | null): void => {
      setMenu(null);
      setOpError(null);
      setEntryDraft("");
      setPendingEntry({ kind, parentPath });
      // Make sure the folder the new entry lands in is expanded so the inline editor is visible.
      const path = parentPath ?? "";
      setExpanded((current) => (current.has(path) ? current : new Set(current).add(path)));
      if (directories[path] === undefined) void loadDirectory(path);
    },
    [directories, loadDirectory],
  );

  const startRename = useCallback((entry: FilesTreeEntry): void => {
    setMenu(null);
    setOpError(null);
    setEntryDraft(entry.name);
    setPendingEntry({ kind: "rename", path: entry.path, name: entry.name });
  }, []);

  const cancelPendingEntry = useCallback((): void => {
    setPendingEntry(null);
    setEntryDraft("");
    setOpError(null);
  }, []);

  const commitPendingEntry = useCallback(async (): Promise<void> => {
    if (pendingEntry === null || mutationRoot.length === 0 || opBusy) return;
    const name = entryDraft.trim();
    if (pendingEntry.kind === "rename" && name === pendingEntry.name) {
      cancelPendingEntry();
      return;
    }
    const invalid = invalidEntryName(name, t);
    if (invalid !== null) {
      setOpError(invalid);
      return;
    }
    const commitRename = async (pending: { path: string; name: string }): Promise<void> => {
      // Vetoed while the target holds unsaved changes: leave the inline editor open with the typed
      // name so nothing the user entered is lost, and send no request.
      if (!(await mayMutateEntry(pending.path))) return;
      const parent = entryParent(pending.path);
      const result = await renameFilesEntry({
        root: mutationRoot,
        path: pending.path,
        newPath: joinRelative(parent, name),
      });
      setPendingEntry(null);
      setEntryDraft("");
      if (selectedPath === pending.path) setSelectedPath(result.path);
      await loadDirectory(parent ?? "");
      invalidateGitStatus();
      onFilesMutatedRef.current?.({ op: "rename", mutation: result });
    };
    // Derived from the owning union rather than restated: a literal copy drifted from
    // PendingEntry's "new-folder" and broke the keiko-ui typecheck.
    const commitCreate = async (
      pending: Exclude<PendingEntry, { readonly kind: "rename" }>,
    ): Promise<void> => {
      const result = await createFilesEntry({
        root: mutationRoot,
        path: joinRelative(pending.parentPath, name),
        kind: pending.kind === "new-file" ? "file" : "directory",
      });
      setPendingEntry(null);
      setEntryDraft("");
      await loadDirectory(pending.parentPath ?? "");
      invalidateGitStatus();
      if (result.kind === "directory") {
        setExpanded((current) => new Set(current).add(result.path));
      } else if (onOpenFile !== undefined) {
        // Open the freshly created (empty) file so the user can start typing immediately.
        activeFileChangeRef.current?.(result.path, mutationRoot);
        onOpenFile(mutationRoot, result.path);
      }
      onFilesMutatedRef.current?.({ op: "create", mutation: result });
    };
    setOpBusy(true);
    setOpError(null);
    try {
      if (pendingEntry.kind === "rename") await commitRename(pendingEntry);
      else await commitCreate(pendingEntry);
    } catch (error: unknown) {
      setOpError(errorMessage(error, t));
    } finally {
      setOpBusy(false);
    }
  }, [
    cancelPendingEntry,
    entryDraft,
    invalidateGitStatus,
    loadDirectory,
    mayMutateEntry,
    mutationRoot,
    onOpenFile,
    opBusy,
    pendingEntry,
    selectedPath,
    t,
  ]);

  const performDelete = useCallback(
    async (entry: FilesTreeEntry): Promise<void> => {
      if (mutationRoot.length === 0 || opBusy) return;
      setOpBusy(true);
      setOpError(null);
      try {
        // Vetoed while the target (or, for a folder, anything inside it) holds unsaved changes: drop
        // the confirmation too, so declining the unsaved-changes prompt leaves no destructive modal
        // behind and focus returns to the originating tree row.
        if (!(await mayMutateEntry(entry.path))) {
          setConfirmDelete(null);
          return;
        }
        const result = await deleteFilesEntry({ root: mutationRoot, path: entry.path });
        setConfirmDelete(null);
        if (selectedPath === entry.path) setSelectedPath(null);
        await loadDirectory(entryParent(entry.path) ?? "");
        invalidateGitStatus();
        onFilesMutatedRef.current?.({ op: "delete", mutation: result });
      } catch (error: unknown) {
        setOpError(errorMessage(error, t));
      } finally {
        setOpBusy(false);
      }
    },
    [invalidateGitStatus, loadDirectory, mayMutateEntry, mutationRoot, opBusy, selectedPath, t],
  );

  const duplicateEntry = useCallback(
    async (entry: FilesTreeEntry): Promise<void> => {
      if (mutationRoot.length === 0 || opBusy) return;
      const parent = entryParent(entry.path);
      const existing = new Set((directories[parent ?? ""]?.entries ?? []).map((row) => row.name));
      const destPath = joinRelative(parent, nextCopyName(entry.name, existing));
      setMenu(null);
      setOpBusy(true);
      setOpError(null);
      try {
        const result = await copyFilesEntry({
          root: mutationRoot,
          sourcePath: entry.path,
          destPath,
        });
        await loadDirectory(parent ?? "");
        invalidateGitStatus();
        // A copy adds a new entry — the host treats it like a create (no open tab to re-home).
        onFilesMutatedRef.current?.({ op: "create", mutation: result });
      } catch (error: unknown) {
        setOpError(errorMessage(error, t));
      } finally {
        setOpBusy(false);
      }
    },
    [directories, invalidateGitStatus, loadDirectory, mutationRoot, opBusy, t],
  );

  // Drag-move: dropping an entry onto a folder renames it into that folder (move = rename).
  const moveEntry = useCallback(
    async (sourcePath: string, targetDir: string | null): Promise<void> => {
      if (mutationRoot.length === 0 || opBusy) return;
      const name = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
      const newPath = joinRelative(targetDir, name);
      // No-op when dropped onto its own current directory, onto itself, or into its own subtree.
      if (!canMoveEntry(sourcePath, targetDir, newPath)) return;
      setOpBusy(true);
      setOpError(null);
      try {
        // A move is a rename, so it orphans an unsaved buffer exactly the same way: ask first.
        if (!(await mayMutateEntry(sourcePath))) return;
        const result = await renameFilesEntry({ root: mutationRoot, path: sourcePath, newPath });
        await loadDirectory(directoryPath(entryParent(sourcePath)));
        await loadDirectory(directoryPath(targetDir));
        invalidateGitStatus();
        onFilesMutatedRef.current?.({ op: "rename", mutation: result });
      } catch (error: unknown) {
        setOpError(errorMessage(error, t));
      } finally {
        setOpBusy(false);
      }
    },
    [invalidateGitStatus, loadDirectory, mayMutateEntry, mutationRoot, opBusy, t],
  );

  const openContextMenu = useCallback(
    (event: ReactMouseEvent, entry: FilesTreeEntry | null): void => {
      if (!mutationsEnabled || (entry?.kind === "directory" && !entry.readable)) return;
      event.preventDefault();
      event.stopPropagation();
      // Remember the row the menu opened on so focus returns there on close (GEN-UI-KEYBOARD-003).
      const opener =
        event.currentTarget instanceof HTMLElement
          ? event.currentTarget.closest<HTMLElement>("[role='treeitem'].tr-row")
          : null;
      menuReturnFocusRef.current =
        opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setOpError(null);
      setMenu({ x: event.clientX, y: event.clientY, entry });
    },
    [mutationsEnabled],
  );

  // Close the context menu on any outside interaction or Escape while it is open.
  useEffect(() => {
    if (menu === null) return;
    const close = (): void => setMenu(null);
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // GEN-UI-KEYBOARD-003 — move focus into the menu (first menuitem) on open, and return it to the
  // originating row on close so keyboard users are never stranded on document.body (WCAG 2.4.3).
  useEffect(() => {
    if (menu === null) {
      const opener = menuReturnFocusRef.current;
      // A menu action that opens the delete dialog owns the restore (it copied the opener into
      // confirmDeleteReturnFocusRef); leave its ref intact and let the delete effect handle focus.
      if (confirmDelete !== null) return;
      menuReturnFocusRef.current = null;
      // Only restore if focus is still on <body> — the menuitem unmounted and nothing else (an
      // inline editor's autoFocus input, say) has since claimed focus.
      if (opener !== null && document.activeElement === document.body) {
        opener.focus({ preventScroll: true });
      }
      return;
    }
    menuRef.current
      ?.querySelector<HTMLButtonElement>('button[role="menuitem"]')
      ?.focus({ preventScroll: true });
  }, [menu, confirmDelete]);

  // GEN-UI-FOCUS-002 — focus the delete dialog on open (the Delete button) and restore focus to
  // the originating tree row on close (WCAG 2.4.3). Tab containment comes from useDialogTabTrap
  // above; here we only manage entering/leaving the dialog.
  useEffect(() => {
    if (confirmDelete === null) {
      const opener = confirmDeleteReturnFocusRef.current;
      confirmDeleteReturnFocusRef.current = null;
      if (opener !== null && document.activeElement === document.body) {
        opener.focus({ preventScroll: true });
      }
      return;
    }
    // Prefer the Delete (primary) button; fall back to the first focusable control.
    const dialog = deleteDialogRef.current;
    const primary = dialog?.querySelector<HTMLButtonElement>("button.ed-reload");
    (primary ?? dialog?.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
  }, [confirmDelete]);

  // WCAG 2.1.2 — Escape cancels the destructive confirm. A document listener rather than a JSX
  // onKeyDown for the same reason the Tab trap moved: while the delete is in flight both buttons are
  // disabled and focus sits on <body>, where no handler bound to the dialog subtree can ever run.
  useEffect(() => {
    if (confirmDelete === null) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || opBusy) return;
      event.preventDefault();
      setConfirmDelete(null);
      setOpError(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [confirmDelete, opBusy]);

  const goUp = useCallback((): void => {
    if (currentDirectoryPath !== null) {
      goToDirectory(parentRelativePath(currentDirectoryPath));
      return;
    }
    const parent = parentDir(effectiveRoot);
    if (parent !== null) openRoot(parent);
  }, [currentDirectoryPath, effectiveRoot, goToDirectory, openRoot]);

  const toggleDirectory = (entry: FilesTreeEntry): void => {
    if (!entry.readable) return;
    const wasOpen = expanded.has(entry.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!wasOpen) {
      // GEN-PERF-MEMORY-005 — mark re-expand as recent use so a still-cached directory is
      // not the first to be evicted; a fetch only happens when its cache entry was evicted.
      touchDirectoryAccess(entry.path);
      if (directories[entry.path] === undefined) {
        void loadDirectory(entry.path);
      }
    }
  };

  const enterDirectory = (entry: FilesTreeEntry): void => {
    if (!entry.readable) return;
    if (presentation === "project") {
      toggleDirectory(entry);
      return;
    }
    goToDirectory(entry.path);
  };

  const retryDirectory = (path: string): void => {
    void loadDirectory(path);
  };

  const showMoreDirectoryEntries = (path: string, entriesCount: number): void => {
    setDirectoryRenderLimits((current) => {
      const currentLimit = current[path] ?? DIRECTORY_RENDER_BATCH_SIZE;
      const nextLimit = Math.min(entriesCount, currentLimit + DIRECTORY_RENDER_BATCH_SIZE);
      return nextLimit > currentLimit ? { ...current, [path]: nextLimit } : current;
    });
  };

  const openDiff = useCallback(
    (path: string): void => {
      if (gitStatusTargetRoot === null) return;
      const gitPath = gitPathFromTreePath(currentDirectoryPath, path);
      setSelectedPath(null);
      setGitDiffState({ path, loading: true, response: null, error: null });
      void fetchGitDiff({ root: gitStatusTargetRoot, path: gitPath })
        .then((response) => {
          setGitDiffState({ path, loading: false, response, error: null });
        })
        .catch((error: unknown) => {
          setGitDiffState({ path, loading: false, response: null, error: errorMessage(error, t) });
        });
    },
    [currentDirectoryPath, gitStatusTargetRoot, t],
  );

  // Locate a loaded tree entry by its root-relative path, across every fetched directory level.
  const findEntry = useCallback(
    (path: string): FilesTreeEntry | null => {
      for (const dir of Object.values(directories)) {
        const found = dir.entries.find((entry) => entry.path === path);
        if (found !== undefined) return found;
      }
      return null;
    },
    [directories],
  );

  // Arrow-key navigation across the currently visible rows (audit C215). Scope-connect pills
  // are intentionally NOT part of the arrow order — only `.tr-row` treeitems are traversed.
  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // F2 renames and Delete removes the focused readable row (VS Code parity), reusing the same
    // inline-edit / confirm flows as the context menu.
    if (
      handleTreeMutationKey(event, {
        enabled: mutationsEnabled,
        findEntry,
        startRename,
        returnFocusRef: confirmDeleteReturnFocusRef,
        setOperationError: setOpError,
        setConfirmDelete,
      })
    )
      return;
    if (!TREE_NAV_KEYS.has(event.key)) return;
    const target = event.target;
    const row =
      target instanceof HTMLElement && target.matches("[role='treeitem'].tr-row") ? target : null;
    if (row === null) return;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role='treeitem'].tr-row"),
    );
    const index = rows.indexOf(row);
    if (index < 0) return;
    event.preventDefault();
    handleTreeNavKey(rows, index, event.key);
  };

  // Memoize the conditional so its identity is stable across renders (keeps the gitChangeByPath
  // Map memo below from rebuilding every render), and satisfies react-hooks/exhaustive-deps.
  const gitChanges: readonly GitChangedFile[] = useMemo(
    () =>
      gitStatusState.status?.available === true
        ? gitStatusState.status.changes.filter((change) => !isIgnoredGitChange(change))
        : [],
    [gitStatusState.status],
  );
  const ignoredGitPaths = useMemo(
    () =>
      new Set(
        gitStatusState.status?.available === true
          ? [
              ...(gitStatusState.status.selectedRootIgnored === true
                ? [currentDirectoryPath ?? ""]
                : []),
              ...gitStatusState.status.changes
                .filter(isIgnoredGitChange)
                .map((change) => treePathFromGitPath(currentDirectoryPath, change.path)),
            ]
          : [],
      ),
    [currentDirectoryPath, gitStatusState.status],
  );
  const unversionedGitPaths = useMemo(
    () =>
      new Set([
        ...gitChanges
          .filter(
            (change) =>
              change.untracked || change.indexStatus === "?" || change.worktreeStatus === "?",
          )
          .map((change) => treePathFromGitPath(currentDirectoryPath, change.path)),
        ...(gitStatusState.status?.untrackedDirectories ?? []).map((path) =>
          treePathFromGitPath(currentDirectoryPath, path),
        ),
      ]),
    [currentDirectoryPath, gitChanges, gitStatusState.status],
  );
  // GEN-PERF-WIDGET-004 — memoize the path->change Map on [gitChanges] so it is not rebuilt
  // over all (up to 500) git changes on every render (incl. every pointermove-driven one).
  const gitChangeByPath = useMemo(
    () =>
      new Map<string, GitChangedFile>(
        gitChanges.map((change): [string, GitChangedFile] => [
          treePathFromGitPath(currentDirectoryPath, change.path),
          change,
        ]),
      ),
    [currentDirectoryPath, gitChanges],
  );
  const gitDirectoryByPath = useMemo(() => {
    const relativeAggregates = aggregateGitDirectories(gitChanges);
    return new Map(
      Array.from(relativeAggregates, ([path, aggregate]) => [
        treePathFromGitPath(currentDirectoryPath, path),
        aggregate,
      ]),
    );
  }, [currentDirectoryPath, gitChanges]);
  const gitSummary = gitStatusSummary(gitStatusState, t);
  const gitDeliveryRoot = deliveryRoot(gitStatusState);
  const canOpenGitDelivery = deliveryAvailable(onOpenGitDelivery, gitStatusState, gitDeliveryRoot);
  const activeTreePath = visibleFilePath(selectedPath, activeFilePath);

  // GEN-PERF-WIDGET-004 — a path->row-index lookup per loaded directory, memoized on
  // [directories], so renderLimitForDirectory does O(1) Map lookups instead of up to two
  // entries.findIndex scans (over as many as ~1000 entries) per expanded directory per render.
  const directoryIndexByPath = useMemo(() => {
    const byDir = new Map<string, Map<string, number>>();
    for (const [dirPath, state] of Object.entries(directories)) {
      const index = new Map<string, number>();
      state.entries.forEach((entry, i) => index.set(entry.path, i));
      byDir.set(dirPath, index);
    }
    return byDir;
  }, [directories]);

  const renderLimitForDirectory = (path: string, entries: readonly FilesTreeEntry[]): number => {
    const configuredLimit = directoryRenderLimits[path] ?? DIRECTORY_RENDER_BATCH_SIZE;
    const index = directoryIndexByPath.get(path);
    const activeIndex = activeTreePath === null ? -1 : (index?.get(activeTreePath) ?? -1);
    const pendingIndex =
      pendingEntry?.kind === "rename" ? (index?.get(pendingEntry.path) ?? -1) : -1;
    return Math.min(entries.length, Math.max(configuredLimit, activeIndex + 1, pendingIndex + 1));
  };

  const hasUnreadableVisibleLink = (path: string): boolean => {
    const entries = directories[path]?.entries ?? [];
    const limit = renderLimitForDirectory(path, entries);
    return entries.slice(0, limit).some((entry) => {
      if (!entry.readable && entry.kind !== "directory") return true;
      return (
        entry.readable &&
        isExpandableDirectory(entry) &&
        expanded.has(entry.path) &&
        hasUnreadableVisibleLink(entry.path)
      );
    });
  };

  // One inline input reused for new file / new folder / rename, styled with the existing root-bar
  // input class so no globals.css change is needed (keeps the #1300 proof gate untouched).
  const renderInlineEditor = (depth: number, icon: ReactNode, ariaLabel: string): ReactNode => (
    <div className="tr-row-wrap" key="__files-inline-editor__">
      <div className="tr-dir-line" style={{ paddingLeft: treeIndent(depth) }}>
        <span className="tr-caret tr-caret-ghost" aria-hidden="true">
          <ChevronRIcon size={11} />
        </span>
        {icon}
        <input
          className="files-root-input mono"
          style={{ flex: 1, minWidth: 0 }}
          aria-label={ariaLabel}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the inline editor is opened on demand.
          autoFocus
          spellCheck={false}
          disabled={opBusy}
          value={entryDraft}
          onChange={(event) => setEntryDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitPendingEntry();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelPendingEntry();
            }
          }}
          onBlur={() => {
            // A blur that is not the result of an in-flight commit discards the draft (click-away).
            if (!opBusy) cancelPendingEntry();
          }}
        />
      </div>
      {opError !== null ? (
        <div className="files-error" role="alert" style={{ marginLeft: treeIndent(depth) }}>
          <span>{opError}</span>
        </div>
      ) : null}
    </div>
  );

  const openFileEntry = (entry: FilesTreeEntry): void => {
    if (!entry.readable) return;
    const fileRoot = effectiveRoot;
    if (openFilesDirectly && onOpenFile !== undefined) {
      activeFileChangeRef.current?.(entry.path, fileRoot);
      onOpenFile(fileRoot, entry.path);
      return;
    }
    setSelectedPath(entry.path);
    activeFileChangeRef.current?.(entry.path, fileRoot);
  };

  const visibilityOf = (entry: FilesTreeEntry): EntryVisibility => {
    const hidden = entry.name.startsWith(".");
    const ignored = markedGitPath(entry.path, ignoredGitPaths);
    const unversioned = markedGitPath(entry.path, unversionedGitPaths);
    const muted = !entry.readable || ignored || (presentation === "project" ? unversioned : hidden);
    const labels = entryVisibilityLabels(entry, { hidden, ignored, unversioned }, tGit);
    return {
      hidden,
      ignored,
      unversioned,
      muted,
      label: labels.length > 0 ? [entry.name, ...labels].join(", ") : undefined,
      tooltip: labels.length > 0 ? labels.join(", ") : undefined,
    };
  };

  const renderDirectoryBadge = (gitAggregate: GitDirectoryAggregate | undefined): ReactNode =>
    gitAggregate !== undefined ? (
      <span
        className="tr-badge tr-git"
        data-git-state={gitAggregate.conflicted ? "conflicted" : "aggregate"}
        aria-label={gitDirectoryLabel(gitAggregate, tGit)}
        title={gitDirectoryLabel(gitAggregate, tGit)}
        style={
          gitAggregate.conflicted
            ? { outline: "1px solid currentColor", fontWeight: 700 }
            : undefined
        }
      >
        {gitAggregate.conflicted ? "U" : "Δ"}
      </span>
    ) : null;

  const renderDirectoryEntry = (
    entry: FilesTreeEntry,
    depth: number,
    entryTip: string,
  ): ReactNode => {
    const open = expanded.has(entry.path);
    const state = directories[entry.path];
    const gitAggregate = gitDirectoryByPath.get(entry.path);
    const visibility = visibilityOf(entry);
    return (
      <div className="tr-row-wrap" key={entry.path}>
        <div className="tr-dir-line" style={{ paddingLeft: treeIndent(depth) }}>
          <button
            className="tr-caret-btn"
            type="button"
            tabIndex={-1}
            disabled={!entry.readable}
            // role="tree" may own only treeitem/group, so an assistive-technology-visible caret
            // button is an invalid owned child and axe fails aria-required-children (#2605). The
            // caret is a pointer-only duplicate: the row's own treeitem carries aria-expanded and
            // Arrow Right/Left operate expansion by dispatching to this button, so hiding it from
            // the accessibility tree removes the invalid child without removing any capability.
            // The aria-label stays as the DOM hook that pointer-level tests locate it by.
            aria-hidden="true"
            aria-label={t(
              open ? "filesWidget.tree.collapseFolder" : "filesWidget.tree.expandFolder",
              { name: entry.name },
            )}
            onClick={() => toggleDirectory(entry)}
          >
            <span className="tr-caret" data-open={open}>
              <ChevronRIcon size={11} />
            </span>
          </button>
          <button
            className={`tr-row tr-dir-enter ${presentationStyles.cmpEntry}`}
            role="treeitem"
            aria-level={depth + 1}
            aria-label={directoryEntryLabel(visibility, gitAggregate, tGit)}
            data-hidden={visibility.hidden || undefined}
            data-git-ignored={visibility.ignored || undefined}
            data-unversioned={visibility.unversioned || undefined}
            data-muted={visibility.muted}
            aria-selected={currentDirectoryPath === entry.path}
            data-active={currentDirectoryPath === entry.path}
            data-readable={entry.readable}
            data-path={entry.path}
            type="button"
            draggable={mutationsEnabled && entry.readable}
            aria-disabled={entry.readable ? undefined : true}
            aria-describedby={unreadableDescription(entry, unreadableReasonId)}
            aria-expanded={open}
            onPointerEnter={(event) => scheduleTreeTooltip(event, entryTip)}
            onPointerMove={moveTreeTooltip}
            onPointerLeave={hideTreeTooltip}
            onBlur={hideTreeTooltip}
            onClick={() => enterDirectory(entry)}
            onContextMenu={(event) => openContextMenu(event, entry)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", entry.path);
              setDraggedPath(entry.path);
            }}
            onDragEnd={() => setDraggedPath(null)}
            onDragOver={(event) => {
              if (entry.readable && draggedPath !== null && draggedPath !== entry.path) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const source = draggedPath;
              setDraggedPath(null);
              if (source !== null) void moveEntry(source, entry.path);
            }}
          >
            <span
              className={`fi-fallback ${presentationStyles.cmpFolderIcon} ${presentationStyles.cmpIcon}`}
            >
              <FolderIcon size={14} />
            </span>
            <span className={`tr-name tr-folder ${presentationStyles.cmpName}`}>{entry.name}</span>
            {renderDirectoryBadge(gitAggregate)}
          </button>
        </div>
        {open ? renderDirectory(entry.path, depth + 1, state) : null}
      </div>
    );
  };

  const fileEntryIds = (
    entry: FilesTreeEntry,
    decoration: ReturnType<typeof gitChangeDecoration> | null,
  ): {
    nameId: string;
    symlinkId: string;
    gitBadgeId: string;
    metaId: string;
    labelledBy: string;
  } => {
    const labelIdBase = fileTreeItemLabelId(fileTreeItemLabelPrefix, entry.path);
    const nameId = `${labelIdBase}-name`;
    const symlinkId = `${labelIdBase}-symlink`;
    const gitBadgeId = `${labelIdBase}-git`;
    const metaId = `${labelIdBase}-meta`;
    const labelledBy = [
      nameId,
      ...(entry.kind === "symlink" ? [symlinkId] : []),
      ...(decoration === null ? [] : [gitBadgeId]),
      metaId,
    ].join(" ");
    return { nameId, symlinkId, gitBadgeId, metaId, labelledBy };
  };

  const renderFileEntry = (entry: FilesTreeEntry, depth: number, entryTip: string): ReactNode => {
    const change = gitChangeByPath.get(entry.path);
    const visibility = visibilityOf(entry);
    const ignored = visibility.ignored;
    const decoration = change === undefined ? null : gitChangeDecoration(change);
    const { nameId, symlinkId, gitBadgeId, metaId, labelledBy } = fileEntryIds(entry, decoration);
    return (
      <div
        className={`tr-row tr-file ${presentationStyles.cmpEntry}`}
        key={entry.path}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={activeTreePath === entry.path}
        aria-label={fileVisibilityLabel(visibility, entry, decoration, t, tGit)}
        aria-labelledby={visibility.label === undefined ? labelledBy : undefined}
        aria-disabled={entry.readable ? undefined : true}
        aria-describedby={entry.readable ? undefined : unreadableReasonId}
        tabIndex={0}
        data-active={activeTreePath === entry.path}
        data-readable={entry.readable}
        data-path={entry.path}
        data-hidden={visibility.hidden || undefined}
        data-git-ignored={ignored || undefined}
        data-unversioned={visibility.unversioned || undefined}
        data-muted={visibility.muted}
        draggable={mutationsEnabled && entry.readable}
        onContextMenu={(event) => openContextMenu(event, entry)}
        onPointerEnter={(event) => scheduleTreeTooltip(event, entryTip)}
        onPointerMove={moveTreeTooltip}
        onPointerLeave={hideTreeTooltip}
        onBlur={hideTreeTooltip}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", entry.path);
          setDraggedPath(entry.path);
        }}
        onDragEnd={() => setDraggedPath(null)}
        onClick={() => openFileEntry(entry)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          openFileEntry(entry);
        }}
        style={{ paddingLeft: treeIndent(depth) }}
      >
        <span className="tr-caret tr-caret-ghost" aria-hidden="true">
          <ChevronRIcon size={11} />
        </span>
        {visibility.muted ? (
          <span className={`fi-fallback ${presentationStyles.cmpIcon}`}>
            <FileGlyphIcon size={14} />
          </span>
        ) : (
          <FileIcon name={entry.name} />
        )}
        <span className={`tr-name ${presentationStyles.cmpName}`} id={nameId}>
          {entry.name}
        </span>
        {entry.kind === "symlink" ? (
          <span className="tr-badge" id={symlinkId}>
            {t("filesWidget.tree.symlinkBadge")}
          </span>
        ) : null}
        {decoration !== null ? (
          <span
            className="tr-badge tr-git"
            id={gitBadgeId}
            data-git-state={decoration.state}
            aria-label={tGit(decoration.labelKey, { path: entry.path })}
            title={tGit(decoration.labelKey, { path: entry.path })}
            style={
              decoration.state === "conflicted"
                ? { outline: "1px solid currentColor", fontWeight: 700 }
                : undefined
            }
          >
            {decoration.badge}
          </span>
        ) : null}
        <span className="tr-meta mono" id={metaId}>
          {formatBytes(entry.sizeBytes ?? 0)}
        </span>
        {change !== undefined && entry.readable ? (
          <button
            className="tr-git-diff"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openDiff(entry.path);
            }}
            aria-label={t("filesWidget.tree.viewGitDiff", { path: entry.path })}
          >
            <DiffIcon size={13} />
          </button>
        ) : null}
      </div>
    );
  };

  const entryTooltip = (entry: FilesTreeEntry): string => {
    const unreadableTitle = t("filesWidget.tree.unreadableLinkReason");
    let baseTip = entry.path;
    if (!entry.readable) {
      baseTip = entry.kind === "directory" ? tGit("tree.unavailable") : unreadableTitle;
    }
    const visibility = visibilityOf(entry);
    const entryTip =
      !entry.readable && entry.kind === "directory"
        ? (visibility.tooltip ?? baseTip)
        : [baseTip, visibility.tooltip].filter(Boolean).join(" — ");
    return entryTip;
  };

  const renderEntry = (entry: FilesTreeEntry, depth: number): ReactNode => {
    if (pendingEntry?.kind === "rename" && pendingEntry.path === entry.path) {
      const icon = isExpandableDirectory(entry) ? (
        <span className="fi-fallback" style={{ color: "var(--accent)" }}>
          <FolderIcon size={14} />
        </span>
      ) : (
        <FileIcon name={entryDraft.length > 0 ? entryDraft : entry.name} />
      );
      return renderInlineEditor(
        depth,
        icon,
        t("filesWidget.tree.renameAriaLabel", { name: entry.name }),
      );
    }
    const entryTip = entryTooltip(entry);
    // #2906 review (comment 3865167721): a readable symlink-to-directory (kind: "symlink",
    // symlinkTargetKind: "directory") is server-listable exactly like a real directory, so it must
    // route through renderDirectoryEntry -- which is already written generically against `entry`
    // (path/readable/symlink), not `entry.kind` -- for expansion, click-to-enter, context menu,
    // and drag/drop. Routing it into renderFileEntry instead turned it into a broken file-open.
    return isExpandableDirectory(entry)
      ? renderDirectoryEntry(entry, depth, entryTip)
      : renderFileEntry(entry, depth, entryTip);
  };

  // role="tree" may own only treeitem and group children, so every status note, error block,
  // inline editor and load-more control is an invalid owned child of the tree element itself and
  // fails axe's aria-required-children (#2605). Splitting a directory into its chrome and its rows
  // lets the ROOT level put only rows inside role="tree" and keep the chrome outside it. Nested
  // levels are unaffected: they render into role="group", which has no required children.
  const directoryNotices = (
    path: string,
    depth: number,
    state: DirectoryState | undefined,
  ): ReactNode => {
    return (
      <>
        {state?.loading === true ? (
          <output
            className="files-note"
            style={{ ...NATIVE_BLOCK_STYLE, paddingLeft: treeIndent(depth) + 18 }}
          >
            {t("filesWidget.directory.loading")}
          </output>
        ) : null}
        {state?.notice === "no-root" ? (
          <output
            className="files-note"
            style={{ ...NATIVE_BLOCK_STYLE, paddingLeft: treeIndent(depth) + 18 }}
          >
            {onRootChange !== undefined
              ? t("filesWidget.directory.noRootPrompt")
              : t("filesWidget.directory.noProjectAvailable")}
          </output>
        ) : null}
        {state?.error !== null && state?.error !== undefined ? (
          <div className="files-error" role="alert" style={{ marginLeft: treeIndent(depth) }}>
            <span>{state.error}</span>
            {state.expectedRefusal === true ? null : (
              <>
                <button type="button" className="files-retry" onClick={() => retryDirectory(path)}>
                  {t("filesWidget.directory.retry")}
                </button>
                <SupportReportButton correlationId={state.correlationId} compact />
              </>
            )}
          </div>
        ) : null}
        {/* Truncation notice sits ABOVE the rows so it is visible as soon as the folder opens
          (audit C353 — below 1000 rows it sat ~24,000px outside the viewport). The count comes
          from the response instead of a hardcoded "1000": the server also truncates early when
          its ignored-entry scan cap is hit, i.e. with fewer visible entries (audit C350). */}
        {state?.truncated === true ? (
          <output
            className="files-note files-warning"
            style={{ ...NATIVE_BLOCK_STYLE, paddingLeft: treeIndent(depth) + 18 }}
          >
            {t("filesWidget.directory.truncated", { count: state.entries.length })}
          </output>
        ) : null}
        {pendingEntry !== null &&
        pendingEntry.kind !== "rename" &&
        (pendingEntry.parentPath ?? "") === path
          ? renderInlineEditor(
              depth,
              pendingEntryDraftIcon(pendingEntry.kind, entryDraft),
              pendingEntryDraftLabel(pendingEntry.kind, t),
            )
          : null}
      </>
    );
  };
  const directoryTrailer = (
    path: string,
    depth: number,
    state: DirectoryState | undefined,
    entries: readonly FilesTreeEntry[],
    hiddenCount: number,
  ): ReactNode => {
    return (
      <>
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="files-load-more"
            style={{ marginLeft: treeIndent(depth) + 18 }}
            onClick={() => showMoreDirectoryEntries(path, entries.length)}
          >
            {t("filesWidget.directory.showMore", {
              count: Math.min(DIRECTORY_RENDER_BATCH_SIZE, hiddenCount),
            })}
          </button>
        ) : null}
        {emptyDirectory(state) ? (
          <output
            className="files-note"
            style={{ ...NATIVE_BLOCK_STYLE, paddingLeft: treeIndent(depth) + 18 }}
          >
            {t("filesWidget.directory.empty")}
          </output>
        ) : null}
      </>
    );
  };

  const directorySections = (
    path: string,
    depth: number,
    state = directories[path],
  ): { readonly notices: ReactNode; readonly rows: ReactNode; readonly trailer: ReactNode } => {
    const entries = state?.entries ?? [];
    const visibleCount = renderLimitForDirectory(path, entries);
    const hiddenCount = entries.length - visibleCount;
    const visibleEntries = hiddenCount > 0 ? entries.slice(0, visibleCount) : entries;
    const notices = directoryNotices(path, depth, state);
    const trailer = directoryTrailer(path, depth, state, entries, hiddenCount);
    return {
      notices,
      rows: <>{visibleEntries.map((entry) => renderEntry(entry, depth))}</>,
      trailer,
    };
  };

  // Nested levels render into role="group" so the treeitem hierarchy stays exposed (audit C143).
  // group has no required children, so a nested directory keeps its chrome inline.
  //
  // S6819 asks for a native element instead of role="group". None exists for this position: the
  // ARIA tree pattern requires a nested level to be exactly role="group" so its treeitems stay
  // owned by the tree, and <details>/<fieldset>/<optgroup>/<address> would each introduce semantics
  // a tree level must not have. Removing the role flattens the hierarchy and puts this level's
  // notices back under role="tree" — the #2605 defect this file just repaired.
  const renderDirectory = (path: string, depth: number, state = directories[path]): ReactNode => {
    const { notices, rows, trailer } = directorySections(path, depth, state);
    return (
      <div // NOSONAR typescript:S6819 — required ARIA tree level, see the note above.
        className="tr-dir"
        role="group"
      >
        {notices}
        {rows}
        {trailer}
      </div>
    );
  };

  const renderGitDiffView = (state: GitDiffState): ReactNode => {
    const diff = state.response?.diff ?? "";
    return (
      <div className="fpv" ref={filesRef} tabIndex={-1}>
        <div className="fpv-bar">
          <button
            className="fpv-back"
            type="button"
            onClick={() => {
              restoreFocusPathRef.current = state.path;
              setGitDiffState(null);
            }}
            title={t("filesWidget.diff.backToFiles")}
            aria-label={t("filesWidget.diff.backToFiles")}
          >
            <BackIcon size={15} />
          </button>
          <DiffIcon size={15} />
          <span className="fpv-name" title={state.path}>
            {state.path}
          </span>
          <span className="fpv-lang mono">{t("filesWidget.diff.langLabel")}</span>
          <span className="spacer" />
          <button
            className="fpv-back"
            type="button"
            onClick={() => {
              restoreFocusPathRef.current = state.path;
              setGitDiffState(null);
            }}
            title={t("filesWidget.diff.close")}
            aria-label={t("filesWidget.diff.close")}
          >
            <CloseIcon size={15} />
          </button>
        </div>
        {state.loading ? (
          <output className="fpv-state" style={NATIVE_BLOCK_STYLE}>
            {t("filesWidget.diff.loading")}
          </output>
        ) : null}
        {state.error !== null ? (
          <div className="fpv-state fpv-error" role="alert">
            <span>{state.error}</span>
          </div>
        ) : null}
        {state.response?.truncated === true ? (
          <div className="fpv-banner">
            {t("filesWidget.diff.truncated", {
              size: formatBytes(state.response.maxBytes),
            })}
          </div>
        ) : null}
        {state.response !== null ? (
          <section
            className={`fpv-code mono ${selectableTextStyles["cmp-selectable-text"]}`}
            // Issue #2710 — diff text must be selectable and its copy native.
            data-text-selectable="true"
            // Scrollable diff pane: tabIndex makes the overflow region keyboard-scrollable.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            aria-label={t("filesWidget.diff.regionLabel", { path: state.path })}
          >
            {diff.length > 0 ? (
              diffLineRecords(diff).map(({ line, key }) => (
                <div className="fpv-line" key={key}>
                  <span className="fpv-src">{line.length > 0 ? line : " "}</span>
                </div>
              ))
            ) : (
              <div className="fpv-line">
                <span className="fpv-src">{t("filesWidget.diff.empty")}</span>
              </div>
            )}
          </section>
        ) : null}
      </div>
    );
  };

  if (gitDiffState !== null) {
    return renderGitDiffView(gitDiffState);
  }

  if (selectedPath !== null) {
    return (
      <FilePreview
        root={effectiveRoot}
        path={selectedPath}
        onOpenInEditor={onOpenFile}
        onClose={() => {
          restoreFocusPathRef.current = selectedPath;
          setSelectedPath(null);
          activeFileChangeRef.current?.(null, effectiveRoot);
        }}
      />
    );
  }

  const renderRootBar = (): ReactNode => (
    <FilesRootBar
      showNavigation={presentation === "directory"}
      opening={openingRoot}
      navigation={navigation}
      draft={rootDraft}
      editable={onRootChange !== undefined}
      canGoUp={
        currentDirectoryPath !== null ||
        (onRootChange !== undefined && parentDir(effectiveRoot) !== null)
      }
      onDraftChange={setRootDraft}
      onOpen={openRoot}
      onUp={goUp}
      onRoot={() => goToDirectory(null)}
    />
  );

  const renderGitSummary = (): ReactNode => {
    if (gitSummary === null) return null;
    const state =
      gitStatusState.status?.state ?? (gitStatusState.error === null ? "loading" : "error");
    return (
      <output className="files-git-status" data-state={state}>
        <GitIcon size={13} />
        <span>{gitSummary}</span>
        {canOpenGitDelivery ? (
          <button
            className="files-root-up"
            style={{ width: 24, height: 24, marginLeft: "auto" }}
            type="button"
            onClick={() => onOpenGitDelivery?.(gitDeliveryRoot)}
            title={t("filesWidget.gitDelivery.open")}
            aria-label={t("filesWidget.gitDelivery.open")}
          >
            <BranchIcon size={13} />
          </button>
        ) : null}
      </output>
    );
  };

  const renderMutationButtons = (): ReactNode => {
    if (!mutationsEnabled) return null;
    return (
      <>
        <button
          className="files-refresh"
          style={{ right: 62 }}
          type="button"
          onClick={() => startNewEntry("new-file", currentDirectoryPath)}
          title={t("filesWidget.newFile")}
          aria-label={t("filesWidget.newFile")}
        >
          <FileGlyphIcon size={13} />
        </button>
        <button
          className="files-refresh"
          style={{ right: 34 }}
          type="button"
          onClick={() => startNewEntry("new-folder", currentDirectoryPath)}
          title={t("filesWidget.newFolder")}
          aria-label={t("filesWidget.newFolder")}
        >
          <FolderIcon size={13} />
        </button>
      </>
    );
  };

  // tabIndex -1: the tree container only receives programmatic focus; rows stay native buttons
  // (Tab fallback) while onTreeKeyDown adds the arrow-key traversal (C215). `.tr` keeps the
  // scroll/keyboard host role it has always had, but role="tree" sits on the element that owns ONLY
  // the rows: a tree may own nothing but treeitem and group, and the root level's status notes,
  // error block, inline editor and load-more button are none of those. Nesting them under the tree
  // is what axe reported as a critical aria-required-children violation on a populated root (#2605).
  const renderRootTree = (): ReactNode => {
    const { notices, rows, trailer } = directorySections(
      currentDirectoryPath ?? "",
      presentation === "project" ? 1 : 0,
    );
    // `tr files-tree` stays on THIS element: it is the flex item that owns `overflow: auto`, and
    // the C203 rule `.files .files-tree { min-height: 0 }` is what lets it shrink below its content
    // so scrolling engages instead of the tree growing the window body. globals.css is SHA-locked,
    // so the class pair has to stay where the rule expects it.
    return (
      <div className="tr files-tree">
        {presentation !== "project" || expanded.has("") ? notices : null}
        {/* Only the rows carry role="tree" — a tree may own nothing but treeitem and group, and the
            root level's notices, error block, inline editor and load-more button are none of those
            (#2605). The keyboard host moves with the role: arrow traversal is a tree behaviour and
            every row it navigates is inside this element. */}
        <div
          role="tree"
          aria-label={t("filesWidget.tree.label")}
          tabIndex={-1}
          onKeyDown={onTreeKeyDown}
        >
          {presentation === "project" ? (
            <ProjectTreeRoot
              root={effectiveRoot}
              expanded={expanded.has("")}
              onToggle={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has("")) next.delete("");
                  else next.add("");
                  return next;
                })
              }
            >
              {rows}
            </ProjectTreeRoot>
          ) : (
            rows
          )}
        </div>
        {presentation !== "project" || expanded.has("") ? trailer : null}
      </div>
    );
  };

  const renderContextMenu = (): ReactNode =>
    menu !== null ? (
      <div
        ref={menuRef}
        role="menu"
        aria-label={t("filesWidget.menu.label")}
        // tabIndex -1: the menu is a programmatic focus container; the menuitems are the tab
        // stops. Satisfies role="menu" focusability without adding a Tab stop.
        tabIndex={-1}
        // Positioned at the cursor and themed with the same popover tokens as `.edm-menu`, so the
        // context menu needs no globals.css rule. Stopping pointerdown keeps the window-level
        // outside-close listener from dismissing it before a menu item's click fires.
        onPointerDown={(event) => event.stopPropagation()}
        // GEN-UI-KEYBOARD-003 — Arrow/Home/End roving among the menuitems (Enter/Space activate
        // the focused button natively).
        onKeyDown={(event) => handleMenuNavKey(event.currentTarget, event)}
        style={{
          position: "fixed",
          top: menu.y,
          left: menu.x,
          zIndex: 9700,
          minWidth: 176,
          padding: 6,
          background: "var(--popover-surface)",
          border: "1px solid var(--popover-border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--popover-shadow)",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {(() => {
          const target = menu.entry?.readable === true ? menu.entry : null;
          const parent = contextMenuParentPath(menu.entry, currentDirectoryPath);
          return (
            <>
              {target !== null ? (
                <>
                  <button
                    type="button"
                    className="edm-item"
                    role="menuitem"
                    onClick={() => startRename(target)}
                  >
                    <EditIcon size={14} />
                    <span>{t("filesWidget.menu.rename")}</span>
                  </button>
                  <button
                    type="button"
                    className="edm-item"
                    role="menuitem"
                    onClick={() => void duplicateEntry(target)}
                  >
                    <CopyIcon size={14} />
                    <span>{t("filesWidget.menu.duplicate")}</span>
                  </button>
                  <button
                    type="button"
                    className="edm-item"
                    role="menuitem"
                    onClick={() => {
                      // Hand the menu's originating row to the delete dialog so focus lands
                      // back on the row (not lost) once the whole chain closes (WCAG 2.4.3).
                      confirmDeleteReturnFocusRef.current = menuReturnFocusRef.current;
                      setMenu(null);
                      setOpError(null);
                      setConfirmDelete(target);
                    }}
                  >
                    <TrashIcon size={14} />
                    <span>{t("filesWidget.menu.delete")}</span>
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="edm-item"
                role="menuitem"
                onClick={() => startNewEntry("new-file", parent)}
              >
                <FileGlyphIcon size={14} />
                <span>{t("filesWidget.menu.newFile")}</span>
              </button>
              <button
                type="button"
                className="edm-item"
                role="menuitem"
                onClick={() => startNewEntry("new-folder", parent)}
              >
                <FolderIcon size={14} />
                <span>{t("filesWidget.menu.newFolder")}</span>
              </button>
            </>
          );
        })()}
      </div>
    ) : null;

  const renderDeleteDialog = (): ReactNode =>
    confirmDelete !== null ? (
      <div className="ed-dialog-backdrop">
        {/* GEN-UI-FOCUS-002 — Escape cancels and Tab/Shift+Tab stay inside the dialog (WCAG
              2.1.2). Both live in document-level effects above, not on this element, so they still
              work while every control is disabled and focus has dropped to <body>. */}
        <dialog
          open
          ref={deleteDialogRef}
          className={`ed-dirty-dialog ${presentationStyles.cmpDeleteDialog}`}
          aria-modal="true"
          aria-labelledby="files-delete-title"
          aria-describedby="files-delete-body"
          tabIndex={-1}
        >
          <h2 id="files-delete-title">{deleteDialogCopy(confirmDelete, t).title}</h2>
          <p id="files-delete-body">{deleteDialogCopy(confirmDelete, t).body}</p>
          {opError !== null ? <p role="alert">{opError}</p> : null}
          <div className="ed-dialog-actions">
            <button
              type="button"
              className="ed-reload"
              onClick={() => void performDelete(confirmDelete)}
              disabled={opBusy}
            >
              {opBusy
                ? t("filesWidget.deleteDialog.deleting")
                : t("filesWidget.deleteDialog.delete")}
            </button>
            <button
              type="button"
              className="ed-icon-action"
              onClick={() => {
                setConfirmDelete(null);
                setOpError(null);
              }}
              disabled={opBusy}
            >
              {t("filesWidget.deleteDialog.cancel")}
            </button>
          </div>
        </dialog>
      </div>
    ) : null;

  const renderTreeTooltip = (): ReactNode =>
    treeTooltip !== null && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={treeTooltipElRef}
            className="files-tree-tooltip mono"
            role="tooltip"
            style={{ left: treeTooltip.x, top: treeTooltip.y }}
          >
            {treeTooltip.text}
          </div>,
          document.body,
        )
      : null;

  const renderTreeView = (): ReactNode => (
    // tabIndex -1: programmatic focus target only — the fallback for the focus restore above
    // when the previously previewed row no longer exists after a refresh.
    <div className="files" ref={filesRef} tabIndex={-1}>
      {renderRootBar()}
      {renderGitSummary()}
      {gitStatusState.status?.available === true && gitStatusState.status.truncated ? (
        <output className="files-note files-warning" style={NATIVE_BLOCK_STYLE}>
          {tGit("git.decorationsIncomplete", { count: gitStatusState.status.maxChanges })}
        </output>
      ) : null}
      <button
        className="files-refresh"
        type="button"
        onClick={refreshCurrentDirectory}
        title={t("filesWidget.refresh")}
        aria-label={t("filesWidget.refresh")}
      >
        <ResetIcon size={13} />
      </button>
      {renderMutationButtons()}
      {(presentation !== "project" || expanded.has("")) &&
      hasUnreadableVisibleLink(currentDirectoryPath ?? "") ? (
        <span id={unreadableReasonId} className={presentationStyles.cmpScreenReaderOnly}>
          {t("filesWidget.tree.unreadableLinkReason")}
        </span>
      ) : null}
      {renderRootTree()}
      {renderContextMenu()}
      {renderDeleteDialog()}
      {renderTreeTooltip()}
    </div>
  );

  return renderTreeView();
}
