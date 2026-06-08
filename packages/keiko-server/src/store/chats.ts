// ADR-0013 — chats CRUD scoped to a project. Parameterized SQL only.

import type { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import {
  SELECTED_SCOPE_KINDS,
  isValidScopePath,
  type SelectedScopeKind,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  DEFAULT_GROUNDING_LIMITS,
  MAX_CONNECTED_SOURCES,
  MAX_LOCAL_KNOWLEDGE_SOURCES,
} from "@oscharko-dev/keiko-contracts/bff-wire";
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
  readonly root?: string;
  // Per-scope connectedAtMs lives inside the multi-source array; absent for legacy single-object
  // and #184 string-array rows, where the column-level connected_scope_at is authoritative.
  readonly connectedAtMs?: number;
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

// Epic #532 — the connected_scope_paths column now holds EITHER a single scope object (legacy)
// OR a JSON array of scope objects (multi-source). The Issue #184 legacy form (a bare array of
// path strings) is still tolerated as a single files scope. Disambiguation: an array whose first
// element is an object is the new multi-source list; an array of strings is the #184 legacy form.
// Epic #532 audit (L2) — defense-in-depth on read. The connectedScope root is fully validated at
// the BFF write path (realpath → deny-list → containment). On read from a possibly-tampered DB row
// we re-assert the SHAPE the writer guarantees: an absolute path. A `root` key that is present but
// not a non-empty absolute string is treated as tampering — the whole scope decode collapses to
// undefined (matching the "a malformed entry can never widen the result" invariant) rather than
// silently grounding against an attacker-chosen relative location.
function decodeScopeRoot(raw: unknown): { readonly ok: boolean; readonly root?: string } {
  if (raw === undefined) return { ok: true };
  if (typeof raw === "string" && raw.length > 0 && isAbsolute(raw)) return { ok: true, root: raw };
  return { ok: false };
}

function decodeSingleScopeObject(raw: Record<string, unknown>): DecodedScopePayload | undefined {
  if (!isSelectedScopeKind(raw.kind) || !Array.isArray(raw.relativePaths)) return undefined;
  const relativePaths = validateScopePathsForKind(raw.kind, raw.relativePaths);
  if (relativePaths === undefined) return undefined;
  const decodedRoot = decodeScopeRoot(raw.root);
  if (!decodedRoot.ok) return undefined;
  const root = decodedRoot.root;
  const connectedAtMs =
    Number.isInteger(raw.connectedAtMs) && (raw.connectedAtMs as number) >= 0
      ? (raw.connectedAtMs as number)
      : undefined;
  return {
    kind: raw.kind,
    relativePaths,
    ...(root !== undefined ? { root } : {}),
    ...(connectedAtMs !== undefined ? { connectedAtMs } : {}),
  };
}

function decodeLegacyFilesArray(parsed: readonly unknown[]): DecodedScopePayload | undefined {
  const relativePaths = validateScopePathsForKind("files", parsed);
  return relativePaths === undefined ? undefined : { kind: "files", relativePaths };
}

function decodeScopeObjectArray(
  entries: readonly unknown[],
): readonly DecodedScopePayload[] | undefined {
  if (entries.length > MAX_CONNECTED_SOURCES) return undefined;
  const payloads: DecodedScopePayload[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const decoded = decodeSingleScopeObject(entry as Record<string, unknown>);
    if (decoded === undefined) return undefined;
    payloads.push(decoded);
  }
  return payloads;
}

function decodeArrayPayload(
  parsed: readonly unknown[],
): readonly DecodedScopePayload[] | undefined {
  if (parsed.length === 0) return undefined;
  if (parsed.every((entry) => typeof entry === "string")) {
    const legacy = decodeLegacyFilesArray(parsed);
    return legacy === undefined ? undefined : [legacy];
  }
  return decodeScopeObjectArray(parsed);
}

// Decodes the column payload into an ORDERED list of scope payloads. A single object yields a
// 1-element list; an array of objects yields one entry per element. The #184 legacy string-array
// form yields a single files scope. A tampered row can never widen the result: any malformed
// entry collapses the whole decode to undefined. Returns undefined when nothing valid was found.
function decodeConnectedScopePayloads(parsed: unknown): readonly DecodedScopePayload[] | undefined {
  if (Array.isArray(parsed)) return decodeArrayPayload(parsed);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const single = decodeSingleScopeObject(parsed as Record<string, unknown>);
  return single === undefined ? undefined : [single];
}

function decodeConnectedScopes(
  paths: string | null,
  connectedAt: number | null,
): readonly ChatConnectedScope[] | undefined {
  if (paths === null || connectedAt === null) return undefined;
  if (!Number.isInteger(connectedAt) || connectedAt < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(paths);
  } catch {
    return undefined;
  }
  const payloads = decodeConnectedScopePayloads(parsed);
  if (payloads === undefined) return undefined;
  return payloads.map((payload) => ({
    kind: payload.kind,
    relativePaths: payload.relativePaths,
    // The newest connectedAtMs lives in the column; per-scope connectedAtMs is carried inside the
    // array (decoded below). Legacy single-object/string-array rows have no per-scope value, so the
    // column timestamp is the authoritative one for every entry in that 1-element list.
    connectedAtMs: payload.connectedAtMs ?? connectedAt,
    ...(payload.root !== undefined ? { root: payload.root } : {}),
  }));
}

function decodeLocalKnowledgeScopeObject(raw: unknown): ChatLocalKnowledgeScope | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const scope = raw as Record<string, unknown>;
  const connectedAtMs = decodeNonNegativeInteger(scope.connectedAtMs);
  if (connectedAtMs === undefined) return undefined;
  return decodeLocalKnowledgeScopePayload(scope, connectedAtMs);
}

// Epic #189 — the local_knowledge_scope_json column now holds EITHER a single scope object (legacy)
// OR a JSON array of scope objects (multi-source). Mirrors decodeConnectedScopes: a single object
// yields a 1-element list; an array yields one entry per element. A tampered row can never widen
// the result — any malformed entry collapses the whole decode to undefined. Returns undefined when
// nothing valid was found (column null, parse error, or any invalid entry).
function decodeLocalKnowledgeScopes(
  raw: string | null,
): readonly ChatLocalKnowledgeScope[] | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) return decodeLocalKnowledgeScopeArray(parsed);
  const single = decodeLocalKnowledgeScopeObject(parsed);
  return single === undefined ? undefined : [single];
}

function decodeLocalKnowledgeScopeArray(
  entries: readonly unknown[],
): readonly ChatLocalKnowledgeScope[] | undefined {
  if (entries.length === 0 || entries.length > MAX_LOCAL_KNOWLEDGE_SOURCES) return undefined;
  const scopes: ChatLocalKnowledgeScope[] = [];
  for (const entry of entries) {
    const decoded = decodeLocalKnowledgeScopeObject(entry);
    if (decoded === undefined) return undefined;
    scopes.push(decoded);
  }
  return scopes;
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
  const connectedScopes = decodeConnectedScopes(row.connected_scope_paths, row.connected_scope_at);
  const localKnowledgeScopes = decodeLocalKnowledgeScopes(row.local_knowledge_scope_json);
  return {
    id: row.id,
    projectPath: row.project_path,
    title: row.title,
    selectedModel: row.selected_model,
    branchLabel: row.branch_label ?? undefined,
    status,
    // Epic #532 — populate BOTH the canonical list and the back-compat single field
    // (= list[0]). Absent binding → both undefined.
    ...(connectedScopes !== undefined && connectedScopes.length > 0
      ? { connectedScopes, connectedScope: connectedScopes[0] }
      : { connectedScope: undefined }),
    // Epic #189 — populate BOTH the canonical connector list and the back-compat single field
    // (= list[0]). Absent binding → both undefined.
    ...(localKnowledgeScopes !== undefined && localKnowledgeScopes.length > 0
      ? { localKnowledgeScopes, localKnowledgeScope: localKnowledgeScopes[0] }
      : { localKnowledgeScope: undefined }),
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

// Epic #532 — validate the multi-source list. Each entry runs the same defense-in-depth shape
// check as the single field; the list is bounded by maxSources (defaults to
// DEFAULT_GROUNDING_LIMITS.maxConnectedSources — a strict subset of the BFF gate). Callers may
// supply a lower operator-configured cap; the store stays self-defending when no limit is passed.
// undefined/null are pass-through (leave-unchanged / clear-all).
function validatePatchScopes(
  scopes: unknown,
  maxSources: number = DEFAULT_GROUNDING_LIMITS.maxConnectedSources,
): void {
  if (scopes === undefined || scopes === null) return;
  if (!Array.isArray(scopes)) {
    throw invalidRequest("connectedScopes must be an array or null.");
  }
  if (scopes.length > maxSources) {
    throw invalidRequest(`connectedScopes must contain at most ${String(maxSources)} sources.`);
  }
  for (const scope of scopes) {
    if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
      throw invalidRequest("connectedScopes entries must be objects.");
    }
    validateConnectedScopeShape(scope as ChatConnectedScope);
  }
}

function validatePatchLocalKnowledgeScope(scope: unknown): void {
  if (scope === undefined || scope === null) return;
  if (typeof scope !== "object" || Array.isArray(scope)) {
    throw invalidRequest("localKnowledgeScope must be an object or null.");
  }
  validateLocalKnowledgeScopeShape(scope as ChatLocalKnowledgeScope);
}

// Epic #189 — validate the multi-source connector list. Each entry runs the same defense-in-depth
// shape check as the single field; the list is bounded by maxSources (defaults to
// DEFAULT_GROUNDING_LIMITS.maxLocalKnowledgeSources — a strict subset of the BFF gate). Callers
// may supply a lower operator-configured cap; the store stays self-defending when no limit is
// passed. undefined/null are pass-through (leave-unchanged / clear-all).
function validatePatchLocalKnowledgeScopes(
  scopes: unknown,
  maxSources: number = DEFAULT_GROUNDING_LIMITS.maxLocalKnowledgeSources,
): void {
  if (scopes === undefined || scopes === null) return;
  if (!Array.isArray(scopes)) {
    throw invalidRequest("localKnowledgeScopes must be an array or null.");
  }
  if (scopes.length > maxSources) {
    throw invalidRequest(
      `localKnowledgeScopes must contain at most ${String(maxSources)} sources.`,
    );
  }
  for (const scope of scopes) {
    if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
      throw invalidRequest("localKnowledgeScopes entries must be objects.");
    }
    validateLocalKnowledgeScopeShape(scope as ChatLocalKnowledgeScope);
  }
}

interface ChatPatchLimits {
  readonly maxConnectedSources?: number;
  readonly maxLocalKnowledgeSources?: number;
}

function validateChatPatch(patch: UpdateChatPatch, limits?: ChatPatchLimits): void {
  // Runtime defense: handlers may pass widened (unknown) input cast to UpdateChatPatch.
  const raw: unknown = patch.status;
  if (raw !== undefined && (typeof raw !== "string" || !VALID_CHAT_STATUSES.has(raw))) {
    throw invalidRequest("Invalid status.");
  }
  validatePatchScope(patch.connectedScope);
  validatePatchScopes(patch.connectedScopes, limits?.maxConnectedSources);
  validatePatchLocalKnowledgeScope(patch.localKnowledgeScope);
  validatePatchLocalKnowledgeScopes(patch.localKnowledgeScopes, limits?.maxLocalKnowledgeSources);
}

// Epic #532 — resolve the effective scope-patch intent. `connectedScopes` SUPERSEDES the legacy
// single `connectedScope`: when the list field is present (including null), it wins. A single
// `connectedScope` object is normalized to a 1-element list. Returns undefined (leave unchanged),
// null (clear all), or the ordered list to persist.
function resolveScopePatch(
  patch: UpdateChatPatch,
): readonly ChatConnectedScope[] | null | undefined {
  if (patch.connectedScopes !== undefined) {
    if (patch.connectedScopes === null || patch.connectedScopes.length === 0) return null;
    return patch.connectedScopes;
  }
  if (patch.connectedScope === undefined) return undefined;
  if (patch.connectedScope === null) return null;
  return [patch.connectedScope];
}

// Issue #184 — three-state encoding of the scope patch for SQL parameter binding.
// `apply = 0` means leave both columns alone; `apply = 1` writes both values verbatim.
interface ScopeUpdateParams {
  readonly apply: 0 | 1;
  readonly pathsJson: string | null;
  readonly connectedAtMs: number | null;
}

function encodeScopeObject(value: ChatConnectedScope): Record<string, unknown> {
  return {
    kind: value.kind,
    relativePaths: value.relativePaths,
    // Epic #532 — persist the optional scope root (a folder outside the chat's project) inside the
    // existing connected_scope_paths JSON column, so no schema migration is needed.
    ...(value.root !== undefined ? { root: value.root } : {}),
    // Per-scope connectedAtMs is carried inside the array so each source keeps its own connect time;
    // the column-level connected_scope_at holds the newest value (for legacy single-object readers).
    connectedAtMs: value.connectedAtMs,
  };
}

// Epic #532 — encode the resolved scope-patch intent. A single source encodes as the legacy single
// object (byte-identical to the pre-#532 single-source form, so back-compat decode is unchanged); a
// multi-source list encodes as a JSON array. connected_scope_at = newest per-scope connectedAtMs.
function scopeUpdateParams(
  value: readonly ChatConnectedScope[] | null | undefined,
): ScopeUpdateParams {
  if (value === undefined) return { apply: 0, pathsJson: null, connectedAtMs: null };
  if (value === null || value.length === 0) {
    return { apply: 1, pathsJson: null, connectedAtMs: null };
  }
  const newestConnectedAtMs = value.reduce((max, scope) => Math.max(max, scope.connectedAtMs), 0);
  const first = value[0];
  if (value.length === 1 && first !== undefined) {
    const single = encodeScopeObject(first);
    delete single.connectedAtMs;
    return { apply: 1, pathsJson: JSON.stringify(single), connectedAtMs: first.connectedAtMs };
  }
  return {
    apply: 1,
    pathsJson: JSON.stringify(value.map(encodeScopeObject)),
    connectedAtMs: newestConnectedAtMs,
  };
}

interface LocalKnowledgeScopeUpdateParams {
  readonly apply: 0 | 1;
  readonly json: string | null;
}

function encodeLocalKnowledgeScopeObject(value: ChatLocalKnowledgeScope): Record<string, unknown> {
  return value.kind === "capsule"
    ? { kind: "capsule", capsuleId: value.capsuleId, connectedAtMs: value.connectedAtMs }
    : { kind: "capsule-set", capsuleSetId: value.capsuleSetId, connectedAtMs: value.connectedAtMs };
}

// Epic #189 — resolve the effective connector-patch intent. `localKnowledgeScopes` (plural)
// SUPERSEDES the legacy single `localKnowledgeScope`: when the list field is present (including
// null), it wins. A single object normalizes to a 1-element list. Returns undefined (leave
// unchanged), null (clear), or the ordered list to persist. Mirrors resolveScopePatch (#532).
function resolveLocalKnowledgeScopePatch(
  patch: UpdateChatPatch,
): readonly ChatLocalKnowledgeScope[] | null | undefined {
  if (patch.localKnowledgeScopes !== undefined) {
    if (patch.localKnowledgeScopes === null || patch.localKnowledgeScopes.length === 0) return null;
    return patch.localKnowledgeScopes;
  }
  if (patch.localKnowledgeScope === undefined) return undefined;
  if (patch.localKnowledgeScope === null) return null;
  return [patch.localKnowledgeScope];
}

// Epic #189 — encode the resolved connector-patch intent into the single local_knowledge_scope_json
// column. A single source encodes as the legacy single object (byte-identical to the pre-#189 form,
// so back-compat decode is unchanged); a multi-source list encodes as a JSON array. Mirrors
// scopeUpdateParams (#532); per-scope connectedAtMs lives inside each object.
function localKnowledgeScopesUpdateParams(
  value: readonly ChatLocalKnowledgeScope[] | null | undefined,
): LocalKnowledgeScopeUpdateParams {
  if (value === undefined) return { apply: 0, json: null };
  if (value === null || value.length === 0) return { apply: 1, json: null };
  const first = value[0];
  if (value.length === 1 && first !== undefined) {
    return { apply: 1, json: JSON.stringify(encodeLocalKnowledgeScopeObject(first)) };
  }
  return { apply: 1, json: JSON.stringify(value.map(encodeLocalKnowledgeScopeObject)) };
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
  const scope = scopeUpdateParams(resolveScopePatch(patch));
  const localScope = localKnowledgeScopesUpdateParams(resolveLocalKnowledgeScopePatch(patch));
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
