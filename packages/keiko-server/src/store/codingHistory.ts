import { randomUUID } from "node:crypto";
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

/** Where a fork ends in its source, as Coding History counts the source's user turns. */
export type CodingHistoryForkBoundary =
  | { readonly kind: "end" }
  | {
      readonly kind: "turn";
      /** Zero-based position of the user turn among the source's user turns. */
      readonly ordinal: number;
      /** How many user turns the source holds; a runtime holding another number cannot be aligned. */
      readonly userTurnCount: number;
    };

/** What a fork would inherit, decided before anything is created. */
export interface CodingHistoryForkPlan {
  readonly boundary: CodingHistoryForkBoundary;
  /** The source's conversation ahead of the fork point, which the new task shows as its own. */
  readonly inheritedCount: number;
  /** The conversation the source shows. */
  readonly sourceCount: number;
}

/** The workspace fields a Coding History task is scoped by. */
export interface CodingHistoryTaskScope {
  readonly projectPath: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly branch: string;
}

export interface CodingHistoryForkSource extends CodingHistoryCreateInput {
  /** The task to fork. It must belong to the same operator, workspace, task workspace and branch. */
  readonly sourceId: string;
  /**
   * The task workspace the new task's own one was provisioned from (#3903 AC4, #3902 AC3): the
   * source may belong to it instead. Absent, the source belongs to the new task's workspace.
   */
  readonly sourceScope?: CodingHistoryTaskScope | undefined;
  /** A user message of the source to fork just before; absent forks the source as it ended. */
  readonly beforeMessageId?: string;
}

export interface CodingHistoryForkInput extends CodingHistoryForkSource {
  readonly runId: string;
  readonly intent: string;
}

export interface CodingHistoryFork extends CodingHistoryForkPlan {
  readonly task: CodingHistoryTask;
}

/** One message of an imported file, already sanitized and within the message bound. */
export interface CodingHistoryImportedMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  /** The time the file says it was written; absent stamps it at import. */
  readonly timestamp?: number | undefined;
}

export interface CodingHistoryImportInput extends CodingHistoryCreateInput {
  readonly messages: readonly CodingHistoryImportedMessage[];
}

export interface CodingHistoryStore {
  readonly begin: (input: CodingHistoryBeginInput) => CodingHistoryTask;
  /** What a fork of the source would inherit, or `undefined` when it cannot be made. */
  readonly planFork: (input: CodingHistoryForkSource) => CodingHistoryForkPlan | undefined;
  /**
   * Begins a new task from a copy of the source's conversation ahead of the fork point, bound to a
   * run of its own that holds only the copies, then begins the given run with its intent. The
   * source is untouched.
   */
  readonly fork: (input: CodingHistoryForkInput) => CodingHistoryFork;
  readonly create: (input: CodingHistoryCreateInput) => CodingHistoryTask;
  /**
   * Creates a task from an imported file (#3904 AC4): its messages are bound to a run of its own,
   * which no runtime ever executed, so the task reads as `imported` and is continued by a fork.
   */
  readonly importTask: (input: CodingHistoryImportInput) => CodingHistoryTask;
  readonly get: (id: string, operatorDigest?: string) => CodingHistoryTask | undefined;
  readonly list: (operatorDigest: string) => readonly CodingHistoryTask[];
  readonly messagesBeforeRun: (id: string, runId: string) => readonly ChatMessage[];
  readonly detail: (id: string, operatorDigest: string) => CodingHistoryDetail | undefined;
  readonly forRun: (runId: string) => CodingHistoryTask | undefined;
  /**
   * The user message that carries the run's task intent: created when the run began, it holds the
   * conversation's skill selection of that moment as its immutable turn binding (#4025).
   */
  readonly intentMessageId: (runId: string) => string | undefined;
  /** Bind an accepted human turn before its native prompt is sent; retries keep the same row. */
  readonly bindNativeTurn: (runId: string, nativeMessageId: string, text: string) => string;
  readonly nativeTurn: (
    runId: string,
  ) =>
    | { readonly chatId: string; readonly userMessageId: string; readonly turnRef: string }
    | undefined;
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
/** Run ids that hold an imported file's messages; no runtime run is ever given one. */
const IMPORT_RUN_PREFIX = "import-";
export const CODING_HISTORY_MESSAGE_MAX_CHARS = 65_536;

/**
 * Where the stored message that starts at `offset` ends: at most one message's length, and never
 * between the two halves of a UTF-16 surrogate pair, so a long text splits into whole characters.
 */
export function codingHistoryChunkEnd(content: string, offset: number): number {
  const end = Math.min(content.length, offset + CODING_HISTORY_MESSAGE_MAX_CHARS);
  return (content.codePointAt(end - 1) ?? 0) > 0xffff ? end - 1 : end;
}

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
    ...latestRun(db, id),
  };
}

/**
 * The task's newest run. An imported task's only run is the synthetic one its import bound, which
 * is no run to continue, so it is named only as the task's origin (#3904 AC4).
 */
function latestRun(
  db: DatabaseSync,
  id: string,
): Pick<CodingHistoryTask, "latestRunId" | "origin"> {
  const latest = db
    .prepare(
      "SELECT run_id FROM coding_history_runs WHERE chat_id = ? ORDER BY sequence DESC LIMIT 1",
    )
    .get(id);
  if (typeof latest?.run_id !== "string") return {};
  return latest.run_id.startsWith(IMPORT_RUN_PREFIX)
    ? { origin: "imported" }
    : { latestRunId: latest.run_id };
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

/** The source id of the user message a run's task intent is stored as. */
const INTENT_SOURCE_ID = "intent";

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
      sourceId: INTENT_SOURCE_ID,
      role: "user",
      content: input.intent,
    });
    return requireTask(db, store, task.id);
  });
}

interface ForkSelection {
  readonly plan: CodingHistoryForkPlan;
  readonly inherited: readonly ChatMessage[];
}

function forkBoundary(
  shown: readonly ChatMessage[],
  beforeMessageId: string | undefined,
): { readonly index: number; readonly boundary: CodingHistoryForkBoundary } | undefined {
  if (beforeMessageId === undefined) return { index: shown.length, boundary: { kind: "end" } };
  const index = shown.findIndex((message) => message.id === beforeMessageId);
  if (shown[index]?.role !== "user") return undefined;
  const turns = (messages: readonly ChatMessage[]): number =>
    messages.filter((message) => message.role === "user").length;
  return {
    index,
    boundary: {
      kind: "turn",
      ordinal: turns(shown.slice(0, index)),
      userTurnCount: turns(shown),
    },
  };
}

/**
 * Decides what a fork inherits. A boundary inside the conversation needs all of it: a source whose
 * earlier messages Coding History no longer lists cannot have its user turns counted, and no turn is
 * guessed. A source of another workspace, task workspace, branch or operator is not forked.
 */
function inTaskScope(task: CodingHistoryTaskScope, scope: CodingHistoryTaskScope): boolean {
  return (
    task.workspaceId === scope.workspaceId &&
    task.taskId === scope.taskId &&
    task.branch === scope.branch &&
    task.projectPath === scope.projectPath
  );
}

function selectFork(
  db: DatabaseSync,
  store: UiStore,
  input: CodingHistoryForkSource,
): ForkSelection | undefined {
  const source = readTask(db, store, input.sourceId, input.operatorDigest);
  if (
    source === undefined ||
    !(
      inTaskScope(source, input) ||
      (input.sourceScope !== undefined && inTaskScope(source, input.sourceScope))
    )
  ) {
    return undefined;
  }
  // The conversation Coding History shows for the source: user and assistant messages, no echoes.
  const listed = store.listMessages(input.sourceId, 200);
  const echoes = repeatedIntentMessageIds(db, input.sourceId);
  const shown = listed.filter((message) => !echoes.has(message.id) && message.role !== "system");
  const truncated = store.countMessages(input.sourceId) > listed.length;
  if (truncated && input.beforeMessageId !== undefined) return undefined;
  const point = forkBoundary(shown, input.beforeMessageId);
  if (point === undefined) return undefined;
  const inherited = shown.slice(0, point.index);
  return {
    inherited,
    plan: {
      boundary: point.boundary,
      inheritedCount: inherited.length,
      sourceCount: shown.length,
    },
  };
}

/** Run id of the synthetic run that holds a fork's copied conversation, ahead of its own run. */
function inheritedRunId(runId: string): string {
  return `inherit-${runId}`;
}

function forkTask(
  db: DatabaseSync,
  store: UiStore,
  now: () => number,
  input: CodingHistoryForkInput,
): CodingHistoryFork {
  return withImmediateTransaction(db, () => {
    const selection = selectFork(db, store, input);
    if (selection === undefined) throw invalidRequest("Coding task cannot be forked.");
    const task = createTask(db, store, input);
    const inheritedRun = inheritedRunId(input.runId);
    bindRun(db, store, task.id, inheritedRun, now);
    selection.inherited.forEach((message, index) => {
      appendMessage(db, store, now, {
        id: task.id,
        runId: inheritedRun,
        sourceId: `inherited-${String(index)}`,
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
        timestamp: message.timestamp,
      });
    });
    bindRun(db, store, task.id, input.runId, now);
    appendMessage(db, store, now, {
      id: task.id,
      runId: input.runId,
      sourceId: INTENT_SOURCE_ID,
      role: "user",
      content: input.intent,
    });
    return { task: requireTask(db, store, task.id), ...selection.plan };
  });
}

function importTask(
  db: DatabaseSync,
  store: UiStore,
  now: () => number,
  input: CodingHistoryImportInput,
): CodingHistoryTask {
  return withImmediateTransaction(db, () => {
    const task = createTask(db, store, input);
    const runId = `${IMPORT_RUN_PREFIX}${randomUUID()}`;
    bindRun(db, store, task.id, runId, now);
    input.messages.forEach((message, index) => {
      appendMessage(db, store, now, {
        id: task.id,
        runId,
        sourceId: `imported-${String(index)}`,
        role: message.role,
        content: message.content,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      });
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
      "INSERT INTO coding_history_runs (run_id, chat_id, sequence) SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1 FROM coding_history_runs WHERE chat_id = ?",
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
    /** A copied message keeps the time it was written; absent stamps it now. */
    readonly timestamp?: number;
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
      timestamp: input.timestamp ?? now(),
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
 * Message ids of the one user row per run that 1.1.x stored as an echo of the run's intent (#3610):
 * through 1.1.7 both capture paths stored the task prompt once more next to the intent `begin` had
 * already written. The echo is the first user row of the run, other than the intent itself, that
 * repeats the intent word for word before the model answered in that run. Reading it out keeps
 * existing histories and continuation context correct without rewriting stored rows. The same
 * words sent again after an answer, or in another run, are the operator's own message and stay.
 * Decided over every stored row of the chat, never only the newest listed window, so an answer
 * older than that window still marks its run as answered (review on #3611).
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
          AND echo.message_id <> intent.message_id
          AND echoed.role = 'user'
          AND stored.role = 'user'
          AND echoed.content = stored.content
          AND NOT EXISTS (
            SELECT 1
              FROM coding_history_message_bindings earlier
              JOIN chat_messages prior ON prior.id = earlier.message_id
             WHERE earlier.run_id = echo.run_id
               AND earlier.source_id <> 'intent'
               AND (prior.timestamp < echoed.timestamp
                    OR (prior.timestamp = echoed.timestamp AND prior.rowid < echoed.rowid))
               AND ((prior.role = 'user' AND prior.content = stored.content)
                    OR (prior.role = 'assistant'
                        AND length(trim(prior.content, ' ' || char(9) || char(10) || char(13))) > 0))
          )`,
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

function readIntentMessageId(db: DatabaseSync, runId: string): string | undefined {
  const row = db
    .prepare(
      "SELECT message_id FROM coding_history_message_bindings WHERE run_id = ? AND source_id = ?",
    )
    .get(runId, INTENT_SOURCE_ID);
  return typeof row?.message_id === "string" ? row.message_id : undefined;
}

function nativeTurn(db: DatabaseSync, runId: string): ReturnType<CodingHistoryStore["nativeTurn"]> {
  const row = db
    .prepare(
      "SELECT chat_id, active_user_message_id, active_native_turn_ref FROM coding_history_runs WHERE run_id=?",
    )
    .get(runId);
  return typeof row?.chat_id === "string" &&
    typeof row.active_user_message_id === "string" &&
    typeof row.active_native_turn_ref === "string"
    ? {
        chatId: row.chat_id,
        userMessageId: row.active_user_message_id,
        turnRef: row.active_native_turn_ref,
      }
    : undefined;
}

function bindNativeTurn(
  db: DatabaseSync,
  store: UiStore,
  now: () => number,
  runId: string,
  nativeMessageId: string,
  text: string,
): string {
  assertId(runId);
  assertId(nativeMessageId);
  if (!/^msg_[A-Za-z0-9_-]+$/u.test(nativeMessageId))
    throw invalidRequest("Invalid native turn identity.");
  return withImmediateTransaction(db, () => {
    const current = nativeTurn(db, runId);
    if (current?.turnRef === nativeMessageId) return current.userMessageId;
    const run = db.prepare("SELECT chat_id FROM coding_history_runs WHERE run_id=?").get(runId);
    if (typeof run?.chat_id !== "string") throw invalidRequest("Coding turn owner unavailable.");
    const prior = db
      .prepare(
        "SELECT message_id FROM coding_history_message_bindings WHERE run_id=? AND source_id=?",
      )
      .get(runId, nativeMessageId);
    if (prior !== undefined) throw invalidRequest("Coding turn already superseded.");
    const messageId = bindNativeTurnMessage(db, store, now, {
      runId,
      nativeMessageId,
      text,
      chatId: run.chat_id,
      initial: current === undefined,
    });
    db.prepare(
      "UPDATE coding_history_runs SET active_native_turn_ref=?, active_user_message_id=? WHERE run_id=?",
    ).run(nativeMessageId, messageId, runId);
    return messageId;
  });
}

function bindNativeTurnMessage(
  db: DatabaseSync,
  store: UiStore,
  now: () => number,
  input: {
    readonly runId: string;
    readonly nativeMessageId: string;
    readonly text: string;
    readonly chatId: string;
    readonly initial: boolean;
  },
): string {
  const { runId, nativeMessageId } = input;
  if (input.initial) {
    const messageId = readIntentMessageId(db, runId);
    if (messageId === undefined) throw invalidRequest("Coding intent unavailable.");
    db.prepare("INSERT INTO coding_history_message_bindings VALUES (?,?,?)").run(
      runId,
      nativeMessageId,
      messageId,
    );
    return messageId;
  }
  appendMessage(db, store, now, {
    id: input.chatId,
    runId,
    sourceId: nativeMessageId,
    role: "user",
    content: input.text,
  });
  const row = db
    .prepare(
      "SELECT message_id FROM coding_history_message_bindings WHERE run_id=? AND source_id=?",
    )
    .get(runId, nativeMessageId);
  if (typeof row?.message_id !== "string") throw invalidRequest("Coding turn message unavailable.");
  return row.message_id;
}

export function createCodingHistoryStore(
  db: DatabaseSync,
  store: UiStore,
  now: () => number,
): CodingHistoryStore {
  return {
    begin: (input) => beginTask(db, store, now, input),
    planFork: (input) => selectFork(db, store, input)?.plan,
    fork: (input) => forkTask(db, store, now, input),
    create: (input) => createTask(db, store, input),
    importTask: (input) => importTask(db, store, now, input),
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
      const listed = store.listMessages(id, 200);
      return listed.filter((message) => !ids.has(message.id) && !repeated.has(message.id));
    },
    detail: (id, operator) => readDetail(db, store, id, operator),
    forRun: (runId): CodingHistoryTask | undefined => {
      const row = db.prepare("SELECT chat_id FROM coding_history_runs WHERE run_id = ?").get(runId);
      return typeof row?.chat_id === "string" ? readTask(db, store, row.chat_id) : undefined;
    },
    intentMessageId: (runId) => readIntentMessageId(db, runId),
    bindNativeTurn: (runId, nativeMessageId, text) =>
      bindNativeTurn(db, store, now, runId, nativeMessageId, text),
    nativeTurn: (runId) => nativeTurn(db, runId),
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
