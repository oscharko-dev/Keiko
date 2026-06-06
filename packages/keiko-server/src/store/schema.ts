// ADR-0013 D5 — Schema v1 + migration runner via PRAGMA user_version. Forward-only, idempotent,
// transactional. Each migration is a `.sql` string of one or more CREATE/ALTER statements; the
// runner applies migrations whose 1-based index > current user_version.

import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 5;

interface Migration {
  readonly version: number;
  readonly sql: string;
}

const V1_SQL = `
CREATE TABLE projects (
  path TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
) STRICT;

CREATE TABLE chats (
  id TEXT NOT NULL PRIMARY KEY,
  project_path TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE,
  title TEXT NOT NULL,
  selected_model TEXT NOT NULL,
  branch_label TEXT,
  status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE chat_messages (
  id TEXT NOT NULL PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  run_id TEXT,
  workflow_id TEXT,
  workflow_status TEXT,
  short_result TEXT
) STRICT;

CREATE INDEX idx_chats_project_path ON chats(project_path);
CREATE INDEX idx_messages_chat_id ON chat_messages(chat_id);
CREATE INDEX idx_messages_chat_ts ON chat_messages(chat_id, timestamp);
`;

// V2 (issue #66) adds an additive `task_type` column to chat_messages so the chat can label
// non-workflow task runs (verify, explain-plan) without overloading workflow_id. STRICT tables
// require an explicit type for ALTER ... ADD COLUMN; existing rows materialise NULL.
const V2_SQL = `
ALTER TABLE chat_messages ADD COLUMN task_type TEXT;
`;

// V3 (issue #184) adds two additive columns to `chats` so a chat can carry its connected
// Files-window scope across reloads. `connected_scope_paths` keeps its legacy column name but
// stores the JSON scope payload ({ kind, relativePaths }); PR #254 legacy rows that stored only a
// JSON path array decode as files scopes. `connected_scope_at` stores epoch ms. Both NULL for
// pre-binding rows; patching either column to NULL clears the binding. The combination round-trips
// into the wire-type ChatConnectedScope at the store boundary.
const V3_SQL = `
ALTER TABLE chats ADD COLUMN connected_scope_paths TEXT;
ALTER TABLE chats ADD COLUMN connected_scope_at INTEGER;
`;

// V4 (issue #200) adds additive local-knowledge scope state to chats. The JSON payload stores
// either { kind: "capsule", capsuleId, connectedAtMs } or { kind: "capsule-set", capsuleSetId,
// connectedAtMs }. NULL means no local-knowledge scope is selected for the chat.
const V4_SQL = `
ALTER TABLE chats ADD COLUMN local_knowledge_scope_json TEXT;
`;

// V5 (issue #539, epic #532) — relationship engine tables. STRICT mode. The schema follows
// docs/relationship-engine/storage.md §3.1 (relationships, lifecycle history) and
// docs/relationship-engine/audit-events.md §5.5 (relationship_audit_entries sibling table).
// No FOREIGN KEY from relationships → projects: endpoint liveness is resolved at the API edge
// through the RelationshipEndpointResolver port (storage.md §2.2). Indexes serve the bounded
// query patterns from api-contract.md §4.3; partial unique indexes enforce 1:1 cardinality at
// the DB layer as a second barrier alongside the validator (storage.md §3.3, §4.1).
const V5_SQL = `
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

CREATE TABLE relationship_lifecycle_history (
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

CREATE INDEX idx_relationship_lifecycle_relationship
  ON relationship_lifecycle_history(relationship_id, occurred_at);

CREATE TABLE relationship_audit_entries (
  event_id                       TEXT NOT NULL PRIMARY KEY,
  relationship_audit_schema_ver  TEXT NOT NULL,
  workspace_id                   TEXT NOT NULL,
  sequence                       INTEGER NOT NULL,
  occurred_at                    INTEGER NOT NULL,
  kind                           TEXT NOT NULL,
  relationship_id                TEXT,
  actor_surface                  TEXT NOT NULL,
  redacted_actor_id              TEXT NOT NULL,
  redaction_state                TEXT NOT NULL,
  summary                        TEXT NOT NULL,
  payload_json                   TEXT NOT NULL,
  CHECK (
    relationship_audit_schema_ver IN ('1')
    AND kind IN (
      'relationship.created','relationship.updated','relationship.deleted',
      'relationship.reconnected','relationship.validation-denied',
      'relationship.policy-denied','relationship.activity-transitioned',
      'relationship.impact-analysis-bounded','relationship.health-finding'
    )
    AND actor_surface IN ('chat','inspector','workflow','health-check','system')
    AND redaction_state IN ('redacted-on-write','redacted-on-write-and-persist')
    AND sequence >= 0
    AND occurred_at >= 0
    AND length(summary) <= 240
  )
) STRICT;

CREATE UNIQUE INDEX uniq_relationship_audit_workspace_sequence
  ON relationship_audit_entries(workspace_id, sequence);
CREATE INDEX idx_relationship_audit_workspace_occurred_at
  ON relationship_audit_entries(workspace_id, occurred_at);
CREATE INDEX idx_relationship_audit_relationship
  ON relationship_audit_entries(workspace_id, relationship_id, occurred_at)
  WHERE relationship_id IS NOT NULL;
`;

const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1_SQL },
  { version: 2, sql: V2_SQL },
  { version: 3, sql: V3_SQL },
  { version: 4, sql: V4_SQL },
  { version: 5, sql: V5_SQL },
];

function currentUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

function setUserVersion(db: DatabaseSync, v: number): void {
  // user_version cannot be parameterized; v is a server-controlled integer constant from MIGRATIONS.
  db.exec(`PRAGMA user_version = ${String(v)}`);
}

// Applies pending migrations inside a single transaction. Throws (and rolls back) on any failure.
export function runMigrations(db: DatabaseSync): void {
  const start = currentUserVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > start);
  if (pending.length === 0) return;
  db.exec("BEGIN");
  try {
    for (const m of pending) {
      db.exec(m.sql);
      setUserVersion(db, m.version);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
