"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
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
import { Icons } from "../../Icons";
import { FileIcon } from "../shared/projectTree";
import { FilePreview } from "./FilePreview";
import {
  useFilesWidgetTranslate,
  type FilesWidgetMessageKey,
  type FilesWidgetTranslate,
} from "./files-widget-i18n";
import { WORKSPACE_FILE_MUTATED_EVENT, workspaceFileMutationRoot } from "./workspace-file-events";

interface FilesWidgetProps {
  root?: string;
  activeFilePath?: string | undefined;
  openFilesDirectly?: boolean | undefined;
  onActiveFileChange?: (
    path: string | null,
    root: string | null,
    activeDirectoryPath?: string | null,
  ) => void;
  // Called when the user opens a different machine path from the root bar. The window host
  // persists it into cfg.root so the new root survives reload (widgets/index.tsx). When omitted,
  // the root bar is hidden (the widget is then locked to its configured/fallback root).
  onRootChange?: (root: string) => void;
  onOpenFile?: ((root: string, path: string) => void) | undefined;
  onOpenGitDelivery?: ((root: string) => void) | undefined;
  // Notified after a successful create/rename/delete so the host can re-home open editor tabs (rename)
  // or close them (delete). Omitted in read-only contexts; its presence does not gate the affordances.
  onFilesMutated?: ((event: FilesMutationEvent) => void) | undefined;
}

export interface FilesMutationEvent {
  readonly op: "create" | "rename" | "delete";
  readonly mutation: FilesMutationResponse;
}

// Parent directory of an absolute POSIX/Windows path, or null at the filesystem root. Pure string
// math (no IO) so the root bar can offer "up" without a round-trip; the BFF still validates.
function parentDir(path: string): string | null {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return null;
  if (idx === 0) return "/"; // POSIX root
  // Windows drive root e.g. "C:" → keep the backslash form "C:\"
  if (/^[A-Za-z]:$/.test(trimmed.slice(0, idx))) return `${trimmed.slice(0, idx)}\\`;
  return trimmed.slice(0, idx);
}

function parentRelativePath(path: string): string | null {
  const trimmed = path.replace(/\/+$/u, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  return parent.length > 0 ? parent : null;
}

function displayPath(root: string, relativePath: string | null): string {
  if (relativePath === null || relativePath.length === 0) return root;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[/\\]+$/u, "")}${separator}${relativePath.replace(/\//gu, separator)}`;
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

interface DirectoryState {
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

// The inline editor reused for all three create/rename flows. `parentPath` is the root-relative
// directory the new entry lands in (null = root); `path`/`name` identify the entry being renamed.
type PendingEntry =
  | { readonly kind: "new-file" | "new-folder"; readonly parentPath: string | null }
  | { readonly kind: "rename"; readonly path: string; readonly name: string };

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
} as const;

// Parent directory (root-relative) of a tree entry, for scoping a new sibling or a rename target.
function entryParent(path: string): string | null {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? null : path.slice(0, idx);
}

function joinRelative(parent: string | null, name: string): string {
  return parent === null || parent.length === 0 ? name : `${parent}/${name}`;
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
function invalidEntryName(name: string): string | null {
  if (name.length === 0) return "Enter a name.";
  if (name === "." || name === "..") return "That name is reserved.";
  if (/[/\\]/u.test(name)) return "A name cannot contain a slash.";
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to read this folder.";
}

// CSS.escape with a fallback for environments without the CSSOM utility (older jsdom):
// escaping quotes/backslashes is enough for an attribute-value selector.
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
function focusParentRow(rows: readonly HTMLButtonElement[], index: number): void {
  const level = Number(rows[index]?.getAttribute("aria-level") ?? "1");
  for (let i = index - 1; i >= 0; i -= 1) {
    if (Number(rows[i]?.getAttribute("aria-level") ?? "1") < level) {
      rows[i]?.focus();
      return;
    }
  }
}

function handleTreeNavKey(rows: readonly HTMLButtonElement[], index: number, key: string): void {
  const row = rows[index];
  if (row === undefined) return;
  const toggle = row
    .closest(".tr-row-wrap")
    ?.querySelector<HTMLButtonElement>("button.tr-caret-btn");
  if (key === "ArrowDown") rows[index + 1]?.focus();
  else if (key === "ArrowUp") rows[index - 1]?.focus();
  else if (key === "Home") rows[0]?.focus();
  else if (key === "End") rows[rows.length - 1]?.focus();
  else if (key === "ArrowRight") {
    const expandedState = row.getAttribute("aria-expanded");
    if (expandedState === "false") toggle?.click();
    else if (expandedState === "true") rows[index + 1]?.focus();
  } else if (key === "ArrowLeft") {
    if (row.getAttribute("aria-expanded") === "true") toggle?.click();
    else focusParentRow(rows, index);
  }
}

// GEN-UI-FOCUS-002 — keep Tab focus cycling within a modal dialog (WCAG 2.1.2/2.4.3). Returns
// true when it handled the key (caller should not do more). jsdom does not enforce inert, so an
// explicit wrap is required for keyboard users to stay inside the dialog.
function trapDialogTab(container: HTMLElement, event: ReactKeyboardEvent): boolean {
  if (event.key !== "Tab") return false;
  const focusables = Array.from(
    container.querySelectorAll<HTMLElement>(
      "button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])",
    ),
  );
  if (focusables.length === 0) {
    event.preventDefault();
    return true;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last?.focus();
    return true;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first?.focus();
    return true;
  }
  return false;
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
  if (event.key === "ArrowDown") items[(index + 1 + items.length) % items.length]?.focus();
  else if (event.key === "ArrowUp") items[(index - 1 + items.length) % items.length]?.focus();
  else if (event.key === "Home") items[0]?.focus();
  else if (event.key === "End") items[items.length - 1]?.focus();
}

function gitStatusSummary(state: GitStatusState): string | null {
  if (state.loading && state.status === null) return "Git status loading";
  if (state.error !== null) return "Git status unavailable";
  const status = state.status;
  if (status === null) return null;
  if (!status.available) return status.state === "unsafe" ? "Git unsafe" : "Git unavailable";
  const branch = status.detached ? "detached HEAD" : (status.branch ?? "unknown branch");
  if (status.clean) return `Git ${branch} clean`;
  const count = status.changes.length;
  return `Git ${branch} ${String(count)} changed ${count === 1 ? "file" : "files"}`;
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

function gitDirectoryLabel(aggregate: GitDirectoryAggregate, t: FilesWidgetTranslate): string {
  const key = aggregate.conflicted
    ? "git.folder.conflicted"
    : aggregate.deleted
      ? "git.folder.deleted"
      : "git.folder.changed";
  return t(key, { count: aggregate.count });
}

// Unreadable symlinks stay focusable via aria-disabled (instead of native disabled) so
// keyboard/screen-reader users can reach the row and hear the reason (audit C196). The neutral
// copy covers all server cases — outside root, deny-listed AND broken links (audit C349).
const UNREADABLE_ENTRY_TITLE = "This link can't be opened from this folder.";

function entryTooltipText(entry: FilesTreeEntry): string {
  return entry.readable ? entry.path : UNREADABLE_ENTRY_TITLE;
}

function renderSymlinkBadge(entry: FilesTreeEntry): ReactNode {
  return entry.symlink ? <span className="tr-badge">link</span> : null;
}

function renderGitAggregateBadge(
  aggregate: GitDirectoryAggregate | undefined,
  t: FilesWidgetTranslate,
): ReactNode {
  if (aggregate === undefined) return null;
  const label = gitDirectoryLabel(aggregate, t);
  return (
    <span
      className="tr-badge tr-git"
      data-git-state={aggregate.conflicted ? "conflicted" : "aggregate"}
      aria-label={label}
      title={label}
      style={
        aggregate.conflicted ? { outline: "1px solid currentColor", fontWeight: 700 } : undefined
      }
    >
      {aggregate.conflicted ? "U" : "Δ"}
    </span>
  );
}

function renderFileGitDecorationBadge(
  decoration: GitDecoration | null,
  path: string,
  t: FilesWidgetTranslate,
): ReactNode {
  if (decoration === null) return null;
  return (
    <span
      className="tr-badge tr-git"
      data-git-state={decoration.state}
      aria-label={t(decoration.labelKey, { path })}
      title={t(decoration.labelKey, { path })}
      style={
        decoration.state === "conflicted"
          ? { outline: "1px solid currentColor", fontWeight: 700 }
          : undefined
      }
    >
      {decoration.badge}
    </span>
  );
}

function renderDirectoryLoadingNote(state: DirectoryState | undefined, depth: number): ReactNode {
  if (state?.loading !== true) return null;
  return (
    <div className="files-note" role="status" style={{ paddingLeft: treeIndent(depth) + 18 }}>
      Loading…
    </div>
  );
}

function renderNoRootNotice(
  state: DirectoryState | undefined,
  depth: number,
  hasRootChange: boolean,
): ReactNode {
  if (state?.notice !== "no-root") return null;
  return (
    <div className="files-note" role="status" style={{ paddingLeft: treeIndent(depth) + 18 }}>
      {hasRootChange
        ? "No folder is open yet. Enter a folder path above and press Open."
        : "No registered project is available."}
    </div>
  );
}

function renderDirectoryErrorNote(
  state: DirectoryState | undefined,
  depth: number,
  onRetry: () => void,
): ReactNode {
  if (state?.error === null || state?.error === undefined) return null;
  return (
    <div className="files-error" role="alert" style={{ marginLeft: treeIndent(depth) }}>
      <span>{state.error}</span>
      <button type="button" className="files-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function renderTruncatedNotice(state: DirectoryState | undefined, depth: number): ReactNode {
  if (state?.truncated !== true) return null;
  return (
    <div
      className="files-note files-warning"
      role="status"
      style={{ paddingLeft: treeIndent(depth) + 18 }}
    >
      Showing only the first {state.entries.length} entries — this folder contains more.
    </div>
  );
}

function renderEmptyDirectoryNotice(state: DirectoryState | undefined, depth: number): ReactNode {
  const isEmpty =
    state !== undefined &&
    !state.loading &&
    state.error === null &&
    state.notice === null &&
    state.entries.length === 0;
  if (!isEmpty) return null;
  return (
    <div className="files-note" role="status" style={{ paddingLeft: treeIndent(depth) + 18 }}>
      Empty folder.
    </div>
  );
}

const filesTreeRequests = new Map<string, Promise<FilesTreeResponse>>();
const gitStatusRequests = new Map<string, Promise<GitRepositoryStatusResponse>>();

function readSharedFilesTree(root: string, path: string): Promise<FilesTreeResponse> {
  const key = `${root}\u0000${path}`;
  const existing = filesTreeRequests.get(key);
  if (existing !== undefined) return existing;
  const request = fetchFilesTree(root, path).finally(() => {
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

// The root prop, trimmed and normalized to null when unset — the configured (host-provided) root
// takes precedence over the fallback root discovered from the projects list.
function resolveConfiguredRoot(root: string | undefined): string | null {
  const trimmed = root?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

function resolveApiRoot(configuredRoot: string | null, fallbackRoot: string | null): string {
  return configuredRoot ?? fallbackRoot ?? "";
}

function resolveVisibleBaseRoot(resolvedRoot: string | null, apiRoot: string): string {
  return resolvedRoot ?? (apiRoot.length > 0 ? apiRoot : "");
}

function resolveGitStatusTargetRoot(visibleRootPath: string): string | null {
  return visibleRootPath.length > 0 ? visibleRootPath : null;
}

function resolveMutationRoot(resolvedRoot: string | null, apiRoot: string): string {
  return resolvedRoot ?? apiRoot;
}

function resolveGitDeliveryRoot(status: GitRepositoryStatusResponse | null): string {
  return status?.available === true ? (status.repositoryRoot ?? status.root) : "";
}

function resolveCanOpenGitDelivery(
  hasOpenGitDelivery: boolean,
  status: GitRepositoryStatusResponse | null,
  gitDeliveryRoot: string,
): boolean {
  return hasOpenGitDelivery && status?.available === true && gitDeliveryRoot.length > 0;
}

function resolveActiveTreePath(
  selectedPath: string | null,
  activeFilePath: string | null | undefined,
): string | null {
  return selectedPath ?? activeFilePath ?? null;
}

// The full-page Git diff view (back/close bar) — pure, so it takes an explicit onClose instead of
// closing over the widget's state setters.
function renderGitDiffBar(path: string, onClose: () => void): ReactNode {
  return (
    <div className="fpv-bar">
      <button
        className="fpv-back"
        type="button"
        onClick={onClose}
        title="Back to files"
        aria-label="Back to files"
      >
        <Icons.back size={15} />
      </button>
      <Icons.diff size={15} />
      <span className="fpv-name" title={path}>
        {path}
      </span>
      <span className="fpv-lang mono">git diff</span>
      <span className="spacer" />
      <button
        className="fpv-back"
        type="button"
        onClick={onClose}
        title="Close diff"
        aria-label="Close diff"
      >
        <Icons.close size={15} />
      </button>
    </div>
  );
}

function renderGitDiffLines(diff: string): ReactNode {
  if (diff.length === 0) {
    return (
      <div className="fpv-line">
        <span className="fpv-src">No diff available.</span>
      </div>
    );
  }
  return diff.split("\n").map((line: string, index: number) => (
    <div className="fpv-line" key={index}>
      <span className="fpv-src">{line.length > 0 ? line : " "}</span>
    </div>
  ));
}

function renderGitDiffContent(state: GitDiffState): ReactNode {
  const diff = state.response?.diff ?? "";
  return (
    <>
      {state.loading ? (
        <div className="fpv-state" role="status">
          Loading diff…
        </div>
      ) : null}
      {state.error !== null ? (
        <div className="fpv-state fpv-error" role="alert">
          <span>{state.error}</span>
        </div>
      ) : null}
      {state.response?.truncated === true ? (
        <div className="fpv-banner">Diff truncated at {formatBytes(state.response.maxBytes)}.</div>
      ) : null}
      {state.response !== null ? (
        <div
          className="fpv-code mono"
          // Scrollable diff pane: tabIndex makes the overflow region keyboard-scrollable.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={`Git diff: ${state.path}`}
        >
          {renderGitDiffLines(diff)}
        </div>
      ) : null}
    </>
  );
}

// The context menu's target entry (the row it was opened on, when readable) and the directory a
// "New File…" / "New Folder…" action from that menu should land in — pure path/entry math.
function menuTargetEntry(menu: ContextMenuState): FilesTreeEntry | null {
  return menu.entry !== null && menu.entry.readable ? menu.entry : null;
}

function menuParentPath(
  menu: ContextMenuState,
  currentDirectoryPath: string | null,
): string | null {
  return menu.entry === null
    ? currentDirectoryPath
    : menu.entry.kind === "directory"
      ? menu.entry.path
      : entryParent(menu.entry.path);
}

export function FilesWidget({
  root,
  activeFilePath,
  openFilesDirectly = false,
  onActiveFileChange,
  onRootChange,
  onOpenFile,
  onOpenGitDelivery,
  onFilesMutated,
}: FilesWidgetProps): ReactNode {
  const t = useFilesWidgetTranslate();
  const configuredRoot = resolveConfiguredRoot(root);
  const [fallbackRoot, setFallbackRoot] = useState<string | null>(null);
  const apiRoot = resolveApiRoot(configuredRoot, fallbackRoot);
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null);
  // Root bar draft: what the user is typing as the next folder to open. Synced to the resolved
  // (real) root whenever the widget loads a folder, so it always shows where we are.
  const [rootDraft, setRootDraft] = useState<string>("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [currentDirectoryPath, setCurrentDirectoryPath] = useState<string | null>(null);
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
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const confirmDeleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  // Root-relative path of the entry currently being dragged in the tree (null when not dragging).
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const onFilesMutatedRef = useRef(onFilesMutated);
  onFilesMutatedRef.current = onFilesMutated;

  const invalidateGitStatus = useCallback((): void => {
    setGitStatusRevision((revision) => revision + 1);
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
    (event: ReactPointerEvent<HTMLButtonElement>, text: string): void => {
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
  const moveTreeTooltip = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
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
    const row = filesRef.current?.querySelector<HTMLButtonElement>(
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
        requestSeq !== directoryLoadSeqRef.current || requestRoot !== apiRoot;
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
        const response = await readSharedFilesTree(apiRoot, path);
        if (isStale()) return;
        if (path === "") {
          setResolvedRoot(response.root);
          activeFileChangeRef.current?.(null, response.root, null);
          setCurrentDirectoryPath(null);
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
            pinnedDirectoryPaths(expandedRef.current),
          );
        });
      } catch (error: unknown) {
        if (isStale()) return;
        setDirectories((current) => ({
          ...current,
          [path]: {
            entries: current[path]?.entries ?? [],
            truncated: current[path]?.truncated ?? false,
            loading: false,
            error: errorMessage(error),
            notice: null,
          },
        }));
      }
    },
    [apiRoot, touchDirectoryAccess],
  );

  useEffect(() => {
    directoryLoadSeqRef.current += 1;
    setSelectedPath(null);
    setGitDiffState(null);
    setCurrentDirectoryPath(null);
    activeFileChangeRef.current?.(null, null, null);
    setResolvedRoot(null);
    setExpanded(new Set([""]));
    setDirectories({});
    setDirectoryRenderLimits({});
    directoryAccessOrderRef.current = [];
    void loadDirectory("");
  }, [apiRoot, loadDirectory]);

  const visibleBaseRoot = resolveVisibleBaseRoot(resolvedRoot, apiRoot);
  const visibleRootPath = displayPath(visibleBaseRoot, currentDirectoryPath);
  const gitStatusTargetRoot = resolveGitStatusTargetRoot(visibleRootPath);

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
            error: errorMessage(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [gitStatusRevision, gitStatusTargetRoot]);

  useEffect(() => {
    const onFocus = (): void => invalidateGitStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [invalidateGitStatus]);

  useEffect(() => {
    const onMutation = (event: Event): void => {
      const boundRoot = resolvedRoot ?? (apiRoot.length > 0 ? apiRoot : null);
      if (boundRoot !== null && workspaceFileMutationRoot(event) === boundRoot) {
        invalidateGitStatus();
      }
    };
    window.addEventListener(WORKSPACE_FILE_MUTATED_EVENT, onMutation);
    return () => window.removeEventListener(WORKSPACE_FILE_MUTATED_EVENT, onMutation);
  }, [apiRoot, invalidateGitStatus, resolvedRoot]);

  // Keep the root-bar input showing where we actually are (resolved root + current folder).
  useEffect(() => {
    setRootDraft(visibleRootPath);
  }, [visibleRootPath]);

  const openRoot = useCallback(
    (next: string): void => {
      const target = next.trim();
      if (onRootChange === undefined || target.length === 0) return;
      if (target === visibleRootPath) return;
      onRootChange(target);
    },
    [onRootChange, visibleRootPath],
  );

  const goToDirectory = useCallback(
    (path: string | null): void => {
      setSelectedPath(null);
      setCurrentDirectoryPath(path);
      activeFileChangeRef.current?.(null, resolvedRoot ?? apiRoot, path);
      if (path !== null && directories[path] === undefined) void loadDirectory(path);
    },
    [apiRoot, directories, loadDirectory, resolvedRoot],
  );

  const refreshCurrentDirectory = useCallback((): void => {
    setSelectedPath(null);
    invalidateGitStatus();
    void loadDirectory(currentDirectoryPath ?? "");
  }, [currentDirectoryPath, invalidateGitStatus, loadDirectory]);

  // The root every mutation targets — the resolved real root, or the configured one before it loads.
  const mutationRoot = resolveMutationRoot(resolvedRoot, apiRoot);
  const mutationsEnabled = mutationRoot.length > 0;

  const startNewEntry = useCallback(
    (kind: "new-file" | "new-folder", parentPath: string | null): void => {
      setMenu(null);
      setOpError(null);
      setEntryDraft("");
      setPendingEntry({ kind, parentPath });
      // Make sure the folder the new entry lands in is expanded so the inline editor is visible.
      if (parentPath !== null) {
        setExpanded((current) =>
          current.has(parentPath) ? current : new Set(current).add(parentPath),
        );
        if (directories[parentPath] === undefined) void loadDirectory(parentPath);
      }
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
    const invalid = invalidEntryName(name);
    if (invalid !== null) {
      setOpError(invalid);
      return;
    }
    setOpBusy(true);
    setOpError(null);
    try {
      if (pendingEntry.kind === "rename") {
        const parent = entryParent(pendingEntry.path);
        const result = await renameFilesEntry({
          root: mutationRoot,
          path: pendingEntry.path,
          newPath: joinRelative(parent, name),
        });
        setPendingEntry(null);
        setEntryDraft("");
        if (selectedPath === pendingEntry.path) setSelectedPath(result.path);
        await loadDirectory(parent ?? "");
        invalidateGitStatus();
        onFilesMutatedRef.current?.({ op: "rename", mutation: result });
      } else {
        const result = await createFilesEntry({
          root: mutationRoot,
          path: joinRelative(pendingEntry.parentPath, name),
          kind: pendingEntry.kind === "new-file" ? "file" : "directory",
        });
        setPendingEntry(null);
        setEntryDraft("");
        await loadDirectory(pendingEntry.parentPath ?? "");
        invalidateGitStatus();
        if (result.kind === "directory") {
          setExpanded((current) => new Set(current).add(result.path));
        } else if (onOpenFile !== undefined) {
          // Open the freshly created (empty) file so the user can start typing immediately.
          activeFileChangeRef.current?.(result.path, mutationRoot);
          onOpenFile(mutationRoot, result.path);
        }
        onFilesMutatedRef.current?.({ op: "create", mutation: result });
      }
    } catch (error: unknown) {
      setOpError(errorMessage(error));
    } finally {
      setOpBusy(false);
    }
  }, [
    cancelPendingEntry,
    entryDraft,
    invalidateGitStatus,
    loadDirectory,
    mutationRoot,
    onOpenFile,
    opBusy,
    pendingEntry,
    selectedPath,
  ]);

  const performDelete = useCallback(
    async (entry: FilesTreeEntry): Promise<void> => {
      if (mutationRoot.length === 0 || opBusy) return;
      setOpBusy(true);
      setOpError(null);
      try {
        const result = await deleteFilesEntry({ root: mutationRoot, path: entry.path });
        setConfirmDelete(null);
        if (selectedPath === entry.path) setSelectedPath(null);
        await loadDirectory(entryParent(entry.path) ?? "");
        invalidateGitStatus();
        onFilesMutatedRef.current?.({ op: "delete", mutation: result });
      } catch (error: unknown) {
        setOpError(errorMessage(error));
      } finally {
        setOpBusy(false);
      }
    },
    [invalidateGitStatus, loadDirectory, mutationRoot, opBusy, selectedPath],
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
        setOpError(errorMessage(error));
      } finally {
        setOpBusy(false);
      }
    },
    [directories, invalidateGitStatus, loadDirectory, mutationRoot, opBusy],
  );

  // Drag-move: dropping an entry onto a folder renames it into that folder (move = rename).
  const moveEntry = useCallback(
    async (sourcePath: string, targetDir: string | null): Promise<void> => {
      if (mutationRoot.length === 0 || opBusy) return;
      const name = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
      const newPath = joinRelative(targetDir, name);
      // No-op when dropped onto its own current directory, onto itself, or into its own subtree.
      if (newPath === sourcePath || entryParent(sourcePath) === targetDir) return;
      if (targetDir === sourcePath || targetDir?.startsWith(`${sourcePath}/`) === true) return;
      setOpBusy(true);
      setOpError(null);
      try {
        const result = await renameFilesEntry({ root: mutationRoot, path: sourcePath, newPath });
        await loadDirectory(entryParent(sourcePath) ?? "");
        await loadDirectory(targetDir ?? "");
        invalidateGitStatus();
        onFilesMutatedRef.current?.({ op: "rename", mutation: result });
      } catch (error: unknown) {
        setOpError(errorMessage(error));
      } finally {
        setOpBusy(false);
      }
    },
    [invalidateGitStatus, loadDirectory, mutationRoot, opBusy],
  );

  const openContextMenu = useCallback(
    (event: ReactMouseEvent, entry: FilesTreeEntry | null): void => {
      if (!mutationsEnabled) return;
      event.preventDefault();
      event.stopPropagation();
      // Remember the row the menu opened on so focus returns there on close (GEN-UI-KEYBOARD-003).
      const opener =
        event.currentTarget instanceof HTMLElement
          ? event.currentTarget.closest<HTMLElement>("button.tr-row")
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
  // the originating tree row on close (WCAG 2.4.3). The Tab trap and Escape live on the dialog's
  // onKeyDown handler below; here we only manage entering/leaving the dialog.
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

  const goUp = useCallback((): void => {
    if (currentDirectoryPath !== null) {
      goToDirectory(parentRelativePath(currentDirectoryPath));
      return;
    }
    const parent = parentDir(resolvedRoot ?? apiRoot);
    if (parent !== null) openRoot(parent);
  }, [apiRoot, currentDirectoryPath, goToDirectory, openRoot, resolvedRoot]);

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
          setGitDiffState({ path, loading: false, response: null, error: errorMessage(error) });
        });
    },
    [currentDirectoryPath, gitStatusTargetRoot],
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

  // F2 renames and Delete removes the focused readable row (VS Code parity), reusing the same
  // inline-edit / confirm flows as the context menu. Returns true when it handled the key (the
  // caller should not also try arrow-key navigation for it).
  const handleTreeRowShortcut = (event: ReactKeyboardEvent<HTMLDivElement>): boolean => {
    if (!mutationsEnabled || (event.key !== "F2" && event.key !== "Delete")) return false;
    const focusedRow =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLButtonElement>("button.tr-row[data-readable='true']")
        : null;
    const path = focusedRow?.getAttribute("data-path");
    const entry = path !== null && path !== undefined ? findEntry(path) : null;
    if (entry === null) return true;
    event.preventDefault();
    if (event.key === "F2") {
      startRename(entry);
    } else {
      setOpError(null);
      confirmDeleteReturnFocusRef.current = focusedRow;
      setConfirmDelete(entry);
    }
    return true;
  };

  // Arrow-key navigation across the currently visible rows (audit C215). Scope-connect pills
  // are intentionally NOT part of the arrow order — only `.tr-row` buttons are traversed.
  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (handleTreeRowShortcut(event)) return;
    if (!TREE_NAV_KEYS.has(event.key)) return;
    const target = event.target;
    const row =
      target instanceof HTMLElement ? target.closest<HTMLButtonElement>("button.tr-row") : null;
    if (row === null) return;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button.tr-row"),
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
          ? gitStatusState.status.changes
              .filter(isIgnoredGitChange)
              .map((change) => treePathFromGitPath(currentDirectoryPath, change.path))
          : [],
      ),
    [currentDirectoryPath, gitStatusState.status],
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
  const gitSummary = gitStatusSummary(gitStatusState);
  const gitDeliveryRoot = resolveGitDeliveryRoot(gitStatusState.status);
  const canOpenGitDelivery = resolveCanOpenGitDelivery(
    onOpenGitDelivery !== undefined,
    gitStatusState.status,
    gitDeliveryRoot,
  );
  const activeTreePath = resolveActiveTreePath(selectedPath, activeFilePath);

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

  // One inline input reused for new file / new folder / rename, styled with the existing root-bar
  // input class so no globals.css change is needed (keeps the #1300 proof gate untouched).
  const renderInlineEditor = (depth: number, icon: ReactNode, ariaLabel: string): ReactNode => (
    <div className="tr-row-wrap" key="__files-inline-editor__">
      <div className="tr-dir-line" style={{ paddingLeft: treeIndent(depth) }}>
        <span className="tr-caret tr-caret-ghost" aria-hidden="true">
          <Icons.chevronR size={11} />
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

  const renderRenameEntry = (entry: FilesTreeEntry, depth: number): ReactNode => {
    const icon =
      entry.kind === "directory" ? (
        <span className="fi-fallback" style={{ color: "var(--accent)" }}>
          <Icons.folder size={14} />
        </span>
      ) : (
        <FileIcon name={entryDraft.length > 0 ? entryDraft : entry.name} />
      );
    return renderInlineEditor(depth, icon, `Rename ${entry.name}`);
  };

  // Drag handlers shared by directory and file rows (identical payload/no-op logic either way).
  const handleTreeRowDragStart = (event: ReactDragEvent<HTMLButtonElement>, path: string): void => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", path);
    setDraggedPath(path);
  };

  const handleTreeRowDragEnd = (): void => setDraggedPath(null);

  const handleDirectoryRowDragOver = (
    event: ReactDragEvent<HTMLButtonElement>,
    entry: FilesTreeEntry,
  ): void => {
    // A folder accepts a drop of any OTHER entry (move into it).
    if (entry.readable && draggedPath !== null && draggedPath !== entry.path) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  };

  const handleDirectoryRowDrop = (
    event: ReactDragEvent<HTMLButtonElement>,
    targetPath: string,
  ): void => {
    event.preventDefault();
    const source = draggedPath;
    setDraggedPath(null);
    if (source !== null) void moveEntry(source, targetPath);
  };

  const renderDirectoryEntryRow = (entry: FilesTreeEntry, depth: number): ReactNode => {
    const pad = treeIndent(depth);
    const open = expanded.has(entry.path);
    const state = directories[entry.path];
    const gitAggregate = gitDirectoryByPath.get(entry.path);
    return (
      <div className="tr-row-wrap" key={entry.path}>
        <div className="tr-dir-line" style={{ paddingLeft: pad }}>
          <button
            className="tr-caret-btn"
            type="button"
            tabIndex={-1}
            disabled={!entry.readable}
            aria-label={`${open ? "Collapse" : "Expand"} folder: ${entry.name}`}
            onClick={() => toggleDirectory(entry)}
          >
            <span className="tr-caret" data-open={open}>
              <Icons.chevronR size={11} />
            </span>
          </button>
          <button
            className="tr-row tr-dir-enter"
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={currentDirectoryPath === entry.path}
            data-active={currentDirectoryPath === entry.path}
            data-readable={entry.readable}
            data-path={entry.path}
            type="button"
            draggable={mutationsEnabled && entry.readable}
            aria-disabled={entry.readable ? undefined : true}
            aria-describedby={entry.readable ? undefined : unreadableReasonId}
            aria-expanded={open}
            onPointerEnter={(event) => scheduleTreeTooltip(event, entryTooltipText(entry))}
            onPointerMove={moveTreeTooltip}
            onPointerLeave={hideTreeTooltip}
            onBlur={hideTreeTooltip}
            onClick={() => enterDirectory(entry)}
            onContextMenu={(event) => openContextMenu(event, entry)}
            onDragStart={(event) => handleTreeRowDragStart(event, entry.path)}
            onDragEnd={handleTreeRowDragEnd}
            onDragOver={(event) => handleDirectoryRowDragOver(event, entry)}
            onDrop={(event) => handleDirectoryRowDrop(event, entry.path)}
          >
            <span className="fi-fallback" style={{ color: "var(--accent)" }}>
              <Icons.folder size={14} />
            </span>
            <span className="tr-name tr-folder">{entry.name}</span>
            {renderSymlinkBadge(entry)}
            {renderGitAggregateBadge(gitAggregate, t)}
          </button>
        </div>
        {open ? renderDirectory(entry.path, depth + 1, state) : null}
      </div>
    );
  };

  const handleFileRowClick = (entry: FilesTreeEntry): void => {
    if (!entry.readable) return;
    const fileRoot = resolvedRoot ?? apiRoot;
    if (openFilesDirectly && onOpenFile !== undefined) {
      activeFileChangeRef.current?.(entry.path, fileRoot);
      onOpenFile(fileRoot, entry.path);
      return;
    }
    setSelectedPath(entry.path);
    activeFileChangeRef.current?.(entry.path, fileRoot);
  };

  const renderFileEntryRow = (entry: FilesTreeEntry, depth: number): ReactNode => {
    const pad = treeIndent(depth);
    const change = gitChangeByPath.get(entry.path);
    const ignored = ignoredGitPaths.has(entry.path);
    const decoration = change === undefined ? null : gitChangeDecoration(change);
    return (
      <div
        className="tr-row-wrap tr-file-wrap"
        key={entry.path}
        data-git-ignored={ignored || undefined}
        style={ignored ? { opacity: 0.55 } : undefined}
      >
        <button
          className="tr-row tr-file"
          onContextMenu={(event) => openContextMenu(event, entry)}
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={activeTreePath === entry.path}
          aria-label={ignored ? `${entry.name}, ${t("git.ignored")}` : undefined}
          data-active={activeTreePath === entry.path}
          data-readable={entry.readable}
          data-path={entry.path}
          style={{ paddingLeft: pad }}
          type="button"
          draggable={mutationsEnabled && entry.readable}
          aria-disabled={entry.readable ? undefined : true}
          aria-describedby={entry.readable ? undefined : unreadableReasonId}
          onPointerEnter={(event) => scheduleTreeTooltip(event, entryTooltipText(entry))}
          onPointerMove={moveTreeTooltip}
          onPointerLeave={hideTreeTooltip}
          onBlur={hideTreeTooltip}
          onDragStart={(event) => handleTreeRowDragStart(event, entry.path)}
          onDragEnd={handleTreeRowDragEnd}
          onClick={() => handleFileRowClick(entry)}
        >
          {/* invisible caret placeholder keeps file rows aligned with sibling folders (C216) */}
          <span className="tr-caret tr-caret-ghost" aria-hidden="true">
            <Icons.chevronR size={11} />
          </span>
          <FileIcon name={entry.name} />
          <span className="tr-name">{entry.name}</span>
          {renderSymlinkBadge(entry)}
          {renderFileGitDecorationBadge(decoration, entry.path, t)}
          <span className="tr-meta mono">{formatBytes(entry.sizeBytes)}</span>
        </button>
        {change !== undefined && entry.readable ? (
          <button
            className="tr-git-diff"
            type="button"
            onClick={() => openDiff(entry.path)}
            aria-label={`View Git diff for ${entry.path}`}
          >
            <Icons.diff size={13} />
          </button>
        ) : null}
      </div>
    );
  };

  // Classify the row into one of three mutually exclusive shapes: an in-place rename editor, a
  // directory row (expandable, drop target), or a file row (openable, drag source).
  const renderEntry = (entry: FilesTreeEntry, depth: number): ReactNode => {
    if (pendingEntry?.kind === "rename" && pendingEntry.path === entry.path) {
      return renderRenameEntry(entry, depth);
    }
    if (entry.kind === "directory") {
      return renderDirectoryEntryRow(entry, depth);
    }
    return renderFileEntryRow(entry, depth);
  };

  // The inline new-file/new-folder editor for this directory, or null when no create is pending
  // here (a pending rename, or a pending create targeting a different directory).
  const renderPendingNewEntry = (path: string, depth: number): ReactNode => {
    if (
      pendingEntry === null ||
      pendingEntry.kind === "rename" ||
      (pendingEntry.parentPath ?? "") !== path
    ) {
      return null;
    }
    const icon =
      pendingEntry.kind === "new-folder" ? (
        <span className="fi-fallback" style={{ color: "var(--accent)" }}>
          <Icons.folder size={14} />
        </span>
      ) : (
        <FileIcon name={entryDraft.length > 0 ? entryDraft : "new-file"} />
      );
    const label = pendingEntry.kind === "new-folder" ? "New folder name" : "New file name";
    return renderInlineEditor(depth, icon, label);
  };

  const renderDirectory = (path: string, depth: number, state = directories[path]): ReactNode => {
    const entries = state?.entries ?? [];
    const visibleCount = renderLimitForDirectory(path, entries);
    const hiddenCount = entries.length - visibleCount;
    const visibleEntries = hiddenCount > 0 ? entries.slice(0, visibleCount) : entries;
    return (
      // Nested levels are role="group" so the treeitem hierarchy is exposed (audit C143);
      // the root level sits directly under role="tree".
      <div className="tr-dir" role={depth === 0 ? undefined : "group"}>
        {renderDirectoryLoadingNote(state, depth)}
        {renderNoRootNotice(state, depth, onRootChange !== undefined)}
        {renderDirectoryErrorNote(state, depth, () => retryDirectory(path))}
        {/* Truncation notice sits ABOVE the rows so it is visible as soon as the folder opens
          (audit C353 — below 1000 rows it sat ~24,000px outside the viewport). The count comes
          from the response instead of a hardcoded "1000": the server also truncates early when
          its ignored-entry scan cap is hit, i.e. with fewer visible entries (audit C350). */}
        {renderTruncatedNotice(state, depth)}
        {renderPendingNewEntry(path, depth)}
        {visibleEntries.map((entry) => renderEntry(entry, depth))}
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="files-load-more"
            style={{ marginLeft: treeIndent(depth) + 18 }}
            onClick={() => showMoreDirectoryEntries(path, entries.length)}
          >
            Show {Math.min(DIRECTORY_RENDER_BATCH_SIZE, hiddenCount)} more entries
          </button>
        ) : null}
        {renderEmptyDirectoryNotice(state, depth)}
      </div>
    );
  };

  const closeGitDiffView = (path: string): void => {
    restoreFocusPathRef.current = path;
    setGitDiffState(null);
  };

  const renderGitDiffView = (state: GitDiffState): ReactNode => (
    <div className="fpv" ref={filesRef} tabIndex={-1}>
      {renderGitDiffBar(state.path, () => closeGitDiffView(state.path))}
      {renderGitDiffContent(state)}
    </div>
  );

  const renderRootBar = (): ReactNode => {
    if (onRootChange === undefined) return null;
    return (
      <form
        className="files-root-bar"
        role="group"
        aria-label="Folder root"
        onSubmit={(event) => {
          event.preventDefault();
          openRoot(rootDraft);
        }}
      >
        <button
          type="button"
          className="files-root-up"
          onClick={goUp}
          disabled={currentDirectoryPath === null && parentDir(resolvedRoot ?? apiRoot) === null}
          title="Open parent folder"
          aria-label="Open parent folder"
        >
          <Icons.arrowUp size={13} />
        </button>
        <input
          type="text"
          className="files-root-input mono"
          aria-label="Folder path — open any folder on this machine"
          placeholder="/path/to/any/folder"
          spellCheck={false}
          value={rootDraft}
          onChange={(event) => setRootDraft(event.target.value)}
        />
        <button type="submit" className="files-root-open" title="Open this folder">
          Open
        </button>
      </form>
    );
  };

  const renderGitStatusBar = (): ReactNode => {
    if (gitSummary === null) return null;
    return (
      <div
        className="files-git-status"
        role="status"
        data-state={
          gitStatusState.status?.state ?? (gitStatusState.error !== null ? "error" : "loading")
        }
      >
        <Icons.git size={13} />
        <span>{gitSummary}</span>
        {canOpenGitDelivery ? (
          <button
            className="files-root-up"
            style={{ width: 24, height: 24, marginLeft: "auto" }}
            type="button"
            onClick={() => onOpenGitDelivery?.(gitDeliveryRoot)}
            title="Open Git"
            aria-label="Open Git"
          >
            <Icons.branch size={13} />
          </button>
        ) : null}
      </div>
    );
  };

  const renderGitTruncatedNotice = (): ReactNode =>
    gitStatusState.status?.available === true && gitStatusState.status.truncated ? (
      <div className="files-note files-warning" role="status">
        {t("git.decorationsIncomplete", { count: gitStatusState.status.maxChanges })}
      </div>
    ) : null;

  const renderFilesToolbarButtons = (): ReactNode => (
    <>
      <button
        className="files-refresh"
        type="button"
        onClick={refreshCurrentDirectory}
        title="Refresh folder"
        aria-label="Refresh folder"
      >
        <Icons.reset size={13} />
      </button>
      {mutationsEnabled ? (
        <>
          {/* New file / new folder reuse the hover-revealed `.files-refresh` icon-button styling;
              only the horizontal offset is inline, so globals.css (and the #1300 proof) is untouched. */}
          <button
            className="files-refresh"
            style={{ right: 62 }}
            type="button"
            onClick={() => startNewEntry("new-file", currentDirectoryPath)}
            title="New file"
            aria-label="New file"
          >
            <Icons.file size={13} />
          </button>
          <button
            className="files-refresh"
            style={{ right: 34 }}
            type="button"
            onClick={() => startNewEntry("new-folder", currentDirectoryPath)}
            title="New folder"
            aria-label="New folder"
          >
            <Icons.folder size={13} />
          </button>
        </>
      ) : null}
    </>
  );

  // tabIndex -1: the tree container only receives programmatic focus; rows stay native
  // buttons (Tab fallback) while onTreeKeyDown adds the arrow-key traversal (C215).
  const renderFilesTree = (): ReactNode => (
    <div
      className="tr files-tree"
      role="tree"
      aria-label="Files"
      tabIndex={-1}
      onKeyDown={onTreeKeyDown}
    >
      {renderDirectory(currentDirectoryPath ?? "", 0)}
    </div>
  );

  const renderContextMenuTargetActions = (target: FilesTreeEntry): ReactNode => (
    <>
      <button
        type="button"
        className="edm-item"
        role="menuitem"
        onClick={() => startRename(target)}
      >
        <Icons.edit size={14} />
        <span>Rename…</span>
      </button>
      <button
        type="button"
        className="edm-item"
        role="menuitem"
        onClick={() => void duplicateEntry(target)}
      >
        <Icons.copy size={14} />
        <span>Duplicate</span>
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
        <Icons.trash size={14} />
        <span>Delete…</span>
      </button>
    </>
  );

  const renderContextMenuItems = (state: ContextMenuState): ReactNode => {
    const target = menuTargetEntry(state);
    const parent = menuParentPath(state, currentDirectoryPath);
    return (
      <>
        {target !== null ? renderContextMenuTargetActions(target) : null}
        <button
          type="button"
          className="edm-item"
          role="menuitem"
          onClick={() => startNewEntry("new-file", parent)}
        >
          <Icons.file size={14} />
          <span>New File…</span>
        </button>
        <button
          type="button"
          className="edm-item"
          role="menuitem"
          onClick={() => startNewEntry("new-folder", parent)}
        >
          <Icons.folder size={14} />
          <span>New Folder…</span>
        </button>
      </>
    );
  };

  const renderContextMenu = (): ReactNode => {
    if (menu === null) return null;
    return (
      <div
        ref={menuRef}
        role="menu"
        aria-label="File actions"
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
        {renderContextMenuItems(menu)}
      </div>
    );
  };

  const renderDeleteConfirmDialog = (): ReactNode => {
    if (confirmDelete === null) return null;
    return (
      <div className="ed-dialog-backdrop" role="presentation">
        {/* GEN-UI-FOCUS-002 — Escape cancels; Tab/Shift+Tab stay trapped inside the dialog
            (WCAG 2.1.2 — jsdom does not enforce inert, so the wrap is explicit). */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- WCAG 2.1.2 modal focus trap + Escape */}
        <div
          ref={deleteDialogRef}
          className="ed-dirty-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="files-delete-title"
          aria-describedby="files-delete-body"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              if (!opBusy) {
                setConfirmDelete(null);
                setOpError(null);
              }
              return;
            }
            trapDialogTab(event.currentTarget, event);
          }}
        >
          <h2 id="files-delete-title">
            Delete {confirmDelete.kind === "directory" ? "folder" : "file"}?
          </h2>
          <p id="files-delete-body">
            "{confirmDelete.name}" will be permanently deleted
            {confirmDelete.kind === "directory" ? ", including everything inside it" : ""}. This
            cannot be undone.
          </p>
          {opError !== null ? <p role="alert">{opError}</p> : null}
          <div className="ed-dialog-actions">
            <button
              type="button"
              className="ed-reload"
              onClick={() => void performDelete(confirmDelete)}
              disabled={opBusy}
            >
              {opBusy ? "Deleting..." : "Delete"}
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
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderTreeTooltipPortal = (): ReactNode => {
    if (treeTooltip === null || typeof document === "undefined") return null;
    return createPortal(
      <div
        ref={treeTooltipElRef}
        className="files-tree-tooltip mono"
        role="tooltip"
        style={{ left: treeTooltip.x, top: treeTooltip.y }}
      >
        {treeTooltip.text}
      </div>,
      document.body,
    );
  };

  if (gitDiffState !== null) {
    return renderGitDiffView(gitDiffState);
  }

  if (selectedPath !== null) {
    return (
      <FilePreview
        root={resolvedRoot ?? apiRoot}
        path={selectedPath}
        onOpenInEditor={onOpenFile}
        onClose={() => {
          restoreFocusPathRef.current = selectedPath;
          setSelectedPath(null);
          activeFileChangeRef.current?.(null, resolvedRoot ?? apiRoot);
        }}
      />
    );
  }

  return (
    // tabIndex -1: programmatic focus target only — the fallback for the focus restore above
    // when the previously previewed row no longer exists after a refresh.
    <div className="files" ref={filesRef} tabIndex={-1}>
      {renderRootBar()}
      {renderGitStatusBar()}
      {renderGitTruncatedNotice()}
      {renderFilesToolbarButtons()}
      <span id={unreadableReasonId} className="visually-hidden">
        This link can&apos;t be opened from this folder.
      </span>
      {renderFilesTree()}
      {renderContextMenu()}
      {renderDeleteConfirmDialog()}
      {renderTreeTooltipPortal()}
    </div>
  );
}
