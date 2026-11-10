import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  JIRA_AGILE_PLANNING_MUTATIONS,
  JIRA_VERSION_REMOTE_LINK_MUTATIONS,
  JIRA_PROJECT_CATEGORY_MUTATIONS,
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
  "jira.epic-remove-issues",
  "jira.rank-epic",
  "jira.rank-issues",
  "jira.set-issue-estimation",
  "jira.upsert-version-remote-link",
  "jira.upsert-version-remote-link-by-global-id",
  "jira.delete-version-remote-link",
  "jira.delete-version-remote-links",
  "jira.create-project-category",
  "jira.update-project-category",
  "jira.delete-project-category",
] as const;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function prior(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  seedJiraMutationMigrationDatabase(db, 72);
  return db;
}
describe("V73 closed Agile planning/version links/category native journal vocabulary", () => {
  it("pins eleven identities and the entire current native mutation vocabulary", () => {
    expect([...OPERATIONS].sort()).toEqual(
      [
        ...JIRA_AGILE_PLANNING_MUTATIONS,
        ...JIRA_VERSION_REMOTE_LINK_MUTATIONS,
        ...JIRA_PROJECT_CATEGORY_MUTATIONS,
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
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(73);
    insert(db, operation, "after");
    expect(
      db
        .prepare("SELECT operation,phase,http_status,protocol_outcome FROM chat_tool_mutations")
        .all(),
    ).toEqual([{ operation, phase: "prepared", http_status: null, protocol_outcome: null }]);
  });
  it("preserves every V72 column, ACK/unknown row, index, FK and FULL durability", () => {
    const db = prior();
    insert(db, "jira.replace-sprint", "sprint");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=204 WHERE invocation_id='sprint'",
    );
    insert(db, "jira.delete-board", "board");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='board'",
    );
    insert(db, "jira.move-screen-tab", "tab");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='succeeded',http_status=204 WHERE invocation_id='tab'",
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
  it("keeps unknown operations, invented ACKs and concurrent active effects closed", () => {
    const db = prior();
    runMigrations(db);
    for (const operation of [
      "jira.draft",
      "jira.raw-http",
      "jira.rank",
      "jira.clear-estimation",
      "jira.delete-category",
    ])
      expect(() => {
        insert(db, operation, operation);
      }).toThrow(/CHECK/u);
    insert(db, "jira.rank-issues", "rank");
    insert(db, "jira.delete-project-category", "category");
    for (const clause of [
      "phase='acknowledged'",
      "phase='settled',outcome='succeeded'",
      "http_status=207",
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
        db.exec(`UPDATE chat_tool_mutations SET ${clause} WHERE invocation_id='rank'`);
      }).toThrow(/CHECK/u);
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='rank'");
    expect(() => {
      db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='category'");
    }).toThrow(/UNIQUE/u);
    db.exec(
      "UPDATE chat_tool_mutations SET phase='acknowledged',http_status=207 WHERE invocation_id='rank'",
    );
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='succeeded-unconfirmed' WHERE invocation_id='rank'",
    );
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='category'");
    db.exec(
      "UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='category'",
    );
    expect(
      db.prepare("SELECT outcome FROM chat_tool_mutations ORDER BY invocation_id").all(),
    ).toEqual([{ outcome: "unknown" }, { outcome: "succeeded-unconfirmed" }]);
  });
  it("rolls back a forward-table collision and preserves the real V72 version", () => {
    const db = prior();
    insert(db, "jira.swap-sprints", "kept");
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const previous = shape(db);
    db.exec("CREATE TABLE chat_tool_mutations_v73 (collision TEXT) STRICT");
    expect(() => {
      runMigrations(db);
    }).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 72 });
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
      rows,
    );
    expect(shape(db)).toEqual(previous);
  });
  it("retains message nullification and independent Coding/Chat ownership cascades", () => {
    const db = prior();
    insertCoding(db);
    runMigrations(db);
    insert(db, "jira.epic-remove-issues", "epic");
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
      { invocation_id: "epic" },
    ]);
    db.exec("DELETE FROM chats WHERE id='chat-tabs'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
  });
});
