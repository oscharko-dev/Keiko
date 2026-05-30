// ADR-0013 — chat_messages CRUD. shortResult is redacted+truncated to ≤ MAX_SHORT_RESULT before persist.

import type { DatabaseSync } from "node:sqlite";
import type { ChatMessage, ChatRole, NewChatMessage, WorkflowStatus } from "./types.js";
import { invalidRequest, notFound } from "./errors.js";

const MAX_SHORT_RESULT = 200;
const ROLES: ReadonlySet<ChatRole> = new Set(["user", "assistant", "system"]);
const STATUSES: ReadonlySet<WorkflowStatus> = new Set(["pending", "running", "completed", "failed"]);

interface MessageRow {
  readonly id: string;
  readonly chat_id: string;
  readonly role: string;
  readonly content: string;
  readonly timestamp: number;
  readonly run_id: string | null;
  readonly workflow_id: string | null;
  readonly workflow_status: string | null;
  readonly short_result: string | null;
}

function rowToMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as ChatRole,
    content: row.content,
    timestamp: row.timestamp,
    runId: row.run_id ?? undefined,
    workflowId: row.workflow_id ?? undefined,
    workflowStatus: (row.workflow_status ?? undefined) as WorkflowStatus | undefined,
    shortResult: row.short_result ?? undefined,
  };
}

const SQL_LIST =
  "SELECT id, chat_id, role, content, timestamp, run_id, workflow_id, workflow_status, short_result FROM chat_messages WHERE chat_id = ? ORDER BY timestamp ASC, id ASC";
const SQL_CHAT_EXISTS = "SELECT 1 FROM chats WHERE id = ?";
const SQL_INSERT = `
INSERT INTO chat_messages
  (id, chat_id, role, content, timestamp, run_id, workflow_id, workflow_status, short_result)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING id, chat_id, role, content, timestamp, run_id, workflow_id, workflow_status, short_result
`;

function validateMessage(msg: NewChatMessage): void {
  if (!ROLES.has(msg.role)) throw invalidRequest("Invalid role.");
  if (msg.content.length === 0) throw invalidRequest("Content is required.");
  if (msg.workflowStatus !== undefined && !STATUSES.has(msg.workflowStatus)) {
    throw invalidRequest("Invalid workflowStatus.");
  }
}

function processShortResult(
  raw: string | undefined,
  redactString: (s: string) => string,
): string | null {
  if (raw === undefined) return null;
  const redacted = redactString(raw);
  return redacted.length > MAX_SHORT_RESULT ? redacted.slice(0, MAX_SHORT_RESULT) : redacted;
}

export function listMessages(db: DatabaseSync, chatId: string): readonly ChatMessage[] {
  return (db.prepare(SQL_LIST).all(chatId) as unknown as MessageRow[]).map(rowToMessage);
}

export function insertMessage(
  db: DatabaseSync,
  id: string,
  msg: NewChatMessage,
  redactString: (s: string) => string,
): ChatMessage {
  validateMessage(msg);
  const chatExists = db.prepare(SQL_CHAT_EXISTS).get(msg.chatId) !== undefined;
  if (!chatExists) throw notFound("Chat");
  const shortResult = processShortResult(msg.shortResult, redactString);
  const row = db
    .prepare(SQL_INSERT)
    .get(
      id,
      msg.chatId,
      msg.role,
      msg.content,
      msg.timestamp,
      msg.runId ?? null,
      msg.workflowId ?? null,
      msg.workflowStatus ?? null,
      shortResult,
    ) as unknown as MessageRow;
  return rowToMessage(row);
}
