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
import { createPortal } from "react-dom";
import {
  activeEditorPane,
  createEditorDirtyCloseIntent,
  editorLayoutOpenFiles,
  editorLayoutPaneIds,
  editorLayoutReducer,
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
import { acquireGrabbingBodyStyle } from "../../interactionGuards";
import { reconcileEditorDirtyByPane, type EditorDirtyByPane } from "./editorDirtyState";
import { deleteEditorHotExitSnapshot } from "./editorHotExitStore";
import type { EditorExternalSaveRequest, EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";
import type { EditorAgentPaneSnapshot } from "../../../../../lib/types";
import { FilesWidget, type FilesMutationEvent } from "./FilesWidget";
import { EditorCommandPalette, type EditorPaletteMode } from "./EditorCommandPalette";
import { type EditorPaletteHost } from "./editorCommands";
import { FileIcon } from "../shared/projectTree";
import {
  allDirtyFiles,
  clampNumber,
  createDistributedPresetLayout,
  createInitialLayout,
  dirtyFilesForPane,
  draggedTabFromEvent,
  EDITOR_TAB_DRAG_MIME,
  MAX_EDITOR_PANES,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  normalizeEditorFile,
  normalizeEditorLayoutStructure,
  normalizeEditorOpenFiles,
  openFilesPatchValue,
  paneIdFromPoint,
  remapDirtyFilesToPresetPanes,
  sameStringList,
  tabInsertionTargetFromPoint,
  type DraggedTab,
  type PointerTabDrag,
  type TabInsertTarget,
} from "./editorPaneGeometry";

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

interface PointerTabDragPosition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

const TAB_POINTER_DRAG_THRESHOLD_PX = 6;
const MIN_SPLIT_RATIO = 15;
const MAX_SPLIT_RATIO = 85;
const CLOSED_TAB_HISTORY_LIMIT = 20;

function DirtyCloseDialog(props: {
  readonly pending: PendingDirtyClose;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const titleId = "editor-dirty-close-title";
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // GEN-UI-FOCUS-006: capture the opener before moving focus into the dialog, and restore it on
    // close/unmount so keyboard focus returns to where the user was (never lost to <body>).
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      if (opener !== null && typeof opener.focus === "function" && opener.isConnected) {
        opener.focus();
      }
    };
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
        className="ed-icon-action"
        aria-label={`Split ${pane.activeFile || "editor"} right`}
        onClick={() => splitPane(pane.id, "row")}
      >
        <Icons.split size={14} />
      </button>
      <button
        type="button"
        className="ed-icon-action"
        aria-label={`Split ${pane.activeFile || "editor"} down`}
        onClick={() => splitPane(pane.id, "column")}
      >
        <Icons.panelDown size={14} />
      </button>
      {showClose ? (
        <button
          type="button"
          className="ed-icon-action"
          aria-label={`Close split ${pane.activeFile || "editor"}`}
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
  const [heldTab, setHeldTab] = useState<DraggedTab | null>(null);
  // GEN-PERF-EDITOR-003 — the tab-drag "held" visual is read from a ref inside the memoized
  // per-pane renderTabHandle closure, so that closure stays referentially stable (it no
  // longer closes over `heldTab` state) and React.memo(EditorRuntimeWidget) keeps bailing
  // non-dragged panes out. The affected pane still re-renders because its `heldTabFile`
  // scalar prop changes; other panes see an unchanged `undefined` and are skipped.
  const heldTabRef = useRef<DraggedTab | null>(null);
  heldTabRef.current = heldTab;
  const [draggedTab, setDraggedTab] = useState<DraggedTab | null>(null);
  const [tabDragPosition, setTabDragPosition] = useState<PointerTabDragPosition | null>(null);
  const [tabDropTargetPaneId, setTabDropTargetPaneId] = useState<string | null>(null);
  const [tabInsertTarget, setTabInsertTargetState] = useState<TabInsertTarget | null>(null);
  const [saveRequest, setSaveRequest] = useState<EditorExternalSaveRequest | null>(null);
  const saveSeqRef = useRef(0);
  const saveResolversRef = useRef(new Map<number, (ok: boolean) => void>());
  const lastPropRootRef = useRef(root?.trim() ?? "");
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const pointerTabDragRef = useRef<PointerTabDrag | null>(null);
  const tabInsertTargetRef = useRef<TabInsertTarget | null>(null);
  const suppressNextTabClickRef = useRef<DraggedTab | null>(null);
  // Quick-Open / command-palette overlay (null = closed). Closed-tab MRU backs the reopen command.
  const [paletteState, setPaletteState] = useState<{ readonly mode: EditorPaletteMode } | null>(
    null,
  );
  const closedTabsRef = useRef<{ readonly paneId: string; readonly file: string }[]>([]);

  const setTabInsertTarget = useCallback((target: TabInsertTarget | null): void => {
    tabInsertTargetRef.current = target;
    setTabInsertTargetState(target);
  }, []);

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
      const normalized = normalizeEditorLayoutStructure(nextRoot, nextLayout);
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

  const activatePane = useCallback(
    (paneId: string): void => {
      const current = layoutRef.current;
      if (current.activePaneId === paneId || current.panes[paneId] === undefined) return;
      commitLayout(editorLayoutReducer(current, { type: "set-active-pane", paneId }));
    },
    [commitLayout],
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

  const applyPanePreset = useCallback(
    (paneId: string, direction: EditorSplitDirection): void => {
      const pane = layout.panes[paneId];
      if (pane === undefined || pane.activeFile.length === 0) return;
      const nextLayout = createDistributedPresetLayout(layout, workspaceRoot, direction, pane);
      if (nextLayout === null) return;
      if (serializeEditorLayoutStateV2(nextLayout) === serializeEditorLayoutStateV2(layout)) {
        return;
      }
      setDirtyByPane((current) => remapDirtyFilesToPresetPanes(current, nextLayout));
      commitLayout(nextLayout);
    },
    [commitLayout, layout, workspaceRoot],
  );

  const splitPane = useCallback(
    (paneId: string, direction: EditorSplitDirection): void => applyPanePreset(paneId, direction),
    [applyPanePreset],
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

  const isTabDragActive = useCallback(
    (): boolean => pointerTabDragRef.current !== null || draggedTab !== null,
    [draggedTab],
  );

  const resizeSidebar = useCallback(
    (event: PointerEvent<HTMLButtonElement>): void => {
      if (event.buttons !== 1) return;
      if (isTabDragActive()) return;
      previewSidebarWidth(event.clientX);
    },
    [isTabDragActive, previewSidebarWidth],
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
      if (isTabDragActive()) return;
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
    [commitSidebarGesture, isTabDragActive, previewSidebarWidth],
  );

  const beginSplitMouseResize = useCallback(
    (split: EditorLayoutSplitNode, event: MouseEvent<HTMLElement>): void => {
      if (isTabDragActive()) return;
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
    [commitSplitGesture, isTabDragActive, previewSplitRatio],
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
    (split: EditorLayoutSplitNode, event: KeyboardEvent<HTMLElement>): void => {
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

  const capturePointer = useCallback((event: PointerEvent<HTMLElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const releasePointer = useCallback((event: PointerEvent<HTMLElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  // Move DOM focus to the roving tab button for (paneId, file) so document.activeElement follows the
  // active tab after keyboard navigation (WCAG APG tablist: focus and selection stay together for
  // automatic activation). The button still carries tabIndex=-1 at this instant — selectOpenFile
  // re-renders it to tabIndex=0 on the next commit — but a programmatic .focus() works regardless.
  const focusTabButton = useCallback((paneId: string, file: string): void => {
    const escapeAttr = (value: string): string =>
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(value)
        : value.replace(/["\\]/g, "\\$&");
    const selector = `[role="tab"][data-pane-id="${escapeAttr(paneId)}"][data-tab-file="${escapeAttr(file)}"]`;
    const focus = (): boolean => {
      const button = document.querySelector<HTMLElement>(selector);
      button?.focus();
      return button !== null;
    };
    // Focus synchronously for the common case (target tab already rendered). If the target was in the
    // overflow menu and is not yet a visible tab, selectOpenFile's re-render scrolls it into view — so
    // retry once after paint so keyboard focus still lands on it.
    if (!focus() && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        focus();
      });
    }
  }, []);

  const handleTabKeyDown = useCallback(
    (paneId: string, path: string, event: KeyboardEvent<HTMLButtonElement>): void => {
      const pane = layoutRef.current.panes[paneId];
      if (pane === undefined) return;
      // Plain ArrowLeft/ArrowRight/Home/End (no Alt) roam the roving tab-stop within the pane's
      // visible tab order and activate the target (automatic activation, WCAG 2.1.1 + APG tablist).
      // Alt+Arrow keeps its existing reorder/move-across-pane behavior (handled below).
      if (!event.altKey) {
        const order = pane.tabOrder;
        if (order.length === 0) return;
        const index = order.indexOf(path);
        let targetFile: string | undefined;
        if (event.key === "ArrowLeft") {
          targetFile = order[index <= 0 ? order.length - 1 : index - 1];
        } else if (event.key === "ArrowRight") {
          targetFile = order[index < 0 || index >= order.length - 1 ? 0 : index + 1];
        } else if (event.key === "Home") {
          targetFile = order[0];
        } else if (event.key === "End") {
          targetFile = order[order.length - 1];
        } else {
          return;
        }
        event.preventDefault();
        if (targetFile === undefined || targetFile === path) {
          focusTabButton(paneId, path);
          return;
        }
        selectOpenFile(paneId, targetFile);
        focusTabButton(paneId, targetFile);
        return;
      }
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
    [commitLayout, focusTabButton, selectOpenFile],
  );

  const beginTabPointerDrag = useCallback(
    (
      paneId: string,
      path: string,
      event: PointerEvent<HTMLButtonElement>,
      onDragModeStart?: (() => void) | undefined,
    ): void => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      let releaseBodyStyle: (() => void) | null = null;
      const clearDragFeedback = (): void => {
        releaseBodyStyle?.();
        releaseBodyStyle = null;
        setHeldTab(null);
        setDraggedTab(null);
        setTabDragPosition(null);
        setTabDropTargetPaneId(null);
        setTabInsertTarget(null);
      };
      const tabRect = event.currentTarget.getBoundingClientRect();
      pointerTabDragRef.current = {
        paneId,
        file: path,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - tabRect.left,
        offsetY: event.clientY - tabRect.top,
        width: tabRect.width,
        dragging: false,
      };
      setHeldTab({ paneId, file: path });
      // GEN-PERF-EDITOR-003 — raw pointermove fires at up to 120-240Hz; resolving the
      // insertion target does a tab-node querySelectorAll plus one getBoundingClientRect
      // per open tab plus an elementFromPoint (each a forced layout), and then three
      // state commits. Buffer the latest pointer and run that work at most once per
      // animation frame (last-event-wins), the same pattern as WindowFrame's drag and
      // workspaceActions' connect gesture. The drag ACTIVATION (threshold crossing)
      // stays synchronous so grab feedback is not delayed by a frame.
      let lastMoveX = 0;
      let lastMoveY = 0;
      let moveFrame: number | null = null;
      const applyMove = (): void => {
        moveFrame = null;
        const drag = pointerTabDragRef.current;
        if (drag === null || !drag.dragging) return;
        const insertTarget = tabInsertionTargetFromPoint(
          drag,
          lastMoveX,
          lastMoveY,
          layoutRef.current,
        );
        const targetPaneId = paneIdFromPoint(lastMoveX, lastMoveY);
        setTabDragPosition({
          x: lastMoveX - drag.offsetX,
          y: lastMoveY - drag.offsetY,
          width: drag.width,
        });
        setTabInsertTarget(insertTarget);
        setTabDropTargetPaneId(
          insertTarget === null && targetPaneId !== null && targetPaneId !== drag.paneId
            ? targetPaneId
            : null,
        );
      };
      const move = (moveEvent: globalThis.PointerEvent): void => {
        const drag = pointerTabDragRef.current;
        if (drag === null) return;
        const distance = Math.hypot(
          moveEvent.clientX - drag.startX,
          moveEvent.clientY - drag.startY,
        );
        if (!drag.dragging && distance < TAB_POINTER_DRAG_THRESHOLD_PX) return;
        if (!drag.dragging) {
          drag.dragging = true;
          suppressNextTabClickRef.current = { paneId: drag.paneId, file: drag.file };
          releaseBodyStyle = acquireGrabbingBodyStyle();
          onDragModeStart?.();
          setDraggedTab({ paneId: drag.paneId, file: drag.file });
        }
        lastMoveX = moveEvent.clientX;
        lastMoveY = moveEvent.clientY;
        moveFrame ??= requestAnimationFrame(applyMove);
        moveEvent.preventDefault();
      };
      const cleanup = (): void => {
        if (moveFrame !== null) {
          cancelAnimationFrame(moveFrame);
          moveFrame = null;
        }
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      };
      const cancel = (): void => {
        cleanup();
        pointerTabDragRef.current = null;
        suppressNextTabClickRef.current = null;
        clearDragFeedback();
      };
      const up = (upEvent: globalThis.PointerEvent): void => {
        cleanup();
        const drag = pointerTabDragRef.current;
        const insertTarget =
          drag === null
            ? null
            : (tabInsertionTargetFromPoint(
                drag,
                upEvent.clientX,
                upEvent.clientY,
                layoutRef.current,
              ) ?? tabInsertTargetRef.current);
        pointerTabDragRef.current = null;
        clearDragFeedback();
        if (drag === null || !drag.dragging) return;
        upEvent.preventDefault();
        window.setTimeout(() => {
          suppressNextTabClickRef.current = null;
        }, 0);
        if (insertTarget !== null) {
          commitLayout(
            editorLayoutReducer(
              layoutRef.current,
              insertTarget.paneId === drag.paneId
                ? {
                    type: "reorder-tab",
                    paneId: drag.paneId,
                    file: drag.file,
                    targetIndex: insertTarget.targetIndex,
                  }
                : {
                    type: "move-tab",
                    fromPaneId: drag.paneId,
                    toPaneId: insertTarget.paneId,
                    file: drag.file,
                    targetIndex: insertTarget.targetIndex,
                  },
            ),
          );
          return;
        }
        const targetPaneId = paneIdFromPoint(upEvent.clientX, upEvent.clientY);
        if (targetPaneId === null || targetPaneId === drag.paneId) return;
        commitLayout(
          editorLayoutReducer(layoutRef.current, {
            type: "move-tab",
            fromPaneId: drag.paneId,
            toPaneId: targetPaneId,
            file: drag.file,
          }),
        );
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", cancel, { once: true });
    },
    [commitLayout, setTabInsertTarget],
  );

  const suppressTabClickAfterPointerDrag = useCallback(
    (paneId: string, path: string, event: MouseEvent<HTMLButtonElement>): void => {
      const suppressedTab = suppressNextTabClickRef.current;
      if (
        suppressedTab === null ||
        suppressedTab.paneId !== paneId ||
        suppressedTab.file !== path
      ) {
        return;
      }
      suppressNextTabClickRef.current = null;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  const dropTab = useCallback(
    (paneId: string, zone: EditorSplitDropZone, event: DragEvent<HTMLElement>): void => {
      event.preventDefault();
      const dragged = draggedTab ?? draggedTabFromEvent(event);
      if (dragged === null) return;
      const paneCount = editorLayoutPaneIds(layoutRef.current).length;
      const effectiveZone =
        zone !== "center" && paneCount >= MAX_EDITOR_PANES && dragged.paneId !== paneId
          ? "center"
          : zone;
      if (effectiveZone !== "center" && paneCount >= MAX_EDITOR_PANES) {
        setDraggedTab(null);
        return;
      }
      commitLayout(
        editorLayoutReducer(layoutRef.current, {
          type: "drop-tab",
          intent: {
            fromPaneId: dragged.paneId,
            toPaneId: paneId,
            file: dragged.file,
            zone: effectiveZone,
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

  const nextTab = useCallback((): void => cycleActiveTab(1), [cycleActiveTab]);
  const prevTab = useCallback((): void => cycleActiveTab(-1), [cycleActiveTab]);

  // Content-free host snapshot consumed by the palette + keybinding layer. Memoized so the command
  // palette does not receive a new object on unrelated editor chrome renders.
  const commandHost: EditorPaletteHost = useMemo(
    () => ({
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
      nextTab,
      prevTab,
      reopenClosed: reopenClosedTab,
      saveAll: saveAllDirty,
    }),
    [
      activeFile,
      closeActivePane,
      closeActiveTab,
      dirtyFileList.length,
      layout,
      nextTab,
      openCommandPalette,
      openQuickOpen,
      prevTab,
      reopenClosedTab,
      saveAllDirty,
      splitActivePane,
      workspaceRoot,
    ],
  );
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
        // GEN-PERF-EDITOR-003 — the full drag-capable tab handle lives HERE (in the
        // pane-memoized closure) instead of as a per-render inline closure in renderPane,
        // so its identity is stable and does not defeat React.memo(EditorRuntimeWidget).
        // The "held" flag is read from heldTabRef at call time (not closed over as state).
        renderTabHandle: (path, active, tabDirty, context) => ({
          draggable: false,
          onDragStart: (event: DragEvent<HTMLButtonElement>) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", path);
            event.dataTransfer.setData(
              EDITOR_TAB_DRAG_MIME,
              JSON.stringify({ paneId, file: path }),
            );
            context?.onDragModeStart?.();
            setDraggedTab({ paneId, file: path });
          },
          onDragEnd: () => setDraggedTab(null),
          onPointerDown: (event: PointerEvent<HTMLButtonElement>) =>
            beginTabPointerDrag(paneId, path, event, context?.onDragModeStart),
          onClickCapture: (event: MouseEvent<HTMLButtonElement>) =>
            suppressTabClickAfterPointerDrag(paneId, path, event),
          onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
            handleTabKeyDown(paneId, path, event),
          "data-active": active ? "true" : "false",
          "data-dirty": tabDirty ? "true" : "false",
          "data-pane-id": paneId,
          "data-tab-file": path,
          "data-tab-draggable": "true",
          "data-tab-held":
            heldTabRef.current?.paneId === paneId && heldTabRef.current.file === path
              ? "true"
              : "false",
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
    beginTabPointerDrag,
    suppressTabClickAfterPointerDrag,
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
      tabInsertTarget:
        tabInsertTarget?.paneId === pane.id
          ? { file: tabInsertTarget.file, edge: tabInsertTarget.edge }
          : undefined,
      renderTabHandle: binding.renderTabHandle,
      // GEN-PERF-EDITOR-003 — a per-pane scalar that changes only for the pane whose tab is
      // held, so a hold-state change re-renders just that pane (its stable renderTabHandle
      // re-reads the held flag) while other panes stay memo-bailed.
      heldTabFile: heldTab?.paneId === pane.id ? heldTab.file : undefined,
    };
    return (
      <section
        className="ed-pane"
        data-active={pane.id === layout.activePaneId ? "true" : "false"}
        data-dragging={draggedTab === null ? "false" : "true"}
        data-tab-drop-target={tabDropTargetPaneId === pane.id ? "true" : "false"}
        data-pane-id={pane.id}
        key={pane.id}
        onPointerDownCapture={() => activatePane(pane.id)}
        onFocusCapture={() => activatePane(pane.id)}
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
        {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- WAI-ARIA window-splitter pattern: focusable role=separator exposes keyboard resizing through aria-valuenow. */}
        <div
          role="separator"
          tabIndex={0}
          className="ed-pane-resizer"
          aria-label="Resize editor split"
          aria-orientation={node.direction === "row" ? "vertical" : "horizontal"}
          aria-valuemin={MIN_SPLIT_RATIO}
          aria-valuemax={MAX_SPLIT_RATIO}
          aria-valuenow={Math.round(node.ratio)}
          onPointerDown={(event) => {
            if (isTabDragActive()) return;
            capturePointer(event);
          }}
          onPointerMove={(event) => {
            if (event.buttons !== 1) return;
            if (isTabDragActive()) return;
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
        {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        {renderNode(node.second)}
      </div>
    );
  };

  const singlePane = paneCount === 1;

  return (
    <div
      className={`editor-workspace${layout.sidebarCollapsed ? " sidebar-collapsed" : ""}`}
      data-tab-dragging={draggedTab === null ? "false" : "true"}
      data-pane-count={paneCount}
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
            className="ed-sidebar-resizer"
            aria-label="Resize project tree"
            onPointerDown={(event) => {
              if (isTabDragActive()) return;
              capturePointer(event);
            }}
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
      {draggedTab !== null && tabDragPosition !== null && typeof document !== "undefined"
        ? createPortal(
            <div
              className="ed-tab-drag-ghost mono"
              style={
                {
                  "--ed-tab-drag-x": `${String(tabDragPosition.x)}px`,
                  "--ed-tab-drag-y": `${String(tabDragPosition.y)}px`,
                  "--ed-tab-drag-width": `${String(tabDragPosition.width)}px`,
                } as CSSProperties
              }
              aria-hidden="true"
            >
              <FileIcon name={draggedTab.file} />
              <span className="ed-tab-drag-ghost-label">{draggedTab.file}</span>
              <span className="ed-tab-drag-ghost-close">×</span>
            </div>,
            document.body,
          )
        : null}
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
