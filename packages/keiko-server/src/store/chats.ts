// ADR-0013 — chats CRUD scoped to a project. Parameterized SQL only.

import type { DatabaseSync } from "node:sqlite";
import type { Chat, CreateChatOptions, UpdateChatPatch } from "./types.js";
import { invalidRequest, notFound } from "./errors.js";

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
  readonly created_at: number;
  readonly updated_at: number;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SQL_LIST =
  "SELECT id, project_path, title, selected_model, branch_label, status, created_at, updated_at FROM chats WHERE project_path = ? ORDER BY created_at ASC";
const SQL_INSERT = `
INSERT INTO chats (id, project_path, title, selected_model, branch_label, status, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
RETURNING id, project_path, title, selected_model, branch_label, status, created_at, updated_at
`;
const SQL_UPDATE = `
UPDATE chats SET
  title = COALESCE(?, title),
  selected_model = COALESCE(?, selected_model),
  branch_label = COALESCE(?, branch_label),
  status = COALESCE(?, status),
  updated_at = ?
WHERE id = ?
RETURNING id, project_path, title, selected_model, branch_label, status, created_at, updated_at
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

function validateChatPatch(patch: UpdateChatPatch): void {
  // Runtime defense: handlers may pass widened (unknown) input cast to UpdateChatPatch.
  const raw: unknown = patch.status;
  if (raw !== undefined && (typeof raw !== "string" || !VALID_CHAT_STATUSES.has(raw))) {
    throw invalidRequest("Invalid status.");
  }
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
  const row = db
    .prepare(SQL_UPDATE)
    .get(titleParam, modelParam, branchParam, statusParam, now, id) as unknown as
    | ChatRow
    | undefined;
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
