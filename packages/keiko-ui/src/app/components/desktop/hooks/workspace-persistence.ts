"use client";

import { looksLikeSecretShape } from "@oscharko-dev/keiko-contracts";
import { WIN_TYPES, type WindowType } from "../windows/WindowsRegistry";
import { WIN_META } from "../windows/descriptor-meta";
import type { AppWindow, Connection } from "../windows/types";

type JsonScalar = string | number | boolean;

const REDACTED_WORKSPACE_CONFIG_VALUE = "[REDACTED]";
const MAX_REFERENCE_VALUE_LENGTH = 256;
const MAX_FIGMA_SELECTED_SCREEN_IDS = 16;
const MAX_FIGMA_SCREEN_NAME_LENGTH = 256;
const MAX_EDITOR_OPEN_FILES = 64;
const MAX_EDITOR_OPEN_FILE_LENGTH = 512;
const MAX_PDF_PREVIEW_LABEL_LENGTH = 240;
const MAX_PDF_PREVIEW_MESSAGE_LENGTH = 360;
const MAX_PDF_PREVIEW_PAGE = 100_000;
const MAX_PDF_PREVIEW_ZOOM = 2;
const MIN_PDF_PREVIEW_ZOOM = 0.5;

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

const INTERNAL_CFG_KEYS: Readonly<Partial<Record<WindowType, readonly string[]>>> = {
  chat: ["chatId"],
  editor: ["openFiles", "layoutJson"],
  files: ["activeFilePath", "activeDirectoryPath", "resolvedRoot"],
  figma: ["snapshotRunId", "selectedScreenIdsJson", "selectedScreenName"],
  figmaView: ["snapshotRunId", "selectedScreenIdsJson", "selectedScreenName"],
  figmaJson: ["snapshotRunId", "screenId", "selectedScreenIdsJson", "selectedScreenName"],
  figmaImage: ["snapshotRunId", "screenId", "selectedScreenName", "imageSrc"],
  pdfCitationPreview: [
    "anchorQuality",
    "currentPage",
    "documentLabel",
    "failureMessage",
    "failureRetryable",
    "failureTitle",
    "pageLabel",
    "pageNumber",
    "rotation",
    "sourceLabel",
    "zoomMode",
    "zoomValue",
  ],
};

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

function looksLikeLocalPath(value: string): boolean {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/\\/gu, "/");
  return (
    /^file:/iu.test(trimmed) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    normalized.includes("/Users/") ||
    normalized.includes("/home/") ||
    normalized.includes("/Volumes/") ||
    normalized.includes("../")
  );
}

function containsTraversalSegment(value: string): boolean {
  return value.replace(/\\/gu, "/").split("/").some((segment) => segment === "..");
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

function isSafeFigmaScreenId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REFERENCE_VALUE_LENGTH) return false;
  if (value.trim() !== value || isSecretShapedString(value)) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isPunct = code === 46 || code === 58 || code === 95 || code === 45;
    if (!isDigit && !isUpper && !isLower && !isPunct) return false;
  }
  return true;
}

function sanitizeFigmaSelectedScreenIdsJson(value: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_FIGMA_SELECTED_SCREEN_IDS
  ) {
    return undefined;
  }
  const screenIds: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") return undefined;
    const screenId = item.trim();
    if (!isSafeFigmaScreenId(screenId)) return undefined;
    screenIds.push(screenId);
  }
  return JSON.stringify(screenIds);
}

function isSafeFigmaImageSrc(value: string): boolean {
  return /^\/api\/figma\/snapshots\/[^/?#]+\/screens\/\d+\/image$/u.test(value);
}

function sanitizeFigmaConfigValue(key: string, value: unknown): JsonScalar | undefined {
  if (typeof value !== "string") return undefined;
  if (key === "snapshotRunId") return isSafeOpaqueReference(value) ? value : undefined;
  if (key === "screenId") return isSafeFigmaScreenId(value) ? value : undefined;
  if (key === "imageSrc") return isSafeFigmaImageSrc(value) ? value : undefined;
  if (key === "selectedScreenIdsJson") return sanitizeFigmaSelectedScreenIdsJson(value);
  if (key === "selectedScreenName") {
    if (value.length > MAX_FIGMA_SCREEN_NAME_LENGTH || isSecretShapedString(value)) {
      return undefined;
    }
    return value;
  }
  return undefined;
}

function safePdfPreviewText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > maxLength ||
    isSecretShapedString(trimmed) ||
    looksLikeLocalPath(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function safePdfPreviewPage(value: unknown): number | undefined {
  if (!Number.isInteger(value) || typeof value !== "number") return undefined;
  return value > 0 && value <= MAX_PDF_PREVIEW_PAGE ? value : undefined;
}

function safePdfPreviewRotation(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return (((Math.round(value / 90) * 90) % 360) + 360) % 360;
}

function safePdfPreviewZoom(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(
    MAX_PDF_PREVIEW_ZOOM,
    Math.max(MIN_PDF_PREVIEW_ZOOM, Math.round(value * 10) / 10),
  );
}

function sanitizePdfCitationPreviewConfigValue(
  key: string,
  value: unknown,
): JsonScalar | undefined {
  if (key === "documentLabel" || key === "pageLabel" || key === "sourceLabel") {
    return safePdfPreviewText(value, MAX_PDF_PREVIEW_LABEL_LENGTH);
  }
  if (key === "failureTitle" || key === "failureMessage") {
    return safePdfPreviewText(value, MAX_PDF_PREVIEW_MESSAGE_LENGTH);
  }
  if (key === "currentPage" || key === "pageNumber") return safePdfPreviewPage(value);
  if (key === "rotation") return safePdfPreviewRotation(value);
  if (key === "zoomValue") return safePdfPreviewZoom(value);
  if (key === "failureRetryable") return typeof value === "boolean" ? value : undefined;
  if (key === "anchorQuality") {
    return value === "page-only" || value === "approximate" || value === "unavailable"
      ? value
      : undefined;
  }
  if (key === "zoomMode") {
    return value === "fit-width" || value === "fit-page" || value === "manual" ? value : undefined;
  }
  return undefined;
}

function sanitizeEditorOpenFiles(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const path = item.trim().replace(/\\/gu, "/").replace(/^\/+/u, "");
    if (
      path.length === 0 ||
      path.length > MAX_EDITOR_OPEN_FILE_LENGTH ||
      containsTraversalSegment(path) ||
      isSecretShapedString(path) ||
      out.includes(path)
    ) {
      continue;
    }
    out.push(path);
    if (out.length >= MAX_EDITOR_OPEN_FILES) break;
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeEditorLayoutRoot(value: unknown): string {
  if (typeof value !== "string") return "";
  const root = value.trim();
  if (root.length === 0 || root.length > MAX_EDITOR_OPEN_FILE_LENGTH) return "";
  return isSecretShapedString(root) ? "" : root;
}

function sanitizeEditorLayoutJson(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record["schemaVersion"] === 2 || record["version"] === 2) {
    const rawPanes = isRecord(record["panes"]) ? record["panes"] : {};
    const panes: Record<
      string,
      { id: string; activeFile: string; openFiles: readonly string[]; tabOrder: readonly string[] }
    > = {};
    for (const [paneId, pane] of Object.entries(rawPanes)) {
      if (!isRecord(pane)) continue;
      const activeFiles =
        typeof pane["activeFile"] === "string"
          ? sanitizeEditorOpenFiles([pane["activeFile"]])
          : undefined;
      const activeFile = activeFiles?.[0];
      const openFiles = sanitizeEditorOpenFiles(pane["openFiles"]);
      const tabOrder = sanitizeEditorOpenFiles(pane["tabOrder"]) ?? openFiles;
      if (openFiles === undefined && activeFile === undefined) continue;
      const files = openFiles ?? activeFiles;
      if (files === undefined) continue;
      const resolvedActiveFile =
        activeFile !== undefined && files.includes(activeFile) ? activeFile : files[0]!;
      panes[paneId.slice(0, 48)] = {
        id: paneId.slice(0, 48),
        activeFile: resolvedActiveFile,
        openFiles: files,
        tabOrder: tabOrder ?? files,
      };
    }
    const paneIds = new Set(Object.keys(panes));
    const sanitizeNode = (node: unknown): unknown => {
      if (!isRecord(node)) return null;
      if (
        node["type"] === "pane" &&
        typeof node["paneId"] === "string" &&
        paneIds.has(node["paneId"])
      ) {
        return { type: "pane", paneId: node["paneId"] };
      }
      if (node["type"] === "split") {
        const first = sanitizeNode(node["first"]);
        const second = sanitizeNode(node["second"]);
        if (first === null || second === null) return null;
        const ratio =
          typeof node["ratio"] === "number" && Number.isFinite(node["ratio"])
            ? Math.min(85, Math.max(15, Math.round(node["ratio"])))
            : 50;
        return {
          type: "split",
          id: typeof node["id"] === "string" ? node["id"].slice(0, 48) : "split-1",
          direction: node["direction"] === "column" ? "column" : "row",
          ratio,
          first,
          second,
        };
      }
      return null;
    };
    const tree = sanitizeNode(record["tree"]);
    const firstPaneId = Object.keys(panes)[0];
    if (tree === null || firstPaneId === undefined) return undefined;
    const activePaneId =
      typeof record["activePaneId"] === "string" && paneIds.has(record["activePaneId"])
        ? record["activePaneId"]
        : firstPaneId;
    const sidebarWidth =
      typeof record["sidebarWidth"] === "number" && Number.isFinite(record["sidebarWidth"])
        ? Math.min(440, Math.max(180, Math.round(record["sidebarWidth"])))
        : 260;
    return JSON.stringify({
      schemaVersion: 2,
      root: sanitizeEditorLayoutRoot(record["root"]),
      activePaneId,
      tree,
      panes,
      sidebarWidth,
      sidebarCollapsed: record["sidebarCollapsed"] === true,
    });
  }
  const rawPanes = Array.isArray(record["panes"]) ? record["panes"].slice(0, 2) : [];
  const panes: { id: string; file: string; openFiles: readonly string[] }[] = [];
  for (const [index, pane] of rawPanes.entries()) {
    if (typeof pane !== "object" || pane === null || Array.isArray(pane)) return undefined;
    const paneRecord = pane as Record<string, unknown>;
    const file = typeof paneRecord["file"] === "string" ? paneRecord["file"].trim() : "";
    const openFiles = sanitizeEditorOpenFiles(paneRecord["openFiles"]);
    if (file.length > MAX_EDITOR_OPEN_FILE_LENGTH || isSecretShapedString(file)) continue;
    const nextOpenFiles =
      openFiles ?? (file.length > 0 ? sanitizeEditorOpenFiles([file]) : undefined);
    if (nextOpenFiles === undefined) continue;
    panes.push({
      id:
        typeof paneRecord["id"] === "string" && paneRecord["id"].trim().length > 0
          ? paneRecord["id"].trim().slice(0, 32)
          : `pane-${index + 1}`,
      file: file.length > 0 ? file.replace(/\\/gu, "/").replace(/^\/+/u, "") : nextOpenFiles[0]!,
      openFiles: nextOpenFiles,
    });
  }
  if (panes.length === 0) return undefined;
  const direction = record["direction"] === "column" ? "column" : "row";
  const splitRatio =
    typeof record["splitRatio"] === "number" && Number.isFinite(record["splitRatio"])
      ? Math.min(75, Math.max(25, Math.round(record["splitRatio"])))
      : 50;
  const sidebarWidth =
    typeof record["sidebarWidth"] === "number" && Number.isFinite(record["sidebarWidth"])
      ? Math.min(440, Math.max(180, Math.round(record["sidebarWidth"])))
      : 260;
  const activePaneId =
    typeof record["activePaneId"] === "string" &&
    panes.some((pane) => pane.id === record["activePaneId"])
      ? record["activePaneId"]
      : panes[0]!.id;
  return JSON.stringify({
    version: 1,
    panes,
    activePaneId,
    direction,
    splitRatio,
    sidebarWidth,
    sidebarCollapsed: record["sidebarCollapsed"] === true,
  });
}

function sanitizeConfigValue(
  type: WindowType,
  key: string,
  value: unknown,
): AppWindow["cfg"][string] {
  if (type === "editor" && key === "openFiles") return sanitizeEditorOpenFiles(value);
  if (type === "editor" && key === "layoutJson") return sanitizeEditorLayoutJson(value);
  if (type === "pdfCitationPreview") {
    return sanitizePdfCitationPreviewConfigValue(key, value);
  }
  if (type === "figma" || type === "figmaView" || type === "figmaJson" || type === "figmaImage") {
    return sanitizeFigmaConfigValue(key, value);
  }
  if (!isJsonScalar(value) || isCredentialKey(key)) return undefined;
  if (typeof value !== "string") return value;
  const persistence = WIN_META[type].persistence;
  if (persistence === "evidence-reference") {
    return isSafeOpaqueReference(value) ? value : undefined;
  }
  if (!isSecretShapedString(value)) return value;
  return persistence === "durable.ui" ? REDACTED_WORKSPACE_CONFIG_VALUE : undefined;
}

function sanitizeCfgForPersistence(type: WindowType, cfg: unknown): AppWindow["cfg"] {
  if (!isRecord(cfg)) return {};
  const persistence = WIN_META[type].persistence;
  if (persistence === "durable.config") return {};
  const allowedKeys = new Set([
    ...(WIN_TYPES[type].config ?? []).map((field) => field.key),
    ...(INTERNAL_CFG_KEYS[type] ?? []),
  ]);
  const out: AppWindow["cfg"] = {};
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
    ...(win["minimized"] === true ? { minimized: true } : {}),
    ...(prev !== undefined ? { prev } : {}),
    ...(isFiniteNumber(win["zoom"]) ? { zoom: win["zoom"] } : {}),
  };
}

function firstSelectedFigmaScreenId(cfg: Record<string, unknown>): string | undefined {
  const raw = cfg["selectedScreenIdsJson"];
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const first = parsed[0];
    return typeof first === "string" && first.length > 0 ? first : undefined;
  } catch {
    return undefined;
  }
}

function migrateLegacyFigmaWindow(win: AppWindow): AppWindow {
  if (win.type !== "figma") return win;
  if (firstSelectedFigmaScreenId(win.cfg) === undefined) return win;
  return {
    ...win,
    type: "figmaView",
    cfg: {
      ...win.cfg,
    },
  };
}

export function sanitizePersistedWindows(wins: readonly AppWindow[]): AppWindow[] {
  const out: AppWindow[] = [];
  for (const win of wins) {
    const next = sanitizeWindow(win);
    if (next !== null) out.push(migrateLegacyFigmaWindow(next));
  }
  const figmaManagers = out.filter((win) => win.type === "figma");
  if (figmaManagers.length <= 1) return out;
  const keeper = figmaManagers.reduce((best, next) => (next.z > best.z ? next : best));
  return out.filter((win) => win.type !== "figma" || win.id === keeper.id);
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
    const scopeSnapshotElided =
      conn.boundScopeElided === true ||
      typeof conn.boundRoot === "string" ||
      typeof conn.boundScopeKind === "string" ||
      typeof conn.boundRelativePath === "string";
    const boundChatWindowId =
      typeof conn.boundChatWindowId === "string" &&
      conn.boundChatWindowId.length > 0 &&
      windowIds.has(conn.boundChatWindowId);
    const boundConnector =
      (conn.boundConnectorKind === "capsule" || conn.boundConnectorKind === "capsule-set") &&
      typeof conn.boundConnectorId === "string" &&
      conn.boundConnectorId.length > 0;
    out.push({
      id: conn.id,
      a: conn.a,
      b: conn.b,
      ...(boundChatWindowId ? { boundChatWindowId: conn.boundChatWindowId } : {}),
      ...(scopeSnapshotElided ? { boundScopeElided: true } : {}),
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
