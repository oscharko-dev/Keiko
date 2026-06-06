"use client";

import { WIN_TYPES, type WindowType } from "../windows/WindowsRegistry";
import { WIN_META } from "../windows/descriptor-meta";
import type { AppWindow, Connection } from "../windows/types";

type JsonScalar = string | number | boolean;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasWindowType(value: unknown): value is WindowType {
  return typeof value === "string" && value in WIN_TYPES;
}

function sanitizeCfgForPersistence(
  type: WindowType,
  cfg: unknown,
): Record<string, string | number | boolean | undefined> {
  if (!isRecord(cfg)) return {};
  const persistence = WIN_META[type].persistence;
  if (persistence === "durable.config") return {};
  const allowedKeys = new Set((WIN_TYPES[type].config ?? []).map((field) => field.key));
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!allowedKeys.has(key) || !isJsonScalar(value)) continue;
    out[key] = value;
  }
  return out;
}

function sanitizePrev(prev: unknown): AppWindow["prev"] | undefined {
  if (!isRecord(prev)) return undefined;
  if (
    !isFiniteNumber(prev["x"]) ||
    !isFiniteNumber(prev["y"]) ||
    !isFiniteNumber(prev["w"]) ||
    !isFiniteNumber(prev["h"])
  ) {
    return undefined;
  }
  return {
    x: prev["x"],
    y: prev["y"],
    w: prev["w"],
    h: prev["h"],
  };
}

function sanitizeWindow(win: unknown): AppWindow | null {
  if (!isRecord(win) || !hasWindowType(win["type"])) return null;
  const type = win["type"];
  if (WIN_META[type].persistence === "transient") return null;
  if (
    typeof win["id"] !== "string" ||
    !isFiniteNumber(win["x"]) ||
    !isFiniteNumber(win["y"]) ||
    !isFiniteNumber(win["w"]) ||
    !isFiniteNumber(win["h"]) ||
    !isFiniteNumber(win["z"]) ||
    typeof win["max"] !== "boolean"
  ) {
    return null;
  }
  const next: AppWindow = {
    id: win["id"],
    type,
    x: win["x"],
    y: win["y"],
    w: win["w"],
    h: win["h"],
    z: win["z"],
    cfg: sanitizeCfgForPersistence(type, win["cfg"]),
    max: win["max"],
  };
  const prev = sanitizePrev(win["prev"]);
  return {
    ...next,
    ...(prev !== undefined ? { prev } : {}),
    ...(isFiniteNumber(win["zoom"]) ? { zoom: win["zoom"] } : {}),
  };
}

export function sanitizePersistedWindows(wins: readonly AppWindow[]): AppWindow[] {
  const out: AppWindow[] = [];
  for (const win of wins) {
    const next = sanitizeWindow(win);
    if (next !== null) out.push(next);
  }
  return out;
}

export function parsePersistedWindows(raw: string | null): AppWindow[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const wins = sanitizePersistedWindows(parsed as AppWindow[]);
    return wins.length > 0 ? wins : null;
  } catch {
    return null;
  }
}

export function sanitizePersistedConnections(
  conns: readonly Connection[],
  wins: readonly AppWindow[],
): Connection[] {
  const windowIds = new Set(wins.map((win) => win.id));
  const out: Connection[] = [];
  for (const conn of conns) {
    if (
      typeof conn.id !== "string" ||
      typeof conn.a !== "string" ||
      typeof conn.b !== "string" ||
      !windowIds.has(conn.a) ||
      !windowIds.has(conn.b)
    ) {
      continue;
    }
    out.push({ id: conn.id, a: conn.a, b: conn.b });
  }
  return out;
}

export function parsePersistedConnections(raw: string | null, wins: readonly AppWindow[]): Connection[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sanitizePersistedConnections(parsed as Connection[], wins);
  } catch {
    return [];
  }
}
