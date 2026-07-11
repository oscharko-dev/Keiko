// GEN-MAINT-COMPLEXITY-002 — pure tab/pane/drag-geometry helpers extracted verbatim from EditorWidget.
//
// This is a DOM-free-by-argument leaf: the layout/file normalizers are pure functions of their args
// and the editor layout contract, and the three pointer/drag helpers
// (`paneIdFromPoint`/`tabInsertionTargetFromPoint`/`draggedTabFromEvent`) read the live DOM but stay
// pure functions of their arguments, so their tests run under `// @vitest-environment jsdom`. These
// intentionally do NOT live in @oscharko-dev/keiko-contracts — that package is a DOM-free leaf and
// these helpers touch `document`/`DragEvent`. EditorWidget imports the whole cluster back.

import type { DragEvent } from "react";
import {
  activeEditorPane,
  createEditorLayoutStateV2,
  editorLayoutOpenFiles,
  editorLayoutPaneIds,
  editorLayoutPanes,
  resolveWorkspaceFileIdentifier,
  type EditorLayoutNode,
  type EditorLayoutPaneNode,
  type EditorLayoutSplitNode,
  type EditorLayoutStateV2,
  type EditorPaneStateV2,
  type EditorSplitDirection,
} from "@oscharko-dev/keiko-contracts";

export const EDITOR_TAB_DRAG_MIME = "application/x-keiko-editor-tab";
export const MIN_SIDEBAR_WIDTH = 180;
export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MAX_SIDEBAR_WIDTH = 440;
export const MAX_EDITOR_PANES = 3;

export interface DraggedTab {
  readonly paneId: string;
  readonly file: string;
}

export interface TabInsertTarget {
  readonly paneId: string;
  readonly file: string;
  readonly edge: "before" | "after";
  readonly targetIndex: number;
}

export interface PointerTabDrag {
  readonly paneId: string;
  readonly file: string;
  readonly startX: number;
  readonly startY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  dragging: boolean;
}

export function clampNumber(value: number, min: number, max: number): number {
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
export function normalizeEditorFile(root: string, file: string | undefined): string {
  const resolution = resolveWorkspaceFileIdentifier(root, file);
  return resolution.kind === "relative" ? resolution.path : "";
}

export function normalizeEditorOpenFiles(
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

export function sameStringList(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  if (left === undefined) return right.length === 0;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function openFilesPatchValue(openFiles: readonly string[]): readonly string[] | undefined {
  return openFiles.length > 0 ? openFiles : undefined;
}

export function sanitizePaneFiles(root: string, pane: EditorPaneStateV2): EditorPaneStateV2 {
  const openFiles = normalizeEditorOpenFiles(root, pane.activeFile, pane.openFiles);
  const activeFile = normalizeEditorFile(root, pane.activeFile) || openFiles[0] || "";
  const tabOrder = normalizeEditorOpenFiles(root, activeFile, pane.tabOrder);
  return { ...pane, openFiles, activeFile, tabOrder: tabOrder.length > 0 ? tabOrder : openFiles };
}

export function sanitizeLayoutFiles(
  root: string,
  layout: EditorLayoutStateV2,
): EditorLayoutStateV2 {
  const panes: Record<string, EditorPaneStateV2> = {};
  for (const [paneId, pane] of Object.entries(layout.panes)) {
    panes[paneId] = sanitizePaneFiles(root, pane);
  }
  return { ...layout, root, panes };
}

export function layoutHasDuplicateFiles(layout: EditorLayoutStateV2): boolean {
  const seen = new Set<string>();
  for (const pane of editorLayoutPanes(layout)) {
    for (const path of pane.openFiles) {
      if (seen.has(path)) return true;
      seen.add(path);
    }
  }
  return false;
}

export function layoutHasClonedPanes(layout: EditorLayoutStateV2): boolean {
  const panes = editorLayoutPanes(layout);
  if (panes.length < 2) return false;
  const first = panes[0]?.openFiles ?? [];
  return panes.every((pane) => sameStringList(pane.openFiles, first));
}

export function createInitialLayout(input: {
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

export function createPresetPane(
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

export function paneNode(paneId: string): EditorLayoutPaneNode {
  return { type: "pane", paneId };
}

export function splitNode(
  id: string,
  direction: EditorSplitDirection,
  first: EditorLayoutNode,
  second: EditorLayoutNode,
): EditorLayoutSplitNode {
  return { type: "split", id, direction, ratio: 50, first, second };
}

export function presetTree(direction: EditorSplitDirection): EditorLayoutSplitNode {
  return splitNode("split-1", direction, paneNode("pane-1"), paneNode("pane-2"));
}

export function createDistributedPresetLayout(
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

export function createSinglePresetLayout(
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

export function dedupeLayoutFilesByActivePane(
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

export function normalizeEditorLayoutStructure(
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

export function dirtyFilesForPane(
  dirtyByPane: Readonly<Record<string, Readonly<Record<string, true>>>>,
  paneId: string,
  files: readonly string[],
): readonly string[] {
  const paneDirty = dirtyByPane[paneId] ?? {};
  return files.filter((file) => paneDirty[file] === true);
}

export function allDirtyFiles(
  dirtyByPane: Readonly<Record<string, Readonly<Record<string, true>>>>,
): readonly string[] {
  const out = new Set<string>();
  for (const paneDirty of Object.values(dirtyByPane)) {
    for (const path of Object.keys(paneDirty)) out.add(path);
  }
  return [...out];
}

export function draggedTabFromEvent(event: DragEvent<HTMLElement>): DraggedTab | null {
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

export function paneIdFromPoint(clientX: number, clientY: number): string | null {
  const target = document.elementFromPoint(clientX, clientY);
  const pane = target?.closest<HTMLElement>(".ed-pane");
  return pane?.dataset.paneId ?? null;
}

export function tabOrderWithInsertion(
  files: readonly string[],
  file: string,
  targetIndex: number,
): readonly string[] {
  const without = files.filter((entry) => entry !== file);
  const clamped = Math.min(without.length, Math.max(0, targetIndex));
  return [...without.slice(0, clamped), file, ...without.slice(clamped)];
}

interface TabNodeRect {
  readonly node: HTMLElement;
  readonly rect: DOMRect;
}

// Live tab nodes for a pane, deduped by file (a tab can render in more than one place, e.g.
// during a transition) and stripped of zero-size nodes (hidden/detached during layout thrash).
function collectPaneTabNodes(targetPaneId: string): readonly TabNodeRect[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      ".ed-tab[data-pane-id][data-tab-file], button[data-pane-id][data-tab-file]",
    ),
  )
    .filter((node) => node.dataset.paneId === targetPaneId)
    .filter((node, index, nodes) => {
      const file = node.dataset.tabFile;
      return (
        file !== undefined && nodes.findIndex((entry) => entry.dataset.tabFile === file) === index
      );
    })
    .map((node) => ({ node, rect: node.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0);
}

// Nearest candidate tab to the pointer, by center-to-pointer distance.
function closestTabNode(
  candidates: readonly TabNodeRect[],
  clientX: number,
  clientY: number,
): TabNodeRect | undefined {
  let best = candidates[0];
  for (const candidate of candidates) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    const candidateCenterX = candidate.rect.left + candidate.rect.width / 2;
    const candidateCenterY = candidate.rect.top + candidate.rect.height / 2;
    const bestCenterX = best.rect.left + best.rect.width / 2;
    const bestCenterY = best.rect.top + best.rect.height / 2;
    const candidateDistance = Math.hypot(clientX - candidateCenterX, clientY - candidateCenterY);
    const bestDistance = Math.hypot(clientX - bestCenterX, clientY - bestCenterY);
    if (candidateDistance < bestDistance) best = candidate;
  }
  return best;
}

// Index the dragged file would land at within the target pane's tab order, or null when the
// target tab is not (any longer) part of that order.
function tabInsertionIndex(
  pane: EditorPaneStateV2,
  drag: PointerTabDrag,
  targetFile: string,
  edge: "before" | "after",
): number | null {
  const targetOrder = pane.tabOrder.filter((entry) => entry !== drag.file);
  const targetFileIndex = targetOrder.indexOf(targetFile);
  if (targetFileIndex < 0) return null;
  return targetFileIndex + (edge === "after" ? 1 : 0);
}

export function tabInsertionTargetFromPoint(
  drag: PointerTabDrag,
  clientX: number,
  clientY: number,
  layout: EditorLayoutStateV2,
): TabInsertTarget | null {
  const targetPaneId = paneIdFromPoint(clientX, clientY);
  if (targetPaneId === null) return null;
  const pane = layout.panes[targetPaneId];
  if (pane === undefined || pane.tabOrder.length < 1) return null;

  const tabNodes = collectPaneTabNodes(targetPaneId);
  if (tabNodes.length === 0) return null;

  const sameRowNodes = tabNodes.filter(
    ({ rect }) => clientY >= rect.top - 10 && clientY <= rect.bottom + 10,
  );
  const candidates = sameRowNodes.length > 0 ? sameRowNodes : tabNodes;
  const best = closestTabNode(candidates, clientX, clientY);
  if (best === undefined) return null;

  const targetFile = best.node.dataset.tabFile;
  if (targetFile === undefined || targetFile === drag.file) return null;
  const edge = clientX < best.rect.left + best.rect.width / 2 ? "before" : "after";
  const targetIndex = tabInsertionIndex(pane, drag, targetFile, edge);
  if (targetIndex === null) return null;

  if (
    targetPaneId === drag.paneId &&
    tabOrderWithInsertion(pane.tabOrder, drag.file, targetIndex).join("\u0000") ===
      pane.tabOrder.join("\u0000")
  ) {
    return null;
  }

  return { paneId: targetPaneId, file: targetFile, edge, targetIndex };
}

export function remapDirtyFilesToPresetPanes(
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
