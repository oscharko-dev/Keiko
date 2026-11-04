import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, runMigrations, SCHEMA_VERSION } from "./schema.js";

// V57 widens the journal's operation CHECK so `jira.attach` can be journaled (#4176). A SQLite
// CHECK cannot be altered in place, so the migration rebuilds the table: no row, column, index or
// other constraint may be lost on the way.
function v56Database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // The journal rows are seeded without their chats; the rebuild is what is under test.
  db.exec("PRAGMA foreign_keys = OFF");
  for (const migration of MIGRATIONS) {
    if (migration.version > 56) break;
    db.exec(migration.sql);
    migration.apply?.(db);
  }
  db.exec("PRAGMA user_version = 56");
  return db;
}
function insertMutation(db: DatabaseSync, operation: string, id: string): void {
  db.prepare(
    `INSERT INTO chat_tool_mutations (invocation_id, chat_id, turn_ref, actor_id, pod_id,
      binding_generation, authentication_generation, authority_digest, action_digest, operation,
      source_kind, correlation_id, phase, created_at, updated_at)
     VALUES (?, 'chat-1', 'turn-1', 'actor', 'pod', 1, 1, ?, ?, ?, 'jira', 'corr', 'prepared', 1, 1)`,
  ).run(id, "a".repeat(64), id.padEnd(64, "0"), operation);
}

describe("V57 journals jira.attach without losing the existing journal", () => {
  it("is the current schema version", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(57);
  });
  it("refuses jira.attach before V57, accepts it after, and keeps every row", () => {
    const db = v56Database();
    try {
      insertMutation(db, "jira.edit", "kept");
      expect(() => {
        insertMutation(db, "jira.attach", "attach-before");
      }).toThrow(/CHECK/u);
      runMigrations(db);
      expect(
        db.prepare("SELECT operation FROM chat_tool_mutations WHERE invocation_id = 'kept'").get(),
      ).toMatchObject({ operation: "jira.edit" });
      expect(() => {
        insertMutation(db, "jira.attach", "attach-after");
      }).not.toThrow();
      expect(() => {
        insertMutation(db, "jira.unknown", "unknown-op");
      }).toThrow(/CHECK/u);
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_tool_mutations'",
        )
        .all()
        .map((row) => String(row.name));
      expect(indexes).toEqual(
        expect.arrayContaining([
          "chat_tool_mutations_turn",
          "chat_tool_mutations_active",
          "chat_tool_mutations_native_dispatch",
        ]),
      );
      expect(
        db
          .prepare("PRAGMA table_info(chat_tool_mutations)")
          .all()
          .map((column) => column.name),
      ).toEqual(expect.arrayContaining(["consumer_kind", "native_mcp_action_digest"]));
    } finally {
      db.close();
    }
  });
});
