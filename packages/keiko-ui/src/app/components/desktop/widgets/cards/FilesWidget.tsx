"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { fetchFilesTree, fetchProjects } from "../../../../../lib/api";
import type { FilesTreeEntry } from "../../../../../lib/types";
import { Icons } from "../../Icons";
import { FileIcon } from "../shared/projectTree";
import { FilePreview } from "./FilePreview";

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

interface DirectoryState {
  readonly entries: readonly FilesTreeEntry[];
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  // Non-error empty state ("no folder is open"): rendered as a plain note WITHOUT the Retry
  // button — retrying cannot change anything when no root is configured (audit C021).
  readonly notice: "no-root" | null;
}

interface TreeTooltipState {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

const TREE_TOOLTIP_DELAY_MS = 650;
const TREE_TOOLTIP_MAX_WIDTH = 240;

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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  const value = idx === 0 ? size.toFixed(0) : size.toFixed(size >= 10 ? 1 : 2);
  return `${value} ${units[idx]}`;
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

function gitChangeLabel(change: GitChangedFile): string {
  if (change.conflicted) return "U";
  if (change.untracked) return "?";
  if (change.indexStatus !== " ") return change.indexStatus;
  return change.worktreeStatus;
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
  const trimmedRoot = root?.trim();
  const configuredRoot = trimmedRoot !== undefined && trimmedRoot.length > 0 ? trimmedRoot : null;
  const [fallbackRoot, setFallbackRoot] = useState<string | null>(null);
  const apiRoot = configuredRoot ?? fallbackRoot ?? "";
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null);
  // Root bar draft: what the user is typing as the next folder to open. Synced to the resolved
  // (real) root whenever the widget loads a folder, so it always shows where we are.
  const [rootDraft, setRootDraft] = useState<string>("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [currentDirectoryPath, setCurrentDirectoryPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
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
  // Shared ARIA description for unreadable symlink rows (audit C196): the rows stay focusable
  // via aria-disabled, and this single hidden span explains WHY they cannot be opened.
  const unreadableReasonId = useId();
  const [gitStatusState, setGitStatusState] = useState<GitStatusState>({
    loading: false,
    status: null,
    error: null,
  });
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
  // Root-relative path of the entry currently being dragged in the tree (null when not dragging).
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const onFilesMutatedRef = useRef(onFilesMutated);
  onFilesMutatedRef.current = onFilesMutated;

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

  const moveTreeTooltip = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    treeTooltipPointerRef.current = { x: event.clientX, y: event.clientY };
    setTreeTooltip((current) => {
      if (current === null) return current;
      const position = treeTooltipPosition(event.clientX, event.clientY);
      return { ...current, ...position };
    });
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
        const response = await fetchFilesTree(apiRoot, path);
        if (path === "") {
          setResolvedRoot(response.root);
          activeFileChangeRef.current?.(null, response.root, null);
          setCurrentDirectoryPath(null);
        }
        setDirectories((current) => ({
          ...current,
          [path]: {
            entries: response.entries,
            truncated: response.truncated,
            loading: false,
            error: null,
            notice: null,
          },
        }));
      } catch (error: unknown) {
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
    [apiRoot],
  );

  useEffect(() => {
    setSelectedPath(null);
    setGitDiffState(null);
    setCurrentDirectoryPath(null);
    activeFileChangeRef.current?.(null, null, null);
    setResolvedRoot(null);
    setExpanded(new Set([""]));
    setDirectories({});
    void loadDirectory("");
  }, [apiRoot, loadDirectory]);

  useEffect(() => {
    const targetRoot = resolvedRoot ?? (apiRoot.length > 0 ? apiRoot : null);
    if (targetRoot === null) {
      setGitStatusState({ loading: false, status: null, error: null });
      return;
    }
    let cancelled = false;
    setGitStatusState((current) => ({ ...current, loading: true, error: null }));
    void fetchGitStatus(targetRoot)
      .then((status) => {
        if (!cancelled) setGitStatusState({ loading: false, status, error: null });
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
  }, [apiRoot, resolvedRoot]);

  const visibleRootPath = displayPath(
    resolvedRoot ?? (apiRoot.length > 0 ? apiRoot : ""),
    currentDirectoryPath,
  );

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
    void loadDirectory(currentDirectoryPath ?? "");
  }, [currentDirectoryPath, loadDirectory]);

  // The root every mutation targets — the resolved real root, or the configured one before it loads.
  const mutationRoot = resolvedRoot ?? apiRoot;
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
        onFilesMutatedRef.current?.({ op: "delete", mutation: result });
      } catch (error: unknown) {
        setOpError(errorMessage(error));
      } finally {
        setOpBusy(false);
      }
    },
    [loadDirectory, mutationRoot, opBusy, selectedPath],
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
        // A copy adds a new entry — the host treats it like a create (no open tab to re-home).
        onFilesMutatedRef.current?.({ op: "create", mutation: result });
      } catch (error: unknown) {
        setOpError(errorMessage(error));
      } finally {
        setOpBusy(false);
      }
    },
    [directories, loadDirectory, mutationRoot, opBusy],
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
        onFilesMutatedRef.current?.({ op: "rename", mutation: result });
      } catch (error: unknown) {
        setOpError(errorMessage(error));
      } finally {
        setOpBusy(false);
      }
    },
    [loadDirectory, mutationRoot, opBusy],
  );

  const openContextMenu = useCallback(
    (event: ReactMouseEvent, entry: FilesTreeEntry | null): void => {
      if (!mutationsEnabled) return;
      event.preventDefault();
      event.stopPropagation();
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
    if (!wasOpen && directories[entry.path] === undefined) {
      void loadDirectory(entry.path);
    }
  };

  const enterDirectory = (entry: FilesTreeEntry): void => {
    if (!entry.readable) return;
    goToDirectory(entry.path);
  };

  const retryDirectory = (path: string): void => {
    void loadDirectory(path);
  };

  const openDiff = useCallback(
    (path: string): void => {
      const targetRoot = resolvedRoot ?? apiRoot;
      if (targetRoot.length === 0) return;
      setSelectedPath(null);
      setGitDiffState({ path, loading: true, response: null, error: null });
      void fetchGitDiff({ root: targetRoot, path })
        .then((response) => {
          setGitDiffState({ path, loading: false, response, error: null });
        })
        .catch((error: unknown) => {
          setGitDiffState({ path, loading: false, response: null, error: errorMessage(error) });
        });
    },
    [apiRoot, resolvedRoot],
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
  // are intentionally NOT part of the arrow order — only `.tr-row` buttons are traversed.
  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // F2 renames and Delete removes the focused readable row (VS Code parity), reusing the same
    // inline-edit / confirm flows as the context menu.
    if (mutationsEnabled && (event.key === "F2" || event.key === "Delete")) {
      const focusedRow =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLButtonElement>("button.tr-row[data-readable='true']")
          : null;
      const path = focusedRow?.getAttribute("data-path");
      const entry = path !== null && path !== undefined ? findEntry(path) : null;
      if (entry !== null) {
        event.preventDefault();
        if (event.key === "F2") startRename(entry);
        else {
          setOpError(null);
          setConfirmDelete(entry);
        }
      }
      return;
    }
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

  const gitChanges: readonly GitChangedFile[] =
    gitStatusState.status?.available === true ? gitStatusState.status.changes : [];
  const gitChangeByPath = new Map<string, GitChangedFile>(
    gitChanges.map((change): [string, GitChangedFile] => [change.path, change]),
  );
  const gitSummary = gitStatusSummary(gitStatusState);
  const gitDeliveryRoot =
    gitStatusState.status?.available === true
      ? (gitStatusState.status.repositoryRoot ?? gitStatusState.status.root)
      : "";
  const canOpenGitDelivery =
    onOpenGitDelivery !== undefined &&
    gitStatusState.status?.available === true &&
    gitDeliveryRoot.length > 0;

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

  const renderEntry = (entry: FilesTreeEntry, depth: number): ReactNode => {
    const pad = treeIndent(depth);
    const open = expanded.has(entry.path);
    if (pendingEntry?.kind === "rename" && pendingEntry.path === entry.path) {
      const icon =
        entry.kind === "directory" ? (
          <span className="fi-fallback" style={{ color: "var(--accent)" }}>
            <Icons.folder size={14} />
          </span>
        ) : (
          <FileIcon name={entryDraft.length > 0 ? entryDraft : entry.name} />
        );
      return renderInlineEditor(depth, icon, `Rename ${entry.name}`);
    }
    // Unreadable symlinks stay focusable via aria-disabled (instead of native disabled) so
    // keyboard/screen-reader users can reach the row and hear the reason (audit C196). The
    // neutral copy covers all server cases — outside root, deny-listed AND broken links
    // (audit C349). Clicks are guarded instead of blocked by the browser.
    const unreadableTitle = "This link can't be opened from this folder.";
    const entryTip = entry.readable ? entry.path : unreadableTitle;
    if (entry.kind === "directory") {
      const state = directories[entry.path];
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
              onPointerEnter={(event) => scheduleTreeTooltip(event, entryTip)}
              onPointerMove={moveTreeTooltip}
              onPointerLeave={hideTreeTooltip}
              onBlur={hideTreeTooltip}
              onClick={() => enterDirectory(entry)}
            >
              <span className="fi-fallback" style={{ color: "var(--accent)" }}>
                <Icons.folder size={14} />
              </span>
              <span className="tr-name tr-folder">{entry.name}</span>
              {entry.symlink ? <span className="tr-badge">link</span> : null}
            </button>
          </div>
          {open ? renderDirectory(entry.path, depth + 1, state) : null}
        </div>
      );
    }

    const activePath = selectedPath ?? activeFilePath ?? null;
    const change = gitChangeByPath.get(entry.path);
    return (
      <button
        className="tr-row tr-file"
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={activePath === entry.path}
        data-active={activePath === entry.path}
        data-readable={entry.readable}
        data-path={entry.path}
        key={entry.path}
        style={{ paddingLeft: pad }}
        type="button"
        aria-disabled={entry.readable ? undefined : true}
        aria-describedby={entry.readable ? undefined : unreadableReasonId}
        onPointerEnter={(event) => scheduleTreeTooltip(event, entryTip)}
        onPointerMove={moveTreeTooltip}
        onPointerLeave={hideTreeTooltip}
        onBlur={hideTreeTooltip}
        onClick={() => {
          if (!entry.readable) return;
          const fileRoot = resolvedRoot ?? apiRoot;
          if (openFilesDirectly && onOpenFile !== undefined) {
            activeFileChangeRef.current?.(entry.path, fileRoot);
            onOpenFile(fileRoot, entry.path);
            return;
          }
          setSelectedPath(entry.path);
          activeFileChangeRef.current?.(entry.path, fileRoot);
        }}
      >
        {/* invisible caret placeholder keeps file rows aligned with sibling folders (C216) */}
        <span className="tr-caret tr-caret-ghost" aria-hidden="true">
          <Icons.chevronR size={11} />
        </span>
        <FileIcon name={entry.name} />
        <span className="tr-name">{entry.name}</span>
        {entry.symlink ? <span className="tr-badge">link</span> : null}
        <span className="tr-meta mono">{formatBytes(entry.sizeBytes)}</span>
      </button>
    );
  };

  const renderDirectory = (path: string, depth: number, state = directories[path]): ReactNode => (
    // Nested levels are role="group" so the treeitem hierarchy is exposed (audit C143);
    // the root level sits directly under role="tree".
    <div className="tr-dir" role={depth === 0 ? undefined : "group"}>
      {state?.loading === true ? (
        <div className="files-note" role="status" style={{ paddingLeft: treeIndent(depth) + 18 }}>
          Loading…
        </div>
      ) : null}
      {state?.notice === "no-root" ? (
        <div className="files-note" role="status" style={{ paddingLeft: treeIndent(depth) + 18 }}>
          {onRootChange !== undefined
            ? "No folder is open yet. Enter a folder path above and press Open."
            : "No registered project is available."}
        </div>
      ) : null}
      {state?.error !== null && state?.error !== undefined ? (
        <div className="files-error" role="alert" style={{ marginLeft: treeIndent(depth) }}>
          <span>{state.error}</span>
          <button type="button" className="files-retry" onClick={() => retryDirectory(path)}>
            Retry
          </button>
        </div>
      ) : null}
      {/* Truncation notice sits ABOVE the rows so it is visible as soon as the folder opens
          (audit C353 — below 1000 rows it sat ~24,000px outside the viewport). The count comes
          from the response instead of a hardcoded "1000": the server also truncates early when
          its ignored-entry scan cap is hit, i.e. with fewer visible entries (audit C350). */}
      {state?.truncated === true ? (
        <div
          className="files-note files-warning"
          role="status"
          style={{ paddingLeft: treeIndent(depth) + 18 }}
        >
          Showing only the first {state.entries.length} entries — this folder contains more.
        </div>
      ) : null}
      {pendingEntry !== null &&
      pendingEntry.kind !== "rename" &&
      (pendingEntry.parentPath ?? "") === path
        ? renderInlineEditor(
            depth,
            pendingEntry.kind === "new-folder" ? (
              <span className="fi-fallback" style={{ color: "var(--accent)" }}>
                <Icons.folder size={14} />
              </span>
            ) : (
              <FileIcon name={entryDraft.length > 0 ? entryDraft : "new-file"} />
            ),
            pendingEntry.kind === "new-folder" ? "New folder name" : "New file name",
          )
        : null}
      {state?.entries.map((entry) => renderEntry(entry, depth))}
      {state !== undefined &&
      !state.loading &&
      state.error === null &&
      state.notice === null &&
      state.entries.length === 0 ? (
        <div className="files-note" role="status" style={{ paddingLeft: treeIndent(depth) + 18 }}>
          Empty folder.
        </div>
      ) : null}
    </div>
  );

  if (gitDiffState !== null) {
    const diff = gitDiffState.response?.diff ?? "";
    return (
      <div className="fpv" ref={filesRef} tabIndex={-1}>
        <div className="fpv-bar">
          <button
            className="fpv-back"
            type="button"
            onClick={() => {
              restoreFocusPathRef.current = gitDiffState.path;
              setGitDiffState(null);
            }}
            title="Back to files"
            aria-label="Back to files"
          >
            <Icons.back size={15} />
          </button>
          <Icons.diff size={15} />
          <span className="fpv-name" title={gitDiffState.path}>
            {gitDiffState.path}
          </span>
          <span className="fpv-lang mono">git diff</span>
          <span className="spacer" />
          <button
            className="fpv-back"
            type="button"
            onClick={() => {
              restoreFocusPathRef.current = gitDiffState.path;
              setGitDiffState(null);
            }}
            title="Close diff"
            aria-label="Close diff"
          >
            <Icons.close size={15} />
          </button>
        </div>
        {gitDiffState.loading ? (
          <div className="fpv-state" role="status">
            Loading diff…
          </div>
        ) : null}
        {gitDiffState.error !== null ? (
          <div className="fpv-state fpv-error" role="alert">
            <span>{gitDiffState.error}</span>
          </div>
        ) : null}
        {gitDiffState.response?.truncated === true ? (
          <div className="fpv-banner">
            Diff truncated at {formatBytes(gitDiffState.response.maxBytes)}.
          </div>
        ) : null}
        {gitDiffState.response !== null ? (
          <div
            className="fpv-code mono"
            // Scrollable diff pane: tabIndex makes the overflow region keyboard-scrollable.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={`Git diff: ${gitDiffState.path}`}
          >
            {diff.length > 0 ? (
              diff.split("\n").map((line: string, index: number) => (
                <div className="fpv-line" key={index}>
                  <span className="fpv-src">{line.length > 0 ? line : " "}</span>
                </div>
              ))
            ) : (
              <div className="fpv-line">
                <span className="fpv-src">No diff available.</span>
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
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
      {onRootChange !== undefined ? (
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
      ) : null}
      {gitSummary !== null ? (
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
              onClick={() => onOpenGitDelivery(gitDeliveryRoot)}
              title="Open Git"
              aria-label="Open Git"
            >
              <Icons.branch size={13} />
            </button>
          ) : null}
        </div>
      ) : null}
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
      <span id={unreadableReasonId} className="visually-hidden">
        This link can&apos;t be opened from this folder.
      </span>
      {/* tabIndex -1: the tree container only receives programmatic focus; rows stay native
          buttons (Tab fallback) while onTreeKeyDown adds the arrow-key traversal (C215). */}
      <div
        className="tr files-tree"
        role="tree"
        aria-label="Files"
        tabIndex={-1}
        onKeyDown={onTreeKeyDown}
      >
        {renderDirectory(currentDirectoryPath ?? "", 0)}
      </div>
      {treeTooltip !== null && typeof document !== "undefined"
        ? createPortal(
            <div
              className="files-tree-tooltip mono"
              role="tooltip"
              style={{ left: treeTooltip.x, top: treeTooltip.y }}
            >
              {treeTooltip.text}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
