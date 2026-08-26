// ADR-0013 D5 — Schema v1 + migration runner via PRAGMA user_version. Forward-only, idempotent,
// transactional. Each migration is a `.sql` string of one or more CREATE/ALTER statements; the
// runner applies migrations whose 1-based index > current user_version.

import type { DatabaseSync } from "node:sqlite";
import {
  migrateLegacyProjectManifests,
  migrateWorkspaceRootObjectIdentities,
} from "./workspaceManifests.js";

export const SCHEMA_VERSION = 20;

interface Migration {
  readonly version: number;
  readonly sql: string;
  readonly apply?: (db: DatabaseSync) => void;
}

export class UiStoreSchemaVersionError extends Error {
  public readonly code = "UI_STORE_SCHEMA_NEWER" as const;

  public constructor(actual: number, supported: number) {
    super(
      `UI store schema version ${String(actual)} is newer than this binary supports (${String(
        supported,
      )}).`,
    );
    this.name = "UiStoreSchemaVersionError";
  }
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

// V6 — persist the redacted, browser-safe grounded answer projection on assistant messages.
// This stores citation metadata and context summaries only, not retrieved excerpt contents.
const V6_SQL = `
ALTER TABLE chat_messages ADD COLUMN grounded_answer_json TEXT;
`;

// V7 (issue #445, epic #443) — durable managed task-workspace instances. STRICT mode. One row per
// provisioned/activated task workspace; the partial unique index on (repository_id, task_id) enforces
// the idempotency invariant at the DB layer as a second barrier alongside the deterministic id
// derivation (AC3). All columns are content-free per the #444 contract (ids/hashes, enums, ISO
// timestamps, branch/path names); `lock_json`, `drift_markers_json`, and `recovery_hints_json` carry
// the nested WorkspaceLock / drift-marker / recovery-hint shapes the contract validator gates.
const V7_SQL = `
CREATE TABLE task_workspace_instances (
  workspace_id           TEXT NOT NULL PRIMARY KEY,
  schema_version         TEXT NOT NULL,
  task_id                TEXT NOT NULL,
  repository_id          TEXT NOT NULL,
  repository_root        TEXT NOT NULL,
  base_branch            TEXT NOT NULL,
  task_branch            TEXT NOT NULL,
  managed_worktree_path  TEXT NOT NULL,
  gitdir_identity        TEXT NOT NULL,
  lifecycle_state        TEXT NOT NULL,
  health                 TEXT NOT NULL,
  lock_json              TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  last_verified_at       TEXT,
  last_verified_head     TEXT,
  drift_markers_json     TEXT NOT NULL,
  recovery_hints_json    TEXT NOT NULL,
  audit_correlation_id   TEXT NOT NULL,
  CHECK (
    schema_version IN ('1')
    AND lifecycle_state IN (
      'provisioning','active','paused','handoff-ready','archived','merged',
      'abandoned','recovery-required','failed','cleanup-pending'
    )
    AND health IN ('healthy','degraded','drifted','locked-out','missing','unknown')
  )
) STRICT;

CREATE UNIQUE INDEX uniq_task_workspace_repo_task
  ON task_workspace_instances(repository_id, task_id);
CREATE INDEX idx_task_workspace_repository
  ON task_workspace_instances(repository_id, updated_at);
`;

// V8 (issue #446, epic #443) — singleton active task-workspace pointer. Studio binds exactly ONE
// active task workspace at a time; this table holds at most one row (id pinned to the constant
// 'active', enforced by CHECK). The WorkspaceBinding surfaces consume is DERIVED from the referenced
// instance (binding.ts), never stored, so the active root has no second copy to drift. Content-free:
// an opaque workspace id + an opaque actor id + ISO timestamps only. ON DELETE CASCADE clears the
// pointer when the referenced instance is removed (the lifecycle service also clears it defensively).
const V8_SQL = `
CREATE TABLE task_workspace_active_pointer (
  id            TEXT NOT NULL PRIMARY KEY DEFAULT 'active',
  workspace_id  TEXT NOT NULL,
  set_by        TEXT NOT NULL,
  set_at        TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (id = 'active'),
  FOREIGN KEY (workspace_id) REFERENCES task_workspace_instances(workspace_id) ON DELETE CASCADE
) STRICT;
`;

// V9 (issue #1632) adds a server-only assistant-message metadata column for authoritative Local
// Knowledge PDF preview citations. The browser-safe grounded_answer_json remains the public wire
// payload; this sibling JSON stores only the minimum private lineage + content-hash metadata the
// preview authorization contract needs and is never projected through ChatMessage.
const V9_SQL = `
ALTER TABLE chat_messages ADD COLUMN grounded_preview_citations_json TEXT;
`;

// V10 (issue #2256) — content-free runtime lifecycle snapshots. This is deliberately a narrow
// recovery ledger, not an event/token stream: every field is an enum, timestamp, bounded counter,
// digest, or opaque identifier. Runtime process details and model input/output remain transient.
const V10_SQL = `
CREATE TABLE coding_runtime_snapshots (
  run_id TEXT NOT NULL PRIMARY KEY,
  schema_version TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  requested_mode TEXT NOT NULL,
  runtime_source TEXT NOT NULL,
  model_source TEXT NOT NULL,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  recovery_acknowledged_at TEXT,
  predecessor_run_id TEXT,
  task_digest TEXT NOT NULL,
  workspace_digest TEXT NOT NULL,
  operator_digest TEXT NOT NULL,
  authority_digest TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  provenance_digest TEXT NOT NULL,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  patch_byte_count INTEGER NOT NULL DEFAULT 0,
  model_request_count INTEGER NOT NULL DEFAULT 0,
  recovery_handle TEXT,
  CHECK (
    schema_version = '1'
    AND state IN ('starting','ready','running','paused','awaiting-approval','stopping','succeeded','failed','cancelled','taken-over','recovery-required')
    AND requested_mode IN ('governed-assist','supervised-coding','autonomous-delivery')
    AND runtime_source IN ('keiko-sidecar','codex-cli-adapter','delivery-runner')
    AND model_source IN ('keiko-model-gateway','openai-api-key-through-gateway','chatgpt-codex-subscription-profile')
    AND (failure_code IS NULL OR failure_code IN ('runtime-unavailable','active-run-conflict','invalid-intent','authority-resolution-failed','authority-expired','authority-replayed','task-drift','workspace-drift','project-drift','branch-drift','scope-drift','budget-drift','authority-budget-exceeded','source-drift','runtime-failed','revoked','recovery-required'))
    AND revision >= 0
    AND tool_call_count BETWEEN 0 AND 1000000
    AND patch_byte_count BETWEEN 0 AND 1073741824
    AND model_request_count BETWEEN 0 AND 1000000
    AND length(run_id) BETWEEN 1 AND 128
    AND length(task_digest) BETWEEN 1 AND 128
    AND length(workspace_digest) BETWEEN 1 AND 128
    AND length(operator_digest) BETWEEN 1 AND 128
    AND length(authority_digest) BETWEEN 1 AND 128
    AND length(binding_digest) BETWEEN 1 AND 128
    AND length(provenance_digest) BETWEEN 1 AND 128
    AND (recovery_handle IS NULL OR length(recovery_handle) BETWEEN 1 AND 128)
  )
) STRICT;

-- A settled run may be retained, but exactly one nonterminal run occupies the runtime slot.
-- Recovery acknowledgement alone does not set terminal_at; an explicit fresh retry releases it.
CREATE UNIQUE INDEX uniq_coding_runtime_active_slot
  ON coding_runtime_snapshots((1))
  WHERE terminal_at IS NULL;
CREATE INDEX idx_coding_runtime_recent_active
  ON coding_runtime_snapshots(terminal_at, updated_at DESC, run_id);
CREATE INDEX idx_coding_runtime_settled_oldest
  ON coding_runtime_snapshots(terminal_at, updated_at, run_id)
  WHERE terminal_at IS NOT NULL;
`;

// V11 (issue #2549) — singleton requested mode for the MemoriaViva capture surface. The value is
// content-free and reuses the canonical product autonomy vocabulary; effective authority remains
// server-owned and is clamped against the configured deployment ceiling at request time.
const V11_SQL = `
CREATE TABLE memory_autonomy_policy (
  id TEXT NOT NULL PRIMARY KEY,
  requested_mode TEXT NOT NULL,
  CHECK (
    id = 'capture'
    AND requested_mode IN ('governed-assist','supervised-coding','autonomous-delivery')
  )
) STRICT;
`;

// V12 — durable, content-bounded identity for canonical chat-turn retries. Only a SHA-256 digest
// scoped to the chat is stored; the opaque provider/client identity never reaches SQLite. The same
// turn may own at most one user row and one assistant row, and divergent text fails closed. NULL
// preserves all historical and ordinary typed Composer messages.
const V12_SQL = `
ALTER TABLE chat_messages ADD COLUMN client_turn_id TEXT;
ALTER TABLE chat_messages ADD COLUMN client_turn_state TEXT;
CREATE UNIQUE INDEX uniq_chat_messages_client_turn_role
  ON chat_messages(chat_id, client_turn_id, role)
  WHERE client_turn_id IS NOT NULL;
`;

// V13 — immutable content identity for canonical retries. Visible user text remains governed by the
// caller's redaction policy, while idempotency compares only this scope-bound digest of the original
// chat/turn/content tuple. No raw provider id or message body is added to the identity column.
const V13_SQL = `
ALTER TABLE chat_messages ADD COLUMN client_turn_content_digest TEXT;
`;

// V14 (issue #2521, epic #2285, ADR-0147 D3/D8) — persisted canonical workspace-trust records.
// ADR-0147 D8 mandates uiDb (one transaction domain) so a future root-removal (#2524) and trust
// invalidation commit atomically; JSON-beside-SQLite was explicitly rejected. Content-free by
// construction: `root_ref` is an opaque derived reference, `record_json` is the validated
// WorkspaceTrustRecord (opaque digests, closed enums, revisions — never paths or manifest bytes).
// The authoritative payload is `record_json`, re-validated through the contract validator on read.
// The denormalized columns are written from that same record and are never used as authority:
// `revision` backs monotonic revision reads, `updated_at` orders deterministic bounded pruning, and
// the `trust` enum is DB-layer enum enforcement plus cheap content-free inspection.
const V14_SQL = `
CREATE TABLE workspace_trust_records (
  root_ref     TEXT NOT NULL PRIMARY KEY,
  revision     INTEGER NOT NULL,
  trust        TEXT NOT NULL,
  record_json  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK (
    revision >= 0
    AND trust IN ('trusted','restricted')
    AND length(root_ref) BETWEEN 3 AND 96
    AND length(record_json) BETWEEN 1 AND 8192
    AND updated_at >= 0
  )
) STRICT;

CREATE INDEX idx_workspace_trust_updated ON workspace_trust_records(updated_at, root_ref);
`;

// V15 (issue #2524, epic #2285, ADR-0147 D1/D8/D9) — server-owned ordered workspace manifests.
// Root rows reference, rather than replace, the existing projects registry. `record_json` is the
// authoritative closed WorkspaceManifest contract; relational columns enforce unique membership,
// stable order, and the one-transaction root-removal/trust-invalidation boundary.
const V15_SQL = `
CREATE TABLE workspace_manifests (
  workspace_id       TEXT NOT NULL PRIMARY KEY,
  schema_version     INTEGER NOT NULL,
  manifest_ref       TEXT NOT NULL UNIQUE,
  revision           INTEGER NOT NULL,
  manifest_digest    TEXT NOT NULL,
  focused_root_ref   TEXT NOT NULL,
  record_json        TEXT NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (
    schema_version = 1
    AND revision >= 0
    AND length(workspace_id) BETWEEN 1 AND 128
    AND length(manifest_ref) BETWEEN 3 AND 96
    AND length(manifest_digest) = 64
    AND length(focused_root_ref) BETWEEN 3 AND 96
    AND length(record_json) BETWEEN 1 AND 262144
    AND updated_at >= 0
  )
) STRICT;

CREATE TABLE workspace_manifest_roots (
  workspace_id    TEXT NOT NULL REFERENCES workspace_manifests(workspace_id) ON DELETE CASCADE,
  root_ref        TEXT NOT NULL UNIQUE,
  position        INTEGER NOT NULL,
  project_path    TEXT NOT NULL UNIQUE REFERENCES projects(path) ON DELETE RESTRICT,
  canonical_root  TEXT NOT NULL UNIQUE,
  identity_digest TEXT NOT NULL UNIQUE,
  PRIMARY KEY (workspace_id, root_ref),
  UNIQUE (workspace_id, position),
  CHECK (
    position BETWEEN 0 AND 31
    AND length(root_ref) BETWEEN 3 AND 96
    AND length(canonical_root) BETWEEN 1 AND 4096
    AND length(identity_digest) = 64
  )
) STRICT;

CREATE INDEX idx_workspace_manifest_roots_workspace
  ON workspace_manifest_roots(workspace_id, position);
`;

// V16 (issue #2549, epic #2537, ADR-0146 D1/D5) — monotonic server-owned revision for the
// memory-autonomy singleton. Conditional writes use it to reject stale authority widening while
// still permitting a stale, strictly safer downgrade.
const V16_SQL = `
ALTER TABLE memory_autonomy_policy
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
`;

// V17 (issue #2772, epic #2285) — bind persisted authority to the filesystem object rather than a
// path-bearing, Number-coerced compatibility digest. The private digest is never projected through
// a contract or evidence surface. NULL is an explicit fail-closed state for filesystems without a
// durable birth identity. Every pre-v17 trust row is revoked once because it predates this binding.
const V17_SQL = `
ALTER TABLE workspace_manifest_roots
  ADD COLUMN object_identity_digest TEXT
  CHECK (object_identity_digest IS NULL OR length(object_identity_digest) = 64);
CREATE UNIQUE INDEX uniq_workspace_manifest_root_object_identity
  ON workspace_manifest_roots(object_identity_digest)
  WHERE object_identity_digest IS NOT NULL;
`;

// V18 (#2860) — immutable assistant-response history for regeneration. The current response stays
// on the existing chat_messages row so gateway/history ordering and canonical turn identity remain
// unchanged; this JSON column stores the validated, monotonic version chain atomically with each
// content update. NULL is the legacy single-version representation.
const V18_SQL = `
ALTER TABLE chat_messages ADD COLUMN assistant_response_versions_json TEXT;
`;

// V19 (#2857) — terminal OpenCode process result without process bodies. Only a closed status,
// bounded exit code, saturating counts, truncation flags and SHA-256 digests are retained.
const V19_SQL = `
ALTER TABLE coding_runtime_snapshots ADD COLUMN result_status TEXT
  CHECK (result_status IS NULL OR result_status IN ('cancelled','failed','signalled','succeeded'));
ALTER TABLE coding_runtime_snapshots ADD COLUMN exit_code INTEGER
  CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND 255);
ALTER TABLE coding_runtime_snapshots ADD COLUMN stdout_byte_count INTEGER
  CHECK (stdout_byte_count IS NULL OR stdout_byte_count BETWEEN 0 AND 1073741824);
ALTER TABLE coding_runtime_snapshots ADD COLUMN stdout_line_count INTEGER
  CHECK (stdout_line_count IS NULL OR stdout_line_count BETWEEN 0 AND 1000000);
ALTER TABLE coding_runtime_snapshots ADD COLUMN stdout_sha256 TEXT
  CHECK (stdout_sha256 IS NULL OR length(stdout_sha256) = 64);
ALTER TABLE coding_runtime_snapshots ADD COLUMN stdout_truncated INTEGER
  CHECK (stdout_truncated IS NULL OR stdout_truncated IN (0,1));
ALTER TABLE coding_runtime_snapshots ADD COLUMN stderr_byte_count INTEGER
  CHECK (stderr_byte_count IS NULL OR stderr_byte_count BETWEEN 0 AND 1073741824);
ALTER TABLE coding_runtime_snapshots ADD COLUMN stderr_line_count INTEGER
  CHECK (stderr_line_count IS NULL OR stderr_line_count BETWEEN 0 AND 1000000);
ALTER TABLE coding_runtime_snapshots ADD COLUMN stderr_sha256 TEXT
  CHECK (stderr_sha256 IS NULL OR length(stderr_sha256) = 64);
ALTER TABLE coding_runtime_snapshots ADD COLUMN stderr_truncated INTEGER
  CHECK (stderr_truncated IS NULL OR stderr_truncated IN (0,1));
`;

// V20 (#2906 KEIKO-0532 P1 round-3 review) -- coding_runtime_snapshots.failure_code is a
// table-level CHECK constraint, so SQLite cannot widen it with ALTER TABLE; the table is rebuilt.
// This closes two literals CODING_WORKBENCH_RUNTIME_FAILURE_CODES already admitted but the
// constraint rejected -- 'approval-activation-failed' (pre-existing gap, only surfaced once a
// snapshot-store round trip was pinned for every contract literal) and 'replay-cap-exhausted'
// (KEIKO-0722, the finding that prompted this migration). Both left a statically valid terminal
// snapshot failing with SQLITE_CONSTRAINT instead of recording the failure. Column set, column
// order, and every other CHECK clause are carried over unchanged from V10 + the V19 result columns
// -- IMPORTANT: the V19 result columns keep their own per-column CHECK (as V19 declared them)
// rather than folding into the trailing table-level CHECK. SQLite's ALTER TABLE DROP COLUMN can
// drop a column together with a CHECK declared inline on that column, but refuses to drop a column
// referenced anywhere in a table-level CHECK constraint (verified empirically: same clause, moved
// from column-level to table-level, turns a working DROP COLUMN into "no such column" on the very
// column being dropped). restoreV13SchemaFixture (legacySchemaTestFixture.ts) individually drops
// each V19 result column, so folding them into the table-level CHECK would silently break that
// fixture the next time a real on-disk database (not the in-memory migration-only tests) exercises
// this table -- keep them column-level.
const V20_SQL = `
CREATE TABLE coding_runtime_snapshots_v20 (
  run_id TEXT NOT NULL PRIMARY KEY,
  schema_version TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  requested_mode TEXT NOT NULL,
  runtime_source TEXT NOT NULL,
  model_source TEXT NOT NULL,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  recovery_acknowledged_at TEXT,
  predecessor_run_id TEXT,
  task_digest TEXT NOT NULL,
  workspace_digest TEXT NOT NULL,
  operator_digest TEXT NOT NULL,
  authority_digest TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  provenance_digest TEXT NOT NULL,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  patch_byte_count INTEGER NOT NULL DEFAULT 0,
  model_request_count INTEGER NOT NULL DEFAULT 0,
  recovery_handle TEXT,
  result_status TEXT
    CHECK (result_status IS NULL OR result_status IN ('cancelled','failed','signalled','succeeded')),
  exit_code INTEGER
    CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND 255),
  stdout_byte_count INTEGER
    CHECK (stdout_byte_count IS NULL OR stdout_byte_count BETWEEN 0 AND 1073741824),
  stdout_line_count INTEGER
    CHECK (stdout_line_count IS NULL OR stdout_line_count BETWEEN 0 AND 1000000),
  stdout_sha256 TEXT
    CHECK (stdout_sha256 IS NULL OR length(stdout_sha256) = 64),
  stdout_truncated INTEGER
    CHECK (stdout_truncated IS NULL OR stdout_truncated IN (0,1)),
  stderr_byte_count INTEGER
    CHECK (stderr_byte_count IS NULL OR stderr_byte_count BETWEEN 0 AND 1073741824),
  stderr_line_count INTEGER
    CHECK (stderr_line_count IS NULL OR stderr_line_count BETWEEN 0 AND 1000000),
  stderr_sha256 TEXT
    CHECK (stderr_sha256 IS NULL OR length(stderr_sha256) = 64),
  stderr_truncated INTEGER
    CHECK (stderr_truncated IS NULL OR stderr_truncated IN (0,1)),
  CHECK (
    schema_version = '1'
    AND state IN ('starting','ready','running','paused','awaiting-approval','stopping','succeeded','failed','cancelled','taken-over','recovery-required')
    AND requested_mode IN ('governed-assist','supervised-coding','autonomous-delivery')
    AND runtime_source IN ('keiko-sidecar','codex-cli-adapter','delivery-runner')
    AND model_source IN ('keiko-model-gateway','openai-api-key-through-gateway','chatgpt-codex-subscription-profile')
    AND (failure_code IS NULL OR failure_code IN ('runtime-unavailable','active-run-conflict','invalid-intent','approval-activation-failed','authority-resolution-failed','authority-expired','authority-replayed','task-drift','workspace-drift','project-drift','branch-drift','scope-drift','budget-drift','authority-budget-exceeded','source-drift','runtime-failed','revoked','recovery-required','replay-cap-exhausted'))
    AND revision >= 0
    AND tool_call_count BETWEEN 0 AND 1000000
    AND patch_byte_count BETWEEN 0 AND 1073741824
    AND model_request_count BETWEEN 0 AND 1000000
    AND length(run_id) BETWEEN 1 AND 128
    AND length(task_digest) BETWEEN 1 AND 128
    AND length(workspace_digest) BETWEEN 1 AND 128
    AND length(operator_digest) BETWEEN 1 AND 128
    AND length(authority_digest) BETWEEN 1 AND 128
    AND length(binding_digest) BETWEEN 1 AND 128
    AND length(provenance_digest) BETWEEN 1 AND 128
    AND (recovery_handle IS NULL OR length(recovery_handle) BETWEEN 1 AND 128)
  )
) STRICT;

INSERT INTO coding_runtime_snapshots_v20 (
  run_id, schema_version, state, revision, requested_mode, runtime_source, model_source,
  failure_code, created_at, updated_at, terminal_at, recovery_acknowledged_at,
  predecessor_run_id, task_digest, workspace_digest, operator_digest, authority_digest,
  binding_digest, provenance_digest, tool_call_count, patch_byte_count, model_request_count,
  recovery_handle, result_status, exit_code, stdout_byte_count, stdout_line_count,
  stdout_sha256, stdout_truncated, stderr_byte_count, stderr_line_count, stderr_sha256,
  stderr_truncated
)
SELECT
  run_id, schema_version, state, revision, requested_mode, runtime_source, model_source,
  failure_code, created_at, updated_at, terminal_at, recovery_acknowledged_at,
  predecessor_run_id, task_digest, workspace_digest, operator_digest, authority_digest,
  binding_digest, provenance_digest, tool_call_count, patch_byte_count, model_request_count,
  recovery_handle, result_status, exit_code, stdout_byte_count, stdout_line_count,
  stdout_sha256, stdout_truncated, stderr_byte_count, stderr_line_count, stderr_sha256,
  stderr_truncated
FROM coding_runtime_snapshots;

DROP TABLE coding_runtime_snapshots;

ALTER TABLE coding_runtime_snapshots_v20 RENAME TO coding_runtime_snapshots;

CREATE UNIQUE INDEX uniq_coding_runtime_active_slot
  ON coding_runtime_snapshots((1))
  WHERE terminal_at IS NULL;
CREATE INDEX idx_coding_runtime_recent_active
  ON coding_runtime_snapshots(terminal_at, updated_at DESC, run_id);
CREATE INDEX idx_coding_runtime_settled_oldest
  ON coding_runtime_snapshots(terminal_at, updated_at, run_id)
  WHERE terminal_at IS NOT NULL;
`;

// KEIKO-0573: exported so a co-located test can assert strict ascending version order across the
// array. Not re-exported through packages/keiko-server/src/store/index.ts, so no packaged surface
// change.
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1_SQL },
  { version: 2, sql: V2_SQL },
  { version: 3, sql: V3_SQL },
  { version: 4, sql: V4_SQL },
  { version: 5, sql: V5_SQL },
  { version: 6, sql: V6_SQL },
  { version: 7, sql: V7_SQL },
  { version: 8, sql: V8_SQL },
  { version: 9, sql: V9_SQL },
  { version: 10, sql: V10_SQL },
  { version: 11, sql: V11_SQL },
  { version: 12, sql: V12_SQL },
  { version: 13, sql: V13_SQL },
  { version: 14, sql: V14_SQL },
  { version: 15, sql: V15_SQL, apply: migrateLegacyProjectManifests },
  { version: 16, sql: V16_SQL },
  { version: 17, sql: V17_SQL, apply: migrateWorkspaceRootObjectIdentities },
  { version: 18, sql: V18_SQL },
  { version: 19, sql: V19_SQL },
  { version: 20, sql: V20_SQL },
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
  if (start > SCHEMA_VERSION) {
    throw new UiStoreSchemaVersionError(start, SCHEMA_VERSION);
  }
  const pending = MIGRATIONS.filter((m) => m.version > start);
  if (pending.length === 0) return;
  db.exec("BEGIN");
  try {
    for (const m of pending) {
      db.exec(m.sql);
      m.apply?.(db);
      setUserVersion(db, m.version);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
