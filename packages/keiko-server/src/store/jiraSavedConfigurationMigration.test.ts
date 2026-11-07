import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { JIRA_SAVED_CONFIGURATION_MUTATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { runMigrations, SCHEMA_VERSION } from "./schema.js";
import {
  seedJiraMutationMigrationDatabase,
  insertJiraMigrationMutation as insert,
  insertJiraMigrationCoding as insertCoding,
  jiraMutationJournalShape as shape,
} from "./jiraMutationMigrationTestFixture.js";

// Independent literal expectations: neither SQL nor the runtime registry supplies these names.
const OPERATIONS = [
  "jira.create-filter", "jira.update-filter", "jira.delete-filter", "jira.set-filter-share-scope",
  "jira.set-filter-columns", "jira.reset-filter-columns",
  "jira.add-filter-permission", "jira.delete-filter-permission",
  "jira.set-my-preference", "jira.delete-my-preference",
] as const;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function v69(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  seedJiraMutationMigrationDatabase(db, 69);
  return db;
}

describe("V70 admits only the ten fixed saved configuration mutation identities", () => {
  it("keeps the migration's explicit new vocabulary complete against the public contract", () => {
    expect([...OPERATIONS].sort()).toEqual([...JIRA_SAVED_CONFIGURATION_MUTATIONS].sort());
  });

  it.each(OPERATIONS)("requires the forward migration for %s", (operation) => {
    const db = v69();
    expect(() => { insert(db, operation, "before"); }).toThrow(/CHECK/u);
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(70);
    insert(db, operation, "after");
    expect(db.prepare("SELECT operation,phase,source_kind,http_status,protocol_outcome FROM chat_tool_mutations").all()).toEqual([
      { operation, phase: "prepared", source_kind: "jira", http_status: null, protocol_outcome: null },
    ]);
  });

  it("preserves actual V69 property, monitoring, screen and Coding records and every journal boundary", () => {
    const db = v69();
    insert(db, "jira.set-project-property", "property");
    db.exec("UPDATE chat_tool_mutations SET phase='acknowledged',http_status=204 WHERE invocation_id='property'");
    insert(db, "jira.stop-jmx-metrics", "monitoring");
    db.exec("UPDATE chat_tool_mutations SET phase='settled',outcome='unknown',http_status=503 WHERE invocation_id='monitoring'");
    insert(db, "jira.rename-screen-tab", "screen");
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const previousShape = shape(db);
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(rows);
    expect(shape(db)).toEqual(previousShape);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects generic operations, read names, forged source ownership and invalid authority evidence", () => {
    const db = v69();
    runMigrations(db);
    for (const operation of [
      "jira.filter", "jira.filter-permissions", "jira.my-preference", "jira.draft",
      "jira.write-filter", "jira.set-preference", "jira.set-any-setting", "jira.raw-http",
    ]) expect(() => { insert(db, operation, operation); }).toThrow(/CHECK/u);
    insert(db, "jira.add-filter-permission", "first");
    insert(db, "jira.delete-filter", "second");
    for (const clause of [
      "phase='acknowledged'", "phase='settled',outcome='succeeded'", "http_status=204",
      "source_kind='configured-mcp'", "protocol_outcome='success'", "configuration_digest=authority_digest",
      "pod_id=NULL", "binding_generation=0", "authentication_generation=0", "authority_digest='short'",
      "action_digest='short'", "consumer_kind='coding'", "native_call_id='forged'", "batch_digest='invalid'",
    ]) expect(() => { db.exec(`UPDATE chat_tool_mutations SET ${clause} WHERE invocation_id='first'`); }).toThrow(/CHECK/u);
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='first'");
    expect(() => { db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='second'"); }).toThrow(/UNIQUE/u);
    db.exec("UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='first'");
    db.exec("UPDATE chat_tool_mutations SET phase='acknowledged',http_status=204 WHERE invocation_id='second'");
    db.exec("UPDATE chat_tool_mutations SET phase='settled',outcome='succeeded-unconfirmed' WHERE invocation_id='second'");
    expect(db.prepare("SELECT outcome FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual([
      { outcome: "unknown" }, { outcome: "succeeded-unconfirmed" },
    ]);
  });

  it("rolls back a V70 target-table collision without losing historical rows, indexes or version", () => {
    const db = v69();
    insert(db, "jira.delete-issue-type-property", "property");
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const previousShape = shape(db);
    db.exec("CREATE TABLE chat_tool_mutations_v70 (collision TEXT) STRICT");
    expect(() => { runMigrations(db); }).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 69 });
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(rows);
    expect(shape(db)).toEqual(previousShape);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains message nullification and distinct Coding/Chat cascading ownership", () => {
    const db = v69();
    insertCoding(db);
    runMigrations(db);
    insert(db, "jira.set-my-preference", "preference");
    db.exec("DELETE FROM chat_messages WHERE id='message-tabs'");
    expect(db.prepare("SELECT user_message_id FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual([
      { user_message_id: null }, { user_message_id: null },
    ]);
    expect(() => { db.exec("UPDATE chat_tool_mutations SET coding_run_id='missing-run' WHERE invocation_id='coding'"); }).toThrow(/FOREIGN KEY/u);
    db.exec("DELETE FROM coding_runtime_snapshots WHERE run_id='run-tabs'");
    expect(db.prepare("SELECT invocation_id FROM chat_tool_mutations").all()).toEqual([{ invocation_id: "preference" }]);
    db.exec("DELETE FROM chats WHERE id='chat-tabs'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
  });
});
