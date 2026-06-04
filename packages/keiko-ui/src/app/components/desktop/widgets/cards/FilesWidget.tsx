"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fetchFilesTree, fetchProjects } from "../../../../../lib/api";
import type { FilesTreeEntry } from "../../../../../lib/types";
import { Icons } from "../../Icons";
import { FileIcon } from "../shared/projectTree";
import { FilePreview } from "./FilePreview";

interface FilesWidgetProps {
  root?: string;
  onActiveFileChange?: (path: string | null, root: string | null) => void;
}

interface DirectoryState {
  readonly entries: readonly FilesTreeEntry[];
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to read this folder.";
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

export function FilesWidget({ root, onActiveFileChange }: FilesWidgetProps): ReactNode {
  const trimmedRoot = root?.trim();
  const configuredRoot = trimmedRoot !== undefined && trimmedRoot.length > 0 ? trimmedRoot : null;
  const [fallbackRoot, setFallbackRoot] = useState<string | null>(null);
  const apiRoot = configuredRoot ?? fallbackRoot ?? "";
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([""]));
  const [refreshKey, setRefreshKey] = useState(0);
  const activeFileChangeRef = useRef(onActiveFileChange);
  activeFileChangeRef.current = onActiveFileChange;

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
            error: "No registered project is available.",
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

  const renderEntry = (entry: FilesTreeEntry, depth: number): ReactNode => {
    const pad = 8 + depth * 13;
    const open = expanded.has(entry.path);
    if (entry.kind === "directory") {
      const state = directories[entry.path];
      return (
        <div key={entry.path}>
          <button
            className="tr-row"
            data-readable={entry.readable}
            style={{ paddingLeft: pad }}
            type="button"
            disabled={!entry.readable}
            aria-expanded={open}
            onClick={() => toggleDirectory(entry)}
            title={entry.readable ? entry.path : "Symlink target is outside the selected root"}
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
          {open ? renderDirectory(entry.path, depth + 1, state) : null}
        </div>
      );
    }

    return (
      <button
        className="tr-row tr-file"
        data-active={selectedPath === entry.path}
        data-readable={entry.readable}
        key={entry.path}
        style={{ paddingLeft: pad + 14 }}
        type="button"
        disabled={!entry.readable}
        onClick={() => {
          setSelectedPath(entry.path);
          activeFileChangeRef.current?.(entry.path, resolvedRoot ?? apiRoot);
        }}
        title={entry.readable ? entry.path : "Symlink target is outside the selected root"}
      >
        <FileIcon name={entry.name} />
        <span className="tr-name">{entry.name}</span>
        {entry.symlink ? <span className="tr-badge">link</span> : null}
        <span className="tr-meta mono">{formatBytes(entry.sizeBytes)}</span>
      </button>
    );
  };

  const renderDirectory = (path: string, depth: number, state = directories[path]): ReactNode => (
    <div className="tr-dir">
      {state?.loading === true ? (
        <div className="files-note" style={{ paddingLeft: 22 + depth * 13 }}>
          Loading...
        </div>
      ) : null}
      {state?.error !== null && state?.error !== undefined ? (
        <div className="files-error" style={{ marginLeft: 8 + depth * 13 }}>
          <span>{state.error}</span>
          <button type="button" onClick={() => retryDirectory(path)}>
            Retry
          </button>
        </div>
      ) : null}
      {state?.entries.map((entry) => renderEntry(entry, depth))}
      {state !== undefined &&
      !state.loading &&
      state.error === null &&
      state.entries.length === 0 ? (
        <div className="files-note" style={{ paddingLeft: 22 + depth * 13 }}>
          Empty folder.
        </div>
      ) : null}
      {state?.truncated === true ? (
        <div className="files-note files-warning" style={{ paddingLeft: 22 + depth * 13 }}>
          Showing the first 1000 entries.
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
          setSelectedPath(null);
          activeFileChangeRef.current?.(null, resolvedRoot ?? apiRoot);
        }}
      />
    );
  }

  return (
    <div className="files">
      <button
        className="files-refresh"
        type="button"
        onClick={() => setRefreshKey((value) => value + 1)}
        title="Refresh folder"
        aria-label="Refresh folder"
      >
        <Icons.reset size={13} />
      </button>
      <div className="tr files-tree">{renderDirectory("", 0)}</div>
    </div>
  );
}
