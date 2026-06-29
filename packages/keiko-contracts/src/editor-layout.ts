/**
 * Editor layout state and reducer for multi-tab, split-pane workspaces (Issue #1375, ADR-0064).
 *
 * The reducer is the single authority for layout structure: drag/keyboard intents in the UI are
 * translated into EditorLayoutActions and applied here, never by mutating pane state directly.
 * editorLayoutReducer is pure and total — it returns a structurally valid EditorLayoutStateV2 for
 * every action and returns the input state unchanged for actions that target a missing pane, split,
 * or file.
 *
 * Invariants maintained by every operation:
 *
 * 1. Tab order is stable and lossless. Within a pane openFiles and tabOrder are the same
 *    de-duplicated, non-empty list; reorder/move only permute it. The order survives a
 *    serialize -> parse round trip, so tabs never shuffle on reload (AC1).
 * 2. Layout operations never read or write file content or dirty state. Files are identified by
 *    path only, so reordering or moving a tab cannot alter a buffer or its dirty marker (AC2/AC3);
 *    the dirty index is re-homed onto the layout by the UI layer.
 * 3. Empty panes collapse predictably. Closing or moving the last tab out of a pane removes that
 *    pane (when others remain) and promotes the sibling of its enclosing split, so the tree never
 *    retains an empty pane alongside populated ones (AC4). The final remaining pane is kept even
 *    when it holds no file.
 * 4. Splits always have exactly two children and resize never restructures. resize-split only
 *    clamps an existing split's ratio into [MIN_SPLIT_RATIO, MAX_SPLIT_RATIO]; it adds or removes
 *    no pane, so nested splits resize without orphan panes or layout jumps (AC5).
 * 5. Identifiers are unique. Pane ids (pane-N) and split ids (split-N) are allocated to avoid
 *    collisions with existing nodes, and every tree pane node resolves to an entry in panes.
 * 6. Persisted values are clamped on read and write. Split ratios and the sidebar width are
 *    clamped, and unknown or malformed persisted state falls back to a fresh single-pane layout
 *    rather than blocking the editor.
 */
export const EDITOR_LAYOUT_SCHEMA_VERSION = 2 as const;

export type EditorSplitDirection = "row" | "column";
export type EditorSplitDropZone = "left" | "right" | "top" | "bottom" | "center";

export interface EditorLayoutPaneNode {
  readonly type: "pane";
  readonly paneId: string;
}

export interface EditorLayoutSplitNode {
  readonly type: "split";
  readonly id: string;
  readonly direction: EditorSplitDirection;
  readonly ratio: number;
  readonly first: EditorLayoutNode;
  readonly second: EditorLayoutNode;
}

export type EditorLayoutNode = EditorLayoutPaneNode | EditorLayoutSplitNode;

export interface EditorPaneStateV2 {
  readonly id: string;
  readonly openFiles: readonly string[];
  readonly activeFile: string;
  readonly tabOrder: readonly string[];
}

export interface EditorLayoutStateV2 {
  readonly schemaVersion: typeof EDITOR_LAYOUT_SCHEMA_VERSION;
  readonly root: string;
  readonly activePaneId: string;
  readonly tree: EditorLayoutNode;
  readonly panes: Readonly<Record<string, EditorPaneStateV2>>;
  readonly sidebarWidth: number;
  readonly sidebarCollapsed: boolean;
}

export interface EditorTabDragIntent {
  readonly file: string;
  readonly fromPaneId: string;
  readonly toPaneId: string;
  readonly zone: EditorSplitDropZone;
  readonly targetIndex?: number | undefined;
}

export type EditorLayoutAction =
  | { readonly type: "open-file"; readonly paneId: string; readonly file: string }
  | { readonly type: "select-file"; readonly paneId: string; readonly file: string }
  | { readonly type: "close-tab"; readonly paneId: string; readonly file: string }
  | { readonly type: "close-pane"; readonly paneId: string }
  | { readonly type: "set-active-pane"; readonly paneId: string }
  | {
      readonly type: "reorder-tab";
      readonly paneId: string;
      readonly file: string;
      readonly targetIndex: number;
    }
  | {
      readonly type: "move-tab";
      readonly fromPaneId: string;
      readonly toPaneId: string;
      readonly file: string;
      readonly targetIndex?: number | undefined;
    }
  | { readonly type: "drop-tab"; readonly intent: EditorTabDragIntent }
  | {
      readonly type: "split-pane";
      readonly paneId: string;
      readonly direction: EditorSplitDirection;
      readonly file?: string | undefined;
    }
  | { readonly type: "resize-split"; readonly splitId: string; readonly ratio: number }
  | {
      readonly type: "set-sidebar";
      readonly width?: number | undefined;
      readonly collapsed?: boolean | undefined;
    }
  | {
      readonly type: "replace-root";
      readonly root: string;
      readonly sidebarWidth?: number | undefined;
    }
  // A file (or folder) moved on disk: re-home its identifier across every pane so open tabs follow
  // the rename instead of going stale. `from`/`to` are matched as path prefixes so a folder rename
  // (`src` -> `lib`) carries every open descendant (`src/app.ts` -> `lib/app.ts`) with it.
  | { readonly type: "rename-file"; readonly from: string; readonly to: string }
  // A file (or folder) was deleted on disk: close it — and every open descendant — across all panes,
  // reusing the close-tab active-file fallback and empty-pane collapse so no orphaned tab survives.
  | { readonly type: "remove-file"; readonly file: string };

export interface CreateEditorLayoutStateV2Input {
  readonly root: string;
  readonly file: string;
  readonly openFiles: readonly string[];
  readonly layoutJson?: string | undefined;
  readonly defaultSidebarWidth: number;
  readonly minSidebarWidth: number;
  readonly maxSidebarWidth: number;
}

const MIN_SPLIT_RATIO = 15;
const MAX_SPLIT_RATIO = 85;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampRatio(value: number): number {
  return clampNumber(Math.round(value), MIN_SPLIT_RATIO, MAX_SPLIT_RATIO);
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0 && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function orderedFiles(
  activeFile: string,
  openFiles: readonly string[],
  tabOrder?: readonly string[],
): readonly string[] {
  const out: string[] = [];
  const add = (file: string): void => {
    if (file.length > 0 && !out.includes(file)) out.push(file);
  };
  for (const file of tabOrder ?? []) add(file);
  for (const file of openFiles) add(file);
  add(activeFile);
  return out;
}

function createPane(
  id: string,
  activeFile: string,
  openFiles: readonly string[],
): EditorPaneStateV2 {
  const tabOrder = orderedFiles(activeFile, openFiles);
  return {
    id,
    openFiles: tabOrder,
    activeFile: activeFile.length > 0 ? activeFile : (tabOrder[0] ?? ""),
    tabOrder,
  };
}

function normalizePane(value: unknown, fallbackId: string): EditorPaneStateV2 | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : fallbackId;
  const activeFile =
    typeof value.activeFile === "string"
      ? value.activeFile
      : typeof value.file === "string"
        ? value.file
        : "";
  const openFiles = stringArray(value.openFiles);
  const tabOrder = stringArray(value.tabOrder);
  const pane = createPane(id, activeFile, orderedFiles(activeFile, openFiles, tabOrder));
  return pane.openFiles.length > 0 || pane.activeFile.length > 0 ? pane : null;
}

function parseDirection(value: unknown): EditorSplitDirection {
  return value === "column" ? "column" : "row";
}

function paneIdsFromTree(node: EditorLayoutNode, out: string[] = []): string[] {
  if (node.type === "pane") {
    out.push(node.paneId);
  } else {
    paneIdsFromTree(node.first, out);
    paneIdsFromTree(node.second, out);
  }
  return out;
}

function normalizePaneNode(
  value: Record<string, unknown>,
  panes: Readonly<Record<string, EditorPaneStateV2>>,
): EditorLayoutPaneNode | null {
  if (
    value.type === "pane" &&
    typeof value.paneId === "string" &&
    panes[value.paneId] !== undefined
  ) {
    return { type: "pane", paneId: value.paneId };
  }
  return null;
}

function normalizeSplitNode(
  value: Record<string, unknown>,
  panes: Readonly<Record<string, EditorPaneStateV2>>,
): EditorLayoutSplitNode | null {
  if (value.type !== "split") return null;
  const first = normalizeTree(value.first, panes);
  const second = normalizeTree(value.second, panes);
  if (first === null || second === null) return null;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : "split-1";
  const ratio = typeof value.ratio === "number" && Number.isFinite(value.ratio) ? value.ratio : 50;
  return {
    type: "split",
    id,
    direction: parseDirection(value.direction),
    ratio: clampRatio(ratio),
    first,
    second,
  };
}

function normalizeTree(
  value: unknown,
  panes: Readonly<Record<string, EditorPaneStateV2>>,
): EditorLayoutNode | null {
  if (!isRecord(value)) return null;
  return normalizePaneNode(value, panes) ?? normalizeSplitNode(value, panes);
}

function normalizePaneRecord(value: unknown): Record<string, EditorPaneStateV2> {
  if (!isRecord(value)) return {};
  const panes: Record<string, EditorPaneStateV2> = {};
  for (const [id, rawPane] of Object.entries(value)) {
    const pane = normalizePane(rawPane, id);
    if (pane !== null) panes[pane.id] = pane;
  }
  return panes;
}

function normalizePaneList(value: unknown): readonly EditorPaneStateV2[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((pane, index) => normalizePane(pane, `pane-${String(index + 1)}`))
    .filter((pane): pane is EditorPaneStateV2 => pane !== null);
}

function persistedSidebarWidth(
  record: Record<string, unknown>,
  input: CreateEditorLayoutStateV2Input,
): number {
  return typeof record.sidebarWidth === "number" && Number.isFinite(record.sidebarWidth)
    ? clampNumber(record.sidebarWidth, input.minSidebarWidth, input.maxSidebarWidth)
    : input.defaultSidebarWidth;
}

function visiblePanesForTree(
  tree: EditorLayoutNode,
  panes: Readonly<Record<string, EditorPaneStateV2>>,
): Record<string, EditorPaneStateV2> {
  const visiblePanes: Record<string, EditorPaneStateV2> = {};
  for (const paneId of new Set(paneIdsFromTree(tree))) {
    const pane = panes[paneId];
    if (pane !== undefined) visiblePanes[paneId] = pane;
  }
  return visiblePanes;
}

function activePaneIdFromRecord(
  record: Record<string, unknown>,
  panes: Readonly<Record<string, EditorPaneStateV2>>,
  fallbackPaneId: string,
): string {
  return typeof record.activePaneId === "string" && panes[record.activePaneId] !== undefined
    ? record.activePaneId
    : fallbackPaneId;
}

function parseV2(
  root: string,
  record: Record<string, unknown>,
  input: CreateEditorLayoutStateV2Input,
): EditorLayoutStateV2 | null {
  const panes = normalizePaneRecord(record.panes);
  const firstPaneId = Object.keys(panes)[0];
  if (firstPaneId === undefined) return null;
  const tree = normalizeTree(record.tree, panes) ?? { type: "pane", paneId: firstPaneId };
  const visiblePanes = visiblePanesForTree(tree, panes);
  const fallbackPaneId = paneIdsFromTree(tree)[0] ?? firstPaneId;
  return {
    schemaVersion: EDITOR_LAYOUT_SCHEMA_VERSION,
    root,
    activePaneId: activePaneIdFromRecord(record, visiblePanes, fallbackPaneId),
    tree,
    panes: visiblePanes,
    sidebarWidth: persistedSidebarWidth(record, input),
    sidebarCollapsed: record.sidebarCollapsed === true,
  };
}

function v1Tree(
  first: EditorPaneStateV2,
  second: EditorPaneStateV2 | undefined,
  record: Record<string, unknown>,
): EditorLayoutNode {
  if (second === undefined) return { type: "pane", paneId: first.id };
  const ratio =
    typeof record.splitRatio === "number" && Number.isFinite(record.splitRatio)
      ? clampRatio(record.splitRatio)
      : 50;
  return {
    type: "split",
    id: "split-1",
    direction: parseDirection(record.direction),
    ratio,
    first: { type: "pane", paneId: first.id },
    second: { type: "pane", paneId: second.id },
  };
}

function parseV1(
  root: string,
  record: Record<string, unknown>,
  input: CreateEditorLayoutStateV2Input,
): EditorLayoutStateV2 | null {
  const panesList = normalizePaneList(record.panes);
  if (panesList.length === 0) return null;
  const panes: Record<string, EditorPaneStateV2> = {};
  for (const pane of panesList) panes[pane.id] = pane;
  const first = panesList[0];
  if (first === undefined) return null;
  const second = panesList[1];
  const tree = v1Tree(first, second, record);
  return {
    schemaVersion: EDITOR_LAYOUT_SCHEMA_VERSION,
    root,
    activePaneId: activePaneIdFromRecord(record, panes, first.id),
    tree,
    panes,
    sidebarWidth: persistedSidebarWidth(record, input),
    sidebarCollapsed: record.sidebarCollapsed === true,
  };
}

function parsePersistedLayout(input: CreateEditorLayoutStateV2Input): EditorLayoutStateV2 | null {
  if (input.layoutJson !== undefined && input.layoutJson.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(input.layoutJson);
      if (isRecord(parsed)) {
        const version = parsed.schemaVersion ?? parsed.version;
        const migrated =
          version === EDITOR_LAYOUT_SCHEMA_VERSION || version === "2"
            ? parseV2(input.root, parsed, input)
            : parseV1(input.root, parsed, input);
        if (migrated !== null) return migrated;
      }
    } catch {
      // Fall through to a fresh layout. Invalid persisted UI state must not block the editor.
    }
  }
  return null;
}

export function createEditorLayoutStateV2(
  input: CreateEditorLayoutStateV2Input,
): EditorLayoutStateV2 {
  const persisted = parsePersistedLayout(input);
  if (persisted !== null) return persisted;
  const activeFile = input.file.length > 0 ? input.file : (input.openFiles[0] ?? "");
  const pane = createPane("pane-1", activeFile, input.openFiles);
  return {
    schemaVersion: EDITOR_LAYOUT_SCHEMA_VERSION,
    root: input.root,
    activePaneId: pane.id,
    tree: { type: "pane", paneId: pane.id },
    panes: { [pane.id]: pane },
    sidebarWidth: input.defaultSidebarWidth,
    sidebarCollapsed: false,
  };
}

export function serializeEditorLayoutStateV2(layout: EditorLayoutStateV2): string {
  return JSON.stringify({
    schemaVersion: EDITOR_LAYOUT_SCHEMA_VERSION,
    root: layout.root,
    activePaneId: layout.activePaneId,
    tree: layout.tree,
    panes: layout.panes,
    sidebarWidth: Math.round(layout.sidebarWidth),
    sidebarCollapsed: layout.sidebarCollapsed,
  });
}

export function editorLayoutPaneIds(layout: EditorLayoutStateV2): readonly string[] {
  return paneIdsFromTree(layout.tree);
}

export function editorLayoutPanes(layout: EditorLayoutStateV2): readonly EditorPaneStateV2[] {
  return editorLayoutPaneIds(layout)
    .map((paneId) => layout.panes[paneId])
    .filter((pane): pane is EditorPaneStateV2 => pane !== undefined);
}

export function activeEditorPane(layout: EditorLayoutStateV2): EditorPaneStateV2 {
  return (
    layout.panes[layout.activePaneId] ??
    editorLayoutPanes(layout)[0] ??
    createPane("pane-1", "", [])
  );
}

function updatePane(
  layout: EditorLayoutStateV2,
  paneId: string,
  update: (pane: EditorPaneStateV2) => EditorPaneStateV2,
): EditorLayoutStateV2 {
  const pane = layout.panes[paneId];
  if (pane === undefined) return layout;
  return { ...layout, panes: { ...layout.panes, [paneId]: update(pane) } };
}

function withoutFile(files: readonly string[], file: string): readonly string[] {
  return files.filter((entry) => entry !== file);
}

function insertFile(files: readonly string[], file: string, index?: number): readonly string[] {
  const without = withoutFile(files, file);
  const clamped = index === undefined ? without.length : clampNumber(index, 0, without.length);
  return [...without.slice(0, clamped), file, ...without.slice(clamped)];
}

function withPaneFiles(
  pane: EditorPaneStateV2,
  files: readonly string[],
  activeFile: string,
): EditorPaneStateV2 {
  const tabOrder = orderedFiles(activeFile, files);
  return {
    ...pane,
    openFiles: tabOrder,
    tabOrder,
    activeFile: activeFile.length > 0 ? activeFile : (tabOrder[0] ?? ""),
  };
}

function nextPaneId(layout: EditorLayoutStateV2): string {
  let index = Object.keys(layout.panes).length + 1;
  while (layout.panes[`pane-${String(index)}`] !== undefined) index += 1;
  return `pane-${String(index)}`;
}

function nextSplitId(node: EditorLayoutNode): string {
  const used = new Set<string>();
  const visit = (current: EditorLayoutNode): void => {
    if (current.type === "split") {
      used.add(current.id);
      visit(current.first);
      visit(current.second);
    }
  };
  visit(node);
  let index = used.size + 1;
  while (used.has(`split-${String(index)}`)) index += 1;
  return `split-${String(index)}`;
}

function replacePaneNode(
  node: EditorLayoutNode,
  paneId: string,
  replacement: EditorLayoutNode,
): EditorLayoutNode {
  if (node.type === "pane") return node.paneId === paneId ? replacement : node;
  return {
    ...node,
    first: replacePaneNode(node.first, paneId, replacement),
    second: replacePaneNode(node.second, paneId, replacement),
  };
}

function removePaneNode(node: EditorLayoutNode, paneId: string): EditorLayoutNode | null {
  if (node.type === "pane") return node.paneId === paneId ? null : node;
  const first = removePaneNode(node.first, paneId);
  const second = removePaneNode(node.second, paneId);
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

function resizeSplitNode(node: EditorLayoutNode, splitId: string, ratio: number): EditorLayoutNode {
  if (node.type === "pane") return node;
  return {
    ...node,
    ratio: node.id === splitId ? clampRatio(ratio) : node.ratio,
    first: resizeSplitNode(node.first, splitId, ratio),
    second: resizeSplitNode(node.second, splitId, ratio),
  };
}

function splitPane(
  layout: EditorLayoutStateV2,
  paneId: string,
  direction: EditorSplitDirection,
  file: string | undefined,
  before: boolean,
): EditorLayoutStateV2 {
  const source = layout.panes[paneId];
  if (source === undefined) return layout;
  const activeFile = file ?? source.activeFile;
  if (activeFile.length === 0) return layout;
  const newPaneId = nextPaneId(layout);
  const newPane = createPane(newPaneId, activeFile, [activeFile]);
  const first: EditorLayoutPaneNode = { type: "pane", paneId: before ? newPaneId : paneId };
  const second: EditorLayoutPaneNode = { type: "pane", paneId: before ? paneId : newPaneId };
  const replacement: EditorLayoutSplitNode = {
    type: "split",
    id: nextSplitId(layout.tree),
    direction,
    ratio: 50,
    first,
    second,
  };
  return {
    ...layout,
    activePaneId: newPaneId,
    tree: replacePaneNode(layout.tree, paneId, replacement),
    panes: { ...layout.panes, [newPaneId]: newPane },
  };
}

function removePane(layout: EditorLayoutStateV2, paneId: string): EditorLayoutStateV2 {
  if (layout.panes[paneId] === undefined || editorLayoutPaneIds(layout).length <= 1) return layout;
  const nextTree = removePaneNode(layout.tree, paneId);
  if (nextTree === null) return layout;
  const panes: Record<string, EditorPaneStateV2> = {};
  for (const [id, pane] of Object.entries(layout.panes)) {
    if (id !== paneId) panes[id] = pane;
  }
  const nextActivePaneId =
    layout.activePaneId === paneId
      ? (paneIdsFromTree(nextTree)[0] ?? layout.activePaneId)
      : layout.activePaneId;
  return { ...layout, tree: nextTree, panes, activePaneId: nextActivePaneId };
}

function closeTab(layout: EditorLayoutStateV2, paneId: string, file: string): EditorLayoutStateV2 {
  const pane = layout.panes[paneId];
  if (!pane?.openFiles.includes(file)) return layout;
  const closingIndex = pane.tabOrder.indexOf(file);
  const nextFiles = withoutFile(pane.openFiles, file);
  if (nextFiles.length === 0) {
    if (editorLayoutPaneIds(layout).length > 1) return removePane(layout, paneId);
    return updatePane(layout, paneId, (current) => withPaneFiles(current, [], ""));
  }
  const nextActive =
    pane.activeFile === file
      ? (nextFiles[closingIndex] ?? nextFiles[closingIndex - 1] ?? nextFiles[0] ?? "")
      : pane.activeFile;
  return updatePane(layout, paneId, (current) => withPaneFiles(current, nextFiles, nextActive));
}

function moveTab(
  layout: EditorLayoutStateV2,
  fromPaneId: string,
  toPaneId: string,
  file: string,
  targetIndex?: number,
): EditorLayoutStateV2 {
  if (fromPaneId === toPaneId) {
    return updatePane(layout, toPaneId, (pane) =>
      withPaneFiles(pane, insertFile(pane.tabOrder, file, targetIndex), file),
    );
  }
  const fromPane = layout.panes[fromPaneId];
  const toPane = layout.panes[toPaneId];
  if (fromPane === undefined || toPane === undefined || !fromPane.openFiles.includes(file))
    return layout;
  let next = closeTab(layout, fromPaneId, file);
  if (next.panes[toPaneId] === undefined) return next;
  next = updatePane(next, toPaneId, (pane) =>
    withPaneFiles(pane, insertFile(pane.tabOrder, file, targetIndex), file),
  );
  return { ...next, activePaneId: toPaneId };
}

// Re-home one identifier under a prefix rename: an exact match becomes `to`; a descendant of the
// renamed folder keeps its suffix (`src/app.ts` under `src` -> `lib` becomes `lib/app.ts`). Any
// other path is unchanged. Folder boundaries use a trailing slash so `src` never matches `srcgen`.
function renamePathUnderPrefix(file: string, from: string, to: string): string {
  if (file === from) return to;
  return file.startsWith(`${from}/`) ? `${to}${file.slice(from.length)}` : file;
}

function dedupeFiles(files: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const file of files) {
    if (file.length > 0 && !out.includes(file)) out.push(file);
  }
  return out;
}

function renameFileInPane(pane: EditorPaneStateV2, from: string, to: string): EditorPaneStateV2 {
  const swap = (file: string): string => renamePathUnderPrefix(file, from, to);
  const openFiles = dedupeFiles(pane.openFiles.map(swap));
  const tabOrder = dedupeFiles(pane.tabOrder.map(swap));
  const activeFile = swap(pane.activeFile);
  // Nothing in this pane referenced the renamed path; leave it byte-identical so React can bail out.
  if (
    openFiles.length === pane.openFiles.length &&
    openFiles.every((file, index) => file === pane.openFiles[index]) &&
    activeFile === pane.activeFile
  ) {
    return pane;
  }
  return {
    ...pane,
    openFiles,
    tabOrder,
    activeFile: activeFile.length > 0 ? activeFile : (tabOrder[0] ?? openFiles[0] ?? ""),
  };
}

function renameFileEverywhere(
  layout: EditorLayoutStateV2,
  from: string,
  to: string,
): EditorLayoutStateV2 {
  if (from.length === 0 || to.length === 0 || from === to) return layout;
  const panes: Record<string, EditorPaneStateV2> = {};
  let changed = false;
  for (const [id, pane] of Object.entries(layout.panes)) {
    const next = renameFileInPane(pane, from, to);
    if (next !== pane) changed = true;
    panes[id] = next;
  }
  // No pane referenced the renamed path: return the original layout so React can bail out of the
  // re-render, matching the referential no-op contract of the other reducer branches.
  return changed ? { ...layout, panes } : layout;
}

function removeFileEverywhere(layout: EditorLayoutStateV2, file: string): EditorLayoutStateV2 {
  if (file.length === 0) return layout;
  // Collect every (pane, openFile) pair the delete touches up front, then fold `closeTab` over them:
  // `closeTab` already owns the active-file fallback and the single-tab pane collapse, and tolerates a
  // pane that an earlier collapse removed, so a file open in several panes is closed in each.
  const targets: (readonly [string, string])[] = [];
  for (const pane of editorLayoutPanes(layout)) {
    for (const open of pane.openFiles) {
      if (open === file || open.startsWith(`${file}/`)) targets.push([pane.id, open]);
    }
  }
  return targets.reduce((acc, [paneId, open]) => closeTab(acc, paneId, open), layout);
}

type PaneFileAction = Extract<
  EditorLayoutAction,
  { readonly type: "open-file" | "select-file" | "close-tab" | "reorder-tab" }
>;
type StructureAction = Extract<
  EditorLayoutAction,
  { readonly type: "close-pane" | "move-tab" | "drop-tab" | "split-pane" }
>;
type LayoutStateAction = Exclude<EditorLayoutAction, PaneFileAction | StructureAction>;

const PANE_FILE_ACTION_TYPES = new Set<EditorLayoutAction["type"]>([
  "open-file",
  "select-file",
  "close-tab",
  "reorder-tab",
]);
const STRUCTURE_ACTION_TYPES = new Set<EditorLayoutAction["type"]>([
  "close-pane",
  "move-tab",
  "drop-tab",
  "split-pane",
]);

function isPaneFileAction(action: EditorLayoutAction): action is PaneFileAction {
  return PANE_FILE_ACTION_TYPES.has(action.type);
}

function isStructureAction(action: EditorLayoutAction): action is StructureAction {
  return STRUCTURE_ACTION_TYPES.has(action.type);
}

function reducePaneFileAction(
  layout: EditorLayoutStateV2,
  action: PaneFileAction,
): EditorLayoutStateV2 {
  switch (action.type) {
    case "open-file":
      return updatePane(layout, action.paneId, (pane) =>
        withPaneFiles(pane, orderedFiles(action.file, pane.openFiles), action.file),
      );
    case "select-file":
      return updatePane({ ...layout, activePaneId: action.paneId }, action.paneId, (pane) =>
        pane.openFiles.includes(action.file)
          ? withPaneFiles(pane, pane.openFiles, action.file)
          : pane,
      );
    case "close-tab":
      return closeTab(layout, action.paneId, action.file);
    case "reorder-tab":
      return updatePane(layout, action.paneId, (pane) =>
        pane.openFiles.includes(action.file)
          ? withPaneFiles(
              pane,
              insertFile(pane.tabOrder, action.file, action.targetIndex),
              action.file,
            )
          : pane,
      );
  }
}

function reduceDropTab(
  layout: EditorLayoutStateV2,
  intent: EditorTabDragIntent,
): EditorLayoutStateV2 {
  if (intent.zone === "center") {
    return moveTab(layout, intent.fromPaneId, intent.toPaneId, intent.file, intent.targetIndex);
  }
  return splitPane(
    moveTab(layout, intent.fromPaneId, intent.fromPaneId, intent.file),
    intent.toPaneId,
    intent.zone === "top" || intent.zone === "bottom" ? "column" : "row",
    intent.file,
    intent.zone === "top" || intent.zone === "left",
  );
}

function reduceStructureAction(
  layout: EditorLayoutStateV2,
  action: StructureAction,
): EditorLayoutStateV2 {
  switch (action.type) {
    case "close-pane":
      return removePane(layout, action.paneId);
    case "move-tab":
      return moveTab(layout, action.fromPaneId, action.toPaneId, action.file, action.targetIndex);
    case "drop-tab":
      return reduceDropTab(layout, action.intent);
    case "split-pane":
      return splitPane(layout, action.paneId, action.direction, action.file, false);
  }
}

function replaceRoot(
  layout: EditorLayoutStateV2,
  action: Extract<LayoutStateAction, { readonly type: "replace-root" }>,
): EditorLayoutStateV2 {
  const pane = createPane("pane-1", "", []);
  return {
    schemaVersion: EDITOR_LAYOUT_SCHEMA_VERSION,
    root: action.root,
    activePaneId: pane.id,
    tree: { type: "pane", paneId: pane.id },
    panes: { [pane.id]: pane },
    sidebarWidth: action.sidebarWidth ?? layout.sidebarWidth,
    sidebarCollapsed: false,
  };
}

function reduceLayoutStateAction(
  layout: EditorLayoutStateV2,
  action: LayoutStateAction,
): EditorLayoutStateV2 {
  switch (action.type) {
    case "set-active-pane":
      return layout.panes[action.paneId] === undefined
        ? layout
        : { ...layout, activePaneId: action.paneId };
    case "resize-split":
      return { ...layout, tree: resizeSplitNode(layout.tree, action.splitId, action.ratio) };
    case "set-sidebar":
      return {
        ...layout,
        sidebarWidth: action.width ?? layout.sidebarWidth,
        sidebarCollapsed: action.collapsed ?? layout.sidebarCollapsed,
      };
    case "replace-root":
      return replaceRoot(layout, action);
    case "rename-file":
      return renameFileEverywhere(layout, action.from, action.to);
    case "remove-file":
      return removeFileEverywhere(layout, action.file);
  }
}

export function editorLayoutReducer(
  layout: EditorLayoutStateV2,
  action: EditorLayoutAction,
): EditorLayoutStateV2 {
  if (isPaneFileAction(action)) return reducePaneFileAction(layout, action);
  return isStructureAction(action)
    ? reduceStructureAction(layout, action)
    : reduceLayoutStateAction(layout, action);
}

export function editorLayoutOpenFiles(layout: EditorLayoutStateV2): readonly string[] {
  const out: string[] = [];
  for (const pane of editorLayoutPanes(layout)) {
    for (const file of pane.openFiles) {
      if (file.length > 0 && !out.includes(file)) out.push(file);
    }
  }
  return out;
}
