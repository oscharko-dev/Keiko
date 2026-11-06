/**
 * The private SQLite schema the pinned OpenCode runtime's own migrations create, derived from the
 * producers: fresh admitted 2.2.5 and 2.1.4 servers' `opencode.db`, every table (SQLite's internal `sqlite_*` tables
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

/**
 * What a retained copy may hold in a table. `session-state` is the session's own record; every
 * other class must be empty, because its rows could act with authority or state a later run does
 * not have. `unknown-state` names a table whose content Keiko does not model. Each version
 * classifies every table it creates, so an upgrade cannot add one nobody looked at.
 */
export type OpenCodePersistenceTableClass =
  "grant" | "credential" | "pending-input" | "unknown-state" | "session-state";

type OpenCodePersistenceTableClasses = Readonly<Record<string, OpenCodePersistenceTableClass>>;

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
 * 2.2.5 adds schedules, background jobs, session parts and attachment blobs and drops
 * session_pending, whose queued input moved to session_inbox.
 */
const OPENCODE_2_2_5_PERSISTENCE_SCHEMA: OpenCodePersistenceSchema = Object.freeze({
  ...Object.fromEntries(
    Object.entries(OPENCODE_2_1_4_PERSISTENCE_SCHEMA).filter(
      ([table]) => table !== "session_pending",
    ),
  ),
  blob: ["bytes", "data", "hash", "height", "mime", "time_created", "width"],
  blob_ref: ["hash", "message_id", "seq", "session_id"],
  job: [
    "child_session_id",
    "error",
    "id",
    "kind",
    "notification_id",
    "output",
    "recovery",
    "session_id",
    "status",
    "time_created",
    "time_updated",
    "title",
  ],
  schedule: [
    "action",
    "check",
    "checks",
    "ends_at",
    "failures",
    "id",
    "last_fired_at",
    "last_message_id",
    "last_outcome",
    "name",
    "next_due_at",
    "remaining_runs",
    "retry_at",
    "run_count",
    "session_id",
    "state",
    "status",
    "time_created",
    "time_updated",
    "tz",
    "when",
  ],
  session_part: [
    "call_id",
    "data",
    "message_id",
    "ordinal",
    "session_id",
    "time_created",
    "time_updated",
    "type",
  ],
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
    "time_busy",
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
});

const OPENCODE_2_1_4_TABLE_CLASSES: OpenCodePersistenceTableClasses = Object.freeze({
  permission: "grant",
  credential: "credential",
  account: "credential",
  account_state: "credential",
  control_account: "credential",
  session_pending: "pending-input",
  session_inbox: "pending-input",
  kv: "unknown-state",
  workspace: "unknown-state",
  event: "session-state",
  event_sequence: "session-state",
  instruction_blob: "session-state",
  instruction_entry: "session-state",
  instruction_state: "session-state",
  migration: "session-state",
  project: "session-state",
  project_directory: "session-state",
  session_message: "session-state",
  session_v2: "session-state",
  worktree: "session-state",
});

/** Which rows refuse a retained 2.2.5 copy. Rows nothing in a settled native run writes stay refused. */
const OPENCODE_2_2_5_TABLE_CLASSES: OpenCodePersistenceTableClasses = Object.freeze({
  ...Object.fromEntries(
    Object.entries(OPENCODE_2_1_4_TABLE_CLASSES).filter(([table]) => table !== "session_pending"),
  ),
  schedule: "pending-input",
  blob: "unknown-state",
  blob_ref: "unknown-state",
  job: "unknown-state",
  session_part: "session-state",
});

export const OPENCODE_PERSISTENCE_TABLE_CLASSES: Readonly<
  Record<string, OpenCodePersistenceTableClasses>
> = Object.freeze({
  "2.2.5": OPENCODE_2_2_5_TABLE_CLASSES,
  "2.1.4": OPENCODE_2_1_4_TABLE_CLASSES,
});

export const OPENCODE_PERSISTENCE_SCHEMAS: Readonly<Record<string, OpenCodePersistenceSchema>> =
  Object.freeze({
    "2.2.5": OPENCODE_2_2_5_PERSISTENCE_SCHEMA,
    "2.1.4": OPENCODE_2_1_4_PERSISTENCE_SCHEMA,
  });
