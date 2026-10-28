import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { createCodingRuntimeSnapshotStore } from "../coding-runtime/codingRuntimeSnapshotStore.js";
import { buildUiStoreOverDatabase } from "./db.js";
import { createChatToolMutationStore } from "./chatToolMutations.js";
import { runMigrations } from "./schema.js";
import { rewindSchemaFixture } from "./legacySchemaTestFixture.js";
import type { CodingHistoryStore } from "./codingHistory.js";
import type {
  ChatToolMutationStore,
  McpChatToolMutationIntent,
  CodingToolMutationConsumer,
} from "./chatToolMutationTypes.js";

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});
const operator = "a".repeat(64);
const authority = "b".repeat(64);
interface Fixture {
  readonly db: DatabaseSync;
  readonly store: ReturnType<typeof buildUiStoreOverDatabase>;
  readonly history: CodingHistoryStore;
  readonly task: ReturnType<CodingHistoryStore["begin"]>;
  readonly journal: ChatToolMutationStore;
  readonly logs: ReturnType<typeof createBufferedServerLogSink>;
  readonly intent: McpChatToolMutationIntent & { readonly consumer: CodingToolMutationConsumer };
}
function fixture(): Fixture {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
  dispose.push(() => {
    store.close();
  });
  const snapshots = createCodingRuntimeSnapshotStore(db);
  const now = new Date(1_000).toISOString();
  snapshots.create({
    schemaVersion: "1",
    runId: "run-one",
    state: "running",
    revision: 1,
    requestedMode: "governed-assist",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    createdAt: now,
    updatedAt: now,
    taskDigest: authority,
    workspaceDigest: authority,
    operatorDigest: operator,
    authorityDigest: authority,
    bindingDigest: authority,
    provenanceDigest: authority,
    toolCallCount: 0,
    patchByteCount: 0,
    modelRequestCount: 0,
  });
  const history = store.codingHistory;
  if (history === undefined) throw new Error("Expected Coding History owner");
  const task = history.begin({
    projectPath: process.cwd(),
    title: "Synthetic native mutation",
    modelId: "synthetic",
    workspaceId: "workspace-one",
    taskId: "task-one",
    branch: "main",
    operatorDigest: operator,
    runId: "run-one",
    intent: "Create a synthetic note",
  });
  const userMessageId = history.bindNativeTurn(
    "run-one",
    "msg_user_one",
    "Create a synthetic note",
  );
  const logs = createBufferedServerLogSink();
  const journal = createChatToolMutationStore(db, () => 1_000, logs);
  const intent = {
    invocationId: "native-invocation-one",
    chatId: task.id,
    userMessageId,
    turnRef: "msg_user_one",
    actorId: operator,
    authorityDigest: authority,
    actionDigest: "c".repeat(64),
    correlationId: "run-one",
    sourceKind: "configured-mcp" as const,
    podId: null,
    bindingGeneration: null,
    credentialGeneration: null,
    configurationDigest: "d".repeat(64),
    serverName: "synthetic",
    toolName: "create_note",
    operation: "mcp.create_note",
    consumer: {
      kind: "coding" as const,
      runId: "run-one",
      sessionId: "ses_one",
      messageId: "msg_assistant_one",
      callId: "call_one",
      argumentsDigest: "e".repeat(64),
    },
  };
  return { db, store, history, task, journal, intent, logs };
}

it("admits only the actual active Coding History turn without creating a chat turn", () => {
  const f = fixture();
  expect(f.journal.prepare(f.intent).kind).toBe("prepared");
  expect(f.journal.beginDispatch(f.intent.invocationId, () => true)).toBe(true);
  expect(f.history.detail(f.task.id, operator)?.messages).toHaveLength(1);
  expect(f.store.listMessages(f.task.id, 20)).toHaveLength(0);
  expect(f.logs.events.map((event) => event.extra?.consumer)).toEqual(["coding", "coding"]);
  expect(JSON.stringify(f.logs.events)).not.toContain("Create a synthetic note");
  expect(
    f.db
      .prepare("SELECT client_turn_state FROM chat_messages WHERE id=?")
      .get(f.intent.userMessageId)?.client_turn_state,
  ).toBeNull();
});

it("refuses stale Human turns, a different operator and a mismatching run authority before dispatch", () => {
  const f = fixture();
  expect(() => f.journal.prepare({ ...f.intent, actorId: "f".repeat(64) })).toThrow();
  expect(() => f.journal.prepare({ ...f.intent, authorityDigest: "f".repeat(64) })).toThrow();
  f.journal.prepare(f.intent);
  f.history.bindNativeTurn("run-one", "msg_user_two", "A separate human request");
  expect(() => f.journal.beginDispatch(f.intent.invocationId, () => true)).toThrow();
});

it("keeps a dispatched or unconfirmed action blocked across an owner restart and new Call IDs", () => {
  const f = fixture();
  f.journal.prepare(f.intent);
  f.journal.beginDispatch(f.intent.invocationId, () => true);
  const reopened = createChatToolMutationStore(f.db, () => 1_001, createBufferedServerLogSink());
  const repeated = {
    ...f.intent,
    invocationId: "native-invocation-two",
    actionDigest: "f".repeat(64),
    consumer: { ...f.intent.consumer, callId: "call_two" },
  };
  expect(reopened.prepare(repeated)).toEqual({ kind: "blocked", reason: "in-flight" });
  reopened.acknowledgeMcp(f.intent.invocationId, true);
  reopened.settle(f.intent.invocationId, "succeeded-unconfirmed");
  expect(reopened.prepare(repeated)).toEqual({ kind: "blocked", reason: "unknown-effect" });
});

it("allows a confirmed action with a fresh Call ID and keeps the original Call ID once-only", () => {
  const f = fixture();
  f.journal.prepare(f.intent);
  f.journal.beginDispatch(f.intent.invocationId, () => true);
  f.journal.acknowledgeMcp(f.intent.invocationId, true);
  f.journal.settle(f.intent.invocationId, "succeeded");
  expect(f.journal.prepare(f.intent).kind).toBe("replayed");
  expect(f.journal.beginDispatch(f.intent.invocationId, () => true)).toBe(false);
  const next = {
    ...f.intent,
    invocationId: "native-invocation-two",
    actionDigest: "f".repeat(64),
    consumer: { ...f.intent.consumer, callId: "call_two" },
  };
  expect(f.journal.prepare(next).kind).toBe("prepared");
  expect(f.journal.beginDispatch(next.invocationId, () => true)).toBe(true);
});

it("keeps ordinary Chat admission closed to a Coding History user message", () => {
  const f = fixture();
  const { consumer: _consumer, ...chatIntent } = f.intent;
  expect(() => f.journal.prepare(chatIntent)).toThrow();
});

it("binds a fresh human turn to a different real user row and refuses an old turn being rebound", () => {
  const f = fixture();
  expect(f.history.bindNativeTurn("run-one", "msg_user_one", "Create a synthetic note")).toBe(
    f.intent.userMessageId,
  );
  const userMessageId = f.history.bindNativeTurn("run-one", "msg_user_two", "Create another note");
  expect(userMessageId).not.toBe(f.intent.userMessageId);
  expect(f.history.detail(f.task.id, operator)?.messages).toHaveLength(2);
  expect(() =>
    f.history.bindNativeTurn("run-one", "msg_user_one", "Create a synthetic note"),
  ).toThrow();
  expect(f.journal.prepare({ ...f.intent, userMessageId, turnRef: "msg_user_two" }).kind).toBe(
    "prepared",
  );
});

it("retains existing Chat effects and History bindings when upgrading schema52", () => {
  const f = fixture();
  const chat = f.store.createChat(process.cwd(), "Existing chat", "synthetic");
  const admitted = f.store.admitChatTurn("old-turn", {
    chatId: chat.id,
    role: "user",
    content: "Existing synthetic input",
    timestamp: 1_000,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (admitted.kind !== "admitted" || admitted.userMessage.canonicalTurnRef === undefined)
    throw new Error("Expected canonical chat turn");
  const { consumer: _consumer, ...base } = f.intent;
  const old = {
    ...base,
    chatId: chat.id,
    userMessageId: admitted.userMessage.id,
    turnRef: admitted.userMessage.canonicalTurnRef,
  };
  f.journal.prepare(old);
  f.journal.beginDispatch(old.invocationId, () => true);
  f.journal.acknowledgeMcp(old.invocationId, true);
  const before = f.journal.settle(old.invocationId, "succeeded");
  const bindings = f.db.prepare("SELECT * FROM coding_history_message_bindings").all();
  rewindSchemaFixture(f.db, 52);
  runMigrations(f.db);
  expect(f.journal.find(old.invocationId)).toEqual(before);
  expect(f.db.prepare("SELECT * FROM coding_history_message_bindings").all()).toEqual(bindings);
  expect(f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("requires complete native identities at the database boundary", () => {
  const f = fixture();
  f.journal.prepare(f.intent);
  expect(() =>
    f.db
      .prepare("UPDATE chat_tool_mutations SET native_call_id=NULL WHERE invocation_id=?")
      .run(f.intent.invocationId),
  ).toThrow();
  expect(() =>
    f.journal.prepare({ ...f.intent, consumer: { ...f.intent.consumer, sessionId: "ses_other" } }),
  ).toThrow();
});
