"use client";

import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { canConnect, snapMap } from "../windows/connectionUtils";
import type { SnapZone } from "../windows/connectionUtils";
import { WIN_TYPES, type WindowType } from "../windows/WindowsRegistry";
import type {
  AppWindow,
  Connection,
  ConnectingState,
  SnapPrev,
  View,
} from "../windows/types";
import type { ViewportWorld, WorkspaceApi } from "./useWorkspace.types";

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
}

type Mutations = Pick<WorkspaceApi, "update" | "focus" | "close" | "maximize" | "add" | "toggleTool">;

function makeUpdate(setWins: MutateArgs["setWins"]): WorkspaceApi["update"] {
  return (id, patch) =>
    setWins((ws) => (ws === null ? ws : ws.map((w) => (w.id === id ? { ...w, ...patch } : w))));
}

function makeFocus(setWins: MutateArgs["setWins"], zc: MutateArgs["zc"]): WorkspaceApi["focus"] {
  return (id) =>
    setWins((ws) => (ws === null ? ws : ws.map((w) => (w.id === id ? { ...w, z: ++zc.current } : w))));
}

function makeClose(setWins: MutateArgs["setWins"]): WorkspaceApi["close"] {
  return (id) => setWins((ws) => (ws === null ? ws : ws.filter((w) => w.id !== id)));
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
        if (w.max && w.prev !== undefined) {
          const restored: AppWindow = {
            ...w,
            x: w.prev.x,
            y: w.prev.y,
            w: w.prev.w,
            h: w.prev.h,
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
    setWins((ws) => {
      const vp = worldVP();
      if (vp === null) return ws;
      const list = ws ?? [];
      if (t.singleton === true) {
        const existing = list.find((w) => w.type === type);
        if (existing !== undefined) {
          return list.map((w) => (w.id === existing.id ? { ...w, z: ++zc.current } : w));
        }
      }
      const { x, y } = addPosition(vp, t.w, t.h, list.length, 40);
      const id = t.singleton === true ? type : `${type}-${Date.now().toString(36)}`;
      return [
        ...list,
        { id, type, x, y, w: t.w, h: t.h, z: ++zc.current, cfg: cfg ?? {}, max: false, zoom: 1 },
      ];
    });
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
      if (list.find((w) => w.type === type) !== undefined) {
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
    maximize: makeMaximize(args),
    add: makeAdd(args),
    toggleTool: makeToggleTool(args),
  };
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
      return ws.map((w, i) => {
        const c = i % cols;
        const rr = Math.floor(i / cols);
        return {
          ...stripPrev(w),
          max: false,
          x: vp.x + g + c * (cw + g),
          y: vp.y + g + rr * (ch + g),
          w: cw,
          h: ch,
        };
      });
    });
}

function makeSplitFront({ setWins, worldVP }: LayoutArgs): WorkspaceApi["splitFront"] {
  return () =>
    setWins((ws) => {
      if (ws === null || ws.length === 0) return ws;
      const vp = worldVP();
      if (vp === null) return ws;
      const ids = [...ws].sort((a, b) => b.z - a.z).slice(0, 2).map((s) => s.id);
      return ws.map((w) => {
        const i = ids.indexOf(w.id);
        if (i === 0) {
          return { ...stripPrev(w), max: false, x: vp.x, y: vp.y, w: vp.w / 2, h: vp.h };
        }
        if (i === 1) {
          return { ...stripPrev(w), max: false, x: vp.x + vp.w / 2, y: vp.y, w: vp.w / 2, h: vp.h };
        }
        return w;
      });
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
        x: vp.x + 24 + i * 30,
        y: vp.y + 24 + i * 30,
        w: Math.min(560, vp.w - 80),
        h: Math.min(420, vp.h - 80),
        z: i + 1,
      }));
    });
}

export function makeLayoutActions(args: LayoutArgs): Pick<WorkspaceApi, "tileAll" | "splitFront" | "cascade"> {
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
  readonly setConns: Dispatch<SetStateAction<Connection[]>>;
  readonly setConnecting: Dispatch<SetStateAction<ConnectingState | null>>;
}

function findHitWindow(
  list: readonly AppWindow[],
  fromId: string,
  px: number,
  py: number,
): AppWindow | undefined {
  const hits = list.filter(
    (w) => w.id !== fromId && px >= w.x && px <= w.x + w.w && py >= w.y && py <= w.y + w.h,
  );
  if (hits.length === 0) return undefined;
  return [...hits].sort((a, b) => b.z - a.z)[0];
}

function isDuplicate(cs: readonly Connection[], a: string, b: string): boolean {
  return cs.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));
}

function setupConnectListeners(
  args: ConnectArgs,
  fromId: string,
  toWX: (cx: number) => number,
  toWY: (cy: number) => number,
): void {
  const { winsRef, setConns, setConnecting } = args;
  const move = (ev: PointerEvent): void => {
    setConnecting({ from: fromId, x: toWX(ev.clientX), y: toWY(ev.clientY) });
  };
  const up = (ev: PointerEvent): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    const px = toWX(ev.clientX);
    const py = toWY(ev.clientY);
    const list = winsRef.current;
    const from = list.find((w) => w.id === fromId);
    const hit = findHitWindow(list, fromId, px, py);
    if (hit !== undefined && from !== undefined && canConnect(from.type, hit.type)) {
      setConns((cs) =>
        isDuplicate(cs, fromId, hit.id)
          ? cs
          : [...cs, { id: `${fromId}~${hit.id}`, a: fromId, b: hit.id }],
      );
    }
    setConnecting(null);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export function makeConnectActions(
  args: ConnectArgs,
): Pick<WorkspaceApi, "startConnect" | "removeConn" | "linkedFilesRoot"> {
  const { wsRef, viewRef, winsRef, connsRef, setConns, setConnecting } = args;
  const startConnect: WorkspaceApi["startConnect"] = (fromId, e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = wsRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const v = viewRef.current;
    const toWX = (cx: number): number => (cx - r.left - v.x) / v.zoom;
    const toWY = (cy: number): number => (cy - r.top - v.y) / v.zoom;
    setConnecting({ from: fromId, x: toWX(e.clientX), y: toWY(e.clientY) });
    setupConnectListeners(args, fromId, toWX, toWY);
  };

  const removeConn: WorkspaceApi["removeConn"] = (id) =>
    setConns((cs) => cs.filter((c) => c.id !== id));

  const linkedFilesRoot: WorkspaceApi["linkedFilesRoot"] = (id) => {
    for (const c of connsRef.current) {
      const otherId = c.a === id ? c.b : c.b === id ? c.a : null;
      if (otherId === null) continue;
      const w = winsRef.current.find((x) => x.id === otherId);
      if (w !== undefined && w.type === "files") {
        const root = w.cfg["root"];
        return typeof root === "string" && root.length > 0 ? root : "src";
      }
    }
    return null;
  };

  return { startConnect, removeConn, linkedFilesRoot };
}

// Re-exports for callers that need the lower-level type
export type { WindowType };
