import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createChatMemoryLearningStore } from "./chatMemoryLearning.js";
import { runMigrations } from "./schema.js";
import { rewindSchemaFixture } from "./legacySchemaTestFixture.js";

// Node 26 exposes the counter before its TypeScript declarations do.
function executedSteps(statement: StatementSync): number {
  return (statement as StatementSync & { stat(name: "vmStep"): number }).stat("vmStep");
}

function observeSteps(db: DatabaseSync): () => number {
  const prepared = vi.spyOn(db, "prepare");
  return () =>
    prepared.mock.results.reduce(
      (sum, result) => (result.type === "return" ? sum + executedSteps(result.value) : sum),
      0,
    );
}

function seedTiedChat(db: DatabaseSync): void {
  runMigrations(db);
  db.exec(`
    INSERT INTO projects (path, name, created_at, last_opened_at) VALUES ('p', 'p', 0, 0);
    INSERT INTO chats (id, project_path, title, selected_model, created_at, updated_at)
      VALUES ('c', 'p', 'c', 'local', 0, 0), ('other', 'p', 'other', 'local', 0, 0);
    INSERT INTO chat_messages (id, chat_id, role, content, timestamp)
      VALUES ('newer', 'c', 'assistant', 'answer', 0), ('other', 'other', 'user', 'other', -1);
    WITH RECURSIVE series(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM series WHERE i < 4096)
    INSERT INTO chat_messages (id, chat_id, role, content, timestamp)
      SELECT 'tie-' || i, 'c', 'user', 'entry', -1 FROM series;
    UPDATE chat_messages SET memory_learning = 'voice' WHERE id = 'tie-4096';
    INSERT INTO chat_memory_learning (chat_id, learned_timestamp, learned_rowid)
      SELECT chat_id, timestamp, rowid FROM chat_messages WHERE id = 'tie-4094';
    DELETE FROM chat_messages WHERE id = 'tie-4094';
  `);
}

describe("pending learning pages", () => {
  it("seeks past learned rows sharing a timestamp and keeps newer messages in Chat order", () => {
    using db = new DatabaseSync(":memory:");
    seedTiedChat(db);
    const readSteps = observeSteps(db);
    const store = createChatMemoryLearningStore(db);
    const tail = store.listPending("c", 2);
    expect(tail.map((message) => [message.id, message.mark?.surface])).toEqual([
      ["tie-4095", undefined],
      ["tie-4096", "voice"],
    ]);
    // Measure database work, independent of wall clock, hardware speed and concurrent tests.
    const steps = readSteps();
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(2048);
    for (const message of tail) store.advance("c", message.position);
    expect(store.listPending("c", 2).map((message) => message.id)).toEqual(["newer"]);
    expect(store.listPending("other", 2).map((message) => message.id)).toEqual(["other"]);
  });

  it("seeks the immediately preceding user even inside a long timestamp group", () => {
    using db = new DatabaseSync(":memory:");
    seedTiedChat(db);
    db.exec(`
      UPDATE chat_messages SET memory_learning = 'desktop', content = 'marked' WHERE id IN ('tie-1', 'tie-3');
      INSERT INTO chat_messages (id, chat_id, role, content, timestamp)
        VALUES ('later-user', 'c', 'user', 'later', 1);
    `);
    const readSteps = observeSteps(db);
    const store = createChatMemoryLearningStore(db);
    // The unmarked user between two marked turns must remain a consent barrier.
    expect(store.readPreviousUserText("c", "tie-3")).toBeUndefined();
    const steps = readSteps();
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(2048);
    expect(store.readPreviousUserText("c", "tie-2")).toBe("marked");
    expect(store.readPreviousUserText("c", "later-user")).toBe("entry");
    expect(store.readPreviousUserText("other", "tie-2")).toBeUndefined();
  });
});

describe("user predecessor seeks across non-user message gaps", () => {
  it("upgrades an existing database without dropping an unmarked consent barrier", () => {
    using db = new DatabaseSync(":memory:");
    seedTiedChat(db);
    rewindSchemaFixture(db, 79);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_messages_user_chat_ts'").get(),
    ).toBeUndefined();
    runMigrations(db);
    runMigrations(db);
    const store = createChatMemoryLearningStore(db);
    expect(store.readPreviousUserText("c", "tie-4096")).toBeUndefined();
    expect(store.listPending("c", 2).map((message) => message.id)).toEqual([
      "tie-4095",
      "tie-4096",
    ]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_messages_user_chat_ts'").get(),
    ).toMatchObject({ name: "idx_messages_user_chat_ts" });
  });

  it.each([0, 1])(
    "bounds work with the current timestamp %i after the predecessor group",
    (currentTimestamp) => {
      using db = new DatabaseSync(":memory:");
      runMigrations(db);
      db.exec(`
        INSERT INTO projects (path, name, created_at, last_opened_at) VALUES ('p', 'p', 0, 0);
        INSERT INTO chats (id, project_path, title, selected_model, created_at, updated_at)
          VALUES ('c', 'p', 'c', 'local', 0, 0);
        INSERT INTO chat_messages (id, chat_id, role, content, timestamp, memory_learning)
          VALUES ('first-user', 'c', 'user', 'The marked statement.', 0, 'desktop');
        WITH RECURSIVE series(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM series WHERE i < 4096)
        INSERT INTO chat_messages (id, chat_id, role, content, timestamp)
          SELECT 'answer-' || i, 'c', 'assistant', 'A synthetic answer.', 0 FROM series;
      `);
      db.prepare(
        `INSERT INTO chat_messages (id, chat_id, role, content, timestamp)
          VALUES ('current-user', 'c', 'user', 'The current statement.', ?)`,
      ).run(currentTimestamp);
      const readSteps = observeSteps(db);
      const store = createChatMemoryLearningStore(db);
      expect(store.readPreviousUserText("c", "current-user")).toBe("The marked statement.");
      const steps = readSteps();
      expect(steps).toBeGreaterThan(0);
      expect(steps).toBeLessThan(256);
    },
  );
});

describe("bounded explicit statement predecessor", () => {
  it("reads the latest two user rows including unmarked statements within their Chat", () => {
    using db = new DatabaseSync(":memory:");
    seedTiedChat(db);
    const readSteps = observeSteps(db);
    const store = createChatMemoryLearningStore(db);
    // A newer assistant row is not a statement, and an uncommitted current turn is not skipped.
    expect(store.readPreviousUserMessage("c", "Not stored yet.")).toEqual({
      id: "tie-4096",
      content: "entry",
      timestamp: -1,
    });
    const steps = readSteps();
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(256);
    // The matching newest row is this already-stored turn. The next user is unmarked but erasable.
    expect(store.readPreviousUserMessage("c", "entry")).toEqual({
      id: "tie-4095",
      content: "entry",
      timestamp: -1,
    });
    expect(store.readPreviousUserMessage("other", "Not stored yet.")).toEqual({
      id: "other",
      content: "other",
      timestamp: -1,
    });
    expect(store.readPreviousUserMessage("missing", "Not stored yet.")).toBeUndefined();
  });
});
