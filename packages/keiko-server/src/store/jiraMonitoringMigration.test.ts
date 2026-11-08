import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations, SCHEMA_VERSION } from "./schema.js";
import {
  seedJiraMutationMigrationDatabase,
  insertJiraMigrationMutation as insert,
  insertJiraMigrationCoding as insertCoding,
  jiraMutationJournalShape as shape,
} from "./jiraMutationMigrationTestFixture.js";

const OPERATIONS = [
  "jira.set-app-monitoring",
  "jira.set-ipd-monitoring",
  "jira.start-jmx-metrics",
  "jira.stop-jmx-metrics",
] as const;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function v67(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  seedJiraMutationMigrationDatabase(db, 67);
  return db;
}

describe("V68 closed monitoring mutation journal vocabulary", () => {
  it.each(OPERATIONS)("admits %s only after the forward migration", (operation) => {
    const db = v67();
    expect(() => {
      insert(db, operation, "before");
    }).toThrow(/CHECK/u);
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(68);
    insert(db, operation, "after");
    expect(
      db
        .prepare("SELECT operation,phase,http_status,protocol_outcome FROM chat_tool_mutations")
        .all(),
    ).toEqual([{ operation, phase: "prepared", http_status: null, protocol_outcome: null }]);
  });

  it("retains V67 acknowledged screen writes, Coding history and the complete existing journal shape", () => {
    const db = v67();
    insert(db, "jira.create-screen-tab", "screen");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=201 WHERE invocation_id='screen'",
    );
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const before = shape(db);
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
      rows,
    );
    expect(shape(db)).toEqual(before);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves one active effect, source ownership and uncertainty instead of admitting a new status model", () => {
    const db = v67();
    runMigrations(db);
    insert(db, "jira.start-jmx-metrics", "first");
    insert(db, "jira.stop-jmx-metrics", "second");
    for (const clause of [
      "phase='acknowledged'",
      "phase='settled',outcome='succeeded'",
      "protocol_outcome='success'",
      "configuration_digest=authority_digest",
      "consumer_kind='coding'",
      "native_session_id='other'",
      "binding_generation=0",
      "authentication_generation=0",
      "batch_digest='invalid'",
    ])
      expect(() => {
        db.exec(`UPDATE chat_tool_mutations SET ${clause} WHERE invocation_id='first'`);
      }).toThrow(/CHECK/u);
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='first'");
    expect(() => {
      db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='second'");
    }).toThrow(/UNIQUE/u);
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='unknown',http_status=400 WHERE invocation_id='first'",
    );
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=204 WHERE invocation_id='second'",
    );
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='succeeded-unconfirmed' WHERE invocation_id='second'",
    );
    expect(
      db
        .prepare("SELECT outcome,http_status FROM chat_tool_mutations ORDER BY invocation_id")
        .all(),
    ).toEqual([
      { outcome: "unknown", http_status: 400 },
      { outcome: "succeeded-unconfirmed", http_status: 204 },
    ]);
    for (const operation of [
      "jira.draft",
      "jira.monitoring",
      "jira.set-jmx-metrics",
      "jira.restart",
      "jira.unknown",
    ])
      expect(() => {
        insert(db, operation, operation);
      }).toThrow(/CHECK/u);
  });

  it("rolls back a failed table rebuild without changing V67 version, rows or indexes", () => {
    const db = v67();
    insert(db, "jira.rename-screen-tab", "kept");
    const rows = db.prepare("SELECT * FROM chat_tool_mutations").all();
    const before = shape(db);
    db.exec("CREATE TABLE chat_tool_mutations_v68 (collision TEXT) STRICT");
    expect(() => {
      runMigrations(db);
    }).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 67 });
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual(rows);
    expect(shape(db)).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps message nullification and Coding/Chat cascade ownership for newly admitted effects", () => {
    const db = v67();
    insertCoding(db);
    runMigrations(db);
    insert(db, "jira.set-ipd-monitoring", "monitoring");
    db.exec("DELETE FROM chat_messages WHERE id='message-tabs'");
    expect(
      db.prepare("SELECT user_message_id FROM chat_tool_mutations ORDER BY invocation_id").all(),
    ).toEqual([{ user_message_id: null }, { user_message_id: null }]);
    db.exec("DELETE FROM coding_runtime_snapshots WHERE run_id='run-tabs'");
    expect(db.prepare("SELECT invocation_id FROM chat_tool_mutations").all()).toEqual([
      { invocation_id: "monitoring" },
    ]);
    db.exec("DELETE FROM chats WHERE id='chat-tabs'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
  });
});
