import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  JIRA_SCREEN_CONFIGURATION_MUTATIONS, JIRA_BOARD_CONFIGURATION_MUTATIONS,
  JIRA_SPRINT_LIFECYCLE_MUTATIONS, JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { runMigrations, SCHEMA_VERSION } from "./schema.js";
import {
  seedJiraMutationMigrationDatabase, insertJiraMigrationMutation as insert,
  insertJiraMigrationCoding as insertCoding, jiraMutationJournalShape as shape,
} from "./jiraMutationMigrationTestFixture.js";

const OPERATIONS = [
  "jira.add-default-screen-field", "jira.add-screen-tab-field", "jira.remove-screen-tab-field",
  "jira.move-screen-tab-field", "jira.set-screen-field-show-when-empty", "jira.move-screen-tab",
  "jira.delete-board", "jira.set-board-refined-velocity", "jira.replace-sprint", "jira.delete-sprint",
  "jira.swap-sprints", "jira.unmap-sprints", "jira.unmap-all-sprints",
] as const;
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function v71(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  seedJiraMutationMigrationDatabase(db, 71);
  return db;
}
describe("V72 closed screen/board/sprint journal vocabulary", () => {
  it("pins the thirteen new native identities and every current native mutation independently", () => {
    expect([...OPERATIONS].sort()).toEqual([
      ...JIRA_SCREEN_CONFIGURATION_MUTATIONS, ...JIRA_BOARD_CONFIGURATION_MUTATIONS, ...JIRA_SPRINT_LIFECYCLE_MUTATIONS,
    ].sort());
    const db = v71();
    runMigrations(db);
    const native = JIRA_MUTATION_OPERATIONS.filter((operation) => operation !== "jira.draft");
    for (const operation of native) insert(db, operation, operation);
    expect(db.prepare("SELECT operation FROM chat_tool_mutations ORDER BY operation").all())
      .toEqual([...native].sort().map((operation) => ({ operation })));
  });
  it.each(OPERATIONS)("admits %s only after the forward migration", (operation) => {
    const db = v71();
    expect(() => { insert(db, operation, "before"); }).toThrow(/CHECK/u);
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(72);
    insert(db, operation, "after");
    expect(db.prepare("SELECT operation,phase,source_kind,http_status,protocol_outcome FROM chat_tool_mutations").all()).toEqual([
      { operation, phase: "prepared", source_kind: "jira", http_status: null, protocol_outcome: null },
    ]);
  });
  it("retains V71 ACK/unknown/Coding rows, every column/index/FK and FULL durability", () => {
    const db = v71();
    insert(db, "jira.create-issue-link", "link");
    db.exec("UPDATE chat_tool_mutations SET phase='acknowledged',http_status=201 WHERE invocation_id='link'");
    insert(db, "jira.merge-version", "merge");
    db.exec("UPDATE chat_tool_mutations SET phase='settled',outcome='succeeded-unconfirmed',http_status=204 WHERE invocation_id='merge'");
    insert(db, "jira.delete-filter", "filter");
    db.exec("UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='filter'");
    insertCoding(db);
    const previousRows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const previousShape = shape(db);
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(previousRows);
    expect(shape(db)).toEqual(previousShape);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("retains native identity, ownership, ACK and single-active-effect constraints", () => {
    const db = v71();
    runMigrations(db);
    for (const operation of ["jira.draft", "jira.raw-http", "jira.move-screen", "jira.unmap", "jira.delete-sprints"])
      expect(() => { insert(db, operation, operation); }).toThrow(/CHECK/u);
    insert(db, "jira.delete-board", "first");
    insert(db, "jira.unmap-all-sprints", "second");
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
  it("rolls back migration collisions without touching previous data or version", () => {
    const db = v71();
    insert(db, "jira.move-version", "kept");
    insertCoding(db);
    const previousRows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const previousShape = shape(db);
    db.exec("CREATE TABLE chat_tool_mutations_v72 (collision TEXT) STRICT");
    expect(() => { runMigrations(db); }).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 71 });
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(previousRows);
    expect(shape(db)).toEqual(previousShape);
  });
  it("preserves message nullification and distinct Coding/Chat ownership cascades", () => {
    const db = v71();
    insertCoding(db);
    runMigrations(db);
    insert(db, "jira.move-screen-tab", "tab");
    db.exec("DELETE FROM chat_messages WHERE id='message-tabs'");
    expect(db.prepare("SELECT user_message_id FROM chat_tool_mutations ORDER BY invocation_id").all())
      .toEqual([{ user_message_id: null }, { user_message_id: null }]);
    expect(() => { db.exec("UPDATE chat_tool_mutations SET coding_run_id='foreign' WHERE invocation_id='coding'"); }).toThrow(/FOREIGN KEY/u);
    db.exec("DELETE FROM coding_runtime_snapshots WHERE run_id='run-tabs'");
    expect(db.prepare("SELECT invocation_id FROM chat_tool_mutations").all()).toEqual([{ invocation_id: "tab" }]);
    db.exec("DELETE FROM chats WHERE id='chat-tabs'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
  });
});
