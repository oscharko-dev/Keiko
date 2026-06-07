// ADR-0013 — chats CRUD scoped to a project. Parameterized SQL only.

import type { DatabaseSync } from "node:sqlite";
import {
  SELECTED_SCOPE_KINDS,
  isValidScopePath,
  type SelectedScopeKind,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type {
  Chat,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  CreateChatOptions,
  UpdateChatPatch,
} from "./types.js";
import { invalidRequest, notFound } from "./errors.js";

const MAX_CONNECTED_SCOPE_PATHS = 50;
const SELECTED_SCOPE_KIND_SET: ReadonlySet<SelectedScopeKind> = new Set(SELECTED_SCOPE_KINDS);

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
  readonly local_knowledge_scope_json: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface DecodedScopePayload {
  readonly kind: SelectedScopeKind;
  readonly relativePaths: readonly string[];
}

function isSelectedScopeKind(value: unknown): value is SelectedScopeKind {
  return typeof value === "string" && SELECTED_SCOPE_KIND_SET.has(value as SelectedScopeKind);
}

function hasValidPathCount(kind: SelectedScopeKind, count: number): boolean {
  if (kind === "workspace-root") return count === 0;
  if (kind === "directory") return count === 1;
  return count > 0 && count <= MAX_CONNECTED_SCOPE_PATHS;
}

// Issue #184 — validates scope-path cardinality and path shape against SelectedScope semantics.
// Repository-root scopes intentionally carry an empty path array; directory scopes carry exactly
// one relative path; files scopes carry one or more workspace-relative entries.
function validateScopePathsForKind(
  kind: SelectedScopeKind,
  paths: readonly unknown[],
): readonly string[] | undefined {
  // Defense-in-depth (Copilot PR #254 finding): even though the BFF boundary validates every
  // entry via isValidScopePath before writing, a corrupted or tampered DB row must not be
  // able to re-introduce an absolute or traversal path on read. The same range cap also
  // applies — a corrupted row carrying 10_000 entries collapses to undefined.
  if (!hasValidPathCount(kind, paths.length)) {
    return undefined;
  }
  const items: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== "string" || !isValidScopePath(entry, { mustBeRelative: true })) {
      return undefined;
    }
    items.push(entry);
  }
  return items;
}

function decodeConnectedScopePayload(parsed: unknown): DecodedScopePayload | undefined {
  // PR #254 wrote legacy JSON arrays. Treat them as files scopes so existing rows survive the
  // Issue #184 audit fix that adds explicit scope kind support.
  if (Array.isArray(parsed)) {
    const relativePaths = validateScopePathsForKind("files", parsed);
    return relativePaths === undefined ? undefined : { kind: "files", relativePaths };
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = parsed as Record<string, unknown>;
  if (!isSelectedScopeKind(raw.kind) || !Array.isArray(raw.relativePaths)) return undefined;
  const relativePaths = validateScopePathsForKind(raw.kind, raw.relativePaths);
  return relativePaths === undefined ? undefined : { kind: raw.kind, relativePaths };
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
  const payload = decodeConnectedScopePayload(parsed);
  if (payload === undefined) {
    return undefined;
  }
  if (!Number.isInteger(connectedAt) || connectedAt < 0) {
    return undefined;
  }
  return { kind: payload.kind, relativePaths: payload.relativePaths, connectedAtMs: connectedAt };
}

function decodeLocalKnowledgeScope(raw: string | null): ChatLocalKnowledgeScope | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const scope = parsed as Record<string, unknown>;
  const connectedAtMs = decodeNonNegativeInteger(scope.connectedAtMs);
  if (connectedAtMs === undefined) return undefined;
  return decodeLocalKnowledgeScopePayload(scope, connectedAtMs);
}

function decodeNonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function decodeLocalKnowledgeScopePayload(
  scope: Record<string, unknown>,
  connectedAtMs: number,
): ChatLocalKnowledgeScope | undefined {
  if (scope.kind === "capsule" && typeof scope.capsuleId === "string") {
    return {
      kind: "capsule",
      capsuleId: scope.capsuleId as Extract<
        ChatLocalKnowledgeScope,
        { readonly kind: "capsule" }
      >["capsuleId"],
      connectedAtMs,
    };
  }
  if (scope.kind === "capsule-set" && typeof scope.capsuleSetId === "string") {
    return {
      kind: "capsule-set",
      capsuleSetId: scope.capsuleSetId as Extract<
        ChatLocalKnowledgeScope,
        { readonly kind: "capsule-set" }
      >["capsuleSetId"],
      connectedAtMs,
    };
  }
  return undefined;
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
    localKnowledgeScope: decodeLocalKnowledgeScope(row.local_knowledge_scope_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS =
  "id, project_path, title, selected_model, branch_label, status, " +
  "connected_scope_paths, connected_scope_at, local_knowledge_scope_json, created_at, updated_at";

const SQL_LIST = `SELECT ${SELECT_COLUMNS} FROM chats WHERE project_path = ? ORDER BY created_at ASC`;
const SQL_LIST_LIMITED = `${SQL_LIST} LIMIT ?`;
// Epic #177 audit: grounded-ask and chat PATCH paths used a project-scan + chat-scan helper that
// fired O(projects × chats) row fetches per request. The chat id is unique across projects (the
// schema enforces it via the chats.id primary key), so a single-row lookup is correct and bounded.
const SQL_FIND_BY_ID = `SELECT ${SELECT_COLUMNS} FROM chats WHERE id = ? LIMIT 1`;
const SQL_INSERT = `
INSERT INTO chats (id, project_path, title, selected_model, branch_label, status,
  connected_scope_paths, connected_scope_at, local_knowledge_scope_json, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
RETURNING ${SELECT_COLUMNS}
`;
// Issue #184 — the trailing CASE WHEN ? = 1 ... ELSE col END pattern lets the caller signal three
// states without polluting the existing four COALESCE columns: apply_scope = 0 → leave both
// scope columns untouched (patch.connectedScope === undefined); apply_scope = 1 → write the two
// scope parameters verbatim (writing NULL into both clears the binding when patch.connectedScope
// === null; writing JSON+ms sets it). The statement contains TWO separate `CASE WHEN ? = 1`
// guards (one per column) so the same apply_scope value is passed twice. The local-knowledge
// scope uses the same 3-state encoding against a single JSON column. Parameter order:
// title, model, branch, status, updated_at, apply_scope, scope_paths, apply_scope, scope_at,
// apply_local_scope, local_scope_json, id.
const SQL_UPDATE = `
UPDATE chats SET
  title = COALESCE(?, title),
  selected_model = COALESCE(?, selected_model),
  branch_label = COALESCE(?, branch_label),
  status = COALESCE(?, status),
  updated_at = ?,
  connected_scope_paths = CASE WHEN ? = 1 THEN ? ELSE connected_scope_paths END,
  connected_scope_at    = CASE WHEN ? = 1 THEN ? ELSE connected_scope_at END,
  local_knowledge_scope_json = CASE WHEN ? = 1 THEN ? ELSE local_knowledge_scope_json END
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

export function listChatsLimited(
  db: DatabaseSync,
  projectPath: string,
  limit: number,
): readonly Chat[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw invalidRequest("limit must be a positive integer.");
  }
  return (db.prepare(SQL_LIST_LIMITED).all(projectPath, limit) as unknown as ChatRow[]).map(
    rowToChat,
  );
}

export function findChatById(db: DatabaseSync, id: string): Chat | undefined {
  const row = db.prepare(SQL_FIND_BY_ID).get(id) as unknown as ChatRow | undefined;
  return row === undefined ? undefined : rowToChat(row);
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
  if (!isSelectedScopeKind(scope.kind)) {
    throw invalidRequest("connectedScope.kind must be a recognized scope kind.");
  }
  if (!Array.isArray(scope.relativePaths)) {
    throw invalidRequest("connectedScope.relativePaths must be an array.");
  }
  if (validateScopePathsForKind(scope.kind, scope.relativePaths) === undefined) {
    throw invalidRequest(
      "connectedScope.relativePaths must match connectedScope.kind and contain valid workspace-relative paths.",
    );
  }
  if (
    typeof scope.connectedAtMs !== "number" ||
    !Number.isInteger(scope.connectedAtMs) ||
    scope.connectedAtMs < 0
  ) {
    throw invalidRequest("connectedScope.connectedAtMs must be a finite non-negative integer.");
  }
}

function validateLocalKnowledgeScopeShape(scope: ChatLocalKnowledgeScope): void {
  if (
    typeof scope.connectedAtMs !== "number" ||
    !Number.isInteger(scope.connectedAtMs) ||
    scope.connectedAtMs < 0
  ) {
    throw invalidRequest(
      "localKnowledgeScope.connectedAtMs must be a finite non-negative integer.",
    );
  }
  switch (scope.kind) {
    case "capsule":
      if (typeof scope.capsuleId !== "string" || scope.capsuleId.length === 0) {
        throw invalidRequest("localKnowledgeScope.capsuleId must be a non-empty string.");
      }
      return;
    case "capsule-set":
      if (typeof scope.capsuleSetId !== "string" || scope.capsuleSetId.length === 0) {
        throw invalidRequest("localKnowledgeScope.capsuleSetId must be a non-empty string.");
      }
      return;
    default:
      throw invalidRequest("localKnowledgeScope.kind must be capsule or capsule-set.");
  }
}

function validatePatchScope(scope: unknown): void {
  if (scope === undefined || scope === null) return;
  if (typeof scope !== "object" || Array.isArray(scope)) {
    throw invalidRequest("connectedScope must be an object or null.");
  }
  validateConnectedScopeShape(scope as ChatConnectedScope);
}

function validatePatchLocalKnowledgeScope(scope: unknown): void {
  if (scope === undefined || scope === null) return;
  if (typeof scope !== "object" || Array.isArray(scope)) {
    throw invalidRequest("localKnowledgeScope must be an object or null.");
  }
  validateLocalKnowledgeScopeShape(scope as ChatLocalKnowledgeScope);
}

function validateChatPatch(patch: UpdateChatPatch): void {
  // Runtime defense: handlers may pass widened (unknown) input cast to UpdateChatPatch.
  const raw: unknown = patch.status;
  if (raw !== undefined && (typeof raw !== "string" || !VALID_CHAT_STATUSES.has(raw))) {
    throw invalidRequest("Invalid status.");
  }
  validatePatchScope(patch.connectedScope);
  validatePatchLocalKnowledgeScope(patch.localKnowledgeScope);
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
    pathsJson: JSON.stringify({ kind: value.kind, relativePaths: value.relativePaths }),
    connectedAtMs: value.connectedAtMs,
  };
}

interface LocalKnowledgeScopeUpdateParams {
  readonly apply: 0 | 1;
  readonly json: string | null;
}

function localKnowledgeScopeUpdateParams(
  value: ChatLocalKnowledgeScope | null | undefined,
): LocalKnowledgeScopeUpdateParams {
  if (value === undefined) return { apply: 0, json: null };
  if (value === null) return { apply: 1, json: null };
  if (value.kind === "capsule") {
    return {
      apply: 1,
      json: JSON.stringify({
        kind: "capsule",
        capsuleId: value.capsuleId,
        connectedAtMs: value.connectedAtMs,
      }),
    };
  }
  return {
    apply: 1,
    json: JSON.stringify({
      kind: "capsule-set",
      capsuleSetId: value.capsuleSetId,
      connectedAtMs: value.connectedAtMs,
    }),
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
  const localScope = localKnowledgeScopeUpdateParams(patch.localKnowledgeScope);
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
      localScope.apply,
      localScope.json,
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
