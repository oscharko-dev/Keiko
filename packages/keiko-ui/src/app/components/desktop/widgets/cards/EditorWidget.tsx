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
  createEditorLayoutStateV2,
  editorLayoutOpenFiles,
  editorLayoutPaneIds,
  editorLayoutPanes,
  editorLayoutReducer,
  serializeEditorLayoutStateV2,
  type EditorDirtyCloseIntent,
  type EditorLayoutNode,
  type EditorLayoutPaneNode,
  type EditorLayoutSplitNode,
  type EditorLayoutStateV2,
  type EditorPaneStateV2,
  type EditorSplitDirection,
  type EditorSplitDropZone,
} from "@oscharko-dev/keiko-contracts";

import { Icons } from "../../Icons";
import { acquireGrabbingBodyStyle } from "../../interactionGuards";
import type { EditorExternalSaveRequest, EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";
import type { EditorAgentPaneSnapshot } from "../../../../../lib/types";
import { FilesWidget } from "./FilesWidget";
import { FileIcon } from "../shared/projectTree";

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

interface PointerTabDrag {
  readonly paneId: string;
  readonly file: string;
  readonly startX: number;
  readonly startY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  dragging: boolean;
}

interface PointerTabDragPosition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

const EDITOR_TAB_DRAG_MIME = "application/x-keiko-editor-tab";
const TAB_POINTER_DRAG_THRESHOLD_PX = 6;
const MIN_SIDEBAR_WIDTH = 180;
const DEFAULT_SIDEBAR_WIDTH = 260;
const MAX_SIDEBAR_WIDTH = 440;
const MIN_SPLIT_RATIO = 15;
const MAX_SPLIT_RATIO = 85;
const MAX_EDITOR_PANES = 2;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeComparablePath(path: string): string {
  return path.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
}

function normalizeEditorFile(root: string, file: string | undefined): string {
  const rawFile = file?.trim() ?? "";
  if (root.trim().length === 0 || rawFile.length === 0) return rawFile;
  const normalizedRoot = normalizeComparablePath(root);
  const normalizedFile = normalizeComparablePath(rawFile);
  const rootCmp = normalizedRoot.toLowerCase();
  const fileCmp = normalizedFile.toLowerCase();
  if (fileCmp === rootCmp) return "";
  if (fileCmp.startsWith(`${rootCmp}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1).replace(/^\/+/u, "");
  }
  return rawFile;
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

function layoutHasDuplicateFiles(layout: EditorLayoutStateV2): boolean {
  const seen = new Set<string>();
  for (const pane of editorLayoutPanes(layout)) {
    for (const path of pane.openFiles) {
      if (seen.has(path)) return true;
      seen.add(path);
    }
  }
  return false;
}

function layoutHasClonedPanes(layout: EditorLayoutStateV2): boolean {
  const panes = editorLayoutPanes(layout);
  if (panes.length < 2) return false;
  const first = panes[0]?.openFiles ?? [];
  return panes.every((pane) => sameStringList(pane.openFiles, first));
}

function createInitialLayout(input: {
  readonly root: string;
  readonly file: string;
  readonly openFiles: readonly string[];
  readonly layoutJson: string | undefined;
}): EditorLayoutStateV2 {
  return normalizeEditorLayoutStructure(
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

function createPresetPane(
  root: string,
  id: string,
  activeFile: string,
  openFiles: readonly string[],
): EditorPaneStateV2 {
  const normalizedOpenFiles = normalizeEditorOpenFiles(root, activeFile, openFiles);
  const normalizedActiveFile =
    normalizeEditorFile(root, activeFile) || normalizedOpenFiles[0] || "";
  return {
    id,
    activeFile: normalizedActiveFile,
    openFiles: normalizedOpenFiles,
    tabOrder: normalizedOpenFiles,
  };
}

function paneNode(paneId: string): EditorLayoutPaneNode {
  return { type: "pane", paneId };
}

function splitNode(
  id: string,
  direction: EditorSplitDirection,
  first: EditorLayoutNode,
  second: EditorLayoutNode,
): EditorLayoutSplitNode {
  return { type: "split", id, direction, ratio: 50, first, second };
}

function presetTree(direction: EditorSplitDirection): EditorLayoutSplitNode {
  return splitNode("split-1", direction, paneNode("pane-1"), paneNode("pane-2"));
}

function createDistributedPresetLayout(
  layout: EditorLayoutStateV2,
  root: string,
  direction: EditorSplitDirection,
  sourcePane: EditorPaneStateV2,
): EditorLayoutStateV2 | null {
  const openFiles = normalizeEditorOpenFiles(
    root,
    sourcePane.activeFile,
    editorLayoutOpenFiles(layout),
  );
  const activeFile = normalizeEditorFile(root, sourcePane.activeFile) || openFiles[0] || "";
  const otherFiles = openFiles.filter((path) => path !== activeFile);
  if (activeFile.length === 0 || otherFiles.length === 0) return null;
  return {
    ...layout,
    root,
    activePaneId: "pane-1",
    tree: presetTree(direction),
    panes: {
      "pane-1": createPresetPane(root, "pane-1", activeFile, [activeFile]),
      "pane-2": createPresetPane(root, "pane-2", otherFiles[0] ?? "", otherFiles),
    },
  };
}

function createSinglePresetLayout(
  layout: EditorLayoutStateV2,
  root: string,
  activeFile: string,
  openFiles: readonly string[],
): EditorLayoutStateV2 {
  return {
    ...layout,
    root,
    activePaneId: "pane-1",
    tree: paneNode("pane-1"),
    panes: {
      "pane-1": createPresetPane(root, "pane-1", activeFile, openFiles),
    },
  };
}

function dedupeLayoutFilesByActivePane(
  layout: EditorLayoutStateV2,
  root: string,
): EditorLayoutStateV2 {
  const paneIds = editorLayoutPaneIds(layout);
  const orderedPaneIds = [
    layout.activePaneId,
    ...paneIds.filter((paneId) => paneId !== layout.activePaneId),
  ];
  const seen = new Set<string>();
  const panes: Record<string, EditorPaneStateV2> = { ...layout.panes };
  for (const paneId of orderedPaneIds) {
    const pane = layout.panes[paneId];
    if (pane === undefined) continue;
    const openFiles = pane.openFiles.filter((path) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
    const activeFile = openFiles.includes(pane.activeFile) ? pane.activeFile : (openFiles[0] ?? "");
    panes[paneId] = createPresetPane(root, pane.id, activeFile, openFiles);
  }
  return { ...layout, panes };
}

function normalizeEditorLayoutStructure(
  root: string,
  layout: EditorLayoutStateV2,
): EditorLayoutStateV2 {
  const sanitized = sanitizeLayoutFiles(root, layout);
  const paneIds = editorLayoutPaneIds(sanitized);
  const hasDuplicateFiles = layoutHasDuplicateFiles(sanitized);
  if (paneIds.length <= MAX_EDITOR_PANES && !hasDuplicateFiles) {
    return sanitized;
  }
  if (paneIds.length <= MAX_EDITOR_PANES && hasDuplicateFiles && !layoutHasClonedPanes(sanitized)) {
    const deduped = dedupeLayoutFilesByActivePane(sanitized, root);
    if (editorLayoutPanes(deduped).every((pane) => pane.openFiles.length > 0)) return deduped;
  }
  const sourcePane = activeEditorPane(sanitized);
  const direction = sanitized.tree.type === "split" ? sanitized.tree.direction : "row";
  const distributed = createDistributedPresetLayout(sanitized, root, direction, sourcePane);
  if (distributed !== null) return distributed;
  const openFiles = editorLayoutOpenFiles(sanitized);
  const activeFile = normalizeEditorFile(root, sourcePane.activeFile) || openFiles[0] || "";
  return createSinglePresetLayout(sanitized, root, activeFile, openFiles);
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

function draggedTabFromEvent(event: DragEvent<HTMLElement>): DraggedTab | null {
  const payload = event.dataTransfer.getData(EDITOR_TAB_DRAG_MIME);
  if (payload.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "paneId" in parsed &&
      "file" in parsed &&
      typeof parsed.paneId === "string" &&
      typeof parsed.file === "string" &&
      parsed.paneId.length > 0 &&
      parsed.file.length > 0
    ) {
      return { paneId: parsed.paneId, file: parsed.file };
    }
  } catch {
    // Ignore stale or foreign drag payloads.
  }
  return null;
}

function paneIdFromPoint(clientX: number, clientY: number): string | null {
  const target = document.elementFromPoint(clientX, clientY);
  const pane = target?.closest<HTMLElement>(".ed-pane");
  return pane?.dataset.paneId ?? null;
}

function remapDirtyFilesToPresetPanes(
  dirtyByPane: Readonly<Record<string, Readonly<Record<string, true>>>>,
  layout: EditorLayoutStateV2,
): Readonly<Record<string, Readonly<Record<string, true>>>> {
  const dirtyFiles = allDirtyFiles(dirtyByPane);
  if (dirtyFiles.length === 0) return {};
  const panes = editorLayoutPanes(layout);
  const fallbackPane = activeEditorPane(layout);
  const next: Record<string, Record<string, true>> = {};
  for (const path of dirtyFiles) {
    const targetPane = panes.find((pane) => pane.openFiles.includes(path)) ?? fallbackPane;
    next[targetPane.id] = { ...(next[targetPane.id] ?? {}), [path]: true };
  }
  return next;
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
  const [dirtyByPane, setDirtyByPane] = useState<
    Readonly<Record<string, Readonly<Record<string, true>>>>
  >({});
  const [pendingClose, setPendingClose] = useState<PendingDirtyClose | null>(null);
  const [heldTab, setHeldTab] = useState<DraggedTab | null>(null);
  const [draggedTab, setDraggedTab] = useState<DraggedTab | null>(null);
  const [tabDragPosition, setTabDragPosition] = useState<PointerTabDragPosition | null>(null);
  const [tabDropTargetPaneId, setTabDropTargetPaneId] = useState<string | null>(null);
  const [saveRequest, setSaveRequest] = useState<EditorExternalSaveRequest | null>(null);
  const saveSeqRef = useRef(0);
  const saveResolversRef = useRef(new Map<number, (ok: boolean) => void>());
  const lastPropRootRef = useRef(root?.trim() ?? "");
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const pointerTabDragRef = useRef<PointerTabDrag | null>(null);
  const suppressNextTabClickRef = useRef(false);

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
      commitLayout(editorLayoutReducer(layout, { type: "select-file", paneId, file: path }));
      setSaveRequest({ id, paneId, file: path });
      return new Promise<boolean>((resolve) => {
        saveResolversRef.current.set(id, resolve);
      });
    },
    [commitLayout, layout],
  );

  const onExternalSaveComplete = useCallback(
    (requestId: number, paneId: string, path: string, ok: boolean): void => {
      const resolve = saveResolversRef.current.get(requestId);
      saveResolversRef.current.delete(requestId);
      if (saveRequest?.id === requestId) setSaveRequest(null);
      if (ok) markDirty(paneId, path, false);
      resolve?.(ok);
    },
    [markDirty, saveRequest?.id],
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
    }
    pendingClose.apply();
    setPendingClose(null);
  }, [dirtyByPane, markDirty, pendingClose]);

  const cancelPendingClose = useCallback((): void => {
    if (pendingClose?.saving === true) return;
    setPendingClose(null);
  }, [pendingClose?.saving]);

  const openRoot = useCallback(
    (nextRoot: string): void => {
      const normalizedRoot = nextRoot.trim();
      if (normalizedRoot.length === 0) return;
      const apply = (): void => {
        const nextLayout = editorLayoutReducer(layout, {
          type: "replace-root",
          root: normalizedRoot,
          sidebarWidth: layout.sidebarWidth,
        });
        setWorkspaceRoot(normalizedRoot);
        setDirtyByPane({});
        commitLayout(nextLayout, normalizedRoot);
      };
      const firstPaneId = editorLayoutPaneIds(layout)[0] ?? layout.activePaneId;
      requestDirtyClose({
        paneId: firstPaneId,
        files: dirtyFileList,
        reason: "root-change",
        apply,
      });
    },
    [commitLayout, dirtyFileList, layout, requestDirtyClose],
  );

  const openFile = useCallback(
    (nextRoot: string, nextFile: string): void => {
      const normalizedRoot = nextRoot.trim();
      const normalizedFile = normalizeEditorFile(normalizedRoot, nextFile);
      if (normalizedRoot.length === 0 || normalizedFile.length === 0) return;
      const paneId = currentPane.id;
      const nextLayout = editorLayoutReducer(layout, {
        type: "open-file",
        paneId,
        file: normalizedFile,
      });
      setWorkspaceRoot(normalizedRoot);
      commitLayout(nextLayout, normalizedRoot);
    },
    [commitLayout, currentPane.id, layout],
  );

  const selectOpenFile = useCallback(
    (paneId: string, nextFile: string): void => {
      if (workspaceRoot.length === 0 || nextFile.length === 0) return;
      commitLayout(editorLayoutReducer(layout, { type: "select-file", paneId, file: nextFile }));
    },
    [commitLayout, layout, workspaceRoot],
  );

  const closeOpenFile = useCallback(
    async (paneId: string, path: string): Promise<boolean> =>
      requestDirtyClose({
        paneId,
        files: [path],
        reason: "tab-close",
        apply: () => {
          markDirty(paneId, path, false);
          commitLayout(editorLayoutReducer(layout, { type: "close-tab", paneId, file: path }));
        },
      }),
    [commitLayout, layout, markDirty, requestDirtyClose],
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

  const closePane = useCallback(
    (paneId: string): void => {
      const pane = layout.panes[paneId];
      if (pane === undefined) return;
      requestDirtyClose({
        paneId,
        files: pane.openFiles,
        reason: "pane-close",
        apply: () => {
          setDirtyByPane((current) => {
            const { [paneId]: _removed, ...remaining } = current;
            return remaining;
          });
          commitLayout(editorLayoutReducer(layout, { type: "close-pane", paneId }));
        },
      });
    },
    [commitLayout, layout, requestDirtyClose],
  );

  const toggleSidebar = useCallback((): void => {
    commitLayout(
      editorLayoutReducer(layout, {
        type: "set-sidebar",
        collapsed: !layout.sidebarCollapsed,
      }),
    );
  }, [commitLayout, layout]);

  const resizeSidebarTo = useCallback(
    (clientX: number): void => {
      if (workspaceRef.current === null) return;
      const rect = workspaceRef.current.getBoundingClientRect();
      const nextWidth = clampNumber(clientX - rect.left, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
      commitLayout(
        editorLayoutReducer(layout, {
          type: "set-sidebar",
          width: nextWidth,
          collapsed: false,
        }),
      );
    },
    [commitLayout, layout],
  );

  const isTabDragActive = useCallback(
    (): boolean => pointerTabDragRef.current !== null || draggedTab !== null,
    [draggedTab],
  );

  const resizeSidebar = useCallback(
    (event: PointerEvent<HTMLButtonElement>): void => {
      if (event.buttons !== 1) return;
      if (isTabDragActive()) return;
      resizeSidebarTo(event.clientX);
    },
    [isTabDragActive, resizeSidebarTo],
  );

  const resizeSidebarBy = useCallback(
    (delta: number): void => {
      commitLayout(
        editorLayoutReducer(layout, {
          type: "set-sidebar",
          width: clampNumber(layout.sidebarWidth + delta, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
          collapsed: false,
        }),
      );
    },
    [commitLayout, layout],
  );

  const resizeSplitTo = useCallback(
    (split: EditorLayoutSplitNode, rect: DOMRect, clientX: number, clientY: number): void => {
      const raw =
        split.direction === "row"
          ? ((clientX - rect.left) / rect.width) * 100
          : ((clientY - rect.top) / rect.height) * 100;
      commitLayout(
        editorLayoutReducer(layout, {
          type: "resize-split",
          splitId: split.id,
          ratio: clampNumber(raw, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO),
        }),
      );
    },
    [commitLayout, layout],
  );

  const resizeSplitBy = useCallback(
    (split: EditorLayoutSplitNode, delta: number): void => {
      commitLayout(
        editorLayoutReducer(layout, {
          type: "resize-split",
          splitId: split.id,
          ratio: clampNumber(split.ratio + delta, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO),
        }),
      );
    },
    [commitLayout, layout],
  );

  const beginSidebarMouseResize = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      if (isTabDragActive()) return;
      event.preventDefault();
      const move = (moveEvent: globalThis.MouseEvent): void => resizeSidebarTo(moveEvent.clientX);
      const up = (): void => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up, { once: true });
    },
    [isTabDragActive, resizeSidebarTo],
  );

  const beginSplitMouseResize = useCallback(
    (split: EditorLayoutSplitNode, event: MouseEvent<HTMLButtonElement>): void => {
      if (isTabDragActive()) return;
      event.preventDefault();
      const parent = event.currentTarget.parentElement;
      if (parent === null) return;
      const move = (moveEvent: globalThis.MouseEvent): void =>
        resizeSplitTo(split, parent.getBoundingClientRect(), moveEvent.clientX, moveEvent.clientY);
      const up = (): void => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up, { once: true });
    },
    [isTabDragActive, resizeSplitTo],
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
      const pane = layout.panes[paneId];
      if (pane === undefined) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const paneIds = editorLayoutPaneIds(layout);
        if (event.shiftKey) {
          const paneIndex = paneIds.indexOf(paneId);
          const targetPaneId =
            event.key === "ArrowLeft" ? paneIds[paneIndex - 1] : paneIds[paneIndex + 1];
          if (targetPaneId !== undefined) {
            commitLayout(
              editorLayoutReducer(layout, {
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
          editorLayoutReducer(layout, {
            type: "reorder-tab",
            paneId,
            file: path,
            targetIndex: nextIndex,
          }),
        );
      }
    },
    [commitLayout, layout],
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
          suppressNextTabClickRef.current = true;
          releaseBodyStyle = acquireGrabbingBodyStyle();
          onDragModeStart?.();
          setDraggedTab({ paneId: drag.paneId, file: drag.file });
        }
        const targetPaneId = paneIdFromPoint(moveEvent.clientX, moveEvent.clientY);
        setTabDragPosition({
          x: moveEvent.clientX - drag.offsetX,
          y: moveEvent.clientY - drag.offsetY,
          width: drag.width,
        });
        setTabDropTargetPaneId(
          targetPaneId !== null && targetPaneId !== drag.paneId ? targetPaneId : null,
        );
        moveEvent.preventDefault();
      };
      const cleanup = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      };
      const cancel = (): void => {
        cleanup();
        pointerTabDragRef.current = null;
        clearDragFeedback();
      };
      const up = (upEvent: globalThis.PointerEvent): void => {
        cleanup();
        const drag = pointerTabDragRef.current;
        pointerTabDragRef.current = null;
        clearDragFeedback();
        if (drag === null || !drag.dragging) return;
        upEvent.preventDefault();
        const targetPaneId = paneIdFromPoint(upEvent.clientX, upEvent.clientY);
        if (targetPaneId === null || targetPaneId === drag.paneId) return;
        commitLayout(
          editorLayoutReducer(layout, {
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
    [commitLayout, layout],
  );

  const suppressTabClickAfterPointerDrag = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      if (!suppressNextTabClickRef.current) return;
      suppressNextTabClickRef.current = false;
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
      const paneCount = editorLayoutPaneIds(layout).length;
      const effectiveZone =
        zone !== "center" && paneCount >= MAX_EDITOR_PANES && dragged.paneId !== paneId
          ? "center"
          : zone;
      if (effectiveZone !== "center" && paneCount >= MAX_EDITOR_PANES) {
        setDraggedTab(null);
        return;
      }
      commitLayout(
        editorLayoutReducer(layout, {
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
    [commitLayout, draggedTab, layout],
  );

  if (workspaceRoot.length === 0) {
    return <EditorRuntimeWidget {...props} />;
  }

  const paneActions = (pane: EditorPaneStateV2): ReactNode => {
    const paneCount = editorLayoutPaneIds(layout).length;
    return (
      <span className="ed-pane-actions" aria-label="Editor split controls">
        <button
          type="button"
          className="ed-icon-action"
          aria-label={`Split ${pane.activeFile || "editor"} right`}
          onClick={() => applyPanePreset(pane.id, "row")}
        >
          <Icons.split size={14} />
        </button>
        <button
          type="button"
          className="ed-icon-action"
          aria-label={`Split ${pane.activeFile || "editor"} down`}
          onClick={() => applyPanePreset(pane.id, "column")}
        >
          <Icons.panelDown size={14} />
        </button>
        {paneCount > 1 ? (
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
  };

  const renderPane = (pane: EditorPaneStateV2): ReactNode => {
    const layoutPaneSnapshots: readonly EditorAgentPaneSnapshot[] = editorLayoutPanes(layout).map(
      (entry: EditorPaneStateV2) => ({
        paneId: entry.id,
        activeFile: entry.activeFile.length > 0 ? entry.activeFile : null,
        openFiles: entry.openFiles,
      }),
    );
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
      onSelectOpenFile: (nextFile) => selectOpenFile(pane.id, nextFile),
      onCloseOpenFile: (path) => closeOpenFile(pane.id, path),
      onDirtyChange: (path, dirty) => markDirty(pane.id, path, dirty),
      toolbarExtras: paneActions(pane),
      externalSaveRequest:
        saveRequest !== null && saveRequest.paneId === pane.id ? saveRequest : undefined,
      onExternalSaveComplete,
    };
    return (
      <section
        className="ed-pane"
        data-active={pane.id === layout.activePaneId ? "true" : "false"}
        data-dragging={draggedTab === null ? "false" : "true"}
        data-tab-drop-target={tabDropTargetPaneId === pane.id ? "true" : "false"}
        data-pane-id={pane.id}
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
        <EditorRuntimeWidget
          {...runtimeProps}
          renderTabHandle={(path, active, tabDirty, context) => ({
            draggable: false,
            onDragStart: (event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", path);
              event.dataTransfer.setData(
                EDITOR_TAB_DRAG_MIME,
                JSON.stringify({ paneId: pane.id, file: path }),
              );
              context?.onDragModeStart?.();
              setDraggedTab({ paneId: pane.id, file: path });
            },
            onDragEnd: () => setDraggedTab(null),
            onPointerDown: (event) =>
              beginTabPointerDrag(pane.id, path, event, context?.onDragModeStart),
            onClickCapture: suppressTabClickAfterPointerDrag,
            onKeyDown: (event) => handleTabKeyDown(pane.id, path, event),
            "data-active": active ? "true" : "false",
            "data-dirty": tabDirty ? "true" : "false",
            "data-tab-draggable": "true",
            "data-tab-held":
              heldTab?.paneId === pane.id && heldTab.file === path ? "true" : "false",
          })}
        />
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
          className="ed-pane-resizer"
          aria-label="Resize editor split"
          onPointerDown={(event) => {
            if (isTabDragActive()) return;
            capturePointer(event);
          }}
          onPointerMove={(event) => {
            if (event.buttons !== 1) return;
            if (isTabDragActive()) return;
            const parent = event.currentTarget.parentElement;
            if (parent !== null) {
              resizeSplitTo(node, parent.getBoundingClientRect(), event.clientX, event.clientY);
            }
          }}
          onPointerUp={releasePointer}
          onPointerCancel={releasePointer}
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
      data-tab-dragging={draggedTab === null ? "false" : "true"}
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
            onPointerUp={releasePointer}
            onPointerCancel={releasePointer}
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
    </div>
  );
}
