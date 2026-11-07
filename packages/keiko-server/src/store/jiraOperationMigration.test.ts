import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { JIRA_MUTATION_OPERATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { MIGRATIONS, runMigrations, SCHEMA_VERSION } from "./schema.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function priorDatabase(version: 61 | 62 | 63 | 64 | 65 = 61): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
    migration.apply?.(db);
  }
  db.exec(`PRAGMA user_version = ${String(version)};
    INSERT INTO projects (path, name, created_at, last_opened_at) VALUES ('/fixture','Fixture',1,1);
    INSERT INTO chats (id, project_path, title, selected_model, created_at, updated_at)
      VALUES ('chat-1','/fixture','Fixture','model',1,1);
    INSERT INTO chat_messages (id, chat_id, role, content, timestamp)
      VALUES ('message-1','chat-1','user','Fixture',1);
    INSERT INTO coding_runtime_snapshots (run_id, schema_version, state, revision,
      requested_mode, runtime_source, model_source, created_at, updated_at, task_digest,
      workspace_digest, operator_digest, authority_digest, binding_digest, provenance_digest)
      VALUES ('run-1','1','running',1,'governed-assist','keiko-sidecar','keiko-model-gateway',
        'fixture-created','fixture-updated','task','workspace','operator','authority','binding','provenance');`);
  return db;
}

function insertMutation(db: DatabaseSync, operation: string, id: string): void {
  db.prepare(
    `INSERT INTO chat_tool_mutations (invocation_id, chat_id, user_message_id, turn_ref, actor_id,
      pod_id, binding_generation, authentication_generation, authority_digest, action_digest,
      operation, source_kind, correlation_id, phase, created_at, updated_at, batch_digest)
      VALUES (?, 'chat-1', 'message-1', 'turn-1', 'actor', 'pod', 2, 3, ?, ?, ?, 'jira',
        'correlation', 'prepared', 1, 2, ?)`,
  ).run(id, "a".repeat(64), id.padEnd(64, "0"), operation, "b".repeat(64));
}

function insertCodingMutation(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO chat_tool_mutations (invocation_id, chat_id, user_message_id, turn_ref, actor_id,
      authority_digest, action_digest, operation, source_kind, configuration_digest, server_name,
      tool_name, protocol_outcome, correlation_id, phase, outcome, created_at, updated_at,
      consumer_kind, coding_run_id, native_session_id, native_message_id, native_call_id,
      native_arguments_digest, native_mcp_action_digest, batch_digest)
      VALUES ('coding', 'chat-1', 'message-1', 'coding-turn', 'actor', ?, ?, 'mcp.write',
        'configured-mcp', ?, 'server', 'write', 'success', 'correlation', 'settled', 'succeeded',
        1, 3, 'coding', 'run-1', 'session', 'native-message', 'call', ?, ?, ?)`,
  ).run(...["a", "b", "c", "d", "e", "f"].map((value) => value.repeat(64)));
}

function journalShape(db: DatabaseSync): unknown {
  return {
    columns: db.prepare("PRAGMA table_info(chat_tool_mutations)").all(),
    foreignKeys: db.prepare("PRAGMA foreign_key_list(chat_tool_mutations)").all(),
    indexes: db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_tool_mutations' ORDER BY name",
      )
      .all(),
  };
}

describe("V62 journals the closed project and Agile operations", () => {
  it.each([
    "jira.create-project",
    "jira.update-project",
    "jira.board-create",
    "jira.sprint-create",
    "jira.sprint-update",
    "jira.sprint-move-issues",
    "jira.backlog-move-issues",
    "jira.epic-update",
    "jira.epic-move-issues",
  ])("admits %s only after the forward migration", (operation) => {
    const db = priorDatabase();
    expect(() => {
      insertMutation(db, operation, "before");
    }).toThrow(/CHECK/u);
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(62);
    expect(() => {
      insertMutation(db, operation, "after");
    }).not.toThrow();
  });

  it("retains every journal column, row, index, foreign key and FULL durability on repeat migration", () => {
    const db = priorDatabase();
    insertMutation(db, "jira.attach", "kept");
    db.exec("UPDATE chat_tool_mutations SET phase = 'acknowledged', http_status = 201;");
    insertCodingMutation(db);
    const before = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const shape = journalShape(db);
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
      before,
    );
    expect(journalShape(db)).toEqual(shape);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps the closed vocabulary and the existing journal constraints", () => {
    const db = priorDatabase();
    runMigrations(db);
    for (const operation of [
      "jira.unknown",
      "jira.draft.create",
      "jira.filter-create",
      "mcp.invoke",
    ]) {
      expect(() => {
        insertMutation(db, operation, operation);
      }).toThrow(/CHECK/u);
    }
    insertMutation(db, "jira.edit", "kept");
    for (const sql of [
      "UPDATE chat_tool_mutations SET batch_digest = 'invalid'",
      "UPDATE chat_tool_mutations SET phase = 'settled'",
      "UPDATE chat_tool_mutations SET phase = 'acknowledged'",
      "UPDATE chat_tool_mutations SET configuration_digest = authority_digest",
      "UPDATE chat_tool_mutations SET native_call_id = 'unexpected'",
      "UPDATE chat_tool_mutations SET binding_generation = 0",
    ])
      expect(() => {
        db.exec(sql);
      }).toThrow(/CHECK/u);
    insertMutation(db, "jira.create-project", "second");
    db.exec("UPDATE chat_tool_mutations SET phase = 'dispatched' WHERE invocation_id = 'kept'");
    expect(() => {
      db.exec("UPDATE chat_tool_mutations SET phase = 'dispatched' WHERE invocation_id = 'second'");
    }).toThrow(/UNIQUE/u);
  });

  it("preserves message nullification and coding/chat cascade ownership", () => {
    const db = priorDatabase();
    insertMutation(db, "jira.create", "chat");
    insertCodingMutation(db);
    runMigrations(db);
    db.exec("DELETE FROM chat_messages WHERE id = 'message-1'");
    expect(db.prepare("SELECT user_message_id FROM chat_tool_mutations").all()).toEqual([
      { user_message_id: null },
      { user_message_id: null },
    ]);
    db.exec("DELETE FROM coding_runtime_snapshots WHERE run_id = 'run-1'");
    expect(db.prepare("SELECT invocation_id FROM chat_tool_mutations").all()).toEqual([
      { invocation_id: "chat" },
    ]);
    db.exec("DELETE FROM chats WHERE id = 'chat-1'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("V63 journals the closed component and version operations", () => {
  it.each([
    "jira.create-component",
    "jira.update-component",
    "jira.create-version",
    "jira.update-version",
  ])("admits %s after preserving existing V62 project and Agile journals", (operation) => {
    const db = priorDatabase(62);
    insertMutation(db, "jira.create-project", "project");
    insertMutation(db, "jira.sprint-update", "sprint");
    insertCodingMutation(db);
    const before = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const shape = journalShape(db);
    expect(() => {
      insertMutation(db, operation, "before");
    }).toThrow(/CHECK/u);
    runMigrations(db);
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(63);
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
      before,
    );
    expect(journalShape(db)).toEqual(shape);
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => {
      insertMutation(db, operation, "after");
    }).not.toThrow();
    for (const invalid of [
      "jira.delete-version",
      "jira.delete-component",
      "jira.draft",
      "jira.unknown",
    ]) {
      expect(() => {
        insertMutation(db, invalid, invalid);
      }).toThrow(/CHECK/u);
    }
  });
});

it("V64 admits only native comment updates while retaining V63 metadata journals", () => {
  const db = priorDatabase(63);
  insertMutation(db, "jira.create-component", "component");
  insertMutation(db, "jira.update-version", "version");
  insertCodingMutation(db);
  const before = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
  const shape = journalShape(db);
  expect(() => {
    insertMutation(db, "jira.update-comment", "before");
  }).toThrow(/CHECK/u);
  runMigrations(db);
  runMigrations(db);
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(64);
  expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
    before,
  );
  expect(journalShape(db)).toEqual(shape);
  expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => {
    insertMutation(db, "jira.update-comment", "after");
  }).not.toThrow();
  for (const invalid of [
    "jira.delete-unknown-comment",
    "jira.delete-unknown-worklog",
    "jira.draft",
    "jira.unknown",
  ]) {
    expect(() => {
      insertMutation(db, invalid, invalid);
    }).toThrow(/CHECK/u);
  }
});

it.each([
  "jira.create-worklog",
  "jira.update-worklog",
  "jira.watch",
  "jira.unwatch",
  "jira.vote",
  "jira.unvote",
])("V65 admits %s while preserving complete V64 journals and ownership", (operation) => {
  const db = priorDatabase(64);
  insertMutation(db, "jira.update-comment", "comment");
  insertCodingMutation(db);
  const before = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
  const shape = journalShape(db);
  expect(() => {
    insertMutation(db, operation, "before");
  }).toThrow(/CHECK/u);
  runMigrations(db);
  runMigrations(db);
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(65);
  expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(
    before,
  );
  expect(journalShape(db)).toEqual(shape);
  expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => {
    insertMutation(db, operation, "after");
  }).not.toThrow();
  for (const invalid of ["jira.draft", "jira.delete-unknown-worklog", "jira.unknown"])
    expect(() => {
      insertMutation(db, invalid, invalid);
    }).toThrow(/CHECK/u);
});

it.each(["jira.delete-comment", "jira.delete-attachment", "jira.delete-worklog"])(
  "V66 admits %s after preserving V65 records and every journal ownership constraint",
  (operation) => {
    const db = priorDatabase(65);
    insertMutation(db, "jira.create-worklog", "worklog");
    db.exec("UPDATE chat_tool_mutations SET phase = 'acknowledged', http_status = 201;");
    insertCodingMutation(db);
    const before = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const shape = journalShape(db);
    expect(() => { insertMutation(db, operation, "before"); }).toThrow(/CHECK/u);
    runMigrations(db);
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(66);
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(before);
    expect(journalShape(db)).toEqual(shape);
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    insertMutation(db, operation, "after");
    for (const sql of [
      "UPDATE chat_tool_mutations SET http_status = 204 WHERE invocation_id = 'after'",
      "UPDATE chat_tool_mutations SET protocol_outcome = 'success' WHERE invocation_id = 'after'",
      "UPDATE chat_tool_mutations SET source_kind = 'configured-mcp' WHERE invocation_id = 'after'",
      "UPDATE chat_tool_mutations SET consumer_kind = 'coding' WHERE invocation_id = 'after'",
    ]) expect(() => { db.exec(sql); }).toThrow(/CHECK/u);
    for (const invalid of ["jira.draft", "jira.delete-unknown", "jira.unknown"])
      expect(() => { insertMutation(db, invalid, invalid); }).toThrow(/CHECK/u);
  },
);

it("keeps the migrated native Jira vocabulary exactly aligned with every current write operation", () => {
  const db = priorDatabase(63);
  runMigrations(db);
  const expected = JIRA_MUTATION_OPERATIONS.filter((operation) => operation !== "jira.draft");
  for (const operation of expected) insertMutation(db, operation, operation);
  const sql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_tool_mutations'")
    .get()?.sql;
  if (typeof sql !== "string") throw new TypeError("Missing migrated journal definition");
  const admitted = [
    ...new Set(
      [...sql.matchAll(/'(?<operation>jira\.[a-z-]+)'/gu)].map((match) => match.groups?.operation),
    ),
  ];
  expect(admitted.sort()).toEqual([...expected].sort());
  expect(() => {
    insertMutation(db, "jira.draft", "composite");
  }).toThrow(/CHECK/u);
});
