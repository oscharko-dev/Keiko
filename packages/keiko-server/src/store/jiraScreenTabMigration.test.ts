import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, runMigrations, SCHEMA_VERSION } from "./schema.js";

const databases: DatabaseSync[] = [];
const TAB_OPERATIONS = ["jira.create-screen-tab", "jira.rename-screen-tab", "jira.delete-screen-tab"] as const;
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function v66(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
  for (const migration of MIGRATIONS) {
    if (migration.version > 66) break;
    db.exec(migration.sql);
    migration.apply?.(db);
  }
  db.exec(`PRAGMA user_version = 66;
    INSERT INTO projects (path,name,created_at,last_opened_at) VALUES ('/tabs','Tabs',1,1);
    INSERT INTO chats (id,project_path,title,selected_model,created_at,updated_at)
      VALUES ('chat-tabs','/tabs','Tabs','model',1,1);
    INSERT INTO chat_messages (id,chat_id,role,content,timestamp)
      VALUES ('message-tabs','chat-tabs','user','Fixture',1);
    INSERT INTO coding_runtime_snapshots (run_id,schema_version,state,revision,requested_mode,
      runtime_source,model_source,created_at,updated_at,task_digest,workspace_digest,operator_digest,
      authority_digest,binding_digest,provenance_digest)
      VALUES ('run-tabs','1','running',1,'governed-assist','keiko-sidecar','keiko-model-gateway',
        'fixture-created','fixture-updated','task','workspace','operator','authority','binding','provenance');`);
  return db;
}
function insert(db: DatabaseSync, operation: string, id: string): void {
  db.prepare(`INSERT INTO chat_tool_mutations (
    invocation_id,chat_id,user_message_id,turn_ref,actor_id,pod_id,binding_generation,
    authentication_generation,authority_digest,action_digest,operation,source_kind,
    correlation_id,phase,created_at,updated_at,batch_digest)
    VALUES (?,'chat-tabs','message-tabs','turn-tabs','actor','pod',2,3,?,?,?,'jira',
      'correlation','prepared',1,2,?)`).run(
    id, "a".repeat(64), id.padEnd(64, "0"), operation, "b".repeat(64),
  );
}
function insertCoding(db: DatabaseSync): void {
  db.prepare(`INSERT INTO chat_tool_mutations (
    invocation_id,chat_id,user_message_id,turn_ref,actor_id,authority_digest,action_digest,
    operation,source_kind,configuration_digest,server_name,tool_name,protocol_outcome,
    correlation_id,phase,outcome,created_at,updated_at,consumer_kind,coding_run_id,
    native_session_id,native_message_id,native_call_id,native_arguments_digest,
    native_mcp_action_digest,batch_digest)
    VALUES ('coding','chat-tabs','message-tabs','coding-turn','actor',?,?,'mcp.write',
      'configured-mcp',?,'server','write','success','correlation','settled','succeeded',
      1,3,'coding','run-tabs','session','native-message','call',?,?,?)`).run(
    ...["a", "b", "c", "d", "e", "f"].map((value) => value.repeat(64)),
  );
}
function shape(db: DatabaseSync): unknown {
  return {
    columns: db.prepare("PRAGMA table_info(chat_tool_mutations)").all(),
    foreignKeys: db.prepare("PRAGMA foreign_key_list(chat_tool_mutations)").all(),
    indexes: db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='chat_tool_mutations' ORDER BY name").all(),
  };
}

describe("V67 screen-tab operations retain the existing durable journal", () => {
  it.each(TAB_OPERATIONS)("admits %s only after the forward migration", (operation) => {
    const db = v66();
    expect(() => { insert(db, operation, "before"); }).toThrow(/CHECK/u);
    runMigrations(db);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(67);
    expect(() => { insert(db, operation, "after"); }).not.toThrow();
    expect(db.prepare("SELECT operation,phase,http_status FROM chat_tool_mutations").all()).toEqual([
      { operation, phase: "prepared", http_status: null },
    ]);
  });

  it("preserves acknowledged Jira and settled Coding rows, all columns, indexes, foreign keys and FULL durability", () => {
    const db = v66();
    insert(db, "jira.delete-worklog", "existing");
    db.exec("UPDATE chat_tool_mutations SET phase='acknowledged',http_status=204 WHERE invocation_id='existing'");
    insertCoding(db);
    const rows = db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all();
    const before = shape(db);
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT * FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual(rows);
    expect(shape(db)).toEqual(before);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps one active Chat effect and refuses unacknowledged success, cross-owner state and undeclared operations", () => {
    const db = v66();
    runMigrations(db);
    insert(db, "jira.create-screen-tab", "first");
    insert(db, "jira.rename-screen-tab", "second");
    for (const operation of ["jira.draft", "jira.create-screen", "jira.delete-screen", "jira.move-screen-tab", "jira.unknown"])
      expect(() => { insert(db, operation, operation); }).toThrow(/CHECK/u);
    for (const clause of [
      "http_status=201", "protocol_outcome='success'", "phase='acknowledged'",
      "phase='settled',outcome='succeeded'", "source_kind='configured-mcp'",
      "configuration_digest=authority_digest", "binding_generation=0",
      "authentication_generation=0", "consumer_kind='coding'", "native_call_id='other'",
      "batch_digest='invalid'",
    ]) expect(() => { db.exec(`UPDATE chat_tool_mutations SET ${clause} WHERE invocation_id='first'`); }).toThrow(/CHECK/u);
    db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='first'");
    expect(() => { db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='second'"); }).toThrow(/UNIQUE/u);
    db.exec("UPDATE chat_tool_mutations SET phase='settled',outcome='unknown' WHERE invocation_id='first'");
    expect(() => { db.exec("UPDATE chat_tool_mutations SET phase='dispatched' WHERE invocation_id='second'"); }).not.toThrow();
  });

  it("retains message nullification and native Coding/Chat cascade ownership", () => {
    const db = v66();
    insertCoding(db);
    runMigrations(db);
    insert(db, "jira.delete-screen-tab", "chat");
    db.exec("DELETE FROM chat_messages WHERE id='message-tabs'");
    expect(db.prepare("SELECT user_message_id FROM chat_tool_mutations ORDER BY invocation_id").all()).toEqual([
      { user_message_id: null }, { user_message_id: null },
    ]);
    db.exec("DELETE FROM coding_runtime_snapshots WHERE run_id='run-tabs'");
    expect(db.prepare("SELECT invocation_id FROM chat_tool_mutations").all()).toEqual([{ invocation_id: "chat" }]);
    db.exec("DELETE FROM chats WHERE id='chat-tabs'");
    expect(db.prepare("SELECT * FROM chat_tool_mutations").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
