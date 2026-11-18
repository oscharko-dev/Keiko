import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatMemoryLearningStore } from "./chatMemoryLearning.js";

const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases) db.close();
  databases.length = 0;
});

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TEMP TABLE chats (id TEXT NOT NULL PRIMARY KEY) STRICT;
    CREATE TEMP TABLE chat_messages (
      id TEXT NOT NULL PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, timestamp INTEGER NOT NULL, memory_learning TEXT,
      memory_learning_mode TEXT
    ) STRICT;
    CREATE INDEX idx_messages_chat_id ON chat_messages(chat_id);
    CREATE INDEX idx_messages_chat_ts ON chat_messages(chat_id,timestamp);
    CREATE INDEX idx_messages_memory_learning ON chat_messages(chat_id,timestamp)
      WHERE memory_learning IS NOT NULL;
    CREATE TEMP TABLE chat_memory_learning (
      chat_id TEXT NOT NULL PRIMARY KEY, learned_timestamp INTEGER NOT NULL,
      learned_rowid INTEGER NOT NULL
    ) STRICT;
  `);
  return db;
}

function message(
  db: DatabaseSync,
  chat: string,
  id: string,
  timestamp: number,
  { role = "user", mark = "desktop" }: { role?: string; mark?: string | null } = {},
): number {
  db.prepare("INSERT OR IGNORE INTO chats VALUES (?)").run(chat);
  return Number(
    db
      .prepare("INSERT INTO chat_messages VALUES (?,?,?,'synthetic',?,?,NULL)")
      .run(id, chat, role, timestamp, mark).lastInsertRowid,
  );
}

// Node 26 exposes SQLite's actual statement work counter; the installed types predate that API.
type MeasuredStatement = StatementSync & { stat(counter: "vmStep"): number };

function observeWork(db: DatabaseSync): () => number {
  const statements: StatementSync[] = [];
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    statements.push(statement);
    return statement;
  });
  return () =>
    statements.reduce((sum, statement) => sum + (statement as MeasuredStatement).stat("vmStep"), 0);
}

describe("global pending-chat queue", () => {
  it("keeps cursor ties, user roles, consent, ordering and keyset pages", () => {
    const db = database();
    const store = createChatMemoryLearningStore(db);
    const learned = message(db, "tie", "old", 20);
    store.advance("tie", { timestamp: 20, rowid: learned });
    message(db, "tie", "new", 20, { mark: "voice" });
    message(db, "alpha", "alpha", 30);
    message(db, "beta", "beta", 30);
    message(db, "gamma", "gamma", 40, { mark: "voice" });
    message(db, "alpha", "old-assistant", 1, { role: "assistant" });
    message(db, "unmarked", "unmarked", 0, { mark: null });
    message(db, "assistant-only", "assistant", 0, { role: "assistant" });
    const done = message(db, "done", "done", -5);
    store.advance("done", { timestamp: -5, rowid: done });

    const all = [
      { chatId: "tie", firstPendingTimestamp: 20 },
      { chatId: "alpha", firstPendingTimestamp: 30 },
      { chatId: "beta", firstPendingTimestamp: 30 },
      { chatId: "gamma", firstPendingTimestamp: 40 },
    ];
    expect(store.listPendingChats(20)).toEqual(all);
    expect(store.listPendingChats(2)).toEqual(all.slice(0, 2));
    expect(store.listPendingChats(2, all[1])).toEqual(all.slice(2));
    expect(store.listPendingChats(2, all[3])).toEqual([]);
    expect(store.listChatsWithPending(20)).toEqual(all.map((row) => row.chatId));
    const current = db.prepare("SELECT rowid AS rowid FROM chat_messages WHERE id='new'").get();
    store.advance("tie", { timestamp: 20, rowid: Number(current?.rowid) });
    expect(store.listPendingChats(20)).toEqual(all.slice(1));
    expect(() => store.listPendingChats(0)).toThrow("limit must be a positive integer");
  });

  it("seeks the first pending turns across 128 long chats instead of rescanning their histories", () => {
    const db = database();
    db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<127)
      INSERT INTO chats SELECT printf('c%03d',i) FROM n;
      WITH RECURSIVE turns(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM turns WHERE i<1023)
      INSERT INTO chat_messages
      SELECT printf('%s-%04d',c.id,t.i),c.id,'user','synthetic',t.i/4,'desktop',NULL
      FROM chats c CROSS JOIN turns t ORDER BY c.id,t.i;
      INSERT INTO chat_memory_learning
      SELECT chat_id,MAX(timestamp),MAX(rowid)-1 FROM chat_messages GROUP BY chat_id;
    `);
    const steps = observeWork(db);
    const store = createChatMemoryLearningStore(db);
    expect(store.listPendingChats(9)).toEqual(
      Array.from({ length: 9 }, (_, i) => ({
        chatId: `c${String(i).padStart(3, "0")}`,
        firstPendingTimestamp: 255,
      })),
    );
    // A real SQLite work bound, independent of wall-clock speed. The old scan takes >2M steps.
    expect(steps()).toBeLessThan(50_000);
  });

  it("keeps sparse unknown chats and an empty queue cheap without reading unmarked history", () => {
    const db = database();
    db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<19999)
      INSERT INTO chats SELECT printf('c%05d',i) FROM n;
      INSERT INTO chat_messages
      SELECT id,id,'user','synthetic',-10,
        CASE WHEN CAST(substr(id,2) AS INTEGER)%1000=0 THEN 'voice' ELSE NULL END,NULL
      FROM chats;
    `);
    const steps = observeWork(db);
    const store = createChatMemoryLearningStore(db);
    expect(store.listPendingChats(9)).toHaveLength(9);
    expect(steps()).toBeLessThan(5_000);
    expect(store.listPendingChats(9, { chatId: "z", firstPendingTimestamp: 0 })).toEqual([]);
    db.exec("DELETE FROM chat_messages; DELETE FROM chats;");
    expect(store.listPendingChats(9)).toEqual([]);
  });

  it("keeps a queue wider than the seek probe complete and reuses fresh state across paths", () => {
    const db = database();
    db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<256)
      INSERT INTO chats SELECT printf('c%03d',i) FROM n;
      INSERT INTO chat_messages SELECT id,id,'user','synthetic',0,'desktop',NULL FROM chats;
      INSERT INTO chat_memory_learning
      SELECT chat_id,timestamp,rowid FROM chat_messages WHERE chat_id='c000';
    `);
    const store = createChatMemoryLearningStore(db);
    expect(store.listPendingChats(300)).toHaveLength(256);
    expect(store.listPendingChats(1)).toEqual([{ chatId: "c001", firstPendingTimestamp: 0 }]);
    expect(store.listPendingChats(9, { chatId: "c255", firstPendingTimestamp: 0 })).toEqual([
      { chatId: "c256", firstPendingTimestamp: 0 },
    ]);
    db.exec("DELETE FROM chat_messages WHERE chat_id='c256'; DELETE FROM chats WHERE id='c256';");
    expect(store.listPendingChats(300)).toHaveLength(255);
    expect(store.listChatsWithPending(2)).toEqual(["c001", "c002"]);
  });
});
