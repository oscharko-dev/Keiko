import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./schema.js";

const V13_SCHEMA_VERSION = 13;

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

// Test-only reverse fixture for the D9 migration pins. Production remains strictly forward-only:
// this helper starts from the current schema, removes every post-v13 object, and fails on any
// mismatch instead of letting a partially rewound database masquerade as a real v13 store.
export function restoreV13SchemaFixture(db: DatabaseSync): void {
  const actualVersion = userVersion(db);
  if (actualVersion !== SCHEMA_VERSION) {
    throw new Error(
      `legacy schema fixture requires current version ${String(SCHEMA_VERSION)}, received ${String(actualVersion)}`,
    );
  }

  db.exec(`
    ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_binding_digest;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_content_revision_digest;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_default_base_ref;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_id_digest;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_number;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_remote_digest;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_repository_id;
    DROP TABLE github_issue_reader_authorization;
    DROP TABLE workspace_manifest_roots;
    DROP TABLE workspace_manifests;
    DROP TABLE workspace_trust_records;
    ALTER TABLE memory_autonomy_policy DROP COLUMN revision;
    ALTER TABLE chat_messages DROP COLUMN assistant_response_versions_json;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN result_status;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN exit_code;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN stdout_byte_count;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN stdout_line_count;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN stdout_sha256;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN stdout_truncated;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN stderr_byte_count;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN stderr_line_count;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN stderr_sha256;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN stderr_truncated;
    PRAGMA user_version = ${String(V13_SCHEMA_VERSION)};
  `);

  if (userVersion(db) !== V13_SCHEMA_VERSION) {
    throw new Error("legacy schema fixture did not reach version 13");
  }
}
