import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  JIRA_GROUP_MUTATIONS,
  JIRA_ISSUE_ACTION_MUTATIONS,
  JIRA_MAINTENANCE_MUTATIONS,
  JIRA_SCHEMA_MUTATIONS,
  JIRA_DIRECTORY_ACCESS_MUTATIONS,
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
  "jira.create-group",
  "jira.delete-group",
  "jira.add-group-user",
  "jira.remove-group-user",
  "jira.pin-comment",
  "jira.notify-issue",
  "jira.request-cluster-index-snapshot",
  "jira.delete-cluster-node",
  "jira.mark-cluster-node-offline",
  "jira.approve-cluster-upgrade",
  "jira.cancel-cluster-upgrade",
  "jira.retry-cluster-upgrade",
  "jira.start-cluster-upgrade",
  "jira.create-index-snapshot",
  "jira.start-reindex",
  "jira.reindex-issues",
  "jira.process-reindex-requests",
  "jira.run-upgrade",
  "jira.create-custom-field",
  "jira.delete-custom-fields",
  "jira.create-issue-type",
  "jira.update-issue-type",
  "jira.delete-issue-type",
  "jira.create-link-type",
  "jira.update-link-type",
  "jira.delete-link-type",
  "jira.reset-link-type-order",
  "jira.move-link-type",
  "jira.set-terminology",
  "jira.set-application-role",
  "jira.set-application-roles",
  "jira.add-user-application",
  "jira.remove-user-application",
  "jira.set-user-columns",
  "jira.reset-user-columns",
] as const;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function prior(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  seedJiraMutationMigrationDatabase(db, 75);
  return db;
}
describe("V76 system/directory/schema and issue-action journal vocabulary", () => {
  it("admits exactly the complete current native write vocabulary", () => {
    expect([...OPERATIONS].sort()).toEqual(
      [
        ...JIRA_GROUP_MUTATIONS,
        ...JIRA_ISSUE_ACTION_MUTATIONS,
        ...JIRA_MAINTENANCE_MUTATIONS,
        ...JIRA_SCHEMA_MUTATIONS,
        ...JIRA_DIRECTORY_ACCESS_MUTATIONS,
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
  it.each(OPERATIONS)("requires the forward migration before admitting %s", (operation) => {
    const db = prior();
    expect(() => {
      insert(db, operation, "before");
    }).toThrow(/CHECK/u);
    runMigrations(db);
    insert(db, operation, "after");
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(76);
    expect(
      db
        .prepare("SELECT operation,phase,http_status,protocol_outcome FROM chat_tool_mutations")
        .all(),
    ).toEqual([{ operation, phase: "prepared", http_status: null, protocol_outcome: null }]);
  });
  it("preserves acknowledged and uncertain native rows, private Coding rows, all constraints and ownership", () => {
    const db = prior();
    insert(db, "jira.update-workflow-scheme", "workflow");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=204 WHERE invocation_id='workflow'",
    );
    insert(db, "jira.apply-email-template-pack", "email");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='email'",
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
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
  });
  it("does not create authority, accept made-up ACKs or allow a second active effect", () => {
    const db = prior();
    runMigrations(db);
    for (const operation of [
      "jira.cluster-nodes",
      "jira.reindex-status",
      "jira.raw-http",
      "jira.restart-node",
      "jira.draft",
    ])
      expect(() => {
        insert(db, operation, operation);
      }).toThrow(/CHECK/u);
    insert(db, "jira.run-upgrade", "upgrade");
    insert(db, "jira.notify-issue", "mail");
    for (const clause of [
      "phase='acknowledged'",
      "phase='settled',outcome='succeeded'",
      "http_status=200",
      "protocol_outcome='success'",
      "pod_id=NULL",
      "binding_generation=0",
      "authentication_generation=0",
      "authority_digest='short'",
      "consumer_kind='coding'",
      "native_call_id='foreign'",
    ])
      expect(() => {
        db.exec(`UPDATE chat_tool_mutations SET ${clause} WHERE invocation_id='upgrade'`);
      }).toThrow(/CHECK/u);
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='upgrade'");
    expect(() => {
      db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='mail'");
    }).toThrow(/UNIQUE/u);
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=200 WHERE invocation_id='upgrade'",
    );
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='succeeded-unconfirmed' WHERE invocation_id='upgrade'",
    );
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='mail'");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='mail'",
    );
    expect(
      db
        .prepare("SELECT invocation_id,outcome FROM chat_tool_mutations ORDER BY invocation_id")
        .all(),
    ).toEqual([
      { invocation_id: "mail", outcome: "unknown" },
      { invocation_id: "upgrade", outcome: "succeeded-unconfirmed" },
    ]);
  });
  it("rolls back a forward-table collision and retains the exact V75 data", () => {
    const db = prior();
    insert(db, "jira.set-system-columns", "kept");
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const previous = shape(db);
    db.exec("CREATE TABLE chat_tool_mutations_v76 (collision TEXT) STRICT");
    expect(() => {
      runMigrations(db);
    }).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 75 });
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
      rows,
    );
    expect(shape(db)).toEqual(previous);
  });
  it("keeps the existing Chat message and Coding run ownership cascades", () => {
    const db = prior();
    insertCoding(db);
    runMigrations(db);
    insert(db, "jira.pin-comment", "pin");
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
      { invocation_id: "pin" },
    ]);
    db.exec("DELETE FROM chats WHERE id='chat-tabs'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
  });
});
