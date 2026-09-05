import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./schema.js";

const V13_SCHEMA_VERSION = 13;

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

interface VersionRollback {
  readonly version: number;
  readonly sql: string;
}

// One rollback fragment per forward migration (V14..V29), each undoing EXACTLY what that
// migration's own `V<n>_SQL` in schema.ts added to reach it — never more, never less — so a rewind
// can stop at any intermediate version and leave every earlier version's data and shape untouched.
// Declared newest-first (descending): dropping the newest objects before older ones is always safe
// against a live FOREIGN KEY (mirrors the drop order every individual `V<n>_SQL` table rebuild
// already uses), while the reverse is not. `restoreV13SchemaFixture` and `rewindSchemaFixture`
// both compose from this ONE list — neither restates a migration's DDL of its own, and a future
// migration is covered the moment its own rollback fragment is appended here.
//
// V20 has no fragment: it only widens a `failure_code` CHECK on `coding_runtime_snapshots` (no
// column added), so there is nothing to structurally undo at fixture granularity.
const ROLLBACKS: readonly VersionRollback[] = [
  { version: 29, sql: `DROP TABLE coding_runtime_description_jobs;` },
  {
    version: 28,
    sql: `
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
    `,
  },
  { version: 27, sql: `DROP TABLE git_journey_outcomes;` },
  {
    version: 26,
    sql: `
      DROP TABLE coding_runtime_ci_repair_budgets;
      ALTER TABLE coding_runtime_snapshots DROP COLUMN ci_observation_revision;
      ALTER TABLE coding_runtime_snapshots DROP COLUMN ci_readiness_record;
      ALTER TABLE coding_runtime_snapshots DROP COLUMN last_successful_verified_commit;
    `,
  },
  {
    version: 25,
    sql: `ALTER TABLE coding_runtime_snapshots DROP COLUMN draft_delivery_source_receipt;`,
  },
  { version: 24, sql: `ALTER TABLE coding_runtime_snapshots DROP COLUMN draft_delivery_record;` },
  { version: 23, sql: `ALTER TABLE coding_runtime_snapshots DROP COLUMN verified_commit_result;` },
  {
    version: 22,
    sql: `
      ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_binding_digest;
      ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_content_revision_digest;
      ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_default_base_ref;
      ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_id_digest;
      ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_number;
      ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_remote_digest;
      ALTER TABLE coding_runtime_snapshots DROP COLUMN issue_repository_id;
    `,
  },
  { version: 21, sql: `DROP TABLE github_issue_reader_authorization;` },
  {
    version: 19,
    sql: `
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
    `,
  },
  { version: 18, sql: `ALTER TABLE chat_messages DROP COLUMN assistant_response_versions_json;` },
  {
    version: 17,
    sql: `
      DROP INDEX uniq_workspace_manifest_root_object_identity;
      ALTER TABLE workspace_manifest_roots DROP COLUMN object_identity_digest;
    `,
  },
  { version: 16, sql: `ALTER TABLE memory_autonomy_policy DROP COLUMN revision;` },
  {
    version: 15,
    sql: `
      DROP TABLE workspace_manifest_roots;
      DROP TABLE workspace_manifests;
    `,
  },
  { version: 14, sql: `DROP TABLE workspace_trust_records;` },
];

/** Every rollback fragment for a migration strictly newer than `targetVersion`, newest first. */
function rollbackSqlAbove(targetVersion: number): string {
  return ROLLBACKS.filter((step) => step.version > targetVersion)
    .map((step) => step.sql)
    .join("\n");
}

/**
 * Rewinds a fully-migrated (current `SCHEMA_VERSION`) test database to an arbitrary older
 * `targetVersion` by applying exactly the rollback fragments above `targetVersion`, newest first —
 * never a full teardown-and-replay, which would destroy any data a test wrote into a column that
 * legitimately survives at `targetVersion` (#3389 wave: three migration tests populate a run
 * BEFORE rewinding to an older version and assert that data still exists after the *next* forward
 * migration; a full rewind to v13 and back up would erase it).
 *
 * Every migration test that needs an "already populated at version N" database should use this
 * instead of hand-writing its own inline `DROP TABLE`/`ALTER TABLE ... DROP COLUMN` rewind: a
 * restated inline rewind silently stops covering new tables/columns the moment a later migration
 * adds one — three such inline rewinds started failing with "table git_journey_outcomes already
 * exists" the moment V27 landed, because none of them knew to drop it. This fixture never restates
 * migration DDL of its own: it composes the SAME rollback fragments `restoreV13SchemaFixture` uses,
 * so a future migration is covered the moment its own fragment is appended to `ROLLBACKS` above.
 */
export function rewindSchemaFixture(db: DatabaseSync, targetVersion: number): void {
  if (
    !Number.isInteger(targetVersion) ||
    targetVersion < V13_SCHEMA_VERSION ||
    targetVersion > SCHEMA_VERSION
  ) {
    throw new RangeError(
      `rewindSchemaFixture: targetVersion must be an integer between ${String(V13_SCHEMA_VERSION)} and ${String(SCHEMA_VERSION)}, received ${String(targetVersion)}`,
    );
  }
  const actualVersion = userVersion(db);
  if (actualVersion !== SCHEMA_VERSION) {
    throw new Error(
      `legacy schema fixture requires current version ${String(SCHEMA_VERSION)}, received ${String(actualVersion)}`,
    );
  }
  if (targetVersion < SCHEMA_VERSION) {
    db.exec(`${rollbackSqlAbove(targetVersion)}\nPRAGMA user_version = ${String(targetVersion)};`);
  }
  if (userVersion(db) !== targetVersion) {
    throw new Error(`legacy schema fixture did not reach version ${String(targetVersion)}`);
  }
}

// Test-only reverse fixture for the D9 migration pins. Production remains strictly forward-only:
// this helper starts from the current schema, removes every post-v13 object, and fails on any
// mismatch instead of letting a partially rewound database masquerade as a real v13 store. A thin
// wrapper over `rewindSchemaFixture` so it can never grow past this repository's per-function line
// bar again: every new migration's rollback lives in `ROLLBACKS`, never in this function body.
export function restoreV13SchemaFixture(db: DatabaseSync): void {
  rewindSchemaFixture(db, V13_SCHEMA_VERSION);
}
