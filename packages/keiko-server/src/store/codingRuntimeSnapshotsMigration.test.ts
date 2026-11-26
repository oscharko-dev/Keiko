// V81 (#4068): admits the supervisor-refusal failure causes. `coding_runtime_snapshots` has a
// foreign-key child (`chat_tool_mutations.coding_run_id ... ON DELETE CASCADE`), so the table
// rebuild must not cascade-delete the child's rows: the runner switches foreign keys off around the
// flagged migration and checks them before the commit.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MIGRATIONS, runMigrations, SCHEMA_VERSION } from "./schema.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const CAUSES = [
  "runtime-supervisor-grants-acl",
  "runtime-supervisor-grants-directory",
  "runtime-supervisor-grants-capability",
  "runtime-supervisor-gateway-connect",
  "runtime-supervisor-gateway-admit",
  "runtime-supervisor-refused",
] as const;

function v80Database(): DatabaseSync {
  return databaseAtVersion(80);
}

function databaseAtVersion(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
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
      VALUES ('run-1','1','starting',1,'governed-assist','keiko-sidecar','keiko-model-gateway',
        'created','updated','task','workspace','operator','authority','binding','provenance');`);
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
  return db;
}

function settle(db: DatabaseSync, cause: string): void {
  db.prepare(
    "UPDATE coding_runtime_snapshots SET state = 'failed', failure_code = ? WHERE run_id = 'run-1'",
  ).run(cause);
}

describe("V81 supervisor-refusal causes", () => {
  it("denies the causes at v80 and admits only the closed set after v81", () => {
    const db = v80Database();
    expect(() => {
      settle(db, CAUSES[0]);
    }).toThrow(/CHECK constraint failed/u);
    runMigrations(db);
    for (const cause of CAUSES) settle(db, cause);
    expect(() => {
      settle(db, "runtime-supervisor-invented");
    }).toThrow(/CHECK constraint failed/u);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
  });

  it("keeps the run, the child rows that reference it, the indexes and foreign keys on", () => {
    const db = v80Database();
    const before = db.prepare("SELECT * FROM coding_runtime_snapshots").all();
    runMigrations(db);
    // The one column a later migration appended (v83 `verification_gap`, #4491) reads NULL for a
    // row that predates it; every other value carries through unchanged.
    expect(db.prepare("SELECT * FROM coding_runtime_snapshots").all()).toEqual(
      before.map((row) => ({ ...row, verification_gap: null })),
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_tool_mutations").get()).toEqual({ n: 1 });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'coding_runtime_snapshots' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "idx_coding_runtime_predecessor" },
      { name: "idx_coding_runtime_recent_active" },
      { name: "idx_coding_runtime_settled_oldest" },
      { name: "uniq_coding_runtime_active_slot" },
    ]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // The child still references the live table: deleting the run cascades to it.
    db.exec("DELETE FROM coding_runtime_snapshots WHERE run_id = 'run-1'");
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_tool_mutations").get()).toEqual({ n: 0 });
  });

  // The rebuild derives its statement from an earlier migration's text. Whatever a later migration
  // added to the table must still be there: only the list of failure codes may differ.
  it("changes nothing of the table but the list of failure codes", () => {
    const db = v80Database();
    const shape = (): unknown => ({
      columns: db
        .prepare("PRAGMA table_info(coding_runtime_snapshots)")
        .all()
        .filter((column) => column.name !== LATER_COLUMN),
      foreignKeys: db.prepare("PRAGMA foreign_key_list(coding_runtime_snapshots)").all(),
      definition: tableDefinition(db),
    });
    const before = shape();
    runMigrations(db);
    // A column a later migration appended (v83, #4491) is the only addition the shape may show.
    expect(shape()).toEqual(before);
    expect(
      db
        .prepare("PRAGMA table_info(coding_runtime_snapshots)")
        .all()
        .some((column) => column.name === LATER_COLUMN),
    ).toBe(true);
  });

  // A store may carry an orphan from before a constraint was enforced. It is not the rebuild's
  // doing, so it must not keep Keiko from starting.
  it("migrates a store that already carried a foreign-key violation elsewhere", () => {
    const db = v80Database();
    db.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO chat_messages (id, chat_id, role, content, timestamp)
        VALUES ('orphan-message','chat-that-never-existed','user','Fixture',2);
      PRAGMA foreign_keys = ON;`);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
    runMigrations(db);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_tool_mutations").get()).toEqual({ n: 1 });
  });
});

describe("V82 output-limit cause", () => {
  it("denies the cause at v81 and admits it after v82, still refusing an invented one", () => {
    const db = databaseAtVersion(81);
    expect(() => {
      settle(db, "output-limit-reached");
    }).toThrow(/CHECK constraint failed/u);
    runMigrations(db);
    settle(db, "output-limit-reached");
    settle(db, "output-exhausted-repeated");
    expect(() => {
      settle(db, "output-limit-invented");
    }).toThrow(/CHECK constraint failed/u);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_tool_mutations").get()).toEqual({ n: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("V84 Windows session and path causes (#4495)", () => {
  const WINDOWS_CAUSES = ["runtime-supervisor-no-desktop", "runtime-supervisor-image-path"];

  it("denies the causes at v83 and admits them after v84, keeping the verification gap", () => {
    const db = databaseAtVersion(83);
    db.exec(
      "UPDATE coding_runtime_snapshots SET verification_gap = 'check-failed' WHERE run_id = 'run-1'",
    );
    for (const cause of WINDOWS_CAUSES) {
      expect(() => {
        settle(db, cause);
      }).toThrow(/CHECK constraint failed/u);
    }
    const before = db.prepare("SELECT * FROM coding_runtime_snapshots").all();
    runMigrations(db);
    expect(db.prepare("SELECT * FROM coding_runtime_snapshots").all()).toEqual(before);
    for (const cause of [...WINDOWS_CAUSES, ...CAUSES, "output-limit-reached"]) settle(db, cause);
    expect(() => {
      settle(db, "runtime-supervisor-invented");
    }).toThrow(/CHECK constraint failed/u);
    expect(() => {
      db.exec(
        "UPDATE coding_runtime_snapshots SET verification_gap = 'invented' WHERE run_id = 'run-1'",
      );
    }).toThrow(/CHECK constraint failed/u);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_tool_mutations").get()).toEqual({ n: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps every column and index of the v83 table", () => {
    const db = databaseAtVersion(83);
    const columns = (): unknown =>
      db
        .prepare("PRAGMA table_info(coding_runtime_snapshots)")
        .all()
        .map((column) => column.name)
        .sort();
    const indexes = (): unknown =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'coding_runtime_snapshots' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
    const before = { columns: columns(), indexes: indexes() };
    runMigrations(db);
    expect({ columns: columns(), indexes: indexes() }).toEqual(before);
  });
});

// The stored CREATE TABLE text with the one part V81 is allowed to change taken out.
// The column v83 appended to the table; the V81 and V82 rebuilds are judged without it.
const LATER_COLUMN = "verification_gap";

function tableDefinition(db: DatabaseSync): string {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'coding_runtime_snapshots'",
    )
    .get() as { sql: string };
  return row.sql
    .replace(/failure_code IN \([^)]*\)/u, "failure_code IN (…)")
    .replace(/"?coding_runtime_snapshots(?:_v\d+)?"?/u, "coding_runtime_snapshots")
    .replaceAll(/\s+/gu, " ")
    .replace(
      /, verification_gap TEXT CHECK \(verification_gap IS NULL OR verification_gap IN \([^)]*\)\)/u,
      "",
    );
}
