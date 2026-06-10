"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { fetchFilesTree, fetchProjects } from "../../../../../lib/api";
import type { FilesTreeEntry, SelectedScopeKind } from "../../../../../lib/types";
import { useOptionalChatSessionContext } from "../../context/ChatSessionContext";
import { Icons } from "../../Icons";
import { ScopeConnectButton } from "../../ScopeConnectButton";
import { FileIcon } from "../shared/projectTree";
import { FilePreview } from "./FilePreview";

interface FilesWidgetProps {
  root?: string;
  onActiveFileChange?: (path: string | null, root: string | null) => void;
  // Called when the user opens a different machine path from the root bar. The window host
  // persists it into cfg.root so the new root survives reload (widgets/index.tsx). When omitted,
  // the root bar is hidden (the widget is then locked to its configured/fallback root).
  onRootChange?: (root: string) => void;
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

interface DirectoryState {
  readonly entries: readonly FilesTreeEntry[];
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  // Non-error empty state ("no folder is open"): rendered as a plain note WITHOUT the Retry
  // button — retrying cannot change anything when no root is configured (audit C021).
  readonly notice: "no-root" | null;
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

const TREE_NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"]);

// Arrow-key traversal for the file tree (APG tree pattern subset, audit C215). Rows stay
// native buttons — Tab/Enter/Space keep working — arrows add efficient traversal, Home/End
// jump, Right expands / Left collapses or moves to the parent level (via aria-level).
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
  if (key === "ArrowDown") rows[index + 1]?.focus();
  else if (key === "ArrowUp") rows[index - 1]?.focus();
  else if (key === "Home") rows[0]?.focus();
  else if (key === "End") rows[rows.length - 1]?.focus();
  else if (key === "ArrowRight") {
    const expandedState = row.getAttribute("aria-expanded");
    if (expandedState === "false") row.click();
    else if (expandedState === "true") rows[index + 1]?.focus();
  } else if (key === "ArrowLeft") {
    if (row.getAttribute("aria-expanded") === "true") row.click();
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

export function FilesWidget({
  root,
  onActiveFileChange,
  onRootChange,
}: FilesWidgetProps): ReactNode {
  const session = useOptionalChatSessionContext();
  const activeChat = session?.activeChat;
  const trimmedRoot = root?.trim();
  const configuredRoot = trimmedRoot !== undefined && trimmedRoot.length > 0 ? trimmedRoot : null;
  const [fallbackRoot, setFallbackRoot] = useState<string | null>(null);
  const apiRoot = configuredRoot ?? fallbackRoot ?? "";
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null);
  // Root bar draft: what the user is typing as the next folder to open. Synced to the resolved
  // (real) root whenever the widget loads a folder, so it always shows where we are.
  const [rootDraft, setRootDraft] = useState<string>("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([""]));
  const [refreshKey, setRefreshKey] = useState(0);
  const activeFileChangeRef = useRef(onActiveFileChange);
  activeFileChangeRef.current = onActiveFileChange;
  // Focus restore (WCAG 2.4.3): closing the preview re-mounts the whole tree, which would drop
  // focus onto document.body. Remember the previewed path on close and put focus back onto its
  // tree row once the tree is rendered again (fallback: the widget container).
  const filesRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusPathRef = useRef<string | null>(null);
  // Shared ARIA description for unreadable symlink rows (audit C196): the rows stay focusable
  // via aria-disabled, and this single hidden span explains WHY they cannot be opened.
  const unreadableReasonId = useId();

  useEffect(() => {
    if (selectedPath !== null) return;
    const path = restoreFocusPathRef.current;
    if (path === null) return;
    restoreFocusPathRef.current = null;
    const row = filesRef.current?.querySelector<HTMLButtonElement>(
      `.tr-file[data-path="${cssEscape(path)}"]`,
    );
    (row ?? filesRef.current)?.focus({ preventScroll: true });
  }, [selectedPath]);

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
          activeFileChangeRef.current?.(null, response.root);
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
    activeFileChangeRef.current?.(null, null);
    setResolvedRoot(null);
    setExpanded(new Set([""]));
    setDirectories({});
    void loadDirectory("");
  }, [apiRoot, loadDirectory, refreshKey]);

  // Keep the root-bar input showing where we actually are (the resolved real root, else the api root).
  useEffect(() => {
    const current = resolvedRoot ?? (apiRoot.length > 0 ? apiRoot : "");
    setRootDraft(current);
  }, [resolvedRoot, apiRoot]);

  const openRoot = useCallback(
    (next: string): void => {
      const target = next.trim();
      if (onRootChange === undefined || target.length === 0) return;
      if (target === (resolvedRoot ?? apiRoot)) return;
      onRootChange(target);
    },
    [onRootChange, resolvedRoot, apiRoot],
  );

  const goUp = useCallback((): void => {
    const parent = parentDir(resolvedRoot ?? apiRoot);
    if (parent !== null) openRoot(parent);
  }, [resolvedRoot, apiRoot, openRoot]);

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

  const retryDirectory = (path: string): void => {
    void loadDirectory(path);
  };

  // Arrow-key navigation across the currently visible rows (audit C215). Scope-connect pills
  // are intentionally NOT part of the arrow order — only `.tr-row` buttons are traversed.
  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
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

  const renderScopeConnector = (
    scopeKind: SelectedScopeKind,
    relativePath: string,
    targetName?: string,
  ): ReactNode => {
    if (session === null || activeChat === undefined) return null;
    if (apiRoot.length === 0) return null;
    if (scopeKind !== "workspace-root" && relativePath.length === 0) return null;
    return (
      <ScopeConnectButton
        chatId={activeChat.id}
        scopeKind={scopeKind}
        currentScopeKind={activeChat.connectedScope?.kind}
        candidateRelativePaths={scopeKind === "workspace-root" ? [] : [relativePath]}
        chat={activeChat}
        onConnected={session.replaceChat}
        targetName={targetName}
      />
    );
  };

  const renderRootConnector = (): ReactNode => {
    const connector = renderScopeConnector("workspace-root", "");
    if (connector === null) return null;
    return (
      <div className="files-scope-bar" role="group" aria-label="Repository scope connector">
        <span className="files-scope-label">Repository scope</span>
        {connector}
      </div>
    );
  };

  const renderEntry = (entry: FilesTreeEntry, depth: number): ReactNode => {
    const pad = treeIndent(depth);
    const open = expanded.has(entry.path);
    // Unreadable symlinks stay focusable via aria-disabled (instead of native disabled) so
    // keyboard/screen-reader users can reach the row and hear the reason (audit C196). The
    // neutral copy covers all server cases — outside root, deny-listed AND broken links
    // (audit C349). Clicks are guarded instead of blocked by the browser.
    const unreadableTitle = "This link can't be opened from this folder.";
    if (entry.kind === "directory") {
      const state = directories[entry.path];
      return (
        <div className="tr-row-wrap" key={entry.path}>
          <button
            className="tr-row"
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={false}
            data-readable={entry.readable}
            style={{ paddingLeft: pad }}
            type="button"
            aria-disabled={entry.readable ? undefined : true}
            aria-describedby={entry.readable ? undefined : unreadableReasonId}
            aria-expanded={open}
            onClick={() => toggleDirectory(entry)}
            title={entry.readable ? entry.path : unreadableTitle}
          >
            <span className="tr-caret" data-open={open}>
              <Icons.chevronR size={11} />
            </span>
            <span className="fi-fallback" style={{ color: "var(--accent)" }}>
              <Icons.folder size={14} />
            </span>
            <span className="tr-name tr-folder">{entry.name}</span>
            {entry.symlink ? <span className="tr-badge">link</span> : null}
          </button>
          {entry.readable ? (
            <div className="tr-connect" style={{ paddingLeft: pad + 20 }}>
              {renderScopeConnector("directory", entry.path, entry.name)}
            </div>
          ) : null}
          {open ? renderDirectory(entry.path, depth + 1, state) : null}
        </div>
      );
    }

    return (
      <button
        className="tr-row tr-file"
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selectedPath === entry.path}
        data-active={selectedPath === entry.path}
        data-readable={entry.readable}
        data-path={entry.path}
        key={entry.path}
        style={{ paddingLeft: pad }}
        type="button"
        aria-disabled={entry.readable ? undefined : true}
        aria-describedby={entry.readable ? undefined : unreadableReasonId}
        onClick={() => {
          if (!entry.readable) return;
          setSelectedPath(entry.path);
          activeFileChangeRef.current?.(entry.path, resolvedRoot ?? apiRoot);
        }}
        title={entry.readable ? entry.path : unreadableTitle}
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

  if (selectedPath !== null) {
    return (
      <FilePreview
        root={resolvedRoot ?? apiRoot}
        path={selectedPath}
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
            disabled={parentDir(resolvedRoot ?? apiRoot) === null}
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
      <button
        className="files-refresh"
        type="button"
        onClick={() => setRefreshKey((value) => value + 1)}
        title="Refresh folder"
        aria-label="Refresh folder"
      >
        <Icons.reset size={13} />
      </button>
      {renderRootConnector()}
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
        {renderDirectory("", 0)}
      </div>
    </div>
  );
}
