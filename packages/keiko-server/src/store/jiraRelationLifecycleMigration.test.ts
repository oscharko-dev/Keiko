import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  JIRA_LINK_MUTATIONS,
  JIRA_RELEASE_LIFECYCLE_MUTATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { runMigrations, SCHEMA_VERSION } from "./schema.js";
import {
  seedJiraMutationMigrationDatabase,
  insertJiraMigrationMutation as insert,
  insertJiraMigrationCoding as insertCoding,
  jiraMutationJournalShape as shape,
} from "./jiraMutationMigrationTestFixture.js";

// Independent native vocabulary: never infer these identities from the SQL under test.
const OPERATIONS = [
  "jira.create-issue-link",
  "jira.delete-issue-link",
  "jira.upsert-remote-link",
  "jira.update-remote-link",
  "jira.delete-remote-link",
  "jira.delete-remote-link-by-global-id",
  "jira.delete-component",
  "jira.merge-version",
  "jira.move-version",
  "jira.remove-and-swap-version",
] as const;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function v70(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  seedJiraMutationMigrationDatabase(db, 70);
  return db;
}

describe("V71 preserves the native mutation journal while admitting ten fixed relation/lifecycle effects", () => {
  it("pins the new closed operation families independently of the migration", () => {
    expect([...OPERATIONS].sort()).toEqual(
      [...JIRA_LINK_MUTATIONS, ...JIRA_RELEASE_LIFECYCLE_MUTATIONS].sort(),
    );
  });

  it.each(OPERATIONS)("requires the forward migration before %s can prepare", (operation) => {
    const db = v70();
    expect(() => {
      insert(db, operation, "before");
    }).toThrow(/CHECK/u);
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(71);
    insert(db, operation, "after");
    expect(
      db
        .prepare(
          "SELECT operation,phase,source_kind,http_status,protocol_outcome FROM chat_tool_mutations",
        )
        .all(),
    ).toEqual([
      {
        operation,
        phase: "prepared",
        source_kind: "jira",
        http_status: null,
        protocol_outcome: null,
      },
    ]);
  });

  it("copies actual V70 rows and preserves every column, index, foreign key and FULL durability", () => {
    const db = v70();
    insert(db, "jira.create-filter", "filter");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=201 WHERE invocation_id='filter'",
    );
    insert(db, "jira.delete-my-preference", "preference");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='unknown',http_status=503 WHERE invocation_id='preference'",
    );
    insert(db, "jira.delete-issue-type-property", "property");
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const previousShape = shape(db);
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
      rows,
    );
    expect(shape(db)).toEqual(previousShape);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps unknown operations, forged ownership and unsupported acknowledgement states denied", () => {
    const db = v70();
    runMigrations(db);
    for (const operation of [
      "jira.issue-link",
      "jira.remote-links",
      "jira.component",
      "jira.version",
      "jira.draft",
      "jira.create-remote-link",
      "jira.link-reciprocal",
      "jira.write-version",
      "jira.raw-http",
    ])
      expect(() => {
        insert(db, operation, operation);
      }).toThrow(/CHECK/u);
    insert(db, "jira.create-issue-link", "first");
    insert(db, "jira.merge-version", "second");
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
      "authority_digest='short'",
      "action_digest='short'",
      "consumer_kind='coding'",
      "native_call_id='forged'",
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

  it("rolls back a V71 table collision without changing historical rows or version", () => {
    const db = v70();
    insert(db, "jira.add-filter-permission", "permission");
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const previousShape = shape(db);
    db.exec("CREATE TABLE chat_tool_mutations_v71 (collision TEXT) STRICT");
    expect(() => {
      runMigrations(db);
    }).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 70 });
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
      rows,
    );
    expect(shape(db)).toEqual(previousShape);
  });

  it("keeps message nullification and distinct Coding/Chat ownership cascades", () => {
    const db = v70();
    insertCoding(db);
    runMigrations(db);
    insert(db, "jira.delete-remote-link-by-global-id", "link");
    db.exec("DELETE FROM chat_messages WHERE id='message-tabs'");
    expect(
      db.prepare("SELECT user_message_id FROM chat_tool_mutations ORDER BY invocation_id").all(),
    ).toEqual([{ user_message_id: null }, { user_message_id: null }]);
    expect(() => {
      db.exec(
        "UPDATE chat_tool_mutations SET coding_run_id='missing-run' WHERE invocation_id='coding'",
      );
    }).toThrow(/FOREIGN KEY/u);
    db.exec("DELETE FROM coding_runtime_snapshots WHERE run_id='run-tabs'");
    expect(db.prepare("SELECT invocation_id FROM chat_tool_mutations").all()).toEqual([
      { invocation_id: "link" },
    ]);
    db.exec("DELETE FROM chats WHERE id='chat-tabs'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
  });
});
