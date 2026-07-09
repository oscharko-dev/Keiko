"use client";

import { WIN_TYPES, type WindowType } from "../windows/WindowsRegistry";
import type { AppWindow, WindowCfgValue } from "../windows/types";
import { clampWorkspaceGroupOrigin } from "../windowRecovery";
import type { ViewportWorld } from "./useWorkspace.types";
import { sanitizePersistedWindows } from "./workspace-persistence";

const WORKSPACE_CLIPBOARD_KIND = "keiko.workspace.windows";
const WORKSPACE_CLIPBOARD_VERSION = 1;
const MAX_CLIPBOARD_WINDOWS = 32;
export const WORKSPACE_CLIPBOARD_PASTE_OFFSET_PX = 32;

interface WorkspaceClipboardWindowDescriptor {
  readonly type: WindowType;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly cfg: Record<string, WindowCfgValue>;
  readonly zoom?: number;
}

interface WorkspaceClipboardPayload {
  readonly kind: typeof WORKSPACE_CLIPBOARD_KIND;
  readonly version: typeof WORKSPACE_CLIPBOARD_VERSION;
  readonly windows: readonly WorkspaceClipboardWindowDescriptor[];
}

export interface DuplicateWorkspaceClipboardArgs {
  readonly wins: readonly AppWindow[];
  readonly payload: string;
  readonly viewport: ViewportWorld;
  readonly zStart: number;
  readonly nowMs: number;
  readonly pasteOffsetPx: number;
}

export interface DuplicateWorkspaceClipboardResult {
  readonly wins: readonly AppWindow[];
  readonly pastedWindowIds: readonly string[];
  readonly nextZ: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasWindowType(value: unknown): value is WindowType {
  return typeof value === "string" && Object.hasOwn(WIN_TYPES, value);
}

function isWorkspaceClipboardTypeEligible(type: WindowType): boolean {
  if (WIN_TYPES[type].singleton === true) return false;
  return type !== "qiRun";
}

function contentFreeCfgRecord(value: unknown): Record<string, WindowCfgValue> | null {
  if (!isRecord(value)) return null;
  return Object.keys(value).length === 0 ? {} : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function descriptorFromRecord(value: unknown): WorkspaceClipboardWindowDescriptor | null {
  if (!isRecord(value) || !hasWindowType(value["type"])) return null;
  const x = finiteNumber(value["x"]);
  const y = finiteNumber(value["y"]);
  const w = finiteNumber(value["w"]);
  const h = finiteNumber(value["h"]);
  const cfg = contentFreeCfgRecord(value["cfg"]);
  const zoom = value["zoom"] === undefined ? undefined : finiteNumber(value["zoom"]);
  if (x === null || y === null || w === null || h === null || cfg === null) return null;
  if (w <= 0 || h <= 0 || zoom === null) return null;
  if (!isWorkspaceClipboardTypeEligible(value["type"])) return null;
  return {
    type: value["type"],
    x,
    y,
    w,
    h,
    cfg,
    ...(zoom !== undefined ? { zoom } : {}),
  };
}

function parseWorkspaceClipboardPayload(
  raw: string,
): readonly WorkspaceClipboardWindowDescriptor[] {
  if (raw.length === 0 || raw.length > 512_000) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  if (
    parsed["kind"] !== WORKSPACE_CLIPBOARD_KIND ||
    parsed["version"] !== WORKSPACE_CLIPBOARD_VERSION ||
    !Array.isArray(parsed["windows"]) ||
    parsed["windows"].length === 0 ||
    parsed["windows"].length > MAX_CLIPBOARD_WINDOWS
  ) {
    return [];
  }
  const descriptors: WorkspaceClipboardWindowDescriptor[] = [];
  for (const rawWindow of parsed["windows"]) {
    const descriptor = descriptorFromRecord(rawWindow);
    if (descriptor === null) return [];
    descriptors.push(descriptor);
  }
  return descriptors;
}

function selectableClipboardWindows(
  wins: readonly AppWindow[],
  selectedWindowIds: readonly string[],
): readonly AppWindow[] {
  const selected = new Set(selectedWindowIds);
  return wins.filter((win) => selected.has(win.id) && win.minimized !== true && win.max !== true);
}

function isKeyedWindowDescriptor(win: AppWindow): boolean {
  if (win.type === "chat") return typeof win.cfg["chatId"] === "string";
  return win.type === "qiRun";
}

function isWorkspaceClipboardWindowEligible(win: AppWindow): boolean {
  return isWorkspaceClipboardTypeEligible(win.type) && !isKeyedWindowDescriptor(win);
}

function descriptorFromWindow(win: AppWindow): WorkspaceClipboardWindowDescriptor | null {
  if (!isWorkspaceClipboardWindowEligible(win)) return null;
  return {
    type: win.type,
    x: win.x,
    y: win.y,
    w: win.w,
    h: win.h,
    cfg: {},
    ...(typeof win.zoom === "number" && Number.isFinite(win.zoom) ? { zoom: win.zoom } : {}),
  };
}

export function buildWorkspaceClipboardPayload(
  wins: readonly AppWindow[],
  selectedWindowIds: readonly string[],
): string | null {
  const selected = selectableClipboardWindows(wins, selectedWindowIds);
  if (selected.length === 0) return null;
  const sanitized = sanitizePersistedWindows(selected)
    .filter(isWorkspaceClipboardWindowEligible)
    .sort((a, b) => a.z - b.z)
    .slice(0, MAX_CLIPBOARD_WINDOWS);
  const descriptors: WorkspaceClipboardWindowDescriptor[] = [];
  for (const win of sanitized) {
    const descriptor = descriptorFromWindow(win);
    if (descriptor !== null) descriptors.push(descriptor);
  }
  if (descriptors.length === 0) return null;
  return JSON.stringify({
    kind: WORKSPACE_CLIPBOARD_KIND,
    version: WORKSPACE_CLIPBOARD_VERSION,
    windows: descriptors,
  } satisfies WorkspaceClipboardPayload);
}

function nextDuplicateId(
  type: WindowType,
  existingIds: Set<string>,
  nowMs: number,
  index: number,
): string {
  const base = `${type}-copy-${nowMs.toString(36)}-${index.toString(36)}`;
  if (!existingIds.has(base)) {
    existingIds.add(base);
    return base;
  }
  let suffix = 1;
  while (existingIds.has(`${base}-${suffix.toString(36)}`)) suffix += 1;
  const id = `${base}-${suffix.toString(36)}`;
  existingIds.add(id);
  return id;
}

function pastedBounds(wins: readonly AppWindow[]): {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const win of wins) {
    minX = Math.min(minX, win.x);
    minY = Math.min(minY, win.y);
    maxX = Math.max(maxX, win.x + win.w);
    maxY = Math.max(maxY, win.y + win.h);
  }
  return { minX, minY, maxX, maxY };
}

function clampPastedWindows(
  wins: readonly AppWindow[],
  viewport: ViewportWorld,
): readonly AppWindow[] {
  const bounds = pastedBounds(wins);
  const clamped = clampWorkspaceGroupOrigin(bounds, viewport);
  const targetX = clamped.x;
  const targetY = clamped.y;
  const dx = targetX - bounds.minX;
  const dy = targetY - bounds.minY;
  if (dx === 0 && dy === 0) return wins;
  return wins.map((win) => ({ ...win, x: win.x + dx, y: win.y + dy }));
}

export function duplicateWorkspaceClipboardWindows({
  wins,
  payload,
  viewport,
  zStart,
  nowMs,
  pasteOffsetPx,
}: DuplicateWorkspaceClipboardArgs): DuplicateWorkspaceClipboardResult | null {
  const descriptors = parseWorkspaceClipboardPayload(payload);
  if (descriptors.length === 0 || !Number.isFinite(pasteOffsetPx)) return null;
  const existingIds = new Set(wins.map((win) => win.id));
  let z = zStart;
  const duplicated = descriptors.map((descriptor, index) => {
    const def = WIN_TYPES[descriptor.type];
    const win: AppWindow = {
      id: nextDuplicateId(descriptor.type, existingIds, nowMs, index),
      type: descriptor.type,
      x: descriptor.x + pasteOffsetPx,
      y: descriptor.y + pasteOffsetPx,
      w: Math.max(descriptor.w, def.min.w),
      h: Math.max(descriptor.h, def.min.h),
      z: ++z,
      cfg: descriptor.cfg,
      max: false,
      zoom: descriptor.zoom ?? 1,
    };
    return win;
  });
  const clamped = clampPastedWindows(duplicated, viewport);
  return {
    wins: [...wins, ...clamped],
    pastedWindowIds: clamped.map((win) => win.id),
    nextZ: z,
  };
}
