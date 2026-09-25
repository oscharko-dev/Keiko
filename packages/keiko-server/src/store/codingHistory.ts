import { withImmediateTransaction } from "./transaction.js";
import type { DatabaseSync } from "node:sqlite";
import type {
  CodingHistoryTask,
  CodingHistoryDetail,
  ChatMessage,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { UiStore } from "./types.js";
import { invalidRequest, notFound } from "./errors.js";

export interface CodingHistoryCreateInput {
  readonly projectPath: string;
  readonly title: string;
  readonly modelId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly operatorDigest: string;
}

export interface CodingHistoryBeginInput extends CodingHistoryCreateInput {
  readonly conversationId?: string;
  readonly runId: string;
  readonly intent: string;
}

export interface CodingHistoryStore {
  readonly begin: (input: CodingHistoryBeginInput) => CodingHistoryTask;
  readonly create: (input: CodingHistoryCreateInput) => CodingHistoryTask;
  readonly get: (id: string, operatorDigest?: string) => CodingHistoryTask | undefined;
  readonly list: (operatorDigest: string) => readonly CodingHistoryTask[];
  readonly messagesBeforeRun: (id: string, runId: string) => readonly ChatMessage[];
  readonly detail: (id: string, operatorDigest: string) => CodingHistoryDetail | undefined;
  readonly forRun: (runId: string) => CodingHistoryTask | undefined;
  readonly bindRun: (id: string, runId: string) => void;
  readonly update: (
    id: string,
    patch: { readonly title?: string; readonly status?: "active" | "completed" },
  ) => CodingHistoryTask;
  readonly upsert: (
    id: string,
    runId: string,
    sourceId: string,
    role: "user" | "assistant",
    content: string,
  ) => boolean;
  readonly append: (
    id: string,
    runId: string,
    sourceId: string,
    role: "user" | "assistant",
    content: string,
  ) => void;
}

interface HistoryRow {
  readonly chat_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly operator_digest: string;
  readonly status: "active" | "completed";
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
export const CODING_HISTORY_MESSAGE_MAX_CHARS = 65_536;

function assertId(value: string): void {
  if (!SAFE_ID.test(value)) throw invalidRequest("Invalid Coding History identity.");
}

function readTask(
  db: DatabaseSync,
  store: UiStore,
  id: string,
  operator?: string,
): CodingHistoryTask | undefined {
  const row = db
    .prepare("SELECT * FROM coding_history_tasks WHERE chat_id = ?")
    .get(id) as unknown as HistoryRow | undefined;
  if (row === undefined || (operator !== undefined && row.operator_digest !== operator))
    return undefined;
  const chat = store.findChatById(id);
  if (chat === undefined) return undefined;
  const latest = db
    .prepare(
      "SELECT run_id FROM coding_history_runs WHERE chat_id = ? ORDER BY sequence DESC LIMIT 1",
    )
    .get(id);
  return {
    id,
    title: chat.title,
    projectPath: chat.projectPath,
    modelId: chat.selectedModel,
    branch: chat.branchLabel ?? "",
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    status: row.status,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    ...(typeof latest?.run_id === "string" ? { latestRunId: latest.run_id } : {}),
  };
}

function requireTask(db: DatabaseSync, store: UiStore, id: string): CodingHistoryTask {
  const task = readTask(db, store, id);
  if (task === undefined) throw notFound("Coding task");
  return task;
}

function createTask(
  db: DatabaseSync,
  store: UiStore,
  input: CodingHistoryCreateInput,
): CodingHistoryTask {
  assertId(input.workspaceId);
  assertId(input.taskId);
  if (!/^[a-f0-9]{64}$/u.test(input.operatorDigest))
    throw invalidRequest("Invalid operator identity.");
  return withImmediateTransaction(db, () => {
    if (!store.listProjects().some((project) => project.path === input.projectPath))
      store.createProject(input.projectPath);
    const chat = store.createChat(input.projectPath, input.title.trim(), input.modelId, {
      branchLabel: input.branch,
    });
    db.prepare("INSERT INTO coding_history_tasks VALUES (?, ?, ?, ?, 'active')").run(
      chat.id,
      input.workspaceId,
      input.taskId,
      input.operatorDigest,
    );
    return requireTask(db, store, chat.id);
  });
}

function beginTask(
  db: DatabaseSync,
  store: UiStore,
  now: () => number,
  input: CodingHistoryBeginInput,
): CodingHistoryTask {
  return withImmediateTransaction(db, () => {
    const task =
      input.conversationId === undefined
        ? createTask(db, store, input)
        : readTask(db, store, input.conversationId, input.operatorDigest);
    if (task === undefined) throw notFound("Coding task");
    bindRun(db, store, task.id, input.runId, now);
    appendMessage(db, store, now, {
      id: task.id,
      runId: input.runId,
      sourceId: "intent",
      role: "user",
      content: input.intent,
    });
    return requireTask(db, store, task.id);
  });
}

function bindRun(
  db: DatabaseSync,
  store: UiStore,
  id: string,
  runId: string,
  now: () => number,
): void {
  assertId(runId);
  requireTask(db, store, id);
  const existing = db
    .prepare("SELECT chat_id FROM coding_history_runs WHERE run_id = ?")
    .get(runId);
  if (existing?.chat_id === id) return;
  if (existing !== undefined) throw invalidRequest("Run already belongs to another coding task.");
  withImmediateTransaction(db, () => {
    db.prepare(
      "INSERT INTO coding_history_runs SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1 FROM coding_history_runs WHERE chat_id = ?",
    ).run(runId, id, id);
    db.prepare("UPDATE coding_history_tasks SET status = 'active' WHERE chat_id = ?").run(id);
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now(), id);
  });
}

function appendMessage(
  db: DatabaseSync,
  store: UiStore,
  now: () => number,
  input: {
    readonly id: string;
    readonly runId: string;
    readonly sourceId: string;
    readonly role: "user" | "assistant";
    readonly content: string;
  },
): void {
  const { id, runId, sourceId, role, content } = input;
  assertId(sourceId);
  if (content.length === 0 || content.length > CODING_HISTORY_MESSAGE_MAX_CHARS)
    throw invalidRequest("Invalid coding message size.");
  const binding = db.prepare("SELECT chat_id FROM coding_history_runs WHERE run_id = ?").get(runId);
  if (binding?.chat_id !== id) throw invalidRequest("Coding task run binding mismatch.");
  withImmediateTransaction(db, () => {
    if (
      db
        .prepare("SELECT 1 FROM coding_history_message_bindings WHERE run_id = ? AND source_id = ?")
        .get(runId, sourceId) !== undefined
    )
      return;
    const message = store.createMessage({
      chatId: id,
      role,
      content,
      timestamp: now(),
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    db.prepare("INSERT INTO coding_history_message_bindings VALUES (?, ?, ?)").run(
      runId,
      sourceId,
      message.id,
    );
  });
}

function upsertMessage(
  db: DatabaseSync,
  store: UiStore,
  now: () => number,
  input: Parameters<typeof appendMessage>[3],
): boolean {
  return withImmediateTransaction(db, () => {
    const binding = db
      .prepare(
        "SELECT message_id FROM coding_history_message_bindings WHERE run_id = ? AND source_id = ?",
      )
      .get(input.runId, input.sourceId);
    if (typeof binding?.message_id !== "string") {
      appendMessage(db, store, now, input);
      return true;
    }
    const message = store.findMessageById(binding.message_id);
    if (message?.chatId !== input.id || message.role !== input.role)
      throw invalidRequest("Coding message binding mismatch.");
    if (message.content === input.content) return false;
    if (
      !input.content.startsWith(message.content) ||
      input.content.length > CODING_HISTORY_MESSAGE_MAX_CHARS
    )
      throw invalidRequest("Coding message prefix changed.");
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run(input.content, message.id);
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now(), input.id);
    return true;
  });
}

/**
 * Message ids of user rows that repeat their own run's intent word for word under the runtime's
 * message id. Through 1.1.7 both capture paths stored the task prompt once more next to the intent
 * `begin` had already written (#3610); reading them out keeps existing histories and continuation
 * context correct without rewriting stored rows. A user row of the same words bound to a DIFFERENT
 * run is the operator's own message and stays.
 */
function repeatedIntentMessageIds(db: DatabaseSync, id: string): ReadonlySet<string> {
  const rows = db
    .prepare(
      `SELECT echo.message_id AS message_id
         FROM coding_history_message_bindings echo
         JOIN coding_history_runs run ON run.run_id = echo.run_id
         JOIN coding_history_message_bindings intent
           ON intent.run_id = echo.run_id AND intent.source_id = 'intent'
         JOIN chat_messages echoed ON echoed.id = echo.message_id
         JOIN chat_messages stored ON stored.id = intent.message_id
        WHERE run.chat_id = ?
          AND echo.source_id <> 'intent'
          AND echoed.role = 'user'
          AND stored.role = 'user'
          AND echoed.content = stored.content`,
    )
    .all(id);
  return new Set(rows.map((row) => String(row.message_id)));
}

function readDetail(
  db: DatabaseSync,
  store: UiStore,
  id: string,
  operator: string,
): CodingHistoryDetail | undefined {
  const task = readTask(db, store, id, operator);
  if (task === undefined) return undefined;
  const binding = db.prepare(
    "SELECT run_id FROM coding_history_message_bindings WHERE message_id = ?",
  );
  const listed = store.listMessages(id, 200);
  const repeated = repeatedIntentMessageIds(db, id);
  const messages = listed
    .filter((message) => !repeated.has(message.id))
    .map((message) => {
      const row = binding.get(message.id);
      return { ...message, ...(typeof row?.run_id === "string" ? { runId: row.run_id } : {}) };
    });
  return { task, messages, truncated: store.countMessages(id) > listed.length };
}

function updateTask(
  db: DatabaseSync,
  store: UiStore,
  now: () => number,
  id: string,
  patch: Parameters<CodingHistoryStore["update"]>[1],
): CodingHistoryTask {
  return withImmediateTransaction(db, () => {
    requireTask(db, store, id);
    if (patch.title !== undefined) store.updateChat(id, { title: patch.title });
    if (patch.status !== undefined)
      db.prepare("UPDATE coding_history_tasks SET status = ? WHERE chat_id = ?").run(
        patch.status,
        id,
      );
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now(), id);
    return requireTask(db, store, id);
  });
}

export function createCodingHistoryStore(
  db: DatabaseSync,
  store: UiStore,
  now: () => number,
): CodingHistoryStore {
  return {
    begin: (input) => beginTask(db, store, now, input),
    create: (input) => createTask(db, store, input),
    get: (id, operator) => readTask(db, store, id, operator),
    list: (operator) =>
      db
        .prepare(
          "SELECT t.chat_id FROM coding_history_tasks t JOIN chats c ON c.id = t.chat_id WHERE t.operator_digest = ? ORDER BY c.updated_at DESC, c.rowid DESC LIMIT 200",
        )
        .all(operator)
        .map((row) => requireTask(db, store, String(row.chat_id))),
    messagesBeforeRun: (id, runId): readonly ChatMessage[] => {
      const ids = new Set(
        db
          .prepare("SELECT message_id FROM coding_history_message_bindings WHERE run_id = ?")
          .all(runId)
          .map((row) => row.message_id),
      );
      const repeated = repeatedIntentMessageIds(db, id);
      return store
        .listMessages(id, 200)
        .filter((message) => !ids.has(message.id) && !repeated.has(message.id));
    },
    detail: (id, operator) => readDetail(db, store, id, operator),
    forRun: (runId): CodingHistoryTask | undefined => {
      const row = db.prepare("SELECT chat_id FROM coding_history_runs WHERE run_id = ?").get(runId);
      return typeof row?.chat_id === "string" ? readTask(db, store, row.chat_id) : undefined;
    },
    bindRun: (id, runId): void => {
      bindRun(db, store, id, runId, now);
    },
    update: (id, patch) => updateTask(db, store, now, id, patch),
    upsert: (id, runId, sourceId, role, content) =>
      upsertMessage(db, store, now, { id, runId, sourceId, role, content }),
    append: (id, runId, sourceId, role, content): void => {
      appendMessage(db, store, now, { id, runId, sourceId, role, content });
    },
  };
}
