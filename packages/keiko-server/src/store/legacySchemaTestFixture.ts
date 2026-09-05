import type { DatabaseSync } from "node:sqlite";
import { runMigrations, SCHEMA_VERSION } from "./schema.js";

const V13_SCHEMA_VERSION = 13;

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

// Module-level (not inline in the function body) so the SQL text — one statement per rolled-back
// migration, oldest column drops last — never counts against restoreV13SchemaFixture's own line
// budget, mirroring how schema.ts's own `V<n>_SQL` migration constants live outside their
// consuming function.
const V13_ROLLBACK_SQL = `
    ALTER TABLE chats DROP COLUMN git_change_scope_json;
    ALTER TABLE relationships RENAME TO relationships_v28;
    DROP INDEX idx_relationships_source;
    DROP INDEX idx_relationships_target;
    DROP INDEX idx_relationships_type;
    DROP INDEX idx_relationships_lifecycle;
    DROP INDEX uniq_relationships_produces_evidence_source;
    DROP INDEX uniq_relationships_starts_workflow_target;
    CREATE TABLE relationships (
      id                  TEXT NOT NULL PRIMARY KEY,
      schema_version      TEXT NOT NULL,
      workspace_scope_id  TEXT NOT NULL,
      scope_kind          TEXT NOT NULL,
      scope_coordinate    TEXT NOT NULL,
      type                TEXT NOT NULL,
      source_kind         TEXT NOT NULL,
      source_id           TEXT NOT NULL,
      target_kind         TEXT NOT NULL,
      target_id           TEXT NOT NULL,
      lifecycle           TEXT NOT NULL,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      etag                TEXT NOT NULL,
      confidence          REAL,
      summary             TEXT,
      CHECK (
        schema_version IN ('1')
        AND type IN (
          'reads-context','proposes-patch','uses-tool','starts-workflow',
          'produces-evidence','references-document','depends-on'
        )
        AND lifecycle IN (
          'draft','active','archived','superseded','revoked','blocked','stale'
        )
        AND scope_kind IN ('user','workspace','project','workflow','global')
        AND source_kind IN (
          'memory','capsule','capsule-set','workflow-run','evidence-run',
          'workspace-path','chat','tool','patch-proposal',
          'agent','connector','data-source','skill','mcp-tool'
        )
        AND target_kind IN (
          'memory','capsule','capsule-set','workflow-run','evidence-run',
          'workspace-path','chat','tool','patch-proposal',
          'agent','connector','data-source','skill','mcp-tool'
        )
        AND created_at >= 0
        AND updated_at >= created_at
        AND (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0))
        AND (summary IS NULL OR length(summary) <= 240)
      )
    ) STRICT;
    INSERT INTO relationships (
      id, schema_version, workspace_scope_id, scope_kind, scope_coordinate, type,
      source_kind, source_id, target_kind, target_id, lifecycle, created_at, updated_at,
      etag, confidence, summary
    )
    SELECT
      id, schema_version, workspace_scope_id, scope_kind, scope_coordinate, type,
      source_kind, source_id, target_kind, target_id, lifecycle, created_at, updated_at,
      etag, confidence, summary
    FROM relationships_v28;
    CREATE INDEX idx_relationships_source
      ON relationships(workspace_scope_id, source_kind, source_id);
    CREATE INDEX idx_relationships_target
      ON relationships(workspace_scope_id, target_kind, target_id);
    CREATE INDEX idx_relationships_type
      ON relationships(workspace_scope_id, type, lifecycle);
    CREATE INDEX idx_relationships_lifecycle
      ON relationships(workspace_scope_id, lifecycle, updated_at);
    CREATE UNIQUE INDEX uniq_relationships_produces_evidence_source
      ON relationships(workspace_scope_id, source_kind, source_id)
      WHERE type = 'produces-evidence' AND lifecycle IN ('draft','active','archived');
    CREATE UNIQUE INDEX uniq_relationships_starts_workflow_target
      ON relationships(workspace_scope_id, target_kind, target_id)
      WHERE type = 'starts-workflow' AND lifecycle IN ('draft','active','archived');
    CREATE TABLE relationship_lifecycle_history_v13 (
      id              TEXT NOT NULL PRIMARY KEY,
      relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
      from_state      TEXT NOT NULL,
      to_state        TEXT NOT NULL,
      occurred_at     INTEGER NOT NULL,
      summary         TEXT,
      CHECK (
        from_state IN ('draft','active','archived','superseded','revoked','blocked','stale')
        AND to_state IN ('draft','active','archived','superseded','revoked','blocked','stale')
        AND occurred_at >= 0
        AND (summary IS NULL OR length(summary) <= 240)
      )
    ) STRICT;
    INSERT INTO relationship_lifecycle_history_v13 (
      id, relationship_id, from_state, to_state, occurred_at, summary
    )
    SELECT id, relationship_id, from_state, to_state, occurred_at, summary
    FROM relationship_lifecycle_history;
    DROP TABLE relationship_lifecycle_history;
    ALTER TABLE relationship_lifecycle_history_v13 RENAME TO relationship_lifecycle_history;
    CREATE INDEX idx_relationship_lifecycle_relationship
      ON relationship_lifecycle_history(relationship_id, occurred_at);
    DROP TABLE relationships_v28;
    DROP TABLE coding_runtime_description_jobs;
    DROP TABLE git_journey_outcomes;
    DROP TABLE coding_runtime_ci_repair_budgets;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN ci_observation_revision;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN ci_readiness_record;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN draft_delivery_source_receipt;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN draft_delivery_record;
    ALTER TABLE coding_runtime_snapshots DROP COLUMN verified_commit_result;
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
  `;

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
  db.exec(V13_ROLLBACK_SQL);
  if (userVersion(db) !== V13_SCHEMA_VERSION) {
    throw new Error("legacy schema fixture did not reach version 13");
  }
}

/**
 * Rewinds a fully-migrated test database to an arbitrary older `targetVersion`, then replays the
 * real, production `MIGRATIONS` list (via `runMigrations`'s `upTo` option) forward to exactly that
 * version. Every migration test that needs an "already populated at version N" database should use
 * this instead of hand-writing its own inline `DROP TABLE`/`ALTER TABLE ... DROP COLUMN` rewind:
 * those restated drops silently stop covering new tables/columns the moment a later migration adds
 * one (#3389 wave: three such inline rewinds started failing with "table git_journey_outcomes
 * already exists" the moment V27 landed, because none of them knew to drop it). This fixture never
 * restates migration DDL of its own — it rewinds through the one shared `restoreV13SchemaFixture`
 * rollback and replays forward through the one production `MIGRATIONS` array, so a future migration
 * is covered automatically the moment its rollback statement is added there.
 */
export function rewindSchemaFixture(db: DatabaseSync, targetVersion: number): void {
  if (!Number.isInteger(targetVersion) || targetVersion < V13_SCHEMA_VERSION) {
    throw new RangeError(
      `rewindSchemaFixture: targetVersion must be an integer >= ${String(V13_SCHEMA_VERSION)}, received ${String(targetVersion)}`,
    );
  }
  restoreV13SchemaFixture(db);
  if (targetVersion > V13_SCHEMA_VERSION) {
    runMigrations(db, { upTo: targetVersion });
  }
  if (userVersion(db) !== targetVersion) {
    throw new Error(`rewindSchemaFixture did not reach version ${String(targetVersion)}`);
  }
}
