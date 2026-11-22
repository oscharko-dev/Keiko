import { isValidScopePath } from "./connected-context.js";
import { WORKSPACE_PORTABLE_PATH_MAX_BYTES } from "./workspace-contract-primitives.js";
import { WORKSPACE_PATH_DISCOVERY_LIMITS, type WorkspacePathDiscoveryEntry } from "./workspace.js";

/**
 * Model-driven retrieval on a folder a person connected to a Chat: the model lists a directory,
 * searches the folder and reads line windows, several times in one turn, instead of receiving a
 * single automatic retrieval. The request is untrusted model output; every bound below is enforced
 * before any workspace work starts.
 */
export const CONNECTED_FOLDER_TOOL_LIMITS = Object.freeze({
  queryChars: 200,
  searchHits: 12,
  snippetBytes: 600,
  readLines: 200,
  readBytes: 8_000,
  listEntries: WORKSPACE_PATH_DISCOVERY_LIMITS.maxResults,
});

export const CONNECTED_FOLDER_TOOL_VIEWS = Object.freeze(["list", "search", "read"] as const);
export type ConnectedFolderToolView = (typeof CONNECTED_FOLDER_TOOL_VIEWS)[number];

export const CONNECTED_FOLDER_SEARCH_MODES = Object.freeze(["keywords", "literal"] as const);
export type ConnectedFolderSearchMode = (typeof CONNECTED_FOLDER_SEARCH_MODES)[number];

/** Direct children of one directory. `after` is the last path of the previous page, or "". */
export interface ConnectedFolderListRequest {
  readonly view: "list";
  readonly directory: string;
  readonly after: string;
}

/** Ranked text search. An empty `directory` searches the whole connected scope. */
export interface ConnectedFolderSearchRequest {
  readonly view: "search";
  readonly mode: ConnectedFolderSearchMode;
  readonly query: string;
  readonly directory: string;
  readonly maxResults: number;
}

export interface ConnectedFolderReadRequest {
  readonly view: "read";
  readonly path: string;
  readonly startLine: number;
  readonly maxLines: number;
}

export type ConnectedFolderToolRequest =
  ConnectedFolderListRequest | ConnectedFolderSearchRequest | ConnectedFolderReadRequest;

/**
 * `out-of-range` is a read that starts after the last line; `not-text` is a file whose bytes are
 * not text (an image, an archive, an office document).
 */
export const CONNECTED_FOLDER_TOOL_FAILURE_REASONS = Object.freeze([
  "invalid-request",
  "scope-denied",
  "out-of-range",
  "not-text",
  "unreadable",
  "budget-exhausted",
  "failed",
] as const);
export type ConnectedFolderToolFailureReason =
  (typeof CONNECTED_FOLDER_TOOL_FAILURE_REASONS)[number];

/** A line window that was returned to the model, so a citation can be checked against it. */
export interface ConnectedFolderToolExcerpt {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly truncated: boolean;
}

interface ConnectedFolderToolSuccess {
  readonly ok: true;
  readonly durationMs: number;
  /** UTF-8 bytes of path and text content this result hands to the model. */
  readonly resultBytes: number;
}

export type ConnectedFolderToolResult =
  | (ConnectedFolderToolSuccess & {
      readonly view: "list";
      readonly directory: string;
      readonly entries: readonly WorkspacePathDiscoveryEntry[];
      /** Pass as `after` to continue; absent when the directory is complete. */
      readonly nextAfter?: string | undefined;
      readonly coverageIncomplete: boolean;
    })
  | (ConnectedFolderToolSuccess & {
      readonly view: "search";
      readonly hits: readonly ConnectedFolderToolExcerpt[];
      readonly filesScanned: number;
      /** More matches exist than were returned, or the scan stopped early. */
      readonly truncated: boolean;
      /** Matches whose source could no longer be read when the snippet was taken. */
      readonly unavailableHits: number;
    })
  | (ConnectedFolderToolSuccess & {
      readonly view: "read";
      readonly excerpt: ConnectedFolderToolExcerpt;
      /** First line after this window; absent at the end of the file. */
      readonly nextStartLine?: number | undefined;
    })
  | { readonly ok: false; readonly reason: ConnectedFolderToolFailureReason };

function ownDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === null || prototype === Object.prototype) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (entry) => "value" in entry && entry.enumerable === true,
    )
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}

function validRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).length <= WORKSPACE_PORTABLE_PATH_MAX_BYTES &&
    isValidScopePath(value, { mustBeRelative: true })
  );
}

/** "" names the root of the connected scope; anything else is a contained relative path. */
function validDirectory(value: unknown): value is string {
  return value === "" || validRelativePath(value);
}

function validList(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["view", "directory", "after"]) &&
    validDirectory(value.directory) &&
    validDirectory(value.after)
  );
}

function validQuery(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= CONNECTED_FOLDER_TOOL_LIMITS.queryChars &&
    !hasControlCharacter(value)
  );
}

function validSearch(value: Record<string, unknown>): boolean {
  const modes: readonly unknown[] = CONNECTED_FOLDER_SEARCH_MODES;
  return (
    exactKeys(value, ["view", "mode", "query", "directory", "maxResults"]) &&
    modes.includes(value.mode) &&
    validQuery(value.query) &&
    validDirectory(value.directory) &&
    boundedInteger(value.maxResults, CONNECTED_FOLDER_TOOL_LIMITS.searchHits)
  );
}

function validRead(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["view", "path", "startLine", "maxLines"]) &&
    validRelativePath(value.path) &&
    boundedInteger(value.startLine, Number.MAX_SAFE_INTEGER) &&
    boundedInteger(value.maxLines, CONNECTED_FOLDER_TOOL_LIMITS.readLines) &&
    Number.isSafeInteger(value.startLine + value.maxLines)
  );
}

export function isConnectedFolderToolRequest(value: unknown): value is ConnectedFolderToolRequest {
  if (!ownDataRecord(value)) return false;
  if (value.view === "list") return validList(value);
  if (value.view === "search") return validSearch(value);
  return value.view === "read" && validRead(value);
}

/** Capture caller-owned data before scope checks or asynchronous workspace work. */
export function captureConnectedFolderToolRequest(
  value: unknown,
): ConnectedFolderToolRequest | undefined {
  return isConnectedFolderToolRequest(value) ? Object.freeze({ ...value }) : undefined;
}
