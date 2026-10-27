import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { createNodeUiStore, buildUiStoreOverDatabase, type UiStore } from "./index.js";
import { rewindSchemaFixture } from "./legacySchemaTestFixture.js";
import { runMigrations } from "./schema.js";
import { createChatToolMutationStore } from "./chatToolMutations.js";
import type { ChatToolMutationIntent, ChatToolMutationStore } from "./chatToolMutationTypes.js";
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of dispose.splice(0)) cleanup();
});
function journalOf(store: UiStore): ChatToolMutationStore {
  if (store.chatToolMutations === undefined)
    throw new Error("Expected production mutation journal");
  return store.chatToolMutations;
}
function intentFor(
  store: UiStore,
  chatId: string,
  clientTurnId = "synthetic-turn",
): ChatToolMutationIntent {
  const turn = store.admitChatTurn(clientTurnId, {
    chatId,
    role: "user",
    content: "synthetic-private-body",
    timestamp: 1000,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (turn.kind !== "admitted" || turn.userMessage.canonicalTurnRef === undefined)
    throw new Error("Expected synthetic turn admission");
  return {
    invocationId: "invocation-one",
    chatId,
    userMessageId: turn.userMessage.id,
    turnRef: turn.userMessage.canonicalTurnRef,
    actorId: "actor-private",
    podId: "pod-private",
    bindingGeneration: 1,
    credentialGeneration: 1,
    authorityDigest: "a".repeat(64),
    actionDigest: "b".repeat(64),
    operation: "jira.create",
    correlationId: "correlation-one",
  };
}
interface Fixture {
  readonly db: DatabaseSync;
  readonly store: UiStore;
  readonly journal: ChatToolMutationStore;
  readonly intent: ChatToolMutationIntent;
  readonly logs: ReturnType<typeof createBufferedServerLogSink>;
}
function fixture(): Fixture {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
  dispose.push(() => {
    store.close();
  });
  const project = store.createProject(process.cwd());
  const chat = store.createChat(project.path, "Synthetic", "model");
  const logs = createBufferedServerLogSink();
  return {
    db,
    store,
    journal: createChatToolMutationStore(db, () => 1000, logs),
    intent: intentFor(store, chat.id),
    logs,
  };
}
function dispatch(f: Fixture): void {
  expect(f.journal.prepare(f.intent).kind).toBe("prepared");
  expect(f.journal.beginDispatch(f.intent.invocationId, () => true)).toBe(true);
}
it("upgrades schema 46 without rewriting existing chats or canonical user turns", () => {
  const f = fixture();
  const before = f.db.prepare("SELECT * FROM chat_messages").all();
  const chats = f.db.prepare("SELECT * FROM chats").all();
  rewindSchemaFixture(f.db, 46);
  runMigrations(f.db);
  expect(f.db.prepare("SELECT * FROM chat_messages").all()).toEqual(before);
  expect(f.db.prepare("SELECT * FROM chats").all()).toEqual(chats);
  expect(f.journal.prepare(f.intent).kind).toBe("prepared");
});
it("retains a dispatched action across restart and never dispatches it twice", () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-tool-journal-"));
  const path = join(directory, "ui.sqlite");
  let store: UiStore | undefined = createNodeUiStore(path);
  try {
    const project = store.createProject(process.cwd());
    const intent = intentFor(store, store.createChat(project.path, "Synthetic", "model").id);
    expect(journalOf(store).prepare(intent).kind).toBe("prepared");
    let effects = 0;
    if (journalOf(store).beginDispatch(intent.invocationId, () => true)) effects++;
    expect(effects).toBe(1);
    store.close();
    store = undefined;
    store = createNodeUiStore(path);
    expect(journalOf(store).find(intent.invocationId)).toMatchObject({
      phase: "dispatched",
      outcome: null,
    });
    if (journalOf(store).beginDispatch(intent.invocationId, () => true)) effects++;
    expect(effects).toBe(1);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
describe("durable mutation admission", () => {
  it("deduplicates equivalent actions even when a model supplies a different call identity", () => {
    const f = fixture();
    dispatch(f);
    expect(f.journal.prepare({ ...f.intent, invocationId: "invocation-two" })).toMatchObject({
      kind: "replayed",
      record: { invocationId: "invocation-one", phase: "dispatched" },
    });
    expect(f.journal.find("invocation-two")).toBeUndefined();
    expect(
      f.journal.beginDispatch(f.intent.invocationId, () => {
        throw new Error("Must not reauthorize an already dispatched action");
      }),
    ).toBe(false);
  });
  it.each([
    { actorId: "another-actor" },
    { podId: "another-pod" },
    { bindingGeneration: 2 },
    { credentialGeneration: 2 },
    { authorityDigest: "c".repeat(64) },
    { operation: "jira.edit" as const },
  ])("rejects changed context for an existing action: %j", (patch) => {
    const f = fixture();
    f.journal.prepare(f.intent);
    expect(() => f.journal.prepare({ ...f.intent, ...patch })).toThrow("conflicts");
  });
  it("requires the real pending user turn in its owning chat", () => {
    const f = fixture();
    expect(() => f.journal.prepare({ ...f.intent, turnRef: "synthetic-turn" })).toThrow(
      "conflicts",
    );
    const other = f.store.createChat(process.cwd(), "Other", "model");
    expect(() => f.journal.prepare({ ...f.intent, chatId: other.id })).toThrow("conflicts");
    f.store.failChatTurn(f.intent.chatId, "synthetic-turn", "cancelled");
    expect(() => f.journal.prepare(f.intent)).toThrow("conflicts");
  });
  it("rolls back guard-side approval claims when final authorization fails", () => {
    const f = fixture();
    f.db.exec(
      "CREATE TABLE synthetic_approval (consumed INTEGER); INSERT INTO synthetic_approval VALUES (0)",
    );
    f.journal.prepare(f.intent);
    expect(
      f.journal.beginDispatch(f.intent.invocationId, () => {
        f.db.exec("UPDATE synthetic_approval SET consumed = 1");
        return false;
      }),
    ).toBe(false);
    expect(f.db.prepare("SELECT consumed FROM synthetic_approval").get()?.consumed).toBe(0);
    expect(f.journal.find(f.intent.invocationId)?.phase).toBe("prepared");
  });
  it("refuses non-durable savepoints and weakened SQLite synchronization", () => {
    const f = fixture();
    f.db.exec("BEGIN");
    expect(() => f.journal.prepare(f.intent)).toThrow("conflicts");
    f.db.exec("ROLLBACK");
    f.db.exec("PRAGMA synchronous = NORMAL");
    expect(() => f.journal.prepare(f.intent)).toThrow("conflicts");
    expect(f.journal.find(f.intent.invocationId)).toBeUndefined();
  });
  it("does not authorize dispatch when persistence fails, and keeps SQL errors private", () => {
    const f = fixture();
    f.journal.prepare(f.intent);
    f.db.exec(
      "CREATE TRIGGER synthetic_failure BEFORE UPDATE ON chat_tool_mutations BEGIN SELECT RAISE(ABORT, 'synthetic-sensitive-detail'); END",
    );
    expect(() => f.journal.beginDispatch(f.intent.invocationId, () => true)).toThrow(
      "The mutation journal could not be persisted.",
    );
    expect(f.journal.find(f.intent.invocationId)?.phase).toBe("prepared");
    expect(f.logs.events.some((event) => event.extra?.event === "dispatched")).toBe(false);
    expect(JSON.stringify(f.logs.events)).not.toContain("synthetic-sensitive-detail");
  });
  it("retains deduplication tombstones when a user message is removed and recreated", () => {
    const f = fixture();
    dispatch(f);
    f.journal.settle(f.intent.invocationId, "unknown");
    f.db.prepare("DELETE FROM chat_messages WHERE id = ?").run(f.intent.userMessageId);
    expect(f.journal.find(f.intent.invocationId)?.userMessageId).toBeNull();
    const replacement = intentFor(f.store, f.intent.chatId);
    expect(f.journal.prepare({ ...replacement, invocationId: "replacement" })).toMatchObject({
      kind: "replayed",
      record: { outcome: "unknown" },
    });
    f.store.deleteChat(f.intent.chatId);
    expect(f.journal.find(f.intent.invocationId)).toBeUndefined();
  });
  it("bounds intent growth within a canonical turn", () => {
    const f = fixture();
    for (let index = 0; index < 32; index++)
      expect(
        f.journal.prepare({
          ...f.intent,
          invocationId: `invocation-${String(index)}`,
          actionDigest: index.toString(16).padStart(64, "0"),
        }).kind,
      ).toBe("prepared");
    expect(f.journal.prepare(f.intent)).toEqual({ kind: "blocked", reason: "capacity" });
  });
});
it("stops before HTTP when pre-effect logging fails, without erasing the dispatch tombstone", () => {
  const f = fixture();
  f.journal.prepare(f.intent);
  const failing = createChatToolMutationStore(f.db, () => 1000, {
    write: () => {
      throw new Error("synthetic-private-sink-error");
    },
  });
  expect(() => failing.beginDispatch(f.intent.invocationId, () => true)).toThrow(
    "The mutation journal activity could not be recorded.",
  );
  expect(f.journal.find(f.intent.invocationId)?.phase).toBe("dispatched");
  expect(failing.beginDispatch(f.intent.invocationId, () => true)).toBe(false);
});
it("does not change an observed success when terminal logging fails", () => {
  const f = fixture();
  dispatch(f);
  f.journal.acknowledge(f.intent.invocationId, 200);
  const failing = createChatToolMutationStore(f.db, () => 1000, {
    write: () => {
      throw new Error("synthetic-private-sink-error");
    },
  });
  expect(failing.settle(f.intent.invocationId, "succeeded").outcome).toBe("succeeded");
});
describe("remote observation and terminal outcomes", () => {
  it("keeps a successful acknowledgement when body reading or confirmation later fails", () => {
    const f = fixture();
    dispatch(f);
    expect(f.journal.acknowledge(f.intent.invocationId, 204).phase).toBe("acknowledged");
    expect(() => f.journal.settle(f.intent.invocationId, "unknown")).toThrow("conflicts");
    expect(f.journal.settle(f.intent.invocationId, "succeeded-unconfirmed").outcome).toBe(
      "succeeded-unconfirmed",
    );
    f.journal.settle(f.intent.invocationId, "succeeded-unconfirmed");
    expect(f.logs.events.filter((event) => event.extra?.event === "settled")).toHaveLength(1);
  });
  it("does not invent success or rejection before a request is dispatched", () => {
    const f = fixture();
    f.journal.prepare(f.intent);
    expect(() => f.journal.settle(f.intent.invocationId, "succeeded")).toThrow("conflicts");
    expect(() => f.journal.acknowledge(f.intent.invocationId, 200)).toThrow("conflicts");
    expect(f.journal.settle(f.intent.invocationId, "not-dispatched").outcome).toBe(
      "not-dispatched",
    );
  });
  it.each([400, 401, 403, 404, 405, 409, 412, 413, 415, 422, 429])(
    "records known rejection %i without authorizing retry",
    (status) => {
      const f = fixture();
      dispatch(f);
      f.journal.acknowledge(f.intent.invocationId, status);
      expect(f.journal.settle(f.intent.invocationId, "rejected").httpStatus).toBe(status);
      expect(f.journal.beginDispatch(f.intent.invocationId, () => true)).toBe(false);
    },
  );
  it.each([302, 408, 418, 500, 502, 503])(
    "preserves unknown effects for ambiguous HTTP %i",
    (status) => {
      const f = fixture();
      dispatch(f);
      f.journal.acknowledge(f.intent.invocationId, status);
      expect(() => f.journal.settle(f.intent.invocationId, "rejected")).toThrow("conflicts");
      expect(f.journal.settle(f.intent.invocationId, "unknown").outcome).toBe("unknown");
    },
  );
  it("blocks new and previously prepared mutations after an unknown effect in the same turn", () => {
    const f = fixture();
    f.journal.prepare(f.intent);
    const second = { ...f.intent, invocationId: "second", actionDigest: "c".repeat(64) };
    f.journal.prepare(second);
    expect(f.journal.beginDispatch(f.intent.invocationId, () => true)).toBe(true);
    expect(f.journal.beginDispatch(second.invocationId, () => true)).toBe(false);
    f.journal.settle(f.intent.invocationId, "unknown");
    expect(f.journal.beginDispatch(second.invocationId, () => true)).toBe(false);
    expect(
      f.journal.prepare({ ...second, invocationId: "third", actionDigest: "d".repeat(64) }),
    ).toEqual({ kind: "blocked", reason: "unknown-effect" });
    f.store.failChatTurn(f.intent.chatId, "synthetic-turn", "failed");
    const newTurn = {
      ...intentFor(f.store, f.intent.chatId, "explicit-new-turn"),
      invocationId: "new-turn-action",
    };
    expect(f.journal.prepare(newTurn).kind).toBe("prepared");
    expect(f.journal.beginDispatch(newTurn.invocationId, () => true)).toBe(true);
  });
  it("emits reconstructible body-free state evidence from the actual store", () => {
    const f = fixture();
    dispatch(f);
    f.journal.settle(f.intent.invocationId, "unknown");
    const terminal = f.logs.events.find((event) => event.extra?.event === "settled");
    expectActivityLogProof(
      "chat.tool-mutation.emitted-line",
      formatActivityLogProofLine(terminal ?? {}),
    );
    expect(f.logs.events.map((event) => event.extra?.event)).toEqual([
      "prepared",
      "dispatched",
      "settled",
    ]);
    for (const privateValue of [
      "synthetic-private-body",
      f.intent.actorId,
      f.intent.podId,
      f.intent.chatId,
      f.intent.userMessageId,
      f.intent.authorityDigest,
    ])
      expect(JSON.stringify(f.logs.events)).not.toContain(privateValue);
  });
});
