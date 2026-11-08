import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations, SCHEMA_VERSION } from "./schema.js";
import {
  seedJiraMutationMigrationDatabase,
  insertJiraMigrationMutation as insert,
  insertJiraMigrationCoding as insertCoding,
  jiraMutationJournalShape as shape,
} from "./jiraMutationMigrationTestFixture.js";

const databases: DatabaseSync[] = [];
const TAB_OPERATIONS = ["jira.create-screen-tab", "jira.rename-screen-tab", "jira.delete-screen-tab"] as const;
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function v66(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  seedJiraMutationMigrationDatabase(db, 66);
  return db;
}

describe("V67 screen-tab operations retain the existing durable journal", () => {
  it.each(TAB_OPERATIONS)("admits %s only after the forward migration", (operation) => {
    const db = v66();
    expect(() => { insert(db, operation, "before"); }).toThrow(/CHECK/u);
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(67);
    expect(() => { insert(db, operation, "after"); }).not.toThrow();
    expect(db.prepare("SELECT operation,phase,http_status FROM chat_tool_mutations").all()).toEqual([
      { operation, phase: "prepared", http_status: null },
    ]);
  });

  it("preserves acknowledged Jira and settled Coding rows, all columns, indexes, foreign keys and FULL durability", () => {
    const db = v66();
    insert(db, "jira.delete-worklog", "existing");
    db.exec("UPDATE chat_tool_mutations SET phase='acknowledged',http_status=204 WHERE invocation_id='existing'");
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const before = shape(db);
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(rows);
    expect(shape(db)).toEqual(before);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps one active Chat effect and refuses unacknowledged success, cross-owner state and undeclared operations", () => {
    const db = v66();
    runMigrations(db);
    insert(db, "jira.create-screen-tab", "first");
    insert(db, "jira.rename-screen-tab", "second");
    for (const operation of ["jira.draft", "jira.create-screen", "jira.delete-screen", "jira.move-screen", "jira.unknown"])
      expect(() => { insert(db, operation, operation); }).toThrow(/CHECK/u);
    for (const clause of [
      "http_status=201", "protocol_outcome='success'", "phase='acknowledged'",
      "phase='settled',outcome='succeeded'", "source_kind='configured-mcp'",
      "configuration_digest=authority_digest", "binding_generation=0",
      "authentication_generation=0", "consumer_kind='coding'", "native_call_id='other'",
      "batch_digest='invalid'",
    ]) expect(() => { db.exec(`UPDATE chat_tool_mutations SET ${clause} WHERE invocation_id='first'`); }).toThrow(/CHECK/u);
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='first'");
    expect(() => { db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='second'"); }).toThrow(/UNIQUE/u);
    db.exec("UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='first'");
    expect(() => { db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='second'"); }).not.toThrow();
  });

  it("retains message nullification and native Coding/Chat cascade ownership", () => {
    const db = v66();
    insertCoding(db);
    runMigrations(db);
    insert(db, "jira.delete-screen-tab", "chat");
    db.exec("DELETE FROM chat_messages WHERE id='message-tabs'");
    expect(db.prepare("SELECT user_message_id FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual([
      { user_message_id: null }, { user_message_id: null },
    ]);
    db.exec("DELETE FROM coding_runtime_snapshots WHERE run_id='run-tabs'");
    expect(db.prepare("SELECT invocation_id FROM chat_tool_mutations").all()).toEqual([{ invocation_id: "chat" }]);
    db.exec("DELETE FROM chats WHERE id='chat-tabs'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
