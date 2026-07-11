"use client";

import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { canConnect, snapMap } from "../windows/connectionUtils";
import type { SnapZone } from "../windows/connectionUtils";
import { WIN_TYPES, type WindowType } from "../windows/WindowsRegistry";
import type { AppWindow, Connection, ConnectingState, SnapPrev, View } from "../windows/types";
import { clampWorkspaceGroupOrigin } from "../windowRecovery";
import {
  activeEditorPane,
  createEditorLayoutStateV2,
  editorLayoutOpenFiles,
  editorLayoutReducer,
  isRootRelativeFileIdentifier,
  resolveWorkspaceFileIdentifier,
  serializeEditorLayoutStateV2,
} from "@oscharko-dev/keiko-contracts";
import type {
  FilesWindowContext,
  OpenEditorFileResult,
  ViewportWorld,
  WorkspaceApi,
} from "./useWorkspace.types";
import type {
  CapsuleSetId,
  KnowledgeCapsuleId,
  QualityIntelligenceFigmaSnapshotSource,
  QualityIntelligenceImageSource,
  WorkspaceUiSelectionState,
} from "@oscharko-dev/keiko-contracts";
import type { ChatConnectedScope, ChatLocalKnowledgeScope } from "@/lib/types";

const EDITOR_DEFAULT_SIDEBAR_WIDTH = 260;
const EDITOR_MIN_SIDEBAR_WIDTH = 180;
const EDITOR_MAX_SIDEBAR_WIDTH = 440;

function addPosition(
  vp: ViewportWorld,
  tW: number,
  tH: number,
  index: number,
  base: number,
): { x: number; y: number } {
  const x = vp.x + Math.max(16, Math.min(base + index * 26, vp.w - tW - 16));
  const y = vp.y + Math.max(16, Math.min(base + index * 26, vp.h - tH - 16));
  return { x, y };
}

interface MutateArgs {
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
  readonly zc: MutableRefObject<number>;
  readonly worldVP: () => ViewportWorld | null;
  readonly winsRef?: MutableRefObject<AppWindow[]>;
}

type Mutations = Pick<
  WorkspaceApi,
  | "update"
  | "focus"
  | "close"
  | "minimize"
  | "restore"
  | "maximize"
  | "add"
  | "openEditorFile"
  | "toggleTool"
>;

function normalizeEditorOpenRoot(root: string): string {
  return root.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
}

// Root-relative file-identifier contract (Issue #1374): coerce a repository reference / persisted
// cfg path into the root-relative identifier the BFF requires, keeping it UNDER `root`. Chat
// repository references use a leading-slash "from the repo root" convention (e.g.
// "/packages/x/y.ts" means "packages/x/y.ts" under the selected root) and are root-relative by
// construction, so an absolute-looking candidate that does not live under `root` has its leading
// slash stripped and is re-validated rather than reinterpreted as a different machine root. A path
// that re-includes the root is reduced to the bare remainder. Anything still not a contained file
// collapses to "" and is dropped by the callers, so a non-root-relative path can never be persisted
// into the editor window cfg or sent to the BFF.
function toRootRelativeOpenPath(root: string, value: unknown): string {
  if (typeof value !== "string") return "";
  const resolution = resolveWorkspaceFileIdentifier(root, value);
  if (resolution.kind === "relative") return resolution.path;
  if (resolution.kind === "outside-root") {
    const coerced = resolution.candidate.replace(/^\/+/u, "");
    return isRootRelativeFileIdentifier(coerced) ? coerced : "";
  }
  return "";
}

function editorCfgString(cfg: AppWindow["cfg"], key: string): string | undefined {
  const value = cfg[key];
  return typeof value === "string" ? value : undefined;
}

function mergeEditorCfgOpenFiles(
  cfg: AppWindow["cfg"],
  root: string,
  file: string,
): readonly string[] {
  const out: string[] = [];
  const add = (value: unknown): void => {
    const normalized = toRootRelativeOpenPath(root, value);
    if (normalized.length === 0 || out.includes(normalized)) return;
    out.push(normalized);
  };
  if (Array.isArray(cfg["openFiles"])) {
    for (const value of cfg["openFiles"]) add(value);
  }
  add(cfg["file"]);
  add(file);
  return out;
}

function editorOpenLayoutPatch(
  cfg: AppWindow["cfg"],
  root: string,
  file: string,
): Pick<AppWindow["cfg"], "file" | "openFiles" | "layoutJson"> {
  const currentFile = toRootRelativeOpenPath(root, editorCfgString(cfg, "file") ?? "");
  const layout = createEditorLayoutStateV2({
    root,
    file: currentFile,
    openFiles: mergeEditorCfgOpenFiles(cfg, root, file),
    layoutJson: editorCfgString(cfg, "layoutJson"),
    defaultSidebarWidth: EDITOR_DEFAULT_SIDEBAR_WIDTH,
    minSidebarWidth: EDITOR_MIN_SIDEBAR_WIDTH,
    maxSidebarWidth: EDITOR_MAX_SIDEBAR_WIDTH,
  });
  const opened = editorLayoutReducer(layout, {
    type: "open-file",
    paneId: activeEditorPane(layout).id,
    file,
  });
  return {
    file,
    openFiles: editorLayoutOpenFiles(opened),
    layoutJson: serializeEditorLayoutStateV2(opened),
  };
}

function revealCfg(
  lineStart: number | undefined,
  lineEnd: number | undefined,
): Record<string, string | number> {
  if (lineStart === undefined) return {};
  const safeStart = Math.max(1, Math.floor(lineStart));
  const safeEnd = Math.max(safeStart, Math.floor(lineEnd ?? safeStart));
  return {
    revealLineStart: safeStart,
    revealLineEnd: safeEnd,
    revealRequestId: `${Date.now().toString(36)}:${safeStart.toString()}:${safeEnd.toString()}`,
  };
}

function sameWorkspaceValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameWorkspaceValue(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    sameWorkspaceValue(
      (left as Readonly<Record<string, unknown>>)[key],
      (right as Readonly<Record<string, unknown>>)[key],
    ),
  );
}

function makeUpdate(setWins: MutateArgs["setWins"]): WorkspaceApi["update"] {
  return (id, patch) =>
    setWins((ws) => {
      if (ws === null) return ws;
      let changed = false;
      const next = ws.map((w) => {
        if (w.id !== id) return w;
        for (const [key, value] of Object.entries(patch)) {
          if (!sameWorkspaceValue(w[key as keyof AppWindow], value)) {
            changed = true;
            return { ...w, ...patch };
          }
        }
        return w;
      });
      return changed ? next : ws;
    });
}

function makeFocus(setWins: MutateArgs["setWins"], zc: MutateArgs["zc"]): WorkspaceApi["focus"] {
  return (id) =>
    setWins((ws) => {
      if (ws === null) return ws;
      const target = ws.find((w) => w.id === id);
      if (target === undefined) return ws;
      const maxZ = ws.reduce((best, w) => Math.max(best, w.z), Number.NEGATIVE_INFINITY);
      if (target.minimized !== true && target.z >= maxZ) return ws;
      zc.current = Math.max(zc.current + 1, maxZ + 1);
      return ws.map((w) => (w.id === id ? { ...w, z: zc.current } : w));
    });
}

function makeClose(setWins: MutateArgs["setWins"]): WorkspaceApi["close"] {
  return (id) =>
    setWins((ws) =>
      ws === null || !ws.some((w) => w.id === id) ? ws : ws.filter((w) => w.id !== id),
    );
}

function makeMinimize(setWins: MutateArgs["setWins"]): WorkspaceApi["minimize"] {
  return (id) =>
    setWins((ws) => {
      if (ws === null) return ws;
      let changed = false;
      const next = ws.map((w) => {
        if (w.id !== id || w.minimized === true) return w;
        changed = true;
        return { ...w, minimized: true };
      });
      return changed ? next : ws;
    });
}

function makeRestore(
  setWins: MutateArgs["setWins"],
  zc: MutateArgs["zc"],
): WorkspaceApi["restore"] {
  return (id) =>
    setWins((ws) => {
      if (ws === null) return ws;
      const target = ws.find((w) => w.id === id);
      if (target === undefined) return ws;
      const maxZ = ws.reduce((best, w) => Math.max(best, w.z), Number.NEGATIVE_INFINITY);
      if (target.minimized !== true && target.z >= maxZ) return ws;
      zc.current = Math.max(zc.current + 1, maxZ + 1);
      return ws.map((w) => (w.id === id ? { ...w, minimized: false, z: zc.current } : w));
    });
}

function fallbackRestoreGeometry(type: WindowType, vp: ViewportWorld): SnapPrev {
  const def = WIN_TYPES[type];
  const w = Math.min(def.w, Math.max(def.min.w, vp.w - 32));
  const h = Math.min(def.h, Math.max(def.min.h, vp.h - 32));
  return {
    x: vp.x + Math.max(16, Math.round((vp.w - w) / 2)),
    y: vp.y + Math.max(16, Math.round((vp.h - h) / 2)),
    w,
    h,
  };
}

function makeMaximize(args: MutateArgs): WorkspaceApi["maximize"] {
  const { setWins, zc, worldVP } = args;
  return (id) =>
    setWins((ws) => {
      if (ws === null) return ws;
      const vp = worldVP();
      if (vp === null) return ws;
      return ws.map((w) => {
        if (w.id !== id) return w;
        if (w.max) {
          const restore = w.prev ?? fallbackRestoreGeometry(w.type, vp);
          const { prev: _prev, ...rest } = w;
          void _prev;
          const restored: AppWindow = {
            ...rest,
            x: restore.x,
            y: restore.y,
            w: restore.w,
            h: restore.h,
            max: false,
            z: ++zc.current,
          };
          return restored;
        }
        return {
          ...w,
          max: true,
          prev: { x: w.x, y: w.y, w: w.w, h: w.h },
          x: vp.x,
          y: vp.y,
          w: vp.w,
          h: vp.h,
          z: ++zc.current,
        };
      });
    });
}

function makeAdd(args: MutateArgs): WorkspaceApi["add"] {
  const { setWins, zc, worldVP } = args;
  return (type, cfg) => {
    const t = WIN_TYPES[type];
    const isFigmaView =
      type === "figma" &&
      typeof cfg?.["selectedScreenIdsJson"] === "string" &&
      cfg["selectedScreenIdsJson"].length > 0;
    // GEN-DUP-NEAR-007 — source the scoped Figma-view card geometry from its registry entry
    // (WIN_TYPES.figmaView) instead of duplicating the literals here. The Math.max clamp against
    // the figma-manager type's minimums (`t`) is preserved, so the effective defaults are
    // unchanged (fv.min.w=300 → Math.max(320,300)=320; fv.min.h=260 → Math.max(360,260)=360).
    const fv = WIN_TYPES.figmaView;
    const defaultW = isFigmaView ? fv.w : t.w;
    const defaultH = isFigmaView ? fv.h : t.h;
    const defaultMinW = isFigmaView ? Math.max(t.min.w, fv.min.w) : t.min.w;
    const defaultMinH = isFigmaView ? Math.max(t.min.h, fv.min.h) : t.min.h;
    let createdId: string | null = null;
    setWins((ws) => {
      const vp = worldVP();
      if (vp === null) return ws;
      const list = ws ?? [];
      if (t.singleton === true) {
        const existing = list.find((w) => w.type === type);
        if (existing !== undefined) {
          createdId = existing.id;
          return list.map((w) =>
            w.id === existing.id
              ? {
                  ...w,
                  cfg: cfg === undefined ? w.cfg : { ...w.cfg, ...cfg },
                  minimized: false,
                  z: ++zc.current,
                }
              : w,
          );
        }
      }
      // Epic #270 — QI run cards are identified by runId: opening a run that already has a card
      // focuses it instead of stacking a duplicate (the per-run "n+1" model is per-run, not per-click).
      // Merge the incoming cfg while focusing so a restored card can receive fresh connected-source
      // handles when the user reopens it from the connected QI hub (Issue #744 drift re-check).
      const dedupeRunId = type === "qiRun" ? cfg?.["runId"] : undefined;
      if (typeof dedupeRunId === "string" && dedupeRunId.length > 0) {
        const existing = list.find((w) => w.type === "qiRun" && w.cfg["runId"] === dedupeRunId);
        if (existing !== undefined) {
          createdId = existing.id;
          return list.map((w) =>
            w.id === existing.id
              ? {
                  ...w,
                  cfg: cfg === undefined ? w.cfg : { ...w.cfg, ...cfg },
                  minimized: false,
                  z: ++zc.current,
                }
              : w,
          );
        }
      }
      const dedupeChatId = type === "chat" ? cfg?.["chatId"] : undefined;
      if (typeof dedupeChatId === "string" && dedupeChatId.length > 0) {
        const existing = list.find((w) => w.type === "chat" && w.cfg["chatId"] === dedupeChatId);
        if (existing !== undefined) {
          createdId = existing.id;
          return list.map((w) =>
            w.id === existing.id ? { ...w, minimized: false, z: ++zc.current } : w,
          );
        }
      }
      const { x, y } = addPosition(vp, defaultW, defaultH, list.length, 40);
      const id = t.singleton === true ? type : `${type}-${Date.now().toString(36)}`;
      createdId = id;
      return [
        ...list,
        {
          id,
          type,
          x,
          y,
          w: Math.max(defaultW, defaultMinW),
          h: Math.max(defaultH, defaultMinH),
          z: ++zc.current,
          cfg: cfg ?? {},
          max: false,
          zoom: 1,
        },
      ];
    });
    return createdId;
  };
}

function makeOpenEditorFile(args: MutateArgs): WorkspaceApi["openEditorFile"] {
  const { setWins, zc, worldVP, winsRef } = args;
  return ({ root, path, lineStart, lineEnd }) => {
    // Root-relative file-identifier contract (Issue #1374): a chat repository reference is opened
    // UNDER the selected root (it is root-relative by construction), so the root is kept and the
    // path is coerced to a contained root-relative identifier rather than deriving a new root.
    const normalizedRoot = normalizeEditorOpenRoot(root);
    if (normalizedRoot.length === 0) {
      return { ok: false, message: "Select a repository source before opening file references." };
    }
    const normalizedPath = toRootRelativeOpenPath(normalizedRoot, path);
    if (normalizedPath.length === 0) {
      return { ok: false, message: "This repository reference is not a valid file path." };
    }
    const vp = worldVP();
    if (vp === null) {
      return {
        ok: false,
        message: "Unable to open editor because the workspace viewport is not ready.",
      };
    }
    const reveal = revealCfg(lineStart, lineEnd);
    const currentWins = winsRef?.current ?? [];
    const existing = currentWins.find((w) => {
      if (w.type !== "editor") return false;
      const existingRoot = typeof w.cfg["root"] === "string" ? w.cfg["root"] : "";
      return normalizeEditorOpenRoot(existingRoot) === normalizedRoot;
    });
    if (existing !== undefined) {
      const targetId = existing.id;
      const result: OpenEditorFileResult = { ok: true, windowId: targetId };
      setWins((ws) => {
        if (ws === null) return ws;
        return ws.map((w) => {
          if (w.id !== targetId) return w;
          const layoutPatch = editorOpenLayoutPatch(w.cfg, normalizedRoot, normalizedPath);
          return {
            ...w,
            minimized: false,
            z: ++zc.current,
            cfg: {
              ...w.cfg,
              root: normalizedRoot,
              ...layoutPatch,
              ...reveal,
            },
          };
        });
      });
      return result;
    }
    const t = WIN_TYPES.editor;
    const { x, y } = addPosition(vp, t.w, t.h, currentWins.length, 40);
    const id = `editor-${Date.now().toString(36)}`;
    const result: OpenEditorFileResult = { ok: true, windowId: id };
    setWins((ws) => {
      const list = ws ?? [];
      return [
        ...list,
        {
          id,
          type: "editor",
          x,
          y,
          w: Math.max(t.w, t.min.w),
          h: Math.max(t.h, t.min.h),
          z: ++zc.current,
          cfg: {
            root: normalizedRoot,
            file: normalizedPath,
            openFiles: [normalizedPath],
            layoutJson: serializeEditorLayoutStateV2(
              createEditorLayoutStateV2({
                root: normalizedRoot,
                file: normalizedPath,
                openFiles: [normalizedPath],
                defaultSidebarWidth: EDITOR_DEFAULT_SIDEBAR_WIDTH,
                minSidebarWidth: EDITOR_MIN_SIDEBAR_WIDTH,
                maxSidebarWidth: EDITOR_MAX_SIDEBAR_WIDTH,
              }),
            ),
            ...reveal,
          },
          max: false,
          zoom: 1,
        },
      ];
    });
    return result;
  };
}

function makeToggleTool(args: MutateArgs): WorkspaceApi["toggleTool"] {
  const { setWins, zc, worldVP } = args;
  return (type) => {
    const t = WIN_TYPES[type];
    setWins((ws) => {
      const vp = worldVP();
      if (vp === null) return ws;
      const list = ws ?? [];
      const existing = list.find((w) => w.type === type);
      if (existing !== undefined && existing.minimized === true) {
        return list.map((w) =>
          w.id === existing.id ? { ...w, minimized: false, z: ++zc.current } : w,
        );
      }
      if (existing !== undefined) {
        return list.filter((w) => w.type !== type);
      }
      const { x, y } = addPosition(vp, t.w, t.h, list.length, 28);
      return [
        ...list,
        { id: type, type, x, y, w: t.w, h: t.h, z: ++zc.current, cfg: {}, max: false, zoom: 1 },
      ];
    });
  };
}

export function makeMutations(args: MutateArgs): Mutations {
  return {
    update: makeUpdate(args.setWins),
    focus: makeFocus(args.setWins, args.zc),
    close: makeClose(args.setWins),
    minimize: makeMinimize(args.setWins),
    restore: makeRestore(args.setWins, args.zc),
    maximize: makeMaximize(args),
    add: makeAdd(args),
    openEditorFile: makeOpenEditorFile(args),
    toggleTool: makeToggleTool(args),
  };
}

export function isWorkspaceWindowSelectable(win: AppWindow): boolean {
  return win.minimized !== true && win.max !== true;
}

function selectableWindowIds(wins: readonly AppWindow[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const win of wins) {
    if (isWorkspaceWindowSelectable(win)) ids.add(win.id);
  }
  return ids;
}

export function normalizeWorkspaceSelection(
  wins: readonly AppWindow[],
  selection: WorkspaceUiSelectionState,
): WorkspaceUiSelectionState {
  const selectableIds = selectableWindowIds(wins);
  const selectedWindowIds: string[] = [];
  for (const id of selection.selectedWindowIds) {
    if (selectableIds.has(id) && !selectedWindowIds.includes(id)) selectedWindowIds.push(id);
  }
  const focusedWindowId =
    selection.focusedWindowId !== null && selectableIds.has(selection.focusedWindowId)
      ? selection.focusedWindowId
      : null;
  if (
    focusedWindowId === selection.focusedWindowId &&
    selectedWindowIds.length === selection.selectedWindowIds.length &&
    selectedWindowIds.every((id, index) => id === selection.selectedWindowIds[index])
  ) {
    return selection;
  }
  return { focusedWindowId, selectedWindowIds };
}

export function replaceWorkspaceSelection(
  wins: readonly AppWindow[],
  windowIds: readonly string[],
): WorkspaceUiSelectionState {
  return normalizeWorkspaceSelection(wins, {
    focusedWindowId: windowIds[windowIds.length - 1] ?? null,
    selectedWindowIds: windowIds,
  });
}

export function toggleWorkspaceSelection(
  wins: readonly AppWindow[],
  selection: WorkspaceUiSelectionState,
  windowId: string,
): WorkspaceUiSelectionState {
  const selectableIds = selectableWindowIds(wins);
  if (!selectableIds.has(windowId)) return normalizeWorkspaceSelection(wins, selection);
  const selected = selection.selectedWindowIds.includes(windowId)
    ? selection.selectedWindowIds.filter((id) => id !== windowId)
    : [...selection.selectedWindowIds, windowId];
  return normalizeWorkspaceSelection(wins, {
    focusedWindowId: windowId,
    selectedWindowIds: selected,
  });
}

function selectedMoveTargets(
  wins: readonly AppWindow[],
  selectedWindowIds: readonly string[],
): readonly AppWindow[] {
  const selected = new Set(selectedWindowIds);
  return wins.filter((win) => selected.has(win.id) && isWorkspaceWindowSelectable(win));
}

function selectedWindowBounds(targets: readonly AppWindow[]): {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
} | null {
  if (targets.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const win of targets) {
    minX = Math.min(minX, win.x);
    minY = Math.min(minY, win.y);
    maxX = Math.max(maxX, win.x + win.w);
    maxY = Math.max(maxY, win.y + win.h);
  }
  return { minX, minY, maxX, maxY };
}

function clampSelectionDelta(
  bounds: NonNullable<ReturnType<typeof selectedWindowBounds>>,
  delta: { readonly dx: number; readonly dy: number },
  viewport: ViewportWorld,
): { readonly dx: number; readonly dy: number } {
  const clamped = clampWorkspaceGroupOrigin(
    {
      ...bounds,
      minX: bounds.minX + delta.dx,
      minY: bounds.minY + delta.dy,
      maxX: bounds.maxX + delta.dx,
      maxY: bounds.maxY + delta.dy,
    },
    viewport,
  );
  const clampedX = clamped.x;
  const clampedY = clamped.y;
  return { dx: clampedX - bounds.minX, dy: clampedY - bounds.minY };
}

export interface MoveSelectedWorkspaceWindowsResult {
  readonly wins: readonly AppWindow[];
  readonly appliedDelta: { readonly dx: number; readonly dy: number };
}

function unchangedSelectionMove(wins: readonly AppWindow[]): MoveSelectedWorkspaceWindowsResult {
  return { wins, appliedDelta: { dx: 0, dy: 0 } };
}

export function moveSelectedWorkspaceWindows(
  wins: readonly AppWindow[],
  selectedWindowIds: readonly string[],
  delta: { readonly dx: number; readonly dy: number },
  viewport: ViewportWorld,
): MoveSelectedWorkspaceWindowsResult {
  if (!Number.isFinite(delta.dx) || !Number.isFinite(delta.dy)) return unchangedSelectionMove(wins);
  if (delta.dx === 0 && delta.dy === 0) return unchangedSelectionMove(wins);
  const targets = selectedMoveTargets(wins, selectedWindowIds);
  const bounds = selectedWindowBounds(targets);
  if (bounds === null) return unchangedSelectionMove(wins);
  const clamped = clampSelectionDelta(bounds, delta, viewport);
  if (clamped.dx === 0 && clamped.dy === 0) return unchangedSelectionMove(wins);
  const targetIds = new Set(targets.map((win) => win.id));
  let changed = false;
  const next = wins.map((win) => {
    if (!targetIds.has(win.id)) return win;
    changed = true;
    return { ...win, x: win.x + clamped.dx, y: win.y + clamped.dy };
  });
  return changed ? { wins: next, appliedDelta: clamped } : unchangedSelectionMove(wins);
}

interface LayoutArgs {
  readonly setWins: Dispatch<SetStateAction<AppWindow[] | null>>;
  readonly worldVP: () => ViewportWorld | null;
}

function stripPrev(w: AppWindow): Omit<AppWindow, "prev"> {
  const { prev: _, ...rest } = w;
  void _;
  return rest;
}

function hasPrev(w: AppWindow): boolean {
  return "prev" in w;
}

function hasLayoutGeometry(w: AppWindow, next: Pick<AppWindow, "x" | "y" | "w" | "h">): boolean {
  return w.x === next.x && w.y === next.y && w.w === next.w && w.h === next.h;
}

function makeTileAll({ setWins, worldVP }: LayoutArgs): WorkspaceApi["tileAll"] {
  return () =>
    setWins((ws) => {
      if (ws === null || ws.length === 0) return ws;
      const vp = worldVP();
      if (vp === null) return ws;
      const n = ws.length;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const g = 12;
      const cw = (vp.w - g * (cols + 1)) / cols;
      const ch = (vp.h - g * (rows + 1)) / rows;
      let changed = false;
      const next = ws.map((w, i) => {
        const c = i % cols;
        const rr = Math.floor(i / cols);
        const geometry = {
          x: vp.x + g + c * (cw + g),
          y: vp.y + g + rr * (ch + g),
          w: cw,
          h: ch,
        };
        if (
          w.max === false &&
          w.minimized === false &&
          !hasPrev(w) &&
          hasLayoutGeometry(w, geometry)
        ) {
          return w;
        }
        changed = true;
        return {
          ...stripPrev(w),
          max: false,
          minimized: false,
          ...geometry,
        };
      });
      return changed ? next : ws;
    });
}

function makeSplitFront({ setWins, worldVP }: LayoutArgs): WorkspaceApi["splitFront"] {
  return () =>
    setWins((ws) => {
      if (ws === null || ws.length === 0) return ws;
      const vp = worldVP();
      if (vp === null) return ws;
      const ids = [...ws]
        .filter((w) => w.minimized !== true)
        .sort((a, b) => b.z - a.z)
        .slice(0, 2)
        .map((s) => s.id);
      if (ids.length < 2) return ws;
      let changed = false;
      const next = ws.map((w) => {
        const i = ids.indexOf(w.id);
        if (i === 0) {
          const geometry = {
            x: vp.x,
            y: vp.y,
            w: vp.w / 2,
            h: vp.h,
          };
          if (
            w.max === false &&
            w.minimized === false &&
            !hasPrev(w) &&
            hasLayoutGeometry(w, geometry)
          ) {
            return w;
          }
          changed = true;
          return {
            ...stripPrev(w),
            max: false,
            minimized: false,
            ...geometry,
          };
        }
        if (i === 1) {
          const geometry = {
            x: vp.x + vp.w / 2,
            y: vp.y,
            w: vp.w / 2,
            h: vp.h,
          };
          if (
            w.max === false &&
            w.minimized === false &&
            !hasPrev(w) &&
            hasLayoutGeometry(w, geometry)
          ) {
            return w;
          }
          changed = true;
          return {
            ...stripPrev(w),
            max: false,
            minimized: false,
            ...geometry,
          };
        }
        return w;
      });
      return changed ? next : ws;
    });
}

function makeCascade({ setWins, worldVP }: LayoutArgs): WorkspaceApi["cascade"] {
  return () =>
    setWins((ws) => {
      if (ws === null) return ws;
      const vp = worldVP();
      if (vp === null) return ws;
      return ws.map((w, i) => ({
        ...stripPrev(w),
        max: false,
        minimized: false,
        x: vp.x + 24 + i * 30,
        y: vp.y + 24 + i * 30,
        w: Math.min(560, vp.w - 80),
        h: Math.min(420, vp.h - 80),
        z: i + 1,
      }));
    });
}

export function makeLayoutActions(
  args: LayoutArgs,
): Pick<WorkspaceApi, "tileAll" | "splitFront" | "cascade"> {
  return {
    tileAll: makeTileAll(args),
    splitFront: makeSplitFront(args),
    cascade: makeCascade(args),
  };
}

interface SnapArgs {
  readonly setSnapPrev: Dispatch<SetStateAction<SnapPrev | null>>;
  readonly snapZone: MutableRefObject<SnapZone | null>;
  readonly worldVP: () => ViewportWorld | null;
  readonly update: WorkspaceApi["update"];
}

export function makeSnapActions({
  setSnapPrev,
  snapZone,
  worldVP,
  update,
}: SnapArgs): Pick<WorkspaceApi, "setSnap" | "commitSnap"> {
  const setSnap: WorkspaceApi["setSnap"] = (zone) => {
    snapZone.current = zone;
    if (zone === null) {
      setSnapPrev(null);
      return;
    }
    const vp = worldVP();
    if (vp === null) return;
    setSnapPrev(snapMap(vp)[zone]);
  };
  const commitSnap: WorkspaceApi["commitSnap"] = (id) => {
    const zone = snapZone.current;
    snapZone.current = null;
    setSnapPrev(null);
    if (zone === null) return;
    const vp = worldVP();
    if (vp === null) return;
    const target = snapMap(vp)[zone];
    const patch: Partial<AppWindow> = { ...target, max: zone === "maxi" };
    if (zone === "maxi") {
      (patch as { prev: { x: number; y: number; w: number; h: number } }).prev = {
        x: vp.x + 40,
        y: vp.y + 40,
        w: 480,
        h: 360,
      };
    }
    update(id, patch);
  };
  return { setSnap, commitSnap };
}

interface ConnectArgs {
  readonly wsRef: RefObject<HTMLElement | null>;
  readonly viewRef: MutableRefObject<View>;
  readonly winsRef: MutableRefObject<AppWindow[]>;
  readonly connsRef: MutableRefObject<Connection[]>;
  readonly winsByIdRef?: MutableRefObject<ReadonlyMap<string, AppWindow>> | undefined;
  readonly connsByIdRef?: MutableRefObject<ReadonlyMap<string, Connection>> | undefined;
  readonly connsByEndpointRef?:
    MutableRefObject<ReadonlyMap<string, readonly Connection[]>> | undefined;
  readonly connectingRef: MutableRefObject<ConnectingState | null>;
  readonly connectCleanupRef: MutableRefObject<(() => void) | null>;
  readonly focus: WorkspaceApi["focus"];
  readonly setConns: Dispatch<SetStateAction<Connection[]>>;
  readonly setConnecting: Dispatch<SetStateAction<ConnectingState | null>>;
  // Epic #532 — invoked when a Files↔Chat relationship edge is created/removed, with the Files
  // window's resolved absolute root. The composition root (AppShell) binds it to the active chat's
  // connectedScopes so the relationship gesture actually grounds the chat against the folder.
  // Release 0.2.0 — the bind callback returns whether the bind was ACCEPTED; `false` (e.g. the
  // per-chat source limit is reached) vetoes the edge so no dangling ungrounded edge is drawn.
  readonly onScopeBind?:
    ((chatWindowId: string, scope: ChatConnectedScope) => boolean | Promise<boolean>) | undefined;
  readonly onScopeUnbind?: ((chatWindowId: string, scope: ChatConnectedScope) => void) | undefined;
  // Epic #189 Slice 3 M3 — invoked when a Connector↔Chat relationship edge is created/removed,
  // with the selected ChatLocalKnowledgeScope from the connector window's cfg. The composition
  // root (AppShell) appends/removes it from the active chat's localKnowledgeScopes.
  readonly onConnectorBind?:
    | ((chatWindowId: string, scope: ChatLocalKnowledgeScope) => boolean | Promise<boolean>)
    | undefined;
  readonly onConnectorUnbind?:
    ((chatWindowId: string, scope: ChatLocalKnowledgeScope) => void) | undefined;
}

function isDuplicate(cs: readonly Connection[], a: string, b: string): boolean {
  return cs.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));
}

function chatWindowIdInPair(a: AppWindow | undefined, b: AppWindow | undefined): string | null {
  if (a?.type === "chat") return a.id;
  if (b?.type === "chat") return b.id;
  return null;
}

type ConnectApi = Omit<
  Pick<
    WorkspaceApi,
    | "startConnect"
    | "confirmConnect"
    | "cancelConnect"
    | "removeConn"
    | "connect"
    | "linkedFilesRoot"
    | "linkedFilesContext"
    | "linkedAllFilesRoots"
    | "linkedConnectorCapsuleIds"
    | "linkedConnectorCapsuleSetIds"
    | "linkedFigmaSnapshotRunIds"
    | "linkedFigmaSnapshotSources"
    | "linkedImageSources"
    | "currentFilesContext"
  >,
  "linkedFigmaSnapshotSources" | "linkedImageSources"
> & {
  readonly linkedFigmaSnapshotSources: NonNullable<WorkspaceApi["linkedFigmaSnapshotSources"]>;
  readonly linkedImageSources: NonNullable<WorkspaceApi["linkedImageSources"]>;
};

// Click-to-Connect flow (replaces the old pointerdown→drag→pointerup gesture):
//   1. startConnect(from): rubber-band Bezier follows the cursor live
//   2. confirmConnect(to): clicks on a valid target window snap the link in
//   3. cancelConnect(): ESC, background click, or same-port re-click cancel
// Synchronous reads of the live connecting state go through connectingRef so
// confirmConnect (fired from a child component) sees the latest source.
export function makeConnectActions(args: ConnectArgs): ConnectApi {
  const {
    wsRef,
    viewRef,
    winsRef,
    connsRef,
    winsByIdRef,
    connsByIdRef,
    connsByEndpointRef,
    connectingRef,
    connectCleanupRef,
    focus,
    setConns,
    setConnecting,
    onScopeBind,
    onScopeUnbind,
    onConnectorBind,
    onConnectorUnbind,
  } = args;

  const winById = (id: string): AppWindow | undefined =>
    winsByIdRef?.current.get(id) ?? winsRef.current.find((w) => w.id === id);
  const connById = (id: string): Connection | undefined =>
    connsByIdRef?.current.get(id) ?? connsRef.current.find((c) => c.id === id);
  const connectionsFor = (id: string): readonly Connection[] =>
    connsByEndpointRef?.current.get(id) ?? connsRef.current.filter((c) => c.a === id || c.b === id);

  const cancelConnect: WorkspaceApi["cancelConnect"] = () => {
    if (connectCleanupRef.current !== null) {
      connectCleanupRef.current();
      connectCleanupRef.current = null;
    }
    connectingRef.current = null;
    setConnecting(null);
  };

  const confirmConnect: WorkspaceApi["confirmConnect"] = (toId, e) => {
    e.preventDefault();
    e.stopPropagation();
    const c = connectingRef.current;
    if (c === null) return;
    const from = winById(c.from);
    const to = winById(toId);
    if (from !== undefined && to !== undefined && canConnect(from.type, to.type)) {
      // Epic #532 — a Files↔Chat edge also binds the folder to the chat's connectedScopes so the
      // relationship gesture grounds the chat. Epic #189 Slice 3 M3 — a Connector↔Chat edge binds
      // the selected connector scope to the chat's localKnowledgeScopes. Both are no-ops for any
      // other window pairing. Release 0.2.0 — the bind callback now VETOES the edge: when the
      // source limit rejects the bind, drawing the edge anyway would show a connection that does
      // not ground anything (dangling-edge inconsistency).
      const boundScope = filesChatBindScope(from, to, Date.now());
      const connectorScope = boundScope === null ? connectorChatBind(from, to) : null;
      const chatWindowId =
        boundScope !== null || connectorScope !== null ? chatWindowIdInPair(from, to) : null;
      let accepted: boolean | Promise<boolean>;
      try {
        accepted =
          boundScope !== null && chatWindowId !== null
            ? (onScopeBind?.(chatWindowId, boundScope) ?? true)
            : connectorScope !== null
              ? chatWindowId !== null
                ? (onConnectorBind?.(chatWindowId, connectorScope) ?? true)
                : false
              : true;
      } catch {
        accepted = false;
      }
      void Promise.resolve(accepted)
        .then((wasAccepted) => {
          if (!wasAccepted) return;
          const stillLive = winById(c.from) !== undefined && winById(toId) !== undefined;
          if (!stillLive) return;
          // Snapshot WHAT the edge bound at bind time. Unbind paths (removeConn / close teardown)
          // must use this snapshot: re-deriving from the window's current cfg unbinds the wrong
          // source after the user navigated the Files window or re-selected another capsule.
          setConns((cs) =>
            isDuplicate(cs, c.from, toId)
              ? cs
              : [
                  ...cs,
                  {
                    id: `${c.from}~${toId}`,
                    a: c.from,
                    b: toId,
                    ...(chatWindowId !== null ? { boundChatWindowId: chatWindowId } : {}),
                    ...(boundScope !== null
                      ? {
                          boundRoot: boundScope.root,
                          boundScopeKind: boundScope.kind,
                          boundRelativePath: boundScope.relativePaths[0],
                        }
                      : {}),
                    ...(connectorScope !== null
                      ? connectorScope.kind === "capsule"
                        ? {
                            boundConnectorKind: "capsule" as const,
                            boundConnectorId: connectorScope.capsuleId as string,
                          }
                        : {
                            boundConnectorKind: "capsule-set" as const,
                            boundConnectorId: connectorScope.capsuleSetId as string,
                          }
                      : {}),
                  },
                ],
          );
          focus(toId);
        })
        .catch(() => undefined);
    }
    cancelConnect();
  };

  const startConnect: WorkspaceApi["startConnect"] = (fromId, e) => {
    e.preventDefault();
    e.stopPropagation();
    // Toggle: clicking the same source port a second time cancels.
    if (connectingRef.current !== null && connectingRef.current.from === fromId) {
      cancelConnect();
      return;
    }
    const el = wsRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const v = viewRef.current;
    const toWX = (cx: number): number => (cx - r.left - v.x) / v.zoom;
    const toWY = (cy: number): number => (cy - r.top - v.y) / v.zoom;
    // Defensive: a previous flow's listener could still be live (e.g. user
    // clicks a different port without first cancelling). Drop it cleanly.
    if (connectCleanupRef.current !== null) {
      connectCleanupRef.current();
      connectCleanupRef.current = null;
    }
    const initial: ConnectingState = { from: fromId, x: toWX(e.clientX), y: toWY(e.clientY) };
    connectingRef.current = initial;
    setConnecting(initial);
    let latestMove: PointerEvent | null = null;
    let frame: number | null = null;
    const flushMove = (): void => {
      frame = null;
      const ev = latestMove;
      if (ev === null) return;
      const next: ConnectingState = { from: fromId, x: toWX(ev.clientX), y: toWY(ev.clientY) };
      connectingRef.current = next;
      setConnecting(next);
    };
    const move = (ev: PointerEvent): void => {
      latestMove = ev;
      if (frame !== null) return;
      frame = window.requestAnimationFrame(flushMove);
    };
    window.addEventListener("pointermove", move);
    connectCleanupRef.current = (): void => {
      window.removeEventListener("pointermove", move);
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
    };
  };

  const removeConn: WorkspaceApi["removeConn"] = (id) => {
    // Epic #532 — if the removed edge was a Files↔Chat binding, unbind that folder from the chat.
    // Epic #189 Slice 3 M3 — if the removed edge was a Connector↔Chat binding, unbind that scope.
    // Release 0.2.0 — prefer the bind-time snapshot stored on the Connection: the window's
    // current cfg may have moved on (Files window navigated elsewhere, another capsule selected),
    // and re-deriving from it would unbind the WRONG source. Falls back to cfg-derivation for
    // edges persisted before the snapshot fields existed.
    const conn = connById(id);
    setConns((cs) => cs.filter((c) => c.id !== id));
    if (conn === undefined) return;
    const a = winById(conn.a);
    const b = winById(conn.b);
    const bothLive = a !== undefined && b !== undefined;
    const chatWindowId = conn.boundChatWindowId ?? (bothLive ? chatWindowIdInPair(a, b) : null);
    const boundScope =
      boundScopeOf(conn) ??
      (conn.boundScopeElided === true || !bothLive ? null : filesChatBindScope(a, b, Date.now()));
    if (boundScope !== null && chatWindowId !== null) onScopeUnbind?.(chatWindowId, boundScope);
    const connectorScope =
      boundConnectorScopeOf(conn) ?? (bothLive ? connectorChatBind(a, b) : null);
    if (connectorScope !== null && chatWindowId !== null) {
      onConnectorUnbind?.(chatWindowId, connectorScope);
    }
  };

  const connect: WorkspaceApi["connect"] = (a, b) => {
    const left = winById(a);
    const right = winById(b);
    if (left === undefined || right === undefined || !canConnect(left.type, right.type)) return;
    setConns((cs) => (isDuplicate(cs, a, b) ? cs : [...cs, { id: `${a}~${b}`, a, b }]));
  };

  const filesContextFor = (w: AppWindow): FilesWindowContext | null => {
    if (w.type !== "files") return null;
    const resolvedRoot = w.cfg["resolvedRoot"];
    const configuredRoot = w.cfg["root"];
    const root =
      typeof resolvedRoot === "string" && resolvedRoot.length > 0
        ? resolvedRoot
        : typeof configuredRoot === "string" && configuredRoot.length > 0
          ? configuredRoot
          : null;
    // No real root available — do not fabricate a sentinel (mirrors resolvedFilesRoot).
    // Returning null prevents a spurious "Context src/" badge in the Chat header and avoids
    // forwarding a non-absolute path to the QI Generate route.
    if (root === null || !isAbsoluteRoot(root)) return null;
    const active = w.cfg["activeFilePath"];
    return {
      id: w.id,
      root,
      ...(typeof active === "string" && active.length > 0 ? { activeFilePath: active } : {}),
    };
  };

  const linkedFilesContext: WorkspaceApi["linkedFilesContext"] = (id) => {
    // Collect EVERY Files window connected to `id`. A hub can be connected to several Files windows
    // plus connector/figma windows (CONNECTABLE.quality). Skip non-files connections instead of
    // stopping at the first one — a connector/figma edge that happens to precede the files edge in
    // connection order must NOT hide a Files window connected afterwards (Issue #714).
    const filesWindows: AppWindow[] = [];
    for (const c of connectionsFor(id)) {
      const otherId = c.a === id ? c.b : c.b === id ? c.a : null;
      if (otherId === null) continue;
      const w = winById(otherId);
      if (w === undefined || w.type !== "files") continue;
      filesWindows.push(w);
    }
    if (filesWindows.length === 0) return null;
    // Prefer the most recently focused (highest-z) connected Files window that HAS a focused file, so
    // a Fachkonzept focused in ANY connected Files window — not just the first-connected — becomes the
    // single-file run source and switching focus live-updates the binding. Fall back to the highest-z
    // connected Files window when none has a focused file (folder binding, unchanged behaviour).
    const byZDesc = [...filesWindows].sort((a, b) => b.z - a.z);
    const focused = byZDesc.find((w) => {
      const active = w.cfg["activeFilePath"];
      return typeof active === "string" && active.length > 0;
    });
    const chosen = focused ?? byZDesc[0];
    return chosen === undefined ? null : filesContextFor(chosen);
  };

  const linkedFilesRoot: WorkspaceApi["linkedFilesRoot"] = (id) =>
    linkedFilesContext(id)?.root ?? null;

  const linkedAllFilesRoots: WorkspaceApi["linkedAllFilesRoots"] = (id) => {
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const c of connectionsFor(id)) {
      if (roots.length >= MAX_SCOPES) break;
      const otherId = c.a === id ? c.b : c.b === id ? c.a : null;
      if (otherId === null) continue;
      const w = winById(otherId);
      if (w === undefined) continue;
      const root = resolvedFilesRoot(w);
      if (root === null || seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
    }
    return roots;
  };

  const currentFilesContext: WorkspaceApi["currentFilesContext"] = () => {
    let onlyContext: FilesWindowContext | null = null;
    let contextCount = 0;
    let topFilesWindow: AppWindow | null = null;
    for (const w of winsRef.current) {
      if (w.type !== "files") continue;
      const ctx = filesContextFor(w);
      if (ctx !== null) {
        contextCount += 1;
        onlyContext = ctx;
      }
      if (topFilesWindow === null || w.z > topFilesWindow.z) topFilesWindow = w;
    }
    if (contextCount === 1) return onlyContext;
    return topFilesWindow === null ? null : filesContextFor(topFilesWindow);
  };

  // Epic #710 #718 — read the selected id of the given kind ("capsule" or "capsule-set") from
  // every connected Connector window, deduped and capped at MAX_SCOPES. Both QI capsule and
  // capsule-set sources flow through this one reader so the hub can bind either (Issue #716/#718).
  const linkedConnectorSelectionIds = (id: string, selectedKind: string): readonly string[] => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const c of connectionsFor(id)) {
      if (ids.length >= MAX_SCOPES) break;
      const otherId = c.a === id ? c.b : c.b === id ? c.a : null;
      if (otherId === null) continue;
      const w = winById(otherId);
      if (w === undefined || w.type !== "connector") continue;
      if (w.cfg["selectedKind"] !== selectedKind) continue;
      const selectedId = w.cfg["selectedId"];
      // Skip a missing, empty, OR whitespace-only selectedId. The server trims before validating and
      // rejects a blank capsule id with QI_BAD_REQUEST (400); treating a whitespace-only id as "no
      // selection" here keeps the binding a silent skip (parity with the server guard) instead of
      // surfacing an unhelpful 400 on Generate.
      if (typeof selectedId !== "string" || selectedId.trim().length === 0) continue;
      if (seen.has(selectedId)) continue;
      seen.add(selectedId);
      ids.push(selectedId);
    }
    return ids;
  };

  const linkedConnectorCapsuleIds: WorkspaceApi["linkedConnectorCapsuleIds"] = (id) =>
    linkedConnectorSelectionIds(id, "capsule");

  const linkedConnectorCapsuleSetIds: WorkspaceApi["linkedConnectorCapsuleSetIds"] = (id) =>
    linkedConnectorSelectionIds(id, "capsule-set");

  // Epic #750 #756 — legacy fallback for whole-snapshot sources. Scoped Figma View/JSON windows
  // are exposed through linkedFigmaSnapshotSources so they cannot be widened to a whole snapshot.
  // Deduped and capped at MAX_SCOPES, matching the connector capsule reader above — including its
  // whitespace-only skip: a blank run id would be rejected server-side, so treat it as "no selection"
  // and skip it rather than emit an unusable figma-snapshot source on Generate.
  const linkedFigmaSnapshotRunIds: WorkspaceApi["linkedFigmaSnapshotRunIds"] = (id) => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const c of connectionsFor(id)) {
      if (ids.length >= MAX_SCOPES) break;
      const otherId = c.a === id ? c.b : c.b === id ? c.a : null;
      if (otherId === null) continue;
      const w = winById(otherId);
      if (w === undefined || w.type !== "figma") continue;
      const runId = w.cfg["snapshotRunId"];
      if (typeof runId !== "string" || runId.trim().length === 0) continue;
      if (seen.has(runId)) continue;
      seen.add(runId);
      ids.push(runId);
    }
    return ids;
  };

  const parseSelectedScreenIds = (raw: unknown): readonly string[] => {
    if (typeof raw !== "string" || raw.trim().length === 0) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Trim → drop empties → dedupe → sort so the scope is canonical: two windows that selected the
      // same screens in a different order (or with duplicates) dedupe to one source, and the server
      // envelope id derived from the scope is stable.
      const cleaned = parsed
        .filter((value): value is string => typeof value === "string" && value.trim() !== "")
        .map((value) => value.trim());
      return [...new Set(cleaned)].sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  };

  const selectedScreenIdsForFigmaWindow = (w: AppWindow): readonly string[] => {
    const parsed = parseSelectedScreenIds(w.cfg["selectedScreenIdsJson"]);
    if (parsed.length > 0) return parsed;
    const screenId = w.cfg["screenId"];
    return typeof screenId === "string" && screenId.trim().length > 0 ? [screenId.trim()] : [];
  };

  const linkedFigmaSnapshotSources: NonNullable<WorkspaceApi["linkedFigmaSnapshotSources"]> = (
    id,
  ) => {
    const seen = new Set<string>();
    const sources: QualityIntelligenceFigmaSnapshotSource[] = [];
    for (const c of connectionsFor(id)) {
      if (sources.length >= MAX_SCOPES) break;
      const otherId = c.a === id ? c.b : c.b === id ? c.a : null;
      if (otherId === null) continue;
      const w = winById(otherId);
      if (
        w === undefined ||
        (w.type !== "figma" && w.type !== "figmaView" && w.type !== "figmaJson")
      ) {
        continue;
      }
      const runId = w.cfg["snapshotRunId"];
      if (typeof runId !== "string" || runId.trim().length === 0) continue;
      const rawScreenIdsJson = w.cfg["selectedScreenIdsJson"];
      const screenName = w.cfg["selectedScreenName"];
      const screenIds = selectedScreenIdsForFigmaWindow(w);
      // A figmaView/figmaJson window is SCOPED — it carries selectedScreenIdsJson and/or
      // selectedScreenName. If such a window's scope cannot be resolved (missing, corrupt, or
      // over-cap persisted JSON the persistence layer dropped on reload), it must contribute NOTHING —
      // never silently widen to the whole board. Only a genuinely unscoped figma window (no scope
      // marker at all) ingests the full snapshot. This is the UI half of the no-leak guarantee; the
      // server enforces the same invariant on the wire.
      const isScopedWindow =
        w.type === "figmaJson" ||
        w.type === "figmaView" ||
        rawScreenIdsJson !== undefined ||
        (typeof screenName === "string" && screenName.trim().length > 0);
      if (isScopedWindow && screenIds.length === 0) continue;
      const key = `${runId}:${screenIds.join(",") || "*"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label =
        screenIds.length > 0 && typeof screenName === "string" && screenName.trim().length > 0
          ? w.type === "figmaJson"
            ? `JSON · ${screenName}`
            : screenName
          : runId;
      sources.push({
        kind: "figma-snapshot",
        label,
        snapshotRunId: runId,
        ...(screenIds.length > 0 ? { screenIds } : {}),
      });
    }
    return sources;
  };

  const linkedImageSources: NonNullable<WorkspaceApi["linkedImageSources"]> = (id) => {
    const seen = new Set<string>();
    const sources: QualityIntelligenceImageSource[] = [];
    for (const c of connectionsFor(id)) {
      if (sources.length >= MAX_SCOPES) break;
      const otherId = c.a === id ? c.b : c.b === id ? c.a : null;
      if (otherId === null) continue;
      const w = winById(otherId);
      if (w === undefined || w.type !== "figmaImage") continue;
      const runId = w.cfg["snapshotRunId"];
      const screenId = w.cfg["screenId"];
      if (typeof runId !== "string" || runId.trim().length === 0) continue;
      if (typeof screenId !== "string" || screenId.trim().length === 0) continue;
      const key = `${runId}:${screenId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const screenName = w.cfg["selectedScreenName"];
      const label =
        typeof screenName === "string" && screenName.trim().length > 0
          ? `Image · ${screenName}`
          : `Image · ${screenId}`;
      sources.push({
        kind: "image",
        label,
        sourceKind: "figma-snapshot-screen",
        snapshotRunId: runId,
        screenId,
      });
    }
    return sources;
  };

  return {
    startConnect,
    confirmConnect,
    cancelConnect,
    removeConn,
    connect,
    linkedFilesRoot,
    linkedFilesContext,
    linkedAllFilesRoots,
    linkedConnectorCapsuleIds,
    linkedConnectorCapsuleSetIds,
    linkedFigmaSnapshotRunIds,
    linkedFigmaSnapshotSources,
    linkedImageSources,
    currentFilesContext,
  };
}

// Re-exports for callers that need the lower-level type
export type { WindowType };

// ─── M3 (#532) pure scope-list helpers (exported for tests) ─────────────────

export const MAX_SCOPES = 16;

/** True when `root` is a non-empty absolute POSIX or Windows path. */
function isAbsoluteRoot(root: string): boolean {
  return root.length > 0 && (root.startsWith("/") || /^[A-Za-z]:[/\\]/u.test(root));
}

/**
 * Strips trailing path separators from an absolute root, normalising Windows backslashes to
 * forward slashes. Windows drive roots ("C:/") are kept intact — trimming them would produce
 * an invalid path. Mirrors the trimTrailingSeparators() logic in connectedSources.ts so that
 * dedup comparisons in appendScope are resilient to trailing-slash differences.
 */
function normaliseRoot(root: string): string {
  // Windows drive root: keep the trailing slash that follows the colon (C:/ or C:\).
  if (/^[A-Za-z]:[/\\]?$/u.test(root)) return root.replace(/\\/gu, "/");
  return root.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

/**
 * Resolves the real absolute root of a Files window.
 * Returns null when only the "src" sentinel fallback would apply — the spec
 * says we must NOT bind that fallback as a connectedScope.
 */
export function resolvedFilesRoot(w: AppWindow): string | null {
  if (w.type !== "files") return null;
  const resolvedRoot = w.cfg["resolvedRoot"];
  const configuredRoot = w.cfg["root"];
  const root =
    typeof resolvedRoot === "string" && resolvedRoot.length > 0
      ? resolvedRoot
      : typeof configuredRoot === "string" && configuredRoot.length > 0
        ? configuredRoot
        : null;
  return root !== null && isAbsoluteRoot(root) ? root : null;
}

function normaliseRelativePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
}

function scopeMatches(a: ChatConnectedScope, b: ChatConnectedScope): boolean {
  if (a.root === undefined || b.root === undefined) return false;
  if (normaliseRoot(a.root) !== normaliseRoot(b.root)) return false;
  if (a.kind !== b.kind) return false;
  if (a.relativePaths.length !== b.relativePaths.length) return false;
  return a.relativePaths.every(
    (path, index) =>
      normaliseRelativePath(path) === normaliseRelativePath(b.relativePaths[index] ?? ""),
  );
}

export function filesVisibleScope(w: AppWindow, connectedAtMs: number): ChatConnectedScope | null {
  const root = resolvedFilesRoot(w);
  if (root === null) return null;
  const activeFile = w.cfg["activeFilePath"];
  if (typeof activeFile === "string" && activeFile.length > 0) {
    return {
      kind: "files",
      relativePaths: [normaliseRelativePath(activeFile)],
      root: normaliseRoot(root),
      connectedAtMs,
    };
  }
  const activeDirectory = w.cfg["activeDirectoryPath"];
  if (typeof activeDirectory === "string" && activeDirectory.length > 0) {
    return {
      kind: "directory",
      relativePaths: [normaliseRelativePath(activeDirectory)],
      root: normaliseRoot(root),
      connectedAtMs,
    };
  }
  return {
    kind: "workspace-root",
    relativePaths: [],
    root: normaliseRoot(root),
    connectedAtMs,
  };
}

/**
 * For a window pair, returns the Files window's resolved root when exactly one side is a Files
 * window and the other is a Chat window; otherwise null. Used to detect a Files↔Chat binding edge.
 */
export function filesChatBindRoot(a: AppWindow, b: AppWindow): string | null {
  const files = a.type === "files" ? a : b.type === "files" ? b : null;
  const chat = a.type === "chat" ? a : b.type === "chat" ? b : null;
  if (files === null || chat === null) return null;
  return resolvedFilesRoot(files);
}

export function filesChatBindScope(
  a: AppWindow,
  b: AppWindow,
  connectedAtMs: number,
): ChatConnectedScope | null {
  const files = a.type === "files" ? a : b.type === "files" ? b : null;
  const chat = a.type === "chat" ? a : b.type === "chat" ? b : null;
  if (files === null || chat === null) return null;
  return filesVisibleScope(files, connectedAtMs);
}

export function boundScopeOf(conn: {
  readonly boundRoot?: string;
  readonly boundScopeKind?: string;
  readonly boundRelativePath?: string;
}): ChatConnectedScope | null {
  if (typeof conn.boundRoot !== "string" || conn.boundRoot.length === 0) return null;
  const connectedAtMs = Date.now();
  if (conn.boundScopeKind === "directory") {
    if (typeof conn.boundRelativePath !== "string" || conn.boundRelativePath.length === 0) {
      return null;
    }
    return {
      kind: "directory",
      relativePaths: [normaliseRelativePath(conn.boundRelativePath)],
      root: normaliseRoot(conn.boundRoot),
      connectedAtMs,
    };
  }
  if (conn.boundScopeKind === "files") {
    if (typeof conn.boundRelativePath !== "string" || conn.boundRelativePath.length === 0) {
      return null;
    }
    return {
      kind: "files",
      relativePaths: [normaliseRelativePath(conn.boundRelativePath)],
      root: normaliseRoot(conn.boundRoot),
      connectedAtMs,
    };
  }
  return {
    kind: "workspace-root",
    relativePaths: [],
    root: normaliseRoot(conn.boundRoot),
    connectedAtMs,
  };
}

/** True when `root` (after trailing-separator normalisation) is already in the scopes list. */
export function isRootConnected(current: readonly ChatConnectedScope[], root: string): boolean {
  const normRoot = normaliseRoot(root);
  return current.some((s) => s.root !== undefined && normaliseRoot(s.root) === normRoot);
}

export function isScopeConnected(
  current: readonly ChatConnectedScope[],
  scope: ChatConnectedScope,
): boolean {
  return current.some((candidate) => scopeMatches(candidate, scope));
}

/**
 * Release 0.2.0 — the combined per-chat source cap. "Up to 16 sources" is a TOTAL across
 * folder/file/repo scopes AND knowledge-connector scopes; the cap is the larger of the two
 * per-list limits so each list's own limit stays reachable. Mirrors validateTotalSourceCap
 * in keiko-server/src/store/chats.ts — keep both in sync.
 */
export function totalSourceCap(limits: {
  readonly maxConnectedSources: number;
  readonly maxLocalKnowledgeSources: number;
}): number {
  return Math.max(limits.maxConnectedSources, limits.maxLocalKnowledgeSources);
}

/**
 * Appends a new source to the current scopes list (de-duped by root, capped at
 * `maxScopes` — defaults to MAX_SCOPES). Returns null when the root is empty/not
 * absolute (caller should surface "browse/choose a folder first"). At the cap the
 * list is returned UNCHANGED (no silent eviction of the oldest source — the 17th
 * source must be prevented, not swapped in; callers surface the limit to the user).
 */
export function appendScope(
  current: readonly ChatConnectedScope[],
  root: string,
  now: number,
  maxScopes: number = MAX_SCOPES,
): readonly ChatConnectedScope[] | null {
  // Normalise trailing separators before any check so "/foo" and "/foo/" are treated identically.
  const normRoot = normaliseRoot(root);
  if (!isAbsoluteRoot(normRoot)) return null;
  if (current.some((s) => s.root !== undefined && normaliseRoot(s.root) === normRoot))
    return current;
  if (current.length >= maxScopes) return current;
  const next: ChatConnectedScope = {
    kind: "workspace-root",
    relativePaths: [],
    root: normRoot,
    connectedAtMs: now,
  };
  return [...current, next];
}

export function appendConnectedScope(
  current: readonly ChatConnectedScope[],
  scope: ChatConnectedScope,
  maxScopes: number = MAX_SCOPES,
): readonly ChatConnectedScope[] | null {
  if (scope.root === undefined) return null;
  const root = normaliseRoot(scope.root);
  if (!isAbsoluteRoot(root)) return null;
  const relativePaths = scope.relativePaths.map(normaliseRelativePath);
  const nextScope: ChatConnectedScope = {
    kind: scope.kind,
    relativePaths,
    root,
    connectedAtMs: scope.connectedAtMs,
  };
  if (current.some((candidate) => scopeMatches(candidate, nextScope))) return current;
  if (current.length >= maxScopes) return current;
  return [...current, nextScope];
}

/**
 * Removes the source with the given root from the scopes list. Returns an
 * empty array (not null) when the list becomes empty so callers can PATCH null.
 * Compares normalised roots (trailing separators folded) so a disconnect still
 * matches when bind-time and unbind-time spellings differ (e.g. "/foo" vs "/foo/").
 */
export function removeScope(
  current: readonly ChatConnectedScope[],
  root: string,
): readonly ChatConnectedScope[] {
  const normRoot = normaliseRoot(root);
  return current.filter((s) => s.root === undefined || normaliseRoot(s.root) !== normRoot);
}

export function removeConnectedScope(
  current: readonly ChatConnectedScope[],
  scope: ChatConnectedScope,
): readonly ChatConnectedScope[] {
  return current.filter((candidate) => !scopeMatches(candidate, scope));
}

/** Canonical reader: derive effective scopes from Chat fields. */
export function effectiveScopes(chat: {
  connectedScopes?: readonly ChatConnectedScope[] | undefined;
  connectedScope?: ChatConnectedScope | undefined;
}): readonly ChatConnectedScope[] {
  return chat.connectedScopes ?? (chat.connectedScope !== undefined ? [chat.connectedScope] : []);
}

// ─── M1 (#189 Slice 3) pure connector-scope helpers (exported for tests) ─────

/**
 * Canonical reader: derive effective local-knowledge scopes from Chat fields.
 * Prefers the plural `localKnowledgeScopes` list; falls back to a 1-element list
 * from the legacy singular `localKnowledgeScope` field.
 */
export function effectiveLocalKnowledgeScopes(chat: {
  localKnowledgeScopes?: readonly ChatLocalKnowledgeScope[] | undefined;
  localKnowledgeScope?: ChatLocalKnowledgeScope | undefined;
}): readonly ChatLocalKnowledgeScope[] {
  return (
    chat.localKnowledgeScopes ??
    (chat.localKnowledgeScope !== undefined ? [chat.localKnowledgeScope] : [])
  );
}

/** Stable de-dupe key for a local-knowledge scope. */
function lkScopeKey(scope: ChatLocalKnowledgeScope): string {
  return scope.kind === "capsule" ? `capsule:${scope.capsuleId}` : `set:${scope.capsuleSetId}`;
}

/** True when the connector scope (same capsule / capsule-set) is already in the list. */
export function isConnectorScopeConnected(
  current: readonly ChatLocalKnowledgeScope[],
  scope: ChatLocalKnowledgeScope,
): boolean {
  const key = lkScopeKey(scope);
  return current.some((s) => lkScopeKey(s) === key);
}

/**
 * Appends a connector scope to the list (de-duped by capsuleId / capsuleSetId, capped at
 * `max`). Returns the same list reference when the scope is already present. At the cap
 * the list is returned UNCHANGED (no silent eviction — callers surface the limit).
 */
export function appendConnectorScope(
  current: readonly ChatLocalKnowledgeScope[],
  scope: ChatLocalKnowledgeScope,
  max: number,
): readonly ChatLocalKnowledgeScope[] {
  const key = lkScopeKey(scope);
  if (current.some((s) => lkScopeKey(s) === key)) return current;
  if (current.length >= max) return current;
  return [...current, scope];
}

/**
 * Removes the connector scope identified by `key` (e.g. `"capsule:<id>"` or
 * `"set:<id>"`) from the list. Returns an empty array when the last scope is removed.
 */
export function removeConnectorScope(
  current: readonly ChatLocalKnowledgeScope[],
  key: string,
): readonly ChatLocalKnowledgeScope[] {
  return current.filter((s) => lkScopeKey(s) !== key);
}

/**
 * Reconstructs the connector scope from a Connection's bind-time snapshot fields.
 * Returns null when the edge carries no snapshot (pre-0.2.0 persisted edges).
 * `connectedAtMs: 0` is fine — unbind paths only match on kind + id.
 */
export function boundConnectorScopeOf(conn: {
  readonly boundConnectorKind?: "capsule" | "capsule-set";
  readonly boundConnectorId?: string;
}): ChatLocalKnowledgeScope | null {
  if (typeof conn.boundConnectorId !== "string" || conn.boundConnectorId.length === 0) return null;
  if (conn.boundConnectorKind === "capsule") {
    return {
      kind: "capsule",
      capsuleId: conn.boundConnectorId as KnowledgeCapsuleId,
      connectedAtMs: 0,
    };
  }
  if (conn.boundConnectorKind === "capsule-set") {
    return {
      kind: "capsule-set",
      capsuleSetId: conn.boundConnectorId as CapsuleSetId,
      connectedAtMs: 0,
    };
  }
  return null;
}

/**
 * For a window pair, returns the connector scope extracted from the Connector
 * window's cfg when exactly one side is a `"connector"` window and the other
 * is a `"chat"` window; otherwise null.
 */
export function connectorChatBind(a: AppWindow, b: AppWindow): ChatLocalKnowledgeScope | null {
  const connector = a.type === "connector" ? a : b.type === "connector" ? b : null;
  const chatWin = a.type === "chat" ? a : b.type === "chat" ? b : null;
  if (connector === null || chatWin === null) return null;
  const kind = connector.cfg["selectedKind"];
  const id = connector.cfg["selectedId"];
  if (typeof kind !== "string" || typeof id !== "string") return null;
  const selectedId = id.trim();
  if (selectedId.length === 0) return null;
  if (kind === "capsule") {
    return {
      kind: "capsule",
      capsuleId: selectedId as KnowledgeCapsuleId,
      connectedAtMs: Date.now(),
    };
  }
  if (kind === "capsule-set") {
    return {
      kind: "capsule-set",
      capsuleSetId: selectedId as CapsuleSetId,
      connectedAtMs: Date.now(),
    };
  }
  return null;
}
