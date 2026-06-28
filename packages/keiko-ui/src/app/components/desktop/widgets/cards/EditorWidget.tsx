"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  activeEditorPane,
  createEditorDirtyCloseIntent,
  createEditorLayoutStateV2,
  editorLayoutOpenFiles,
  editorLayoutPaneIds,
  editorLayoutReducer,
  resolveWorkspaceFileIdentifier,
  selectWorkspaceFileTarget,
  serializeEditorLayoutStateV2,
  type EditorDirtyCloseIntent,
  type EditorLayoutNode,
  type EditorLayoutSplitNode,
  type EditorLayoutStateV2,
  type EditorPaneStateV2,
  type EditorSplitDirection,
  type EditorSplitDropZone,
} from "@oscharko-dev/keiko-contracts";

import { Icons } from "../../Icons";
import { reconcileEditorDirtyByPane, type EditorDirtyByPane } from "./editorDirtyState";
import { deleteEditorHotExitSnapshot } from "./editorHotExitStore";
import type { EditorExternalSaveRequest, EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";
import type { EditorAgentPaneSnapshot } from "../../../../../lib/types";
import { FilesWidget, type FilesMutationEvent } from "./FilesWidget";
import { EditorCommandPalette, type EditorPaletteMode } from "./EditorCommandPalette";
import { type EditorPaletteHost } from "./editorCommands";

const EditorRuntimeWidget = dynamic<EditorRuntimeWidgetProps>(
  () => import("./EditorRuntimeWidget"),
  {
    ssr: false,
    loading: () => <div className="ed-host-loading" aria-hidden="true" />,
  },
);

export interface EditorWidgetWorkspacePatch {
  readonly root?: string | undefined;
  readonly file?: string | undefined;
  readonly openFiles?: readonly string[] | undefined;
  readonly layoutJson?: string | undefined;
}

export interface EditorWidgetProps extends EditorRuntimeWidgetProps {
  readonly layoutJson?: string | undefined;
  readonly onWorkspaceChange?: ((patch: EditorWidgetWorkspacePatch) => void) | undefined;
}

interface PendingDirtyClose {
  readonly intent: EditorDirtyCloseIntent;
  readonly apply: () => void;
  readonly dirtyFiles: readonly string[];
  readonly saving: boolean;
  readonly error?: string | undefined;
}

interface DraggedTab {
  readonly paneId: string;
  readonly file: string;
}

const MIN_SIDEBAR_WIDTH = 180;
const DEFAULT_SIDEBAR_WIDTH = 260;
const MAX_SIDEBAR_WIDTH = 440;
const MIN_SPLIT_RATIO = 15;
const MAX_SPLIT_RATIO = 85;
const CLOSED_TAB_HISTORY_LIMIT = 20;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Root-relative file-identifier contract (Issue #1374): turn a configured/persisted file (which
// may be absolute, e.g. from an older session or a symlink-aliased root) into the root-relative
// identifier the BFF requires. An absolute path that does not live under `root` resolves to "" so
// the editor renders its non-blocking empty state instead of sending an absolute path that the BFF
// would reject with 400 BAD_PATH. This and the chat repository-reference open path
// (workspaceActions) share the contract in @oscharko-dev/keiko-contracts; the editor window's
// cfg-persistence normalizer (AppShell.normalizeEditorWindowCfg) is a separate layer that likewise
// never persists an absolute file id.
function normalizeEditorFile(root: string, file: string | undefined): string {
  const resolution = resolveWorkspaceFileIdentifier(root, file);
  return resolution.kind === "relative" ? resolution.path : "";
}

function normalizeEditorOpenFiles(
  root: string,
  file: string | undefined,
  openFiles: readonly string[] | undefined,
): readonly string[] {
  const out: string[] = [];
  const add = (path: string | undefined): void => {
    const normalized = normalizeEditorFile(root, path);
    if (normalized.length === 0 || out.includes(normalized)) return;
    out.push(normalized);
  };
  for (const path of openFiles ?? []) add(path);
  add(file);
  return out;
}

function sameStringList(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (left === undefined) return right.length === 0;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function openFilesPatchValue(openFiles: readonly string[]): readonly string[] | undefined {
  return openFiles.length > 0 ? openFiles : undefined;
}

function sanitizePaneFiles(root: string, pane: EditorPaneStateV2): EditorPaneStateV2 {
  const openFiles = normalizeEditorOpenFiles(root, pane.activeFile, pane.openFiles);
  const activeFile = normalizeEditorFile(root, pane.activeFile) || openFiles[0] || "";
  const tabOrder = normalizeEditorOpenFiles(root, activeFile, pane.tabOrder);
  return { ...pane, openFiles, activeFile, tabOrder: tabOrder.length > 0 ? tabOrder : openFiles };
}

function sanitizeLayoutFiles(root: string, layout: EditorLayoutStateV2): EditorLayoutStateV2 {
  const panes: Record<string, EditorPaneStateV2> = {};
  for (const [paneId, pane] of Object.entries(layout.panes)) {
    panes[paneId] = sanitizePaneFiles(root, pane);
  }
  return { ...layout, root, panes };
}

function createInitialLayout(input: {
  readonly root: string;
  readonly file: string;
  readonly openFiles: readonly string[];
  readonly layoutJson: string | undefined;
}): EditorLayoutStateV2 {
  return sanitizeLayoutFiles(
    input.root,
    createEditorLayoutStateV2({
      root: input.root,
      file: input.file,
      openFiles: input.openFiles,
      layoutJson: input.layoutJson,
      defaultSidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      minSidebarWidth: MIN_SIDEBAR_WIDTH,
      maxSidebarWidth: MAX_SIDEBAR_WIDTH,
    }),
  );
}

function dirtyFilesForPane(
  dirtyByPane: Readonly<Record<string, Readonly<Record<string, true>>>>,
  paneId: string,
  files: readonly string[],
): readonly string[] {
  const paneDirty = dirtyByPane[paneId] ?? {};
  return files.filter((file) => paneDirty[file] === true);
}

function allDirtyFiles(
  dirtyByPane: Readonly<Record<string, Readonly<Record<string, true>>>>,
): readonly string[] {
  const out = new Set<string>();
  for (const paneDirty of Object.values(dirtyByPane)) {
    for (const path of Object.keys(paneDirty)) out.add(path);
  }
  return [...out];
}

function DirtyCloseDialog(props: {
  readonly pending: PendingDirtyClose;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const titleId = "editor-dirty-close-title";
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" && !props.pending.saving) props.onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [props]);
  return (
    <div className="ed-dialog-backdrop" role="presentation">
      <div
        className="ed-dirty-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId}>Unsaved editor changes</h2>
        <p>Choose how to handle these files before continuing.</p>
        <ul>
          {props.pending.dirtyFiles.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
        {props.pending.error !== undefined ? <p role="alert">{props.pending.error}</p> : null}
        <div className="ed-dialog-actions">
          <button
            type="button"
            className="ed-save"
            onClick={props.onSave}
            disabled={props.pending.saving}
          >
            {props.pending.saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            className="ed-reload"
            onClick={props.onDiscard}
            disabled={props.pending.saving}
          >
            Discard
          </button>
          <button
            type="button"
            className="ed-icon-action"
            onClick={props.onCancel}
            disabled={props.pending.saving}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// The split controls rendered into each pane's toolbar. A pure function of the pane plus the stable
// split/close callbacks, so it can be built inside the memoized per-pane binding without depending on
// the live layout (the >1-pane condition is passed in as `showClose`).
function renderPaneActions(
  pane: EditorPaneStateV2,
  showClose: boolean,
  splitPane: (paneId: string, direction: EditorSplitDirection) => void,
  closePane: (paneId: string) => void,
): ReactNode {
  return (
    <span className="ed-pane-actions" aria-label="Editor split controls">
      <button
        type="button"
        className="ed-icon-action ui-tip"
        aria-label={`Split ${pane.activeFile || "editor"} right`}
        data-tip="Split right"
        onClick={() => splitPane(pane.id, "row")}
      >
        <Icons.split size={14} />
      </button>
      <button
        type="button"
        className="ed-icon-action ui-tip"
        aria-label={`Split ${pane.activeFile || "editor"} down`}
        data-tip="Split down"
        onClick={() => splitPane(pane.id, "column")}
      >
        <Icons.panelDown size={14} />
      </button>
      {showClose ? (
        <button
          type="button"
          className="ed-icon-action ui-tip"
          aria-label={`Close split ${pane.activeFile || "editor"}`}
          data-tip="Close split"
          onClick={() => closePane(pane.id)}
        >
          <Icons.close size={14} />
        </button>
      ) : null}
    </span>
  );
}

// The stable per-pane prop bundle the memoized editor host receives, built once per pane set.
interface PaneBinding {
  readonly onSelectOpenFile: (file: string) => void;
  readonly onCloseOpenFile: (path: string) => Promise<boolean> | boolean | void;
  readonly onDirtyChange: (path: string, dirty: boolean) => void;
  readonly onMoveTab: (fromPaneId: string, file: string, toPaneId: string) => void;
  readonly onSplitPane: (paneId: string, direction: "row" | "column") => void;
  readonly toolbarExtras: ReactNode;
  readonly renderTabHandle: NonNullable<EditorRuntimeWidgetProps["renderTabHandle"]>;
}

export function EditorWidget({
  root,
  file,
  openFiles: configuredOpenFiles,
  layoutJson,
  onWorkspaceChange,
  ...props
}: EditorWidgetProps): ReactNode {
  const initialRoot = root?.trim() ?? "";
  const initialConfiguredFile = normalizeEditorFile(initialRoot, file);
  const initialOpenFiles = normalizeEditorOpenFiles(
    initialRoot,
    initialConfiguredFile,
    configuredOpenFiles,
  );
  const initialLayout = createInitialLayout({
    root: initialRoot,
    file: initialConfiguredFile,
    openFiles: initialOpenFiles,
    layoutJson,
  });
  const [workspaceRoot, setWorkspaceRoot] = useState(initialRoot);
  const [layout, setLayout] = useState<EditorLayoutStateV2>(initialLayout);
  // The live layout, read by the pane callbacks so their identity stays stable across layout
  // mutations (Wave 2 perf, the #1580 pattern). Without this every callback closes over `layout` and
  // gets a new identity on each `setLayout`, which churns the per-pane props and defeats the
  // `React.memo` on each pane's editor host — so a tab-select or split-resize in one pane re-renders
  // every pane. Updated on each render (after both `commitLayout` and the prop-sync effect commit).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [dirtyByPane, setDirtyByPane] = useState<EditorDirtyByPane>({});
  const [pendingClose, setPendingClose] = useState<PendingDirtyClose | null>(null);
  const [draggedTab, setDraggedTab] = useState<DraggedTab | null>(null);
  const [saveRequest, setSaveRequest] = useState<EditorExternalSaveRequest | null>(null);
  const saveSeqRef = useRef(0);
  const saveResolversRef = useRef(new Map<number, (ok: boolean) => void>());
  const lastPropRootRef = useRef(root?.trim() ?? "");
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  // Quick-Open / command-palette overlay (null = closed). Closed-tab MRU backs the reopen command.
  const [paletteState, setPaletteState] = useState<{ readonly mode: EditorPaletteMode } | null>(
    null,
  );
  const closedTabsRef = useRef<{ readonly paneId: string; readonly file: string }[]>([]);

  const buildPatch = useCallback(
    (nextRoot: string, nextLayout: EditorLayoutStateV2): EditorWidgetWorkspacePatch => {
      const nextActivePane = activeEditorPane(nextLayout);
      return {
        root: nextRoot,
        file: nextActivePane.activeFile.length > 0 ? nextActivePane.activeFile : undefined,
        openFiles: openFilesPatchValue(editorLayoutOpenFiles(nextLayout)),
        layoutJson: serializeEditorLayoutStateV2(nextLayout),
      };
    },
    [],
  );

  const commitLayout = useCallback(
    (nextLayout: EditorLayoutStateV2, nextRoot = workspaceRoot): void => {
      const normalized = sanitizeLayoutFiles(nextRoot, nextLayout);
      setLayout(normalized);
      // Re-home the per-pane dirty index onto the committed layout so a dirty tab
      // keeps its marker and unsaved-changes prompt as it moves between panes and
      // no orphaned flag survives on a collapsed pane (Issue #1375 AC3).
      setDirtyByPane((current) => reconcileEditorDirtyByPane(current, normalized));
      if (nextRoot.length > 0) onWorkspaceChange?.(buildPatch(nextRoot, normalized));
    },
    [buildPatch, onWorkspaceChange, workspaceRoot],
  );

  useEffect(() => {
    const nextRoot = root?.trim() ?? "";
    const nextConfiguredFile = normalizeEditorFile(nextRoot, file);
    const nextOpenFiles = normalizeEditorOpenFiles(
      nextRoot,
      nextConfiguredFile,
      configuredOpenFiles,
    );
    const nextLayout = createInitialLayout({
      root: nextRoot,
      file: nextConfiguredFile,
      openFiles: nextOpenFiles,
      layoutJson,
    });
    const nextActivePane = activeEditorPane(nextLayout);
    const nextAllOpenFiles = editorLayoutOpenFiles(nextLayout);
    const rootChanged = lastPropRootRef.current !== nextRoot;
    lastPropRootRef.current = nextRoot;
    setWorkspaceRoot(nextRoot);
    setLayout(nextLayout);
    if (rootChanged) setDirtyByPane({});
    if (nextRoot.length === 0 || onWorkspaceChange === undefined) return;
    const normalizedFileChanged = (file?.trim() ?? "") !== nextActivePane.activeFile;
    const openFilesChanged = !sameStringList(configuredOpenFiles, nextAllOpenFiles);
    const layoutChanged = layoutJson !== serializeEditorLayoutStateV2(nextLayout);
    if (normalizedFileChanged || openFilesChanged || layoutChanged) {
      onWorkspaceChange(buildPatch(nextRoot, nextLayout));
    }
  }, [buildPatch, configuredOpenFiles, file, layoutJson, onWorkspaceChange, root]);

  const dirtyFileList = useMemo(() => allDirtyFiles(dirtyByPane), [dirtyByPane]);
  const currentPane = activeEditorPane(layout);
  const activeFile = currentPane.activeFile;

  useEffect(() => {
    if (dirtyFileList.length === 0) return;
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirtyFileList.length]);

  const markDirty = useCallback((paneId: string, path: string, dirty: boolean): void => {
    setDirtyByPane((current) => {
      const paneDirty = current[paneId] ?? {};
      if (dirty) {
        if (paneDirty[path] === true) return current;
        return { ...current, [paneId]: { ...paneDirty, [path]: true } };
      }
      if (paneDirty[path] !== true) return current;
      const { [path]: _removed, ...remaining } = paneDirty;
      return { ...current, [paneId]: remaining };
    });
  }, []);

  const requestExternalSave = useCallback(
    (paneId: string, path: string): Promise<boolean> => {
      saveSeqRef.current += 1;
      const id = saveSeqRef.current;
      commitLayout(
        editorLayoutReducer(layoutRef.current, { type: "select-file", paneId, file: path }),
      );
      setSaveRequest({ id, paneId, file: path });
      return new Promise<boolean>((resolve) => {
        saveResolversRef.current.set(id, resolve);
      });
    },
    [commitLayout],
  );

  const onExternalSaveComplete = useCallback(
    (requestId: number, paneId: string, path: string, ok: boolean): void => {
      const resolve = saveResolversRef.current.get(requestId);
      saveResolversRef.current.delete(requestId);
      // Functional update (instead of reading `saveRequest` in deps) keeps this callback's identity
      // stable across save lifecycle changes, so a save in one pane does not re-render the others.
      setSaveRequest((current) => (current?.id === requestId ? null : current));
      if (ok) markDirty(paneId, path, false);
      resolve?.(ok);
    },
    [markDirty],
  );

  const requestDirtyClose = useCallback(
    (input: {
      readonly paneId: string;
      readonly files: readonly string[];
      readonly reason: EditorDirtyCloseIntent["reason"];
      readonly apply: () => void;
    }): boolean => {
      const dirtySet = new Set(allDirtyFiles(dirtyByPane));
      const dirtyFiles =
        input.reason === "root-change" || input.reason === "window-close"
          ? input.files.filter((entry) => dirtySet.has(entry))
          : dirtyFilesForPane(dirtyByPane, input.paneId, input.files);
      if (dirtyFiles.length === 0) {
        input.apply();
        return true;
      }
      setPendingClose({
        intent: createEditorDirtyCloseIntent({
          paneId: input.paneId,
          files: dirtyFiles,
          reason: input.reason,
        }),
        apply: input.apply,
        dirtyFiles,
        saving: false,
      });
      return false;
    },
    [dirtyByPane],
  );

  const savePendingClose = useCallback((): void => {
    if (pendingClose === null || pendingClose.saving) return;
    setPendingClose({ ...pendingClose, saving: true, error: undefined });
    void (async () => {
      for (const path of pendingClose.dirtyFiles) {
        const paneId =
          Object.entries(dirtyByPane).find(([, files]) => files[path] === true)?.[0] ??
          pendingClose.intent.paneId;
        const ok = await requestExternalSave(paneId, path);
        if (!ok) {
          setPendingClose({
            ...pendingClose,
            saving: false,
            error: "Save failed. The close action was not applied.",
          });
          return;
        }
      }
      pendingClose.apply();
      setPendingClose(null);
    })();
  }, [dirtyByPane, pendingClose, requestExternalSave]);

  const discardPendingClose = useCallback((): void => {
    if (pendingClose === null || pendingClose.saving) return;
    for (const path of pendingClose.dirtyFiles) {
      for (const [paneId, files] of Object.entries(dirtyByPane)) {
        if (files[path] === true) markDirty(paneId, path, false);
      }
      // AC5: an explicit Discard must delete the hot-exit snapshot for the file, otherwise the
      // discarded edits resurface as a recovery offer the next time the file is opened. The runtime
      // widget's own clean-delete effect cannot be relied on here: applying the close unmounts that
      // widget in the same React commit as the dirty flag is cleared, so the effect never runs.
      // Deletion is scoped to the still-current workspace root (apply() may switch roots afterward).
      void deleteEditorHotExitSnapshot(workspaceRoot, path);
    }
    pendingClose.apply();
    setPendingClose(null);
  }, [dirtyByPane, markDirty, pendingClose, workspaceRoot]);

  const cancelPendingClose = useCallback((): void => {
    if (pendingClose?.saving === true) return;
    setPendingClose(null);
  }, [pendingClose?.saving]);

  const openRoot = useCallback(
    (nextRoot: string): void => {
      const normalizedRoot = nextRoot.trim();
      if (normalizedRoot.length === 0) return;
      const apply = (): void => {
        const nextLayout = editorLayoutReducer(layoutRef.current, {
          type: "replace-root",
          root: normalizedRoot,
          sidebarWidth: layoutRef.current.sidebarWidth,
        });
        setWorkspaceRoot(normalizedRoot);
        setDirtyByPane({});
        commitLayout(nextLayout, normalizedRoot);
      };
      const firstPaneId =
        editorLayoutPaneIds(layoutRef.current)[0] ?? layoutRef.current.activePaneId;
      requestDirtyClose({
        paneId: firstPaneId,
        files: dirtyFileList,
        reason: "root-change",
        apply,
      });
    },
    [commitLayout, dirtyFileList, requestDirtyClose],
  );

  const openFile = useCallback(
    (nextRoot: string, nextFile: string): void => {
      // Resolve to a {root, file} pair: a root-relative or absolute-inside-root candidate keeps
      // `nextRoot`; a single absolute file outside it selects its containing directory as the root
      // (AC3). An unresolvable candidate is dropped so the editor stays on its current usable state.
      const target = selectWorkspaceFileTarget(nextRoot, nextFile);
      if (target === null || target.file.length === 0) return;
      const paneId = activeEditorPane(layoutRef.current).id;
      const nextLayout = editorLayoutReducer(layoutRef.current, {
        type: "open-file",
        paneId,
        file: target.file,
      });
      setWorkspaceRoot(target.root);
      commitLayout(nextLayout, target.root);
    },
    [commitLayout],
  );

  const selectOpenFile = useCallback(
    (paneId: string, nextFile: string): void => {
      if (workspaceRoot.length === 0 || nextFile.length === 0) return;
      commitLayout(
        editorLayoutReducer(layoutRef.current, { type: "select-file", paneId, file: nextFile }),
      );
    },
    [commitLayout, workspaceRoot],
  );

  // A file mutation from the sidebar tree: re-home (rename) or close (delete) any open tabs so they do
  // not go stale and 404. A create needs no layout change — the new file is opened directly by the
  // FilesWidget. The renamed tab reloads from disk (a clean buffer), so the stale dirty marker is
  // pruned by `reconcileEditorDirtyByPane` inside `commitLayout`; the old hot-exit snapshot is dropped
  // so discarded edits cannot resurface under the deleted/renamed path.
  const handleFilesMutated = useCallback(
    (event: FilesMutationEvent): void => {
      const { op, mutation } = event;
      if (
        op === "rename" &&
        mutation.previousPath !== undefined &&
        mutation.previousPath !== mutation.path
      ) {
        commitLayout(
          editorLayoutReducer(layoutRef.current, {
            type: "rename-file",
            from: mutation.previousPath,
            to: mutation.path,
          }),
        );
        void deleteEditorHotExitSnapshot(workspaceRoot, mutation.previousPath);
      } else if (op === "delete") {
        commitLayout(
          editorLayoutReducer(layoutRef.current, { type: "remove-file", file: mutation.path }),
        );
        void deleteEditorHotExitSnapshot(workspaceRoot, mutation.path);
      }
    },
    [commitLayout, workspaceRoot],
  );

  // Bounded MRU of closed (paneId, file) for the "Reopen Closed Editor" command. Deduped by file so a
  // repeatedly closed file does not flood the stack; capped so it never grows unbounded.
  const pushClosedTab = useCallback((paneId: string, file: string): void => {
    if (file.length === 0) return;
    const next = closedTabsRef.current.filter((entry) => entry.file !== file);
    next.push({ paneId, file });
    closedTabsRef.current = next.slice(-CLOSED_TAB_HISTORY_LIMIT);
  }, []);

  const closeOpenFile = useCallback(
    async (paneId: string, path: string): Promise<boolean> =>
      requestDirtyClose({
        paneId,
        files: [path],
        reason: "tab-close",
        apply: () => {
          markDirty(paneId, path, false);
          pushClosedTab(paneId, path);
          commitLayout(
            editorLayoutReducer(layoutRef.current, { type: "close-tab", paneId, file: path }),
          );
        },
      }),
    [commitLayout, markDirty, pushClosedTab, requestDirtyClose],
  );

  const splitPane = useCallback(
    (paneId: string, direction: EditorSplitDirection): void => {
      commitLayout(
        editorLayoutReducer(layoutRef.current, { type: "split-pane", paneId, direction }),
      );
    },
    [commitLayout],
  );

  const closePane = useCallback(
    (paneId: string): void => {
      const pane = layoutRef.current.panes[paneId];
      if (pane === undefined) return;
      requestDirtyClose({
        paneId,
        files: pane.openFiles,
        reason: "pane-close",
        apply: () => {
          for (const file of pane.openFiles) pushClosedTab(paneId, file);
          setDirtyByPane((current) => {
            const { [paneId]: _removed, ...remaining } = current;
            return remaining;
          });
          commitLayout(editorLayoutReducer(layoutRef.current, { type: "close-pane", paneId }));
        },
      });
    },
    [commitLayout, pushClosedTab, requestDirtyClose],
  );

  const toggleSidebar = useCallback((): void => {
    commitLayout(
      editorLayoutReducer(layoutRef.current, {
        type: "set-sidebar",
        collapsed: !layoutRef.current.sidebarCollapsed,
      }),
    );
  }, [commitLayout]);

  // Live-resize gesture state. During a pointer/mouse drag the split ratio or sidebar width is written
  // straight to the CSS variable on the DOM, and the final value is committed to layout state only on
  // release — so a drag is a pure style update with no per-frame React render or layout persistence
  // (the #1580 transform-during-gesture + persistence-debounce wins). Keyboard resize still commits
  // each discrete step immediately.
  const splitGestureRef = useRef<{ readonly splitId: string; readonly ratio: number } | null>(null);
  const sidebarGestureRef = useRef<number | null>(null);

  const previewSidebarWidth = useCallback((clientX: number): void => {
    const node = workspaceRef.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    const width = clampNumber(clientX - rect.left, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
    node.style.setProperty("--ed-sidebar-width", `${String(width)}px`);
    sidebarGestureRef.current = width;
  }, []);

  const commitSidebarGesture = useCallback((): void => {
    const width = sidebarGestureRef.current;
    sidebarGestureRef.current = null;
    if (width === null) return;
    commitLayout(
      editorLayoutReducer(layoutRef.current, { type: "set-sidebar", width, collapsed: false }),
    );
  }, [commitLayout]);

  const resizeSidebar = useCallback(
    (event: PointerEvent<HTMLButtonElement>): void => {
      if (event.buttons !== 1) return;
      previewSidebarWidth(event.clientX);
    },
    [previewSidebarWidth],
  );

  const resizeSidebarBy = useCallback(
    (delta: number): void => {
      commitLayout(
        editorLayoutReducer(layoutRef.current, {
          type: "set-sidebar",
          width: clampNumber(
            layoutRef.current.sidebarWidth + delta,
            MIN_SIDEBAR_WIDTH,
            MAX_SIDEBAR_WIDTH,
          ),
          collapsed: false,
        }),
      );
    },
    [commitLayout],
  );

  const previewSplitRatio = useCallback(
    (split: EditorLayoutSplitNode, parent: HTMLElement, clientX: number, clientY: number): void => {
      const rect = parent.getBoundingClientRect();
      const raw =
        split.direction === "row"
          ? ((clientX - rect.left) / rect.width) * 100
          : ((clientY - rect.top) / rect.height) * 100;
      const ratio = clampNumber(raw, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO);
      parent.style.setProperty("--ed-split-ratio", `${String(ratio)}%`);
      splitGestureRef.current = { splitId: split.id, ratio };
    },
    [],
  );

  const commitSplitGesture = useCallback((): void => {
    const gesture = splitGestureRef.current;
    splitGestureRef.current = null;
    if (gesture === null) return;
    commitLayout(
      editorLayoutReducer(layoutRef.current, {
        type: "resize-split",
        splitId: gesture.splitId,
        ratio: gesture.ratio,
      }),
    );
  }, [commitLayout]);

  const resizeSplitBy = useCallback(
    (split: EditorLayoutSplitNode, delta: number): void => {
      commitLayout(
        editorLayoutReducer(layoutRef.current, {
          type: "resize-split",
          splitId: split.id,
          ratio: clampNumber(split.ratio + delta, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO),
        }),
      );
    },
    [commitLayout],
  );

  const beginSidebarMouseResize = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault();
      const move = (moveEvent: globalThis.MouseEvent): void =>
        previewSidebarWidth(moveEvent.clientX);
      const up = (): void => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        commitSidebarGesture();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up, { once: true });
    },
    [previewSidebarWidth, commitSidebarGesture],
  );

  const beginSplitMouseResize = useCallback(
    (split: EditorLayoutSplitNode, event: MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault();
      const parent = event.currentTarget.parentElement;
      if (parent === null) return;
      const move = (moveEvent: globalThis.MouseEvent): void =>
        previewSplitRatio(split, parent, moveEvent.clientX, moveEvent.clientY);
      const up = (): void => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        commitSplitGesture();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up, { once: true });
    },
    [previewSplitRatio, commitSplitGesture],
  );

  const handleSidebarResizerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      const step = event.shiftKey ? 32 : 12;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        resizeSidebarBy(-step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        resizeSidebarBy(step);
      }
    },
    [resizeSidebarBy],
  );

  const handleSplitResizerKeyDown = useCallback(
    (split: EditorLayoutSplitNode, event: KeyboardEvent<HTMLButtonElement>): void => {
      const step = event.shiftKey ? 10 : 2;
      const decrementKey = split.direction === "row" ? "ArrowLeft" : "ArrowUp";
      const incrementKey = split.direction === "row" ? "ArrowRight" : "ArrowDown";
      if (event.key === decrementKey) {
        event.preventDefault();
        resizeSplitBy(split, -step);
      } else if (event.key === incrementKey) {
        event.preventDefault();
        resizeSplitBy(split, step);
      }
    },
    [resizeSplitBy],
  );

  const capturePointer = useCallback((event: PointerEvent<HTMLButtonElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const releasePointer = useCallback((event: PointerEvent<HTMLButtonElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleTabKeyDown = useCallback(
    (paneId: string, path: string, event: KeyboardEvent<HTMLButtonElement>): void => {
      if (!event.altKey) return;
      const pane = layoutRef.current.panes[paneId];
      if (pane === undefined) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const paneIds = editorLayoutPaneIds(layoutRef.current);
        if (event.shiftKey) {
          const paneIndex = paneIds.indexOf(paneId);
          const targetPaneId =
            event.key === "ArrowLeft" ? paneIds[paneIndex - 1] : paneIds[paneIndex + 1];
          if (targetPaneId !== undefined) {
            commitLayout(
              editorLayoutReducer(layoutRef.current, {
                type: "move-tab",
                fromPaneId: paneId,
                toPaneId: targetPaneId,
                file: path,
              }),
            );
          }
          return;
        }
        const index = pane.tabOrder.indexOf(path);
        const nextIndex = event.key === "ArrowLeft" ? index - 1 : index + 1;
        commitLayout(
          editorLayoutReducer(layoutRef.current, {
            type: "reorder-tab",
            paneId,
            file: path,
            targetIndex: nextIndex,
          }),
        );
      }
    },
    [commitLayout],
  );

  const dropTab = useCallback(
    (paneId: string, zone: EditorSplitDropZone, event: DragEvent<HTMLElement>): void => {
      event.preventDefault();
      if (draggedTab === null) return;
      commitLayout(
        editorLayoutReducer(layoutRef.current, {
          type: "drop-tab",
          intent: {
            fromPaneId: draggedTab.paneId,
            toPaneId: paneId,
            file: draggedTab.file,
            zone,
          },
        }),
      );
      setDraggedTab(null);
    },
    [commitLayout, draggedTab],
  );

  // Stable cross-pane tab move (used by the per-pane binding so it does not churn on every render).
  const moveTabAction = useCallback(
    (fromPaneId: string, toPaneId: string, file: string): void => {
      commitLayout(
        editorLayoutReducer(layoutRef.current, { type: "move-tab", fromPaneId, toPaneId, file }),
      );
    },
    [commitLayout],
  );

  // ── Command/keybinding/palette actions (Wave 2 items 2.3/2.4/2.5) ──────────────────────────────
  // All read the live layout from `layoutRef`, so they act on the active pane regardless of where
  // focus is, and route through the existing close/select/split/save callbacks.
  const closeActiveTab = useCallback((): void => {
    const pane = activeEditorPane(layoutRef.current);
    if (pane.activeFile.length > 0) void closeOpenFile(pane.id, pane.activeFile);
  }, [closeOpenFile]);

  const cycleActiveTab = useCallback(
    (delta: number): void => {
      const pane = activeEditorPane(layoutRef.current);
      const order = pane.tabOrder;
      if (order.length < 2) return;
      const index = order.indexOf(pane.activeFile);
      const next = order[(index + delta + order.length) % order.length];
      if (next !== undefined) selectOpenFile(pane.id, next);
    },
    [selectOpenFile],
  );

  const reopenClosedTab = useCallback((): void => {
    const last = closedTabsRef.current.pop();
    if (last !== undefined) openFile(workspaceRoot, last.file);
  }, [openFile, workspaceRoot]);

  const saveAllDirty = useCallback((): void => {
    for (const [paneId, files] of Object.entries(dirtyByPane)) {
      for (const file of Object.keys(files)) void requestExternalSave(paneId, file);
    }
  }, [dirtyByPane, requestExternalSave]);

  const splitActivePane = useCallback(
    (direction: EditorSplitDirection): void =>
      splitPane(activeEditorPane(layoutRef.current).id, direction),
    [splitPane],
  );

  const closeActivePane = useCallback(
    (): void => closePane(activeEditorPane(layoutRef.current).id),
    [closePane],
  );

  const openQuickOpen = useCallback((): void => setPaletteState({ mode: "files" }), []);
  const openCommandPalette = useCallback((): void => setPaletteState({ mode: "commands" }), []);

  // Content-free host snapshot consumed by the palette + keybinding layer. Rebuilt each render and
  // mirrored into a ref so the document-level keydown listener always dispatches against current state.
  const commandHost: EditorPaletteHost = {
    root: workspaceRoot,
    activePaneId: layout.activePaneId,
    paneCount: editorLayoutPaneIds(layout).length,
    activeFile: activeFile.length > 0 ? activeFile : null,
    closedTabCount: closedTabsRef.current.length,
    dirtyCount: dirtyFileList.length,
    openQuickOpen,
    openCommandPalette,
    splitActive: splitActivePane,
    closeActiveSplit: closeActivePane,
    closeActiveTab,
    nextTab: () => cycleActiveTab(1),
    prevTab: () => cycleActiveTab(-1),
    reopenClosed: reopenClosedTab,
    saveAll: saveAllDirty,
  };
  const commandHostRef = useRef(commandHost);
  commandHostRef.current = commandHost;

  // Container-level capturing keydown for editor-chrome chords (mirrors the on-mount save backstop,
  // but scoped to the whole editor so it also fires from the sidebar/tab strip). Only browser-safe
  // chords are bound — Cmd/Ctrl+W and Cmd/Ctrl+Shift+T are reserved and intentionally omitted.
  useEffect(() => {
    const node = workspaceRef.current;
    if (node === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const host = commandHostRef.current;
      const key = event.key.toLowerCase();
      if (key === "p" && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) host.openCommandPalette();
        else host.openQuickOpen();
        return;
      }
      if (!event.altKey) return;
      const handled = (action: () => void): void => {
        event.preventDefault();
        event.stopPropagation();
        action();
      };
      if (key === "arrowright") handled(host.nextTab);
      else if (key === "arrowleft") handled(host.prevTab);
      else if (key === "t") handled(host.reopenClosed);
      else if (key === "\\") handled(() => host.splitActive("row"));
      else if (key === "s") handled(host.saveAll);
    };
    node.addEventListener("keydown", onKeyDown, true);
    return () => node.removeEventListener("keydown", onKeyDown, true);
  }, [workspaceRoot]);

  // Agent-pane snapshots, memoized by the pane SET. A split resize only changes a tree node's ratio,
  // leaving `layout.panes` untouched, so this stays referentially stable across a resize and does not
  // churn the per-pane editor-host props.
  const layoutPaneSnapshots = useMemo<readonly EditorAgentPaneSnapshot[]>(
    () =>
      Object.values(layout.panes).map((entry) => ({
        paneId: entry.id,
        activeFile: entry.activeFile.length > 0 ? entry.activeFile : null,
        openFiles: entry.openFiles,
      })),
    [layout.panes],
  );

  const paneCount = editorLayoutPaneIds(layout).length;

  // Per-pane bound callbacks + split-control chrome + tab-drag handle, memoized by the pane set (and
  // the now-stable underlying callbacks). A layout mutation that does not touch a given pane keeps its
  // binding referentially identical, so the `React.memo`-wrapped editor host bails out of the
  // re-render — the #1580 fan-out fix applied to editor panes.
  const paneBindings = useMemo(() => {
    const map = new Map<string, PaneBinding>();
    for (const pane of Object.values(layout.panes)) {
      const paneId = pane.id;
      map.set(paneId, {
        onSelectOpenFile: (file: string) => selectOpenFile(paneId, file),
        onCloseOpenFile: (path: string) => closeOpenFile(paneId, path),
        onDirtyChange: (path: string, dirty: boolean) => markDirty(paneId, path, dirty),
        onMoveTab: (fromPaneId: string, file: string, toPaneId: string) =>
          moveTabAction(fromPaneId, toPaneId, file),
        onSplitPane: (targetPaneId: string, direction: "row" | "column") =>
          splitPane(targetPaneId, direction),
        toolbarExtras: renderPaneActions(pane, paneCount > 1, splitPane, closePane),
        renderTabHandle: (path: string, active: boolean, tabDirty: boolean) => ({
          draggable: true,
          onDragStart: (event: DragEvent<HTMLButtonElement>) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", path);
            setDraggedTab({ paneId, file: path });
          },
          onDragEnd: () => setDraggedTab(null),
          onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
            handleTabKeyDown(paneId, path, event),
          "data-active": active ? "true" : "false",
          "data-dirty": tabDirty ? "true" : "false",
        }),
      });
    }
    return map;
  }, [
    layout.panes,
    paneCount,
    selectOpenFile,
    closeOpenFile,
    markDirty,
    moveTabAction,
    splitPane,
    closePane,
    handleTabKeyDown,
  ]);

  if (workspaceRoot.length === 0) {
    return <EditorRuntimeWidget {...props} />;
  }

  const renderPane = (pane: EditorPaneStateV2): ReactNode => {
    const binding = paneBindings.get(pane.id);
    if (binding === undefined) return null;
    const runtimeProps: EditorRuntimeWidgetProps = {
      ...props,
      root: workspaceRoot,
      ...(pane.activeFile.length > 0 ? { file: pane.activeFile } : {}),
      openFiles: pane.openFiles,
      dirtyFiles: dirtyFileList,
      windowId: `${props.windowId ?? "editor"}-${pane.id}`,
      paneId: pane.id,
      layoutPanes: layoutPaneSnapshots,
      activePaneId: layout.activePaneId,
      onSelectOpenFile: binding.onSelectOpenFile,
      onSplitPane: binding.onSplitPane,
      onMoveTab: binding.onMoveTab,
      onCloseOpenFile: binding.onCloseOpenFile,
      onDirtyChange: binding.onDirtyChange,
      toolbarExtras: binding.toolbarExtras,
      externalSaveRequest:
        saveRequest !== null && saveRequest.paneId === pane.id ? saveRequest : undefined,
      onExternalSaveComplete,
      renderTabHandle: binding.renderTabHandle,
    };
    return (
      <section
        className="ed-pane"
        data-active={pane.id === layout.activePaneId ? "true" : "false"}
        data-dragging={draggedTab === null ? "false" : "true"}
        key={pane.id}
      >
        <div className="ed-pane-drop-zones" aria-hidden="true">
          {(["left", "right", "top", "bottom", "center"] as const).map((zone) => (
            <button
              type="button"
              className={`ed-pane-drop-zone ${zone}`}
              key={zone}
              tabIndex={-1}
              aria-label={`Drop tab ${zone}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropTab(pane.id, zone, event)}
            />
          ))}
        </div>
        <EditorRuntimeWidget {...runtimeProps} />
      </section>
    );
  };

  const renderNode = (node: EditorLayoutNode): ReactNode => {
    if (node.type === "pane") {
      const pane = layout.panes[node.paneId];
      return pane === undefined ? null : renderPane(pane);
    }
    return (
      <div
        className={`ed-panes ${node.direction}`}
        data-split-id={node.id}
        style={{ "--ed-split-ratio": `${String(node.ratio)}%` } as CSSProperties}
      >
        {renderNode(node.first)}
        <button
          type="button"
          className="ed-pane-resizer ui-tip"
          // WAI-ARIA window-splitter pattern: a focusable separator is an interactive widget;
          // role="separator" with aria-valuenow and Arrow-key handling is its canonical markup.
          // eslint-disable-next-line jsx-a11y/no-interactive-element-to-noninteractive-role
          role="separator"
          aria-label="Resize editor split"
          aria-orientation={node.direction === "row" ? "vertical" : "horizontal"}
          aria-valuemin={MIN_SPLIT_RATIO}
          aria-valuemax={MAX_SPLIT_RATIO}
          aria-valuenow={Math.round(node.ratio)}
          data-tip="Resize editor split"
          onPointerDown={capturePointer}
          onPointerMove={(event) => {
            if (event.buttons !== 1) return;
            const parent = event.currentTarget.parentElement;
            if (parent !== null) {
              previewSplitRatio(node, parent, event.clientX, event.clientY);
            }
          }}
          onPointerUp={(event) => {
            releasePointer(event);
            commitSplitGesture();
          }}
          onPointerCancel={(event) => {
            releasePointer(event);
            commitSplitGesture();
          }}
          onMouseDown={(event) => beginSplitMouseResize(node, event)}
          onKeyDown={(event) => handleSplitResizerKeyDown(node, event)}
        />
        {renderNode(node.second)}
      </div>
    );
  };

  const singlePane = editorLayoutPaneIds(layout).length === 1;

  return (
    <div
      className={`editor-workspace${layout.sidebarCollapsed ? " sidebar-collapsed" : ""}`}
      ref={workspaceRef}
      style={{ "--ed-sidebar-width": `${String(layout.sidebarWidth)}px` } as CSSProperties}
    >
      {layout.sidebarCollapsed ? (
        <button
          type="button"
          className="ed-sidebar-restore ui-tip"
          aria-label="Show project tree"
          data-tip="Show project tree"
          onClick={toggleSidebar}
        >
          <Icons.sidebar size={15} />
        </button>
      ) : (
        <>
          <aside className="ed-sidebar" aria-label="Editor files">
            <div className="ed-sidebar-chrome">
              <button
                type="button"
                className="ed-icon-action ui-tip"
                aria-label="Hide project tree"
                data-tip="Hide project tree"
                onClick={toggleSidebar}
              >
                <Icons.sidebar size={14} />
              </button>
            </div>
            <FilesWidget
              root={workspaceRoot}
              activeFilePath={activeFile.length > 0 ? activeFile : undefined}
              openFilesDirectly
              onRootChange={openRoot}
              onOpenFile={openFile}
              onFilesMutated={handleFilesMutated}
            />
          </aside>
          <button
            type="button"
            className="ed-sidebar-resizer ui-tip"
            aria-label="Resize project tree"
            data-tip="Resize project tree"
            onPointerDown={capturePointer}
            onPointerMove={resizeSidebar}
            onPointerUp={(event) => {
              releasePointer(event);
              commitSidebarGesture();
            }}
            onPointerCancel={(event) => {
              releasePointer(event);
              commitSidebarGesture();
            }}
            onMouseDown={beginSidebarMouseResize}
            onKeyDown={handleSidebarResizerKeyDown}
          />
        </>
      )}
      <div className="ed-main">
        <div className={`ed-panes ed-panes-root${singlePane ? " single" : ""}`}>
          {renderNode(layout.tree)}
        </div>
      </div>
      {pendingClose !== null ? (
        <DirtyCloseDialog
          pending={pendingClose}
          onSave={savePendingClose}
          onDiscard={discardPendingClose}
          onCancel={cancelPendingClose}
        />
      ) : null}
      {paletteState !== null ? (
        <EditorCommandPalette
          mode={paletteState.mode}
          root={workspaceRoot}
          host={commandHost}
          onOpenFile={openFile}
          onClose={() => setPaletteState(null)}
        />
      ) : null}
    </div>
  );
}
