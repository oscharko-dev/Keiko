// Test-only fixtures built from the actual historical migrations; no duplicate journal DDL.
import type { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./schema.js";

export function seedJiraMutationMigrationDatabase(db: DatabaseSync, version: 66 | 67 | 68 | 69 | 70 | 71 | 72 | 73 | 74 | 75): void {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
    migration.apply?.(db);
  }
  db.exec(`PRAGMA user_version = ${String(version)};
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
}
export function insertJiraMigrationMutation(db: DatabaseSync, operation: string, id: string): void {
  db.prepare(`INSERT INTO chat_tool_mutations (
    invocation_id,chat_id,user_message_id,turn_ref,actor_id,pod_id,binding_generation,
    authentication_generation,authority_digest,action_digest,operation,source_kind,
    correlation_id,phase,created_at,updated_at,batch_digest)
    VALUES (?,'chat-tabs','message-tabs','turn-tabs','actor','pod',2,3,?,?,?,'jira',
      'correlation','prepared',1,2,?)`).run(
    id, "a".repeat(64), id.padEnd(64, "0"), operation, "b".repeat(64),
  );
}
export function insertJiraMigrationCoding(db: DatabaseSync): void {
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
export function jiraMutationJournalShape(db: DatabaseSync): unknown {
  return {
    columns: db.prepare("PRAGMA table_info(chat_tool_mutations)").all(),
    foreignKeys: db.prepare("PRAGMA foreign_key_list(chat_tool_mutations)").all(),
    indexes: db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='chat_tool_mutations' ORDER BY name").all(),
  };
}
