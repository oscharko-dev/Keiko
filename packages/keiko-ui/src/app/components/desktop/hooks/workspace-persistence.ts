"use client";

import { looksLikeSecretShape } from "@oscharko-dev/keiko-contracts";
import { WIN_TYPES, type WindowType } from "../windows/WindowsRegistry";
import { WIN_META } from "../windows/descriptor-meta";
import type { AppWindow, Connection } from "../windows/types";

type JsonScalar = string | number | boolean;

const REDACTED_WORKSPACE_CONFIG_VALUE = "[REDACTED]";
const MAX_REFERENCE_VALUE_LENGTH = 256;

const CREDENTIAL_KEY_MARKERS = [
  "apikey",
  "accesskey",
  "clientsecret",
  "credential",
  "password",
  "privatekey",
  "secret",
  "token",
] as const;

const CREDENTIAL_ASSIGNMENT_MARKERS = [
  "api_key=",
  "apikey=",
  "client_secret=",
  "clientsecret=",
  "credential=",
  "authorization:",
  "password=",
  "secret=",
  "token=",
] as const;

const ENV_CREDENTIAL_FILENAMES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.test",
  ".env.production",
] as const;

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

function alnumLower(value: string): string {
  let out = "";
  for (const char of value.toLowerCase()) {
    if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) out += char;
  }
  return out;
}

function isCredentialKey(key: string): boolean {
  const normalized = alnumLower(key);
  return CREDENTIAL_KEY_MARKERS.some((marker) => normalized.includes(marker));
}

function containsBearerSecret(value: string): boolean {
  const marker = "bearer ";
  const at = value.toLowerCase().indexOf(marker);
  if (at === -1) return false;
  let length = 0;
  for (let idx = at + marker.length; idx < value.length; idx += 1) {
    const char = value[idx] ?? "";
    if (char.trim().length === 0) break;
    length += 1;
  }
  return length >= 8;
}

function containsUrlCredentials(value: string): boolean {
  if (!value.includes("://")) return false;
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

function containsCredentialPath(value: string): boolean {
  const segments = value.toLowerCase().replaceAll("\\", "/").split("/");
  for (let idx = 0; idx < segments.length; idx += 1) {
    const segment = segments[idx] ?? "";
    const next = segments[idx + 1] ?? "";
    if (ENV_CREDENTIAL_FILENAMES.includes(segment as (typeof ENV_CREDENTIAL_FILENAMES)[number]))
      return true;
    if (segment === ".npmrc" || segment === "credentials.json") return true;
    if (segment === ".aws" && next === "credentials") return true;
    if (segment === ".ssh" && next.startsWith("id_")) return true;
  }
  return false;
}

function isSecretShapedString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  return (
    looksLikeSecretShape(trimmed) ||
    containsBearerSecret(trimmed) ||
    containsUrlCredentials(trimmed) ||
    CREDENTIAL_ASSIGNMENT_MARKERS.some((marker) => lower.includes(marker)) ||
    containsCredentialPath(trimmed)
  );
}

function isAllowedReferenceChar(char: string): boolean {
  const code = char.charCodeAt(0);
  const isDigit = code >= 48 && code <= 57;
  const isUpper = code >= 65 && code <= 90;
  const isLower = code >= 97 && code <= 122;
  const isPunct = code === 46 || code === 95 || code === 45;
  return isDigit || isUpper || isLower || isPunct;
}

function isSafeOpaqueReference(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REFERENCE_VALUE_LENGTH || value.startsWith("."))
    return false;
  if (value.trim() !== value || isSecretShapedString(value)) return false;
  for (const char of value) {
    if (!isAllowedReferenceChar(char)) return false;
  }
  return true;
}

function sanitizeConfigValue(
  type: WindowType,
  key: string,
  value: unknown,
): JsonScalar | undefined {
  if (!isJsonScalar(value) || isCredentialKey(key)) return undefined;
  if (typeof value !== "string") return value;
  const persistence = WIN_META[type].persistence;
  if (persistence === "evidence-reference") {
    return isSafeOpaqueReference(value) ? value : undefined;
  }
  if (!isSecretShapedString(value)) return value;
  return persistence === "durable.ui" ? REDACTED_WORKSPACE_CONFIG_VALUE : undefined;
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
    if (!allowedKeys.has(key)) continue;
    const next = sanitizeConfigValue(type, key, value);
    if (next !== undefined) out[key] = next;
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
    // Release 0.2.0 — carry the bind-time snapshot fields through persistence (typed-checked,
    // never trusted blindly) so unbind-after-reload still removes the source the edge bound.
    const boundRoot = typeof conn.boundRoot === "string" && conn.boundRoot.length > 0;
    const boundConnector =
      (conn.boundConnectorKind === "capsule" || conn.boundConnectorKind === "capsule-set") &&
      typeof conn.boundConnectorId === "string" &&
      conn.boundConnectorId.length > 0;
    out.push({
      id: conn.id,
      a: conn.a,
      b: conn.b,
      ...(boundRoot ? { boundRoot: conn.boundRoot } : {}),
      ...(boundConnector
        ? { boundConnectorKind: conn.boundConnectorKind, boundConnectorId: conn.boundConnectorId }
        : {}),
    });
  }
  return out;
}

export function parsePersistedConnections(
  raw: string | null,
  wins: readonly AppWindow[],
): Connection[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sanitizePersistedConnections(parsed as Connection[], wins);
  } catch {
    return [];
  }
}
