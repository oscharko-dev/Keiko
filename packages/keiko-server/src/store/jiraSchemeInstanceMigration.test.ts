import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  JIRA_OPTION_SCHEME_MUTATIONS,
  JIRA_WORKFLOW_SCHEME_MUTATIONS,
  JIRA_INSTANCE_SETTING_MUTATIONS,
  JIRA_EMAIL_TEMPLATE_MUTATIONS,
  JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { runMigrations, SCHEMA_VERSION } from "./schema.js";
import {
  seedJiraMutationMigrationDatabase,
  insertJiraMigrationMutation as insert,
  insertJiraMigrationCoding as insertCoding,
  jiraMutationJournalShape as shape,
} from "./jiraMutationMigrationTestFixture.js";

const OPERATIONS = [
  "jira.create-issue-type-scheme",
  "jira.update-issue-type-scheme",
  "jira.delete-issue-type-scheme",
  "jira.add-issue-type-scheme-projects",
  "jira.set-issue-type-scheme-projects",
  "jira.clear-issue-type-scheme-projects",
  "jira.remove-issue-type-scheme-project",
  "jira.create-priority-scheme",
  "jira.update-priority-scheme",
  "jira.delete-priority-scheme",
  "jira.create-workflow-scheme",
  "jira.update-workflow-scheme",
  "jira.delete-workflow-scheme",
  "jira.create-workflow-scheme-draft",
  "jira.update-workflow-scheme-draft",
  "jira.delete-workflow-scheme-draft",
  "jira.set-workflow-scheme-default",
  "jira.delete-workflow-scheme-default",
  "jira.set-workflow-scheme-draft-default",
  "jira.delete-workflow-scheme-draft-default",
  "jira.set-workflow-scheme-issue-type",
  "jira.delete-workflow-scheme-issue-type",
  "jira.set-workflow-scheme-draft-issue-type",
  "jira.delete-workflow-scheme-draft-issue-type",
  "jira.set-workflow-scheme-workflow",
  "jira.delete-workflow-scheme-workflow",
  "jira.set-workflow-scheme-draft-workflow",
  "jira.delete-workflow-scheme-draft-workflow",
  "jira.set-application-property",
  "jira.set-system-columns",
  "jira.set-instance-base-url",
  "jira.set-read-only-mode",
  "jira.upload-email-template-pack",
  "jira.apply-email-template-pack",
  "jira.revert-email-template-pack",
] as const;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function prior(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  seedJiraMutationMigrationDatabase(db, 74);
  return db;
}
describe("V75 closed scheme and instance configuration journal vocabulary", () => {
  it("pins thirty-five native writes and every current non-draft Jira operation", () => {
    expect([...OPERATIONS].sort()).toEqual(
      [
        ...JIRA_OPTION_SCHEME_MUTATIONS,
        ...JIRA_WORKFLOW_SCHEME_MUTATIONS,
        ...JIRA_INSTANCE_SETTING_MUTATIONS,
        ...JIRA_EMAIL_TEMPLATE_MUTATIONS,
      ].sort(),
    );
    const db = prior();
    runMigrations(db);
    const operations = JIRA_MUTATION_OPERATIONS.filter((operation) => operation !== "jira.draft");
    for (const operation of operations) insert(db, operation, operation);
    expect(
      db.prepare("SELECT operation FROM chat_tool_mutations ORDER BY operation").all(),
    ).toEqual([...operations].sort().map((operation) => ({ operation })));
  });
  it.each(OPERATIONS)("admits %s only after the forward migration", (operation) => {
    const db = prior();
    expect(() => {
      insert(db, operation, "before");
    }).toThrow(/CHECK/u);
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(75);
    insert(db, operation, "after");
    expect(
      db
        .prepare("SELECT operation,phase,http_status,protocol_outcome FROM chat_tool_mutations")
        .all(),
    ).toEqual([{ operation, phase: "prepared", http_status: null, protocol_outcome: null }]);
  });
  it("preserves V74 rows, all columns/indexes/FKs, ownership and FULL durability", () => {
    const db = prior();
    insert(db, "jira.delete-role", "role");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=204 WHERE invocation_id='role'",
    );
    insert(db, "jira.delete-permission-scheme", "scheme");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='scheme'",
    );
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const previous = shape(db);
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
      rows,
    );
    expect(shape(db)).toEqual(previous);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("does not admit reads, arbitrary effects, missing authority, invented ACKs or concurrent active effects", () => {
    const db = prior();
    runMigrations(db);
    for (const operation of [
      "jira.draft",
      "jira.email-template-pack",
      "jira.server-info",
      "jira.publish-workflow-scheme",
      "jira.migrate-workflow",
      "jira.raw-http",
    ])
      expect(() => {
        insert(db, operation, operation);
      }).toThrow(/CHECK/u);
    insert(db, "jira.apply-email-template-pack", "email");
    insert(db, "jira.set-instance-base-url", "url");
    for (const clause of [
      "phase='acknowledged'",
      "phase='settled',outcome='succeeded'",
      "http_status=204",
      "source_kind='configured-mcp'",
      "protocol_outcome='success'",
      "pod_id=NULL",
      "binding_generation=0",
      "authentication_generation=0",
      "authority_digest='short'",
      "consumer_kind='coding'",
      "native_call_id='foreign'",
    ])
      expect(() => {
        db.exec(`UPDATE chat_tool_mutations SET ${clause} WHERE invocation_id='email'`);
      }).toThrow(/CHECK/u);
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='email'");
    expect(() => {
      db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='url'");
    }).toThrow(/UNIQUE/u);
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=204 WHERE invocation_id='email'",
    );
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='succeeded-unconfirmed' WHERE invocation_id='email'",
    );
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='url'");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='url'",
    );
    expect(
      db.prepare("SELECT outcome FROM chat_tool_mutations ORDER BY invocation_id").all(),
    ).toEqual([{ outcome: "succeeded-unconfirmed" }, { outcome: "unknown" }]);
  });
  it("rolls back an unfinished forward-table collision without rewriting V74", () => {
    const db = prior();
    insert(db, "jira.update-role", "kept");
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const previous = shape(db);
    db.exec("CREATE TABLE chat_tool_mutations_v75 (collision TEXT) STRICT");
    expect(() => {
      runMigrations(db);
    }).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 74 });
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
      rows,
    );
    expect(shape(db)).toEqual(previous);
  });
  it("preserves message nullification and separate Chat/Coding ownership cascades", () => {
    const db = prior();
    insertCoding(db);
    runMigrations(db);
    insert(db, "jira.set-system-columns", "columns");
    db.exec("DELETE FROM chat_messages WHERE id='message-tabs'");
    expect(
      db.prepare("SELECT user_message_id FROM chat_tool_mutations ORDER BY invocation_id").all(),
    ).toEqual([{ user_message_id: null }, { user_message_id: null }]);
    expect(() => {
      db.exec(
        "UPDATE chat_tool_mutations SET coding_run_id='foreign' WHERE invocation_id='coding'",
      );
    }).toThrow(/FOREIGN KEY/u);
    db.exec("DELETE FROM coding_runtime_snapshots WHERE run_id='run-tabs'");
    expect(db.prepare("SELECT invocation_id FROM chat_tool_mutations").all()).toEqual([
      { invocation_id: "columns" },
    ]);
    db.exec("DELETE FROM chats WHERE id='chat-tabs'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
  });
});
