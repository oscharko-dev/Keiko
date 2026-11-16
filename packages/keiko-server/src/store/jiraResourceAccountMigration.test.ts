import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  JIRA_AVATAR_MUTATIONS,
  JIRA_IDENTITY_MUTATIONS,
  JIRA_PRIVATE_ACCOUNT_MUTATIONS,
  JIRA_ISSUE_LIFECYCLE_MUTATIONS,
  JIRA_PROJECT_LIFECYCLE_MUTATIONS,
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
  "jira.unlock-user-anonymization",
  "jira.archive-issues",
  "jira.delete-issue",
  "jira.archive-issue",
  "jira.restore-issue",
  "jira.move-subtask",
  "jira.create-issues",
  "jira.create-reciprocal-remote-link",
  "jira.delete-project",
  "jira.archive-project",
  "jira.restore-project",
  "jira.update-project-type",
  "jira.set-project-permission-scheme",
  "jira.set-project-priority-scheme",
  "jira.remove-project-priority-scheme",
  "jira.create-user",
  "jira.update-user",
  "jira.delete-user",
  "jira.invalidate-user-session",
  "jira.schedule-user-anonymization",
  "jira.rerun-user-anonymization",
  "jira.upload-temporary-avatar",
  "jira.crop-temporary-avatar",
  "jira.upload-issue-type-avatar",
  "jira.create-issue-type-avatar",
  "jira.upload-project-avatar",
  "jira.create-project-avatar",
  "jira.set-project-avatar",
  "jira.delete-project-avatar",
  "jira.upload-owned-avatar",
  "jira.create-owned-avatar",
  "jira.delete-owned-avatar",
  "jira.upload-user-avatar",
  "jira.create-user-avatar",
  "jira.set-user-avatar",
  "jira.delete-user-avatar",
  "jira.update-myself",
  "jira.update-my-password",
  "jira.update-user-password",
  "jira.login",
  "jira.logout",
  "jira.release-websudo",
] as const;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function prior(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  seedJiraMutationMigrationDatabase(db, 76);
  return db;
}
describe("V77 resource/account/avatar native journal vocabulary", () => {
  it("admits exactly the implemented mutation set, including all prior native writes", () => {
    expect([...OPERATIONS].sort()).toEqual(
      [
        ...JIRA_AVATAR_MUTATIONS,
        ...JIRA_IDENTITY_MUTATIONS,
        ...JIRA_PRIVATE_ACCOUNT_MUTATIONS,
        ...JIRA_ISSUE_LIFECYCLE_MUTATIONS,
        ...JIRA_PROJECT_LIFECYCLE_MUTATIONS,
        "jira.unlock-user-anonymization",
        "jira.create-issues",
        "jira.create-reciprocal-remote-link",
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
  it.each(OPERATIONS)("requires V77 before admitting %s", (operation) => {
    const db = prior();
    expect(() => {
      insert(db, operation, "before");
    }).toThrow(/CHECK/u);
    runMigrations(db);
    insert(db, operation, "after");
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(77);
    expect(
      db
        .prepare("SELECT operation,phase,http_status,protocol_outcome FROM chat_tool_mutations")
        .all(),
    ).toEqual([{ operation, phase: "prepared", http_status: null, protocol_outcome: null }]);
  });
  it("keeps private validation reads and invented unlock aliases outside the write journal", () => {
    const db = prior();
    runMigrations(db);
    for (const operation of [
      "jira.validate-create-user-password",
      "jira.validate-update-user-password",
      "jira.validate-license",
      "jira.unlock-anonymization",
      "jira.current-session",
      "jira.project",
      "jira.raw-http",
      "jira.draft",
    ])
      expect(() => {
        insert(db, operation, operation);
      }).toThrow(/CHECK/u);
  });
  it("preserves acknowledged/unknown native records, Coding ownership, indexes and constraints", () => {
    const db = prior();
    insert(db, "jira.run-upgrade", "acknowledged");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=202 WHERE invocation_id='acknowledged'",
    );
    insert(db, "jira.notify-issue", "unknown");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='unknown'",
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
  it("never invents ACKs, removes ownership or admits a second active native effect", () => {
    const db = prior();
    runMigrations(db);
    insert(db, "jira.create-issues", "bulk");
    insert(db, "jira.delete-project", "delete");
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
        db.exec(`UPDATE chat_tool_mutations SET ${clause} WHERE invocation_id='bulk'`);
      }).toThrow(/CHECK/u);
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='bulk'");
    expect(() => {
      db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='delete'");
    }).toThrow(/UNIQUE/u);
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=201 WHERE invocation_id='bulk'",
    );
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='succeeded-unconfirmed' WHERE invocation_id='bulk'",
    );
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='delete'");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='delete'",
    );
    expect(
      db
        .prepare("SELECT invocation_id,outcome FROM chat_tool_mutations ORDER BY invocation_id")
        .all(),
    ).toEqual([
      { invocation_id: "bulk", outcome: "succeeded-unconfirmed" },
      { invocation_id: "delete", outcome: "unknown" },
    ]);
  });
  it("rolls back a forward-table collision without touching historical V76 rows", () => {
    const db = prior();
    insert(db, "jira.run-upgrade", "kept");
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const previous = shape(db);
    db.exec("CREATE TABLE chat_tool_mutations_v77 (collision TEXT) STRICT");
    expect(() => {
      runMigrations(db);
    }).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 76 });
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
      rows,
    );
    expect(shape(db)).toEqual(previous);
  });
  it("keeps existing message nulling and Chat/Coding parent cascades", () => {
    const db = prior();
    insertCoding(db);
    runMigrations(db);
    insert(db, "jira.update-my-password", "password");
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
      { invocation_id: "password" },
    ]);
    db.exec("DELETE FROM chats WHERE id='chat-tabs'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
  });
});
