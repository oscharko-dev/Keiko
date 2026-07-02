// ADR-0013 — chat_messages CRUD. shortResult is redacted+truncated to ≤ MAX_SHORT_RESULT before persist.
// Issue #66 adds:
//   - `cancelled` to the accepted workflow status set (parity with src/ui/runs.ts RunStatus).
//   - `task_type` column read/write so non-workflow runs (verify/explain-plan) can be labelled.
//   - updateMessage(): partial PATCH on the row, re-using the existing redact+truncate path.

import type { DatabaseSync } from "node:sqlite";
import type {
  ChatMessage,
  ChatRole,
  GroundedAnswer,
  NewChatMessage,
  StoredPdfCitationPreviewCitation,
  UpdateChatMessagePatch,
  WorkflowStatus,
} from "./types.js";
import { invalidRequest, notFound } from "./errors.js";

const MAX_SHORT_RESULT = 200;
const MAX_TASK_TYPE = 64;
// Constrained to a-z, digits, and a single inner `-` so the label remains URL-safe and survives
// a SQL round-trip. Identical to the rule the BFF descriptors use for taskType identifiers.
const TASK_TYPE_RE = /^[a-z][a-z0-9-]*$/;

const ROLES: ReadonlySet<ChatRole> = new Set(["user", "assistant", "system"]);
const STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

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
  readonly task_type: string | null;
  readonly grounded_answer_json: string | null;
  readonly grounded_preview_citations_json: string | null;
}

function parseGroundedAnswer(raw: string | null): GroundedAnswer | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as GroundedAnswer;
  } catch {
    return undefined;
  }
}

function parseGroundedPreviewCitations(
  raw: string | null,
): readonly StoredPdfCitationPreviewCitation[] | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as readonly StoredPdfCitationPreviewCitation[];
  } catch {
    return undefined;
  }
}

function rowToMessage(row: MessageRow): ChatMessage {
  const groundedAnswer = parseGroundedAnswer(row.grounded_answer_json);
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
    taskType: row.task_type ?? undefined,
    ...(groundedAnswer === undefined ? {} : { groundedAnswer }),
  };
}

const COLUMNS =
  "id, chat_id, role, content, timestamp, run_id, workflow_id, workflow_status, short_result, task_type, grounded_answer_json, grounded_preview_citations_json";

const SQL_LIST = `SELECT ${COLUMNS} FROM chat_messages WHERE chat_id = ? ORDER BY timestamp ASC, rowid ASC`;
const SQL_LIST_LIMITED = `
SELECT ${COLUMNS}
FROM (
  SELECT rowid AS __rowid, ${COLUMNS}
  FROM chat_messages
  WHERE chat_id = ?
  ORDER BY timestamp DESC, rowid DESC
  LIMIT ?
)
ORDER BY timestamp ASC, __rowid ASC`;
const SQL_LIST_PREFIX_LIMITED = `${SQL_LIST} LIMIT ?`;
const SQL_COUNT = "SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ?";
const SQL_FIND_BY_ID = `SELECT ${COLUMNS} FROM chat_messages WHERE id = ? LIMIT 1`;
const SQL_CHAT_EXISTS = "SELECT 1 FROM chats WHERE id = ?";
const SQL_REPLACE_ASSISTANT_CONTENT = `
  UPDATE chat_messages
  SET content = ?, timestamp = ?
  WHERE id = ? AND role = 'assistant'
  RETURNING ${COLUMNS}
`;
const SQL_INSERT = `
INSERT INTO chat_messages
  (id, chat_id, role, content, timestamp, run_id, workflow_id, workflow_status, short_result, task_type, grounded_answer_json, grounded_preview_citations_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING ${COLUMNS}
`;

function validateTaskType(value: string): void {
  if (value.length === 0 || value.length > MAX_TASK_TYPE || !TASK_TYPE_RE.test(value)) {
    throw invalidRequest("Invalid taskType.");
  }
}

function hasRunSummaryFields(msg: NewChatMessage): boolean {
  return (
    msg.runId !== undefined ||
    msg.workflowId !== undefined ||
    msg.workflowStatus !== undefined ||
    msg.shortResult !== undefined ||
    msg.taskType !== undefined
  );
}

function validateRunIdentifiers(msg: NewChatMessage): void {
  if (msg.runId?.length === 0) {
    throw invalidRequest("runId is required for run summaries.");
  }
  if (msg.workflowId?.length === 0) {
    throw invalidRequest("workflowId must be non-empty.");
  }
}

function validateRunSummaryScope(msg: NewChatMessage): void {
  if (hasRunSummaryFields(msg) && (msg.role !== "system" || msg.runId === undefined)) {
    throw invalidRequest("Run summary fields require a system message with runId.");
  }
  if (msg.groundedAnswer !== undefined && msg.role !== "assistant") {
    throw invalidRequest("Grounded answer metadata requires an assistant message.");
  }
}

function validateMessage(msg: NewChatMessage): void {
  if (!ROLES.has(msg.role)) throw invalidRequest("Invalid role.");
  if (msg.content.length === 0) throw invalidRequest("Content is required.");
  validateRunIdentifiers(msg);
  validateRunSummaryScope(msg);
  if (msg.workflowStatus !== undefined && !STATUSES.has(msg.workflowStatus)) {
    throw invalidRequest("Invalid workflowStatus.");
  }
  if (msg.taskType !== undefined) validateTaskType(msg.taskType);
}

function processShortResult(
  raw: string | undefined,
  redactString: (s: string) => string,
): string | null {
  if (raw === undefined) return null;
  const redacted = redactString(raw);
  return redacted.length > MAX_SHORT_RESULT ? redacted.slice(0, MAX_SHORT_RESULT) : redacted;
}

function processGroundedAnswer(
  raw: GroundedAnswer | undefined,
  redactString: (s: string) => string,
): string | null {
  if (raw === undefined) return null;
  const redacted = redactString(JSON.stringify(raw));
  try {
    JSON.parse(redacted);
  } catch {
    throw invalidRequest("Grounded answer metadata is invalid.");
  }
  return redacted;
}

function processGroundedPreviewCitations(
  raw: readonly StoredPdfCitationPreviewCitation[] | undefined,
): string | null {
  if (raw === undefined) return null;
  const json = JSON.stringify(raw);
  try {
    JSON.parse(json);
  } catch {
    throw invalidRequest("Grounded preview citation metadata is invalid.");
  }
  return json;
}

export function listMessages(db: DatabaseSync, chatId: string): readonly ChatMessage[] {
  return (db.prepare(SQL_LIST).all(chatId) as unknown as MessageRow[]).map(rowToMessage);
}

export function listMessagesLimited(
  db: DatabaseSync,
  chatId: string,
  limit: number,
): readonly ChatMessage[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw invalidRequest("limit must be a positive integer.");
  }
  return (db.prepare(SQL_LIST_LIMITED).all(chatId, limit) as unknown as MessageRow[]).map(
    rowToMessage,
  );
}

export function listMessagesPrefixLimited(
  db: DatabaseSync,
  chatId: string,
  limit: number,
): readonly ChatMessage[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw invalidRequest("limit must be a positive integer.");
  }
  return (db.prepare(SQL_LIST_PREFIX_LIMITED).all(chatId, limit) as unknown as MessageRow[]).map(
    rowToMessage,
  );
}

export function countMessages(db: DatabaseSync, chatId: string): number {
  const row = db.prepare(SQL_COUNT).get(chatId) as { count?: unknown } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

export function findMessageById(db: DatabaseSync, id: string): ChatMessage | undefined {
  const row = db.prepare(SQL_FIND_BY_ID).get(id) as unknown as MessageRow | undefined;
  return row === undefined ? undefined : rowToMessage(row);
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
  const groundedAnswer = processGroundedAnswer(msg.groundedAnswer, redactString);
  const groundedPreviewCitations = null;
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
      msg.taskType ?? null,
      groundedAnswer,
      groundedPreviewCitations,
    ) as unknown as MessageRow;
  return rowToMessage(row);
}

export function attachGroundedAnswer(
  db: DatabaseSync,
  id: string,
  answer: GroundedAnswer,
  previewCitations: readonly StoredPdfCitationPreviewCitation[] | undefined,
  redactString: (s: string) => string,
): ChatMessage {
  const groundedAnswer = processGroundedAnswer(answer, redactString);
  const groundedPreviewCitations = processGroundedPreviewCitations(previewCitations);
  const row = db
    .prepare(
      `
        UPDATE chat_messages
        SET grounded_answer_json = ?, grounded_preview_citations_json = ?
        WHERE id = ? AND role = 'assistant'
        RETURNING ${COLUMNS}
      `,
    )
    .get(groundedAnswer, groundedPreviewCitations, id) as unknown as MessageRow | undefined;
  if (row === undefined) throw notFound("Message");
  return rowToMessage(row);
}

export function findGroundedPreviewCitations(
  db: DatabaseSync,
  id: string,
): readonly StoredPdfCitationPreviewCitation[] | undefined {
  const row = db.prepare(SQL_FIND_BY_ID).get(id) as unknown as MessageRow | undefined;
  return row === undefined
    ? undefined
    : parseGroundedPreviewCitations(row.grounded_preview_citations_json);
}

// Issue #66 — Partial PATCH on a system run-summary message. Builds a dynamic SET clause from the
// supplied fields so absent fields are not overwritten. shortResult goes through the existing
// redact+truncate pipeline. workflowStatus and taskType are validated before SQL is built. An
// empty patch is an invalid_request — the route surface guards this earlier, but the store layer
// also fails-closed.
export function updateMessage(
  db: DatabaseSync,
  id: string,
  patch: UpdateChatMessagePatch,
  redactString: (s: string) => string,
): ChatMessage {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (patch.workflowStatus !== undefined) {
    if (!STATUSES.has(patch.workflowStatus)) throw invalidRequest("Invalid workflowStatus.");
    sets.push("workflow_status = ?");
    args.push(patch.workflowStatus);
  }
  if (patch.shortResult !== undefined) {
    sets.push("short_result = ?");
    args.push(processShortResult(patch.shortResult, redactString));
  }
  if (patch.taskType !== undefined) {
    validateTaskType(patch.taskType);
    sets.push("task_type = ?");
    args.push(patch.taskType);
  }
  if (sets.length === 0) {
    throw invalidRequest("PATCH body must include at least one updatable field.");
  }
  const sql = `
    UPDATE chat_messages
    SET ${sets.join(", ")}
    WHERE id = ? AND role = 'system' AND run_id IS NOT NULL AND length(run_id) > 0
    RETURNING ${COLUMNS}
  `;
  const row = db.prepare(sql).get(...args, id) as unknown as MessageRow | undefined;
  if (row === undefined) throw notFound("Message");
  return rowToMessage(row);
}

export function replaceAssistantMessageContent(
  db: DatabaseSync,
  id: string,
  content: string,
  timestamp: number,
): ChatMessage {
  if (content.length === 0) throw invalidRequest("Content is required.");
  const row = db.prepare(SQL_REPLACE_ASSISTANT_CONTENT).get(content, timestamp, id) as unknown as
    | MessageRow
    | undefined;
  if (row === undefined) throw notFound("Message");
  return rowToMessage(row);
}
