import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { JIRA_ROLE_MUTATIONS, JIRA_PERMISSION_SCHEME_MUTATIONS, JIRA_MUTATION_OPERATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { runMigrations, SCHEMA_VERSION } from "./schema.js";
import { seedJiraMutationMigrationDatabase, insertJiraMigrationMutation as insert,
  insertJiraMigrationCoding as insertCoding, jiraMutationJournalShape as shape } from "./jiraMutationMigrationTestFixture.js";

const OPERATIONS = [
  "jira.create-role", "jira.update-role", "jira.replace-role", "jira.delete-role",
  "jira.add-role-default-actors", "jira.delete-role-default-actor",
  "jira.add-project-role-actors", "jira.set-project-role-actors", "jira.delete-project-role-actor",
  "jira.create-permission-scheme", "jira.update-permission-scheme", "jira.delete-permission-scheme",
  "jira.add-permission-grant", "jira.delete-permission-grant", "jira.set-permission-scheme-attribute",
] as const;
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function prior(): DatabaseSync {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  seedJiraMutationMigrationDatabase(db, 73);
  return db;
}
describe("V74 closed role and permission administration journal vocabulary", () => {
  it("pins fifteen native names and the full current mutation vocabulary", () => {
    expect([...OPERATIONS].sort()).toEqual([...JIRA_ROLE_MUTATIONS, ...JIRA_PERMISSION_SCHEME_MUTATIONS].sort());
    const db = prior(); runMigrations(db);
    const operations = JIRA_MUTATION_OPERATIONS.filter((operation) => operation !== "jira.draft");
    for (const operation of operations) insert(db, operation, operation);
    expect(db.prepare("SELECT operation FROM chat_tool_mutations ORDER BY operation").all())
      .toEqual([...operations].sort().map((operation) => ({ operation })));
  });
  it.each(OPERATIONS)("admits %s only after the forward migration", (operation) => {
    const db = prior();
    expect(() => { insert(db, operation, "before"); }).toThrow(/CHECK/u);
    runMigrations(db); expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(74);
    insert(db, operation, "after");
    expect(db.prepare("SELECT operation,phase,http_status,protocol_outcome FROM chat_tool_mutations").all())
      .toEqual([{ operation, phase: "prepared", http_status: null, protocol_outcome: null }]);
  });
  it("preserves V73 ACK/unknown rows, every column/index/FK and FULL durability", () => {
    const db = prior();
    insert(db, "jira.rank-issues", "rank");
    db.exec("UPDATE chat_tool_mutations SET phase='acknowledged',http_status=207 WHERE invocation_id='rank'");
    insert(db, "jira.delete-project-category", "category");
    db.exec("UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='category'");
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all(); const previous = shape(db);
    runMigrations(db); runMigrations(db);
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(rows);
    expect(shape(db)).toEqual(previous);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("keeps unknown operations, invented ACKs and parallel active effects closed", () => {
    const db = prior(); runMigrations(db);
    for (const operation of ["jira.draft", "jira.raw-http", "jira.grant-permission", "jira.delete-project-role", "jira.swap-role"])
      expect(() => { insert(db, operation, operation); }).toThrow(/CHECK/u);
    insert(db, "jira.delete-role", "role"); insert(db, "jira.delete-permission-scheme", "scheme");
    for (const clause of ["phase='acknowledged'", "phase='settled',outcome='succeeded'", "http_status=204",
      "source_kind='configured-mcp'", "protocol_outcome='success'", "pod_id=NULL", "binding_generation=0",
      "authentication_generation=0", "authority_digest='short'", "consumer_kind='coding'", "native_call_id='foreign'"])
      expect(() => { db.exec(`UPDATE chat_tool_mutations SET ${clause} WHERE invocation_id='role'`); }).toThrow(/CHECK/u);
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='role'");
    expect(() => { db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='scheme'"); }).toThrow(/UNIQUE/u);
    db.exec("UPDATE chat_tool_mutations SET phase='acknowledged',http_status=204 WHERE invocation_id='role'");
    db.exec("UPDATE chat_tool_mutations SET phase='settled',outcome='succeeded-unconfirmed' WHERE invocation_id='role'");
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='scheme'");
    db.exec("UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='scheme'");
    expect(db.prepare("SELECT outcome FROM chat_tool_mutations ORDER BY invocation_id").all())
      .toEqual([{ outcome: "succeeded-unconfirmed" }, { outcome: "unknown" }]);
  });
  it("rolls back an unfinished forward-table collision without changing the real V73 schema", () => {
    const db = prior(); insert(db, "jira.rank-epic", "kept"); insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all(); const previous = shape(db);
    db.exec("CREATE TABLE chat_tool_mutations_v74 (collision TEXT) STRICT");
    expect(() => { runMigrations(db); }).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 73 });
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(rows);
    expect(shape(db)).toEqual(previous);
  });
  it("preserves message nullification and Chat/Coding ownership cascades", () => {
    const db = prior(); insertCoding(db); runMigrations(db); insert(db, "jira.add-permission-grant", "grant");
    db.exec("DELETE FROM chat_messages WHERE id='message-tabs'");
    expect(db.prepare("SELECT user_message_id FROM chat_tool_mutations ORDER BY invocation_id").all())
      .toEqual([{ user_message_id: null }, { user_message_id: null }]);
    expect(() => { db.exec("UPDATE chat_tool_mutations SET coding_run_id='foreign' WHERE invocation_id='coding'"); }).toThrow(/FOREIGN KEY/u);
    db.exec("DELETE FROM coding_runtime_snapshots WHERE run_id='run-tabs'");
    expect(db.prepare("SELECT invocation_id FROM chat_tool_mutations").all()).toEqual([{ invocation_id: "grant" }]);
    db.exec("DELETE FROM chats WHERE id='chat-tabs'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
  });
});
