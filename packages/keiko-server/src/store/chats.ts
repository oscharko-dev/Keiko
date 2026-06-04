// ADR-0013 — chats CRUD scoped to a project. Parameterized SQL only.

import type { DatabaseSync } from "node:sqlite";
import { isValidScopePath } from "@oscharko-dev/keiko-contracts/connected-context";
import type { Chat, ChatConnectedScope, CreateChatOptions, UpdateChatPatch } from "./types.js";
import { invalidRequest, notFound } from "./errors.js";

const MAX_CONNECTED_SCOPE_PATHS = 50;

const MAX_SELECTED_MODEL_LEN = 160;
const SELECTED_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/\- ]*$/;
const FORBIDDEN_SELECTED_MODEL_TERMS = [
  "apiKey",
  "api_key",
  "baseUrl",
  "base_url",
  "provider",
  "deployment",
  "endpoint",
  "secret",
  "token",
  "credential",
] as const;

interface ChatRow {
  readonly id: string;
  readonly project_path: string;
  readonly title: string;
  readonly selected_model: string;
  readonly branch_label: string | null;
  readonly status: string | null;
  readonly connected_scope_paths: string | null;
  readonly connected_scope_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

// Issue #184 — defensive parse of a persisted JSON scope-paths column. The column is only
// ever written via JSON.stringify on a validated string[]; any row that fails to parse to a
// non-empty string array is treated as a cleared binding rather than throwing, so a corrupted
// row never bricks the chat list. Validation at write time is enforced at the BFF boundary.
function validateDecodedPaths(parsed: unknown): readonly string[] | undefined {
  // Defense-in-depth (Copilot PR #254 finding): even though the BFF boundary validates every
  // entry via isValidScopePath before writing, a corrupted or tampered DB row must not be
  // able to re-introduce an absolute or traversal path on read. The same range cap also
  // applies — a corrupted row carrying 10_000 entries collapses to undefined.
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_CONNECTED_SCOPE_PATHS) {
    return undefined;
  }
  const items: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || !isValidScopePath(entry, { mustBeRelative: true })) {
      return undefined;
    }
    items.push(entry);
  }
  return items;
}

function decodeConnectedScope(
  paths: string | null,
  connectedAt: number | null,
): ChatConnectedScope | undefined {
  if (paths === null || connectedAt === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(paths);
  } catch {
    return undefined;
  }
  const items = validateDecodedPaths(parsed);
  if (items === undefined) {
    return undefined;
  }
  if (!Number.isInteger(connectedAt) || connectedAt < 0) {
    return undefined;
  }
  return { relativePaths: items, connectedAtMs: connectedAt };
}

function rowToChat(row: ChatRow): Chat {
  const status = row.status === null ? undefined : (row.status as "open" | "closed");
  return {
    id: row.id,
    projectPath: row.project_path,
    title: row.title,
    selectedModel: row.selected_model,
    branchLabel: row.branch_label ?? undefined,
    status,
    connectedScope: decodeConnectedScope(row.connected_scope_paths, row.connected_scope_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS =
  "id, project_path, title, selected_model, branch_label, status, " +
  "connected_scope_paths, connected_scope_at, created_at, updated_at";

const SQL_LIST = `SELECT ${SELECT_COLUMNS} FROM chats WHERE project_path = ? ORDER BY created_at ASC`;
const SQL_INSERT = `
INSERT INTO chats (id, project_path, title, selected_model, branch_label, status,
  connected_scope_paths, connected_scope_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
RETURNING ${SELECT_COLUMNS}
`;
// Issue #184 — the trailing CASE WHEN ? = 1 ... ELSE col END pattern lets the caller signal three
// states without polluting the existing four COALESCE columns: apply_scope = 0 → leave both
// scope columns untouched (patch.connectedScope === undefined); apply_scope = 1 → write the two
// scope parameters verbatim (writing NULL into both clears the binding when patch.connectedScope
// === null; writing JSON+ms sets it). The statement contains TWO separate `CASE WHEN ? = 1`
// guards (one per column) so the same apply_scope value is passed twice. Parameter order:
// title, model, branch, status, updated_at, apply_scope, scope_paths, apply_scope, scope_at, id.
const SQL_UPDATE = `
UPDATE chats SET
  title = COALESCE(?, title),
  selected_model = COALESCE(?, selected_model),
  branch_label = COALESCE(?, branch_label),
  status = COALESCE(?, status),
  updated_at = ?,
  connected_scope_paths = CASE WHEN ? = 1 THEN ? ELSE connected_scope_paths END,
  connected_scope_at    = CASE WHEN ? = 1 THEN ? ELSE connected_scope_at END
WHERE id = ?
RETURNING ${SELECT_COLUMNS}
`;
const SQL_DELETE = "DELETE FROM chats WHERE id = ?";
const SQL_PROJECT_EXISTS = "SELECT 1 FROM projects WHERE path = ?";
const SQL_TOUCH = "UPDATE chats SET updated_at = ? WHERE id = ?";

function validateSelectedModel(value: string): void {
  if (value.length === 0) throw invalidRequest("selectedModel is required.");
  if (value.length > MAX_SELECTED_MODEL_LEN || !SELECTED_MODEL_RE.test(value)) {
    throw invalidRequest("selectedModel must be a registry id.");
  }
  const lower = value.toLowerCase();
  if (
    value.includes("://") ||
    value.trim().startsWith("{") ||
    FORBIDDEN_SELECTED_MODEL_TERMS.some((term) => lower.includes(term.toLowerCase()))
  ) {
    throw invalidRequest("selectedModel must be a registry id.");
  }
}

export function listChats(db: DatabaseSync, projectPath: string): readonly Chat[] {
  return (db.prepare(SQL_LIST).all(projectPath) as unknown as ChatRow[]).map(rowToChat);
}

export function insertChat(
  db: DatabaseSync,
  args: {
    readonly id: string;
    readonly projectPath: string;
    readonly title: string;
    readonly selectedModel: string;
    readonly opts: CreateChatOptions | undefined;
    readonly now: number;
  },
): Chat {
  if (args.title.length === 0) throw invalidRequest("Title is required.");
  validateSelectedModel(args.selectedModel);
  const projectExists = db.prepare(SQL_PROJECT_EXISTS).get(args.projectPath) !== undefined;
  if (!projectExists) throw notFound("Project");
  const branch = args.opts?.branchLabel ?? null;
  const row = db
    .prepare(SQL_INSERT)
    .get(
      args.id,
      args.projectPath,
      args.title,
      args.selectedModel,
      branch,
      args.now,
      args.now,
    ) as unknown as ChatRow;
  return rowToChat(row);
}

const VALID_CHAT_STATUSES: ReadonlySet<string> = new Set(["open", "closed"]);

// Issue #184 — defense-in-depth at the store boundary. The BFF handler is the AUTHORITATIVE
// gate (path validation via isValidScopePath, range guard, finite-integer guard); these checks
// are a runtime safety net for in-process callers that bypass HTTP, and for the cast from
// `unknown`. They must never weaken the BFF rules: the criteria here are strict-subset.

function validateConnectedScopeShape(scope: ChatConnectedScope): void {
  if (!Array.isArray(scope.relativePaths)) {
    throw invalidRequest("connectedScope.relativePaths must be an array.");
  }
  if (scope.relativePaths.length === 0 || scope.relativePaths.length > MAX_CONNECTED_SCOPE_PATHS) {
    throw invalidRequest(
      `connectedScope.relativePaths length out of range (1..${String(MAX_CONNECTED_SCOPE_PATHS)}).`,
    );
  }
  for (const entry of scope.relativePaths) {
    if (typeof entry !== "string" || !isValidScopePath(entry, { mustBeRelative: true })) {
      throw invalidRequest(
        "connectedScope.relativePaths must contain valid workspace-relative paths.",
      );
    }
  }
  if (
    typeof scope.connectedAtMs !== "number" ||
    !Number.isInteger(scope.connectedAtMs) ||
    scope.connectedAtMs < 0
  ) {
    throw invalidRequest("connectedScope.connectedAtMs must be a finite non-negative integer.");
  }
}

function validateChatPatch(patch: UpdateChatPatch): void {
  // Runtime defense: handlers may pass widened (unknown) input cast to UpdateChatPatch.
  const raw: unknown = patch.status;
  if (raw !== undefined && (typeof raw !== "string" || !VALID_CHAT_STATUSES.has(raw))) {
    throw invalidRequest("Invalid status.");
  }
  const scope: unknown = patch.connectedScope;
  if (scope !== undefined && scope !== null) {
    if (typeof scope !== "object" || Array.isArray(scope)) {
      throw invalidRequest("connectedScope must be an object or null.");
    }
    validateConnectedScopeShape(scope as ChatConnectedScope);
  }
}

// Issue #184 — three-state encoding of the scope patch for SQL parameter binding.
// `apply = 0` means leave both columns alone; `apply = 1` writes both values verbatim.
interface ScopeUpdateParams {
  readonly apply: 0 | 1;
  readonly pathsJson: string | null;
  readonly connectedAtMs: number | null;
}

function scopeUpdateParams(value: ChatConnectedScope | null | undefined): ScopeUpdateParams {
  if (value === undefined) return { apply: 0, pathsJson: null, connectedAtMs: null };
  if (value === null) return { apply: 1, pathsJson: null, connectedAtMs: null };
  return {
    apply: 1,
    pathsJson: JSON.stringify(value.relativePaths),
    connectedAtMs: value.connectedAtMs,
  };
}

export function updateChat(
  db: DatabaseSync,
  id: string,
  patch: UpdateChatPatch,
  now: number,
): Chat {
  validateChatPatch(patch);
  if (patch.selectedModel !== undefined) validateSelectedModel(patch.selectedModel);
  const titleParam = patch.title ?? null;
  const modelParam = patch.selectedModel ?? null;
  const branchParam = patch.branchLabel ?? null;
  const statusParam = patch.status ?? null;
  const scope = scopeUpdateParams(patch.connectedScope);
  const row = db
    .prepare(SQL_UPDATE)
    .get(
      titleParam,
      modelParam,
      branchParam,
      statusParam,
      now,
      scope.apply,
      scope.pathsJson,
      scope.apply,
      scope.connectedAtMs,
      id,
    ) as unknown as ChatRow | undefined;
  if (row === undefined) throw notFound("Chat");
  return rowToChat(row);
}

export function deleteChat(db: DatabaseSync, id: string): void {
  const info = db.prepare(SQL_DELETE).run(id);
  if (info.changes === 0) throw notFound("Chat");
}

export function touchChat(db: DatabaseSync, id: string, now: number): void {
  const info = db.prepare(SQL_TOUCH).run(now, id);
  if (info.changes === 0) throw notFound("Chat");
}
