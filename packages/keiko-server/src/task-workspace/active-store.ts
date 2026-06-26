// Durable singleton active task-workspace pointer (Issue #446, Epic #443).
//
// Studio binds exactly ONE active task workspace at a time. The pointer is the durable source of truth
// for "which workspace is active"; the WorkspaceBinding surfaces consume is DERIVED from the referenced
// WorkspaceInstance (see binding.ts), never stored here — so there is no second copy of the root to
// drift. The table is pinned to a single row (id = 'active', CHECK-enforced) over the SAME node:sqlite
// handle as the UI store and the #445 instance store (schema.ts §V8), so the V8 sibling row shares the
// single-writer transaction model.
//
// The pointer is content-free: an opaque workspace id + an opaque actor id + ISO timestamps. No root,
// no branch, no path is persisted here. "Clear active" deletes the row → unbound mode.

import type { DatabaseSync } from "node:sqlite";

export interface ActiveWorkspacePointer {
  readonly workspaceId: string;
  readonly setBy: string;
  readonly setAt: string;
  readonly updatedAt: string;
}

export interface ActiveWorkspacePointerStore {
  /** The current active pointer, or undefined in unbound mode (no row). */
  readonly get: () => ActiveWorkspacePointer | undefined;
  /** Upsert the singleton row (id pinned to 'active'); returns the persisted pointer. */
  readonly set: (input: {
    readonly workspaceId: string;
    readonly setBy: string;
    readonly atIso: string;
  }) => ActiveWorkspacePointer;
  /** Delete the singleton row → unbound mode. Idempotent. */
  readonly clear: () => void;
}

interface PointerRow {
  readonly workspace_id: string;
  readonly set_by: string;
  readonly set_at: string;
  readonly updated_at: string;
}

const SQL_GET = `SELECT workspace_id, set_by, set_at, updated_at FROM task_workspace_active_pointer WHERE id = 'active'`;
const SQL_CLEAR = `DELETE FROM task_workspace_active_pointer WHERE id = 'active'`;
// `set_at` records when the CURRENT workspace became active, `updated_at` the last touch. On conflict
// the CASE keeps the original `set_at` when the SAME workspace is re-set (an idempotent re-activation
// preserves its "became active" time) and resets it when switching to a DIFFERENT workspace.
const SQL_SET = `
INSERT INTO task_workspace_active_pointer (id, workspace_id, set_by, set_at, updated_at)
VALUES ('active', ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  set_at = CASE
    WHEN task_workspace_active_pointer.workspace_id = excluded.workspace_id
    THEN task_workspace_active_pointer.set_at
    ELSE excluded.set_at
  END,
  workspace_id = excluded.workspace_id,
  set_by = excluded.set_by,
  updated_at = excluded.updated_at
RETURNING workspace_id, set_by, set_at, updated_at
`;

function rowToPointer(row: PointerRow): ActiveWorkspacePointer {
  return {
    workspaceId: row.workspace_id,
    setBy: row.set_by,
    setAt: row.set_at,
    updatedAt: row.updated_at,
  };
}

export function buildActiveWorkspacePointerStoreOverDatabase(
  db: DatabaseSync,
): ActiveWorkspacePointerStore {
  return {
    get: (): ActiveWorkspacePointer | undefined => {
      const row = db.prepare(SQL_GET).get() as unknown as PointerRow | undefined;
      return row === undefined ? undefined : rowToPointer(row);
    },
    set: (input): ActiveWorkspacePointer => {
      const row = db
        .prepare(SQL_SET)
        .get(input.workspaceId, input.setBy, input.atIso, input.atIso) as unknown as PointerRow;
      return rowToPointer(row);
    },
    clear: (): void => {
      db.prepare(SQL_CLEAR).run();
    },
  };
}
