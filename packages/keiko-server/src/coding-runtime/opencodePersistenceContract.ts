/**
 * The private SQLite schema the pinned OpenCode runtime's own migrations create, derived from the
 * producers: fresh admitted 2.1.4 and 2.0.10 servers' `opencode.db`, every table (SQLite's internal `sqlite_*` tables
 * excepted) with its complete column set. `opencodeNativeSessionResume.real.test.ts` proves that the
 * database of a real settled run still has exactly this schema.
 *
 * Session retention carries a whole database forward (#3908 AC4), so a table or column the
 * contract does not name is state no audit has examined: a producer upgrade could persist
 * authority, credentials or pending input there. The audit therefore refuses any table, column,
 * view or trigger beyond the contract, and any that is missing, for the version the session was
 * built by. A new runtime version needs its own producer-derived entry before its state is
 * retained.
 */
type OpenCodePersistenceSchema = Readonly<Record<string, readonly string[]>>;

const OPENCODE_2_1_4_PERSISTENCE_SCHEMA: OpenCodePersistenceSchema = Object.freeze({
  account: [
    "access_token",
    "email",
    "id",
    "refresh_token",
    "time_created",
    "time_updated",
    "token_expiry",
    "url",
  ],
  account_state: ["active_account_id", "active_org_id", "id"],
  control_account: [
    "access_token",
    "active",
    "email",
    "refresh_token",
    "time_created",
    "time_updated",
    "token_expiry",
    "url",
  ],
  credential: [
    "active",
    "connector_id",
    "id",
    "integration_id",
    "label",
    "method_id",
    "time_created",
    "time_updated",
    "value",
  ],
  event: ["aggregate_id", "created", "data", "id", "seq", "type"],
  event_sequence: ["aggregate_id", "owner_id", "seq"],
  instruction_blob: ["hash", "value"],
  instruction_entry: ["key", "removed", "session_id", "time_created", "time_updated", "value"],
  instruction_state: [
    "current_values",
    "epoch_start",
    "initial_values",
    "session_id",
    "through_seq",
  ],
  kv: ["key", "time_created", "time_updated", "value"],
  migration: ["id", "time_completed"],
  permission: ["action", "id", "project_id", "resource", "time_created", "time_updated"],
  project: [
    "commands",
    "icon_color",
    "icon_url",
    "icon_url_override",
    "id",
    "name",
    "sandboxes",
    "time_active",
    "time_archived",
    "time_created",
    "time_initialized",
    "time_updated",
    "vcs",
    "worktree",
  ],
  project_directory: ["directory", "project_id", "strategy", "time_created", "type"],
  session_inbox: [
    "delivery",
    "enqueued_seq",
    "id",
    "payload",
    "session_id",
    "time_created",
    "type",
  ],
  session_message: ["data", "id", "seq", "session_id", "time_created", "time_updated", "type"],
  session_pending: ["admitted_seq", "data", "delivery", "id", "session_id", "time_created", "type"],
  session_v2: [
    "agent",
    "cost",
    "directory",
    "fork_boundary",
    "fork_session_id",
    "id",
    "idle_outcome",
    "metadata",
    "model",
    "parent_id",
    "path",
    "permission",
    "project_id",
    "resume_attempts",
    "revert",
    "share_url",
    "slug",
    "summary_additions",
    "summary_deletions",
    "summary_diffs",
    "summary_files",
    "time_archived",
    "time_compacting",
    "time_created",
    "time_idle",
    "time_suspended",
    "time_updated",
    "time_viewed",
    "title",
    "tokens_cache_read",
    "tokens_cache_write",
    "tokens_input",
    "tokens_output",
    "tokens_reasoning",
    "version",
    "workspace_id",
  ],
  workspace: ["binding", "created_at", "id", "last_used_at", "provider"],
  worktree: ["directory", "project_id", "strategy", "time_created"],
});

/**
 * The still-admitted published 2.0.10 runtime has the same table/column contract except for these
 * project columns. Its original 47 migrations predate 2.1.4's time_active/time_archived additions.
 * Both entries are checked against their own real producer by the native session continuity suite.
 */
const OPENCODE_2_0_10_PERSISTENCE_SCHEMA: OpenCodePersistenceSchema = Object.freeze({
  ...OPENCODE_2_1_4_PERSISTENCE_SCHEMA,
  project: [
    "commands",
    "icon_color",
    "icon_url",
    "icon_url_override",
    "id",
    "name",
    "sandboxes",
    "time_created",
    "time_initialized",
    "time_updated",
    "vcs",
    "worktree",
  ],
});

export const OPENCODE_PERSISTENCE_SCHEMAS: Readonly<Record<string, OpenCodePersistenceSchema>> =
  Object.freeze({
    "2.1.4": OPENCODE_2_1_4_PERSISTENCE_SCHEMA,
    "2.0.10": OPENCODE_2_0_10_PERSISTENCE_SCHEMA,
  });
