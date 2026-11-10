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
  "jira.set-board-property",
  "jira.delete-board-property",
  "jira.set-sprint-property",
  "jira.delete-sprint-property",
  "jira.set-comment-property",
  "jira.delete-comment-property",
  "jira.set-dashboard-item-property",
  "jira.delete-dashboard-item-property",
  "jira.set-issue-property",
  "jira.delete-issue-property",
  "jira.set-issue-type-property",
  "jira.delete-issue-type-property",
  "jira.set-project-property",
  "jira.delete-project-property",
  "jira.set-user-property",
  "jira.delete-user-property",
] as const;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function v68(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  seedJiraMutationMigrationDatabase(db, 68);
  return db;
}

describe("V69 journals only fixed native entity-property writes", () => {
  it.each(OPERATIONS)(
    "admits %s after the forward migration without a generic property operation",
    (operation) => {
      const db = v68();
      expect(() => {
        insert(db, operation, "before");
      }).toThrow(/CHECK/u);
      runMigrations(db);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(69);
      insert(db, operation, "after");
      expect(
        db.prepare("SELECT operation,phase,source_kind,http_status FROM chat_tool_mutations").all(),
      ).toEqual([{ operation, phase: "prepared", source_kind: "jira", http_status: null }]);
    },
  );

  it("preserves historical monitoring, screen and Coding rows and every durable journal boundary", () => {
    const db = v68();
    insert(db, "jira.set-app-monitoring", "monitoring");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=200 WHERE invocation_id='monitoring'",
    );
    insert(db, "jira.rename-screen-tab", "screen");
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

  it("rejects generic targets, read names, cross-owner identities and unacknowledged success", () => {
    const db = v68();
    runMigrations(db);
    for (const operation of [
      "jira.set-property",
      "jira.delete-property",
      "jira.set-dashboard-property",
      "jira.issue-property",
      "jira.project-property-keys",
      "jira.draft",
      "jira.unknown",
    ])
      expect(() => {
        insert(db, operation, operation);
      }).toThrow(/CHECK/u);
    insert(db, "jira.set-issue-property", "first");
    insert(db, "jira.delete-user-property", "second");
    for (const clause of [
      "phase='acknowledged'",
      "phase='settled',outcome='succeeded'",
      "http_status=204",
      "source_kind='configured-mcp'",
      "protocol_outcome='success'",
      "configuration_digest=authority_digest",
      "pod_id=NULL",
      "binding_generation=0",
      "authentication_generation=0",
      "consumer_kind='coding'",
      "native_call_id='other'",
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
      "UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='first'",
    );
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=204 WHERE invocation_id='second'",
    );
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='succeeded-unconfirmed' WHERE invocation_id='second'",
    );
    expect(
      db.prepare("SELECT outcome FROM chat_tool_mutations ORDER BY invocation_id").all(),
    ).toEqual([{ outcome: "unknown" }, { outcome: "succeeded-unconfirmed" }]);
  });

  it("rolls back a failed V69 rebuild without losing the existing journal or version", () => {
    const db = v68();
    insert(db, "jira.stop-jmx-metrics", "kept");
    const rows = db.prepare("SELECT * FROM chat_tool_mutations").all();
    const before = shape(db);
    db.exec("CREATE TABLE chat_tool_mutations_v69 (collision TEXT) STRICT");
    expect(() => {
      runMigrations(db);
    }).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 68 });
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual(rows);
    expect(shape(db)).toEqual(before);
  });
});
