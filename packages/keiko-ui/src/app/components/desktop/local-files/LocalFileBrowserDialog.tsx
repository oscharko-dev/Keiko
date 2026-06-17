"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ApiError, fetchFilesTree, fetchProjects } from "@/lib/api";
import type { FilesTreeEntry, ProjectWithAvailability } from "@/lib/types";
import { useModalInteractionLock } from "../hooks/useModalInteractionLock";
import { Icons } from "../Icons";

export type LocalFileBrowserSelectionMode = "folder" | "file" | "files" | "folder-or-files";

export interface LocalFileBrowserSelection {
  readonly rootPath: string;
  readonly folderPath: string;
  readonly files: readonly string[];
}

interface LocalFileBrowserDialogProps {
  readonly mode: LocalFileBrowserSelectionMode;
  readonly title: string;
  readonly description: string;
  readonly note?: ReactNode;
  readonly initialRootPath: string;
  readonly initialFiles?: readonly string[];
  readonly fetchProjectsImpl?: typeof fetchProjects;
  readonly fetchFilesTreeImpl?: typeof fetchFilesTree;
  readonly isFileDisabled?: (entry: FilesTreeEntry) => boolean;
  readonly fileDisabledReason?: (entry: FilesTreeEntry) => string | undefined;
  readonly fileMeta?: (entry: FilesTreeEntry, selected: boolean) => ReactNode;
  readonly onApply: (selection: LocalFileBrowserSelection) => void;
  readonly onCancel: () => void;
}

const GENERIC_BROWSE_ERROR = "Der Ordner konnte nicht geladen werden.";

// Mirror the shared local-knowledge formatError contract: an ApiError carries a stable code that the
// bare `.message` (often just "HTTP 500") drops, and any empty message must fall back to a non-empty
// string so the alert is never rendered blank (an invisible empty error box).
function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    const base = error.message.trim();
    return base.length > 0 ? `${base} (${error.code})` : `${GENERIC_BROWSE_ERROR} (${error.code})`;
  }
  if (error instanceof Error) {
    return error.message.trim().length > 0 ? error.message : GENERIC_BROWSE_ERROR;
  }
  const text = String(error).trim();
  return text.length > 0 ? text : GENERIC_BROWSE_ERROR;
}

export function dirname(path: string): string {
  const clean = path.trim().replace(/[/\\]+$/u, "");
  const slashIdx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (slashIdx <= 0) return clean.startsWith("/") ? "/" : "";
  return clean.slice(0, slashIdx);
}

export function displayLocalPath(root: string, relativePath: string | null): string {
  if (relativePath === null || relativePath.length === 0) return root;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[/\\]+$/u, "")}${separator}${relativePath.replace(/\//gu, separator)}`;
}

function parentRelativePath(path: string | null): string | null {
  if (path === null || path.length === 0) return null;
  const trimmed = path.replace(/\/+$/u, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  return parent.length > 0 ? parent : null;
}

function useFocusTrap(
  dialogRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  onEscape: () => void,
): void {
  // Initial focus runs ONCE per open — keyed only on [active, dialogRef]. Keeping it out of the
  // keydown effect matters: onEscape (the caller's onCancel) usually has an unstable identity, so a
  // combined effect would re-run on every parent re-render and yank focus back to the first control
  // while the user is mid-navigation.
  useEffect(() => {
    if (!active) return;
    dialogRef.current
      ?.querySelector<HTMLElement>(
        "button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])",
      )
      ?.focus();
  }, [active, dialogRef]);

  useEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const narrowedDialog: HTMLDivElement = dialog;

    function focusablesIn(root: HTMLDivElement): readonly HTMLElement[] {
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])",
        ),
      );
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusablesIn(narrowedDialog);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    narrowedDialog.addEventListener("keydown", handleKeyDown);
    return () => narrowedDialog.removeEventListener("keydown", handleKeyDown);
  }, [active, dialogRef, onEscape]);
}

function modeAllowsFileSelection(mode: LocalFileBrowserSelectionMode): boolean {
  return mode === "file" || mode === "files" || mode === "folder-or-files";
}

function canApplySelection(
  mode: LocalFileBrowserSelectionMode,
  activeRoot: string,
  selectedFiles: ReadonlySet<string>,
): boolean {
  if (activeRoot.length === 0) return false;
  if (mode === "folder") return true;
  if (mode === "file") return selectedFiles.size === 1;
  if (mode === "files") return selectedFiles.size > 0;
  return true;
}

export function LocalFileBrowserDialog({
  mode,
  title,
  description,
  note,
  initialRootPath,
  initialFiles = [],
  fetchProjectsImpl = fetchProjects,
  fetchFilesTreeImpl = fetchFilesTree,
  isFileDisabled,
  fileDisabledReason,
  fileMeta,
  onApply,
  onCancel,
}: LocalFileBrowserDialogProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalInteractionLock();
  useFocusTrap(dialogRef, true, onCancel);

  const [projects, setProjects] = useState<readonly ProjectWithAvailability[]>([]);
  const [activeRoot, setActiveRoot] = useState(initialRootPath.trim());
  const [rootDraft, setRootDraft] = useState(initialRootPath.trim());
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly FilesTreeEntry[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<ReadonlySet<string>>(
    () => new Set(initialFiles),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchProjectsImpl()
      .then((payload) => {
        if (cancelled) return;
        const available = payload.projects.filter((project) => project.available);
        setProjects(available);
        if (activeRoot.length === 0 && available[0] !== undefined) {
          setActiveRoot(available[0].path);
          setRootDraft(available[0].path);
        }
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRoot.length, fetchProjectsImpl]);

  useEffect(() => {
    if (activeRoot.length === 0) {
      setEntries([]);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchFilesTreeImpl(activeRoot, currentPath ?? "")
      .then((payload) => {
        if (cancelled) return;
        setEntries(payload.entries);
        setActiveRoot(payload.root);
        setRootDraft(payload.root);
        const nextPath = payload.path.length > 0 ? payload.path : null;
        if (currentPath !== nextPath) setCurrentPath(nextPath);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setEntries([]);
          setError(formatError(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRoot, currentPath, fetchFilesTreeImpl]);

  function openRoot(nextRoot: string): void {
    const trimmed = nextRoot.trim();
    if (trimmed.length === 0) return;
    setSelectedFiles(new Set());
    setCurrentPath(null);
    setActiveRoot(trimmed);
    setRootDraft(trimmed);
  }

  function chooseProject(project: ProjectWithAvailability): void {
    openRoot(project.path);
  }

  function openDirectory(path: string): void {
    setSelectedFiles(new Set());
    setCurrentPath(path);
  }

  function selectSingleFile(path: string): void {
    setSelectedFiles(new Set([path]));
  }

  function toggleFile(path: string): void {
    setSelectedFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const visiblePath = displayLocalPath(activeRoot, currentPath);
  const selectedFilePaths = Array.from(selectedFiles);
  const selectedAbsolutePath =
    selectedFilePaths.length === 1
      ? displayLocalPath(activeRoot, selectedFilePaths[0] ?? null)
      : "";
  const canApply = canApplySelection(mode, activeRoot, selectedFiles);
  const allowsFileSelection = modeAllowsFileSelection(mode);
  const titleId = "local-file-browser-title";
  const descId = "local-file-browser-desc";

  function applySelection(): void {
    onApply({
      rootPath: activeRoot,
      folderPath: visiblePath,
      files: selectedFilePaths,
    });
  }

  return createPortal(
    <div
      className="dlg-overlay in"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="dlg lkd-source-picker"
        tabIndex={-1}
      >
        <div className="dlg-head">
          <div className="dlg-htext">
            <div id={titleId} className="dlg-title">
              {title}
            </div>
            <div id={descId} className="dlg-sub">
              {description}
            </div>
            {note !== undefined ? <div className="dlg-sub">{note}</div> : null}
          </div>
        </div>
        <div className="dlg-body lkd-source-picker-body">
          {projects.length > 0 ? (
            <div className="lkd-picker-projects" aria-label="Registered project folders">
              {projects.map((project) => (
                <button
                  key={project.path}
                  type="button"
                  className="lk-btn lk-btn-ghost"
                  onClick={() => chooseProject(project)}
                >
                  {project.name ?? project.path}
                </button>
              ))}
            </div>
          ) : null}

          <form
            className="lkd-picker-root"
            onSubmit={(event) => {
              event.preventDefault();
              openRoot(rootDraft);
            }}
          >
            <label htmlFor="local-file-browser-root" className="dlg-label">
              Folder root
            </label>
            <input
              id="local-file-browser-root"
              type="text"
              className="dlg-input lkd-connect-input"
              value={rootDraft}
              placeholder="/absolute/path/to/folder"
              onChange={(event) => setRootDraft(event.target.value)}
            />
            <button type="submit" className="lk-btn lk-btn-ghost">
              Open
            </button>
          </form>

          <div className="lkd-picker-current">
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              disabled={currentPath === null}
              onClick={() => {
                setSelectedFiles(new Set());
                setCurrentPath(parentRelativePath(currentPath));
              }}
            >
              Up
            </button>
            <span className="mono" title={visiblePath}>
              {visiblePath || "No folder selected"}
            </span>
          </div>

          {error !== null ? (
            <div role="alert" className="lk-alert">
              {error}
            </div>
          ) : null}
          {loading ? (
            <p role="status" className="lk-loading">
              Loading folder...
            </p>
          ) : (
            <ul className="lkd-picker-list" aria-label="Local source browser">
              {entries.map((entry) => {
                // A selectable source is a REGULAR file only. A "symlink"-kind entry (and any file
                // flagged symlink) must never be offered for selection — the workspace read path
                // refuses to follow symlinks, so selecting one would resolve to an unreadable source.
                const isSelectableFile = entry.kind === "file" && !entry.symlink;
                const fileDisabled =
                  entry.kind !== "directory" &&
                  (!isSelectableFile ||
                    !allowsFileSelection ||
                    !entry.readable ||
                    (isFileDisabled?.(entry) ?? false));
                const disabledReason =
                  entry.kind !== "directory" && fileDisabled
                    ? entry.symlink || entry.kind === "symlink"
                      ? "Symbolic links cannot be selected."
                      : (fileDisabledReason?.(entry) ?? "File cannot be selected.")
                    : undefined;
                const selected = selectedFiles.has(entry.path);

                return (
                  <li key={entry.path} className="lkd-picker-entry">
                    {entry.kind === "directory" ? (
                      <button
                        type="button"
                        className="lkd-picker-row"
                        disabled={!entry.readable}
                        onClick={() => openDirectory(entry.path)}
                      >
                        <Icons.folder size={14} />
                        <span>{entry.name}</span>
                      </button>
                    ) : mode === "file" ? (
                      <button
                        type="button"
                        className="lkd-picker-row"
                        disabled={fileDisabled}
                        aria-pressed={selected}
                        title={disabledReason}
                        onClick={() => selectSingleFile(entry.path)}
                      >
                        <Icons.files size={14} />
                        <span>{entry.name}</span>
                        <span className="lkd-picker-meta">
                          {fileMeta?.(entry, selected) ?? (selected ? "selected" : "")}
                        </span>
                      </button>
                    ) : (
                      <label
                        className="lkd-picker-row"
                        data-disabled={String(fileDisabled)}
                        title={disabledReason}
                      >
                        <input
                          type="checkbox"
                          disabled={fileDisabled}
                          checked={selected}
                          onChange={() => toggleFile(entry.path)}
                        />
                        <span>{entry.name}</span>
                        <span className="lkd-picker-meta">
                          {fileMeta?.(entry, selected) ?? (selected ? "selected" : "")}
                        </span>
                      </label>
                    )}
                  </li>
                );
              })}
              {entries.length === 0 && activeRoot.length > 0 ? (
                <li className="lkd-picker-empty">No entries in this folder.</li>
              ) : null}
            </ul>
          )}
          {mode === "file" && selectedFilePaths.length === 1 ? (
            <p className="qi-source-picker-selection" title={selectedAbsolutePath}>
              Selected file: <span className="qi-monospace">{selectedAbsolutePath}</span>
            </p>
          ) : null}
        </div>
        <div className="dlg-foot">
          <button type="button" className="dlg-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="dlg-btn primary"
            disabled={!canApply}
            onClick={applySelection}
          >
            Use selection
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
