// Durable persistence for managed task-workspace instances (Issue #445, Epic #443).
//
// A dedicated store composed over the SAME node:sqlite DatabaseSync handle as the UI store and the
// relationship engine (schema.ts §V7), mirroring the relationship-store composition pattern so the
// V7 sibling table shares the single-writer transaction model. The store is the durable home for the
// `WorkspaceInstance` the contract defines; #446 (binding) and #447 (reconcile/repair) read and
// extend it without a second persistence layer.
//
// Every write is gated by the contract's `validateWorkspaceInstance` (content-free closed allowlist,
// SC3) and every read re-validates the reconstructed row, so a corrupt or smuggled record can neither
// be stored nor silently trusted on the way out. The unique (repository_id, task_id) index enforces
// the idempotency invariant at the DB layer (AC3).

import type { DatabaseSync } from "node:sqlite";
import {
  validateWorkspaceInstance,
  type TaskWorkspaceDriftMarker,
  type TaskWorkspaceHealth,
  type TaskWorkspaceLifecycleState,
  type WorkspaceInstance,
  type WorkspaceLock,
  type WorkspaceRecoveryHint,
} from "@oscharko-dev/keiko-contracts";

export interface WorkspaceInstanceStore {
  readonly getById: (workspaceId: string) => WorkspaceInstance | undefined;
  readonly findByRepositoryAndTask: (
    repositoryId: string,
    taskId: string,
  ) => WorkspaceInstance | undefined;
  readonly listByRepository: (repositoryId: string) => readonly WorkspaceInstance[];
  // Every persisted instance across all repositories — the enumeration startup reconciliation walks
  // (#447). Ordered deterministically (most recently updated first, then by id) so reconciliation and
  // its evidence are reproducible across restarts.
  readonly listAll: () => readonly WorkspaceInstance[];
  readonly upsert: (instance: WorkspaceInstance) => WorkspaceInstance;
  readonly delete: (workspaceId: string) => void;
}

interface InstanceRow {
  readonly workspace_id: string;
  readonly schema_version: string;
  readonly task_id: string;
  readonly repository_id: string;
  readonly repository_root: string;
  readonly base_branch: string;
  readonly task_branch: string;
  readonly managed_worktree_path: string;
  readonly gitdir_identity: string;
  readonly lifecycle_state: string;
  readonly health: string;
  readonly lock_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_verified_at: string | null;
  readonly last_verified_head: string | null;
  readonly drift_markers_json: string;
  readonly recovery_hints_json: string;
  readonly audit_correlation_id: string;
}

const COLUMNS = `
  workspace_id, schema_version, task_id, repository_id, repository_root, base_branch, task_branch,
  managed_worktree_path, gitdir_identity, lifecycle_state, health, lock_json, created_at, updated_at,
  last_verified_at, last_verified_head, drift_markers_json, recovery_hints_json, audit_correlation_id
`;

const SQL_GET_BY_ID = `SELECT ${COLUMNS} FROM task_workspace_instances WHERE workspace_id = ?`;
const SQL_FIND_BY_REPO_TASK = `SELECT ${COLUMNS} FROM task_workspace_instances WHERE repository_id = ? AND task_id = ?`;
const SQL_LIST_BY_REPO = `SELECT ${COLUMNS} FROM task_workspace_instances WHERE repository_id = ? ORDER BY updated_at DESC, workspace_id`;
const SQL_LIST_ALL = `SELECT ${COLUMNS} FROM task_workspace_instances ORDER BY updated_at DESC, workspace_id`;
const SQL_DELETE = "DELETE FROM task_workspace_instances WHERE workspace_id = ?";
const SQL_UPSERT = `
INSERT INTO task_workspace_instances (${COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
  schema_version = excluded.schema_version,
  task_id = excluded.task_id,
  repository_id = excluded.repository_id,
  repository_root = excluded.repository_root,
  base_branch = excluded.base_branch,
  task_branch = excluded.task_branch,
  managed_worktree_path = excluded.managed_worktree_path,
  gitdir_identity = excluded.gitdir_identity,
  lifecycle_state = excluded.lifecycle_state,
  health = excluded.health,
  lock_json = excluded.lock_json,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  last_verified_at = excluded.last_verified_at,
  last_verified_head = excluded.last_verified_head,
  drift_markers_json = excluded.drift_markers_json,
  recovery_hints_json = excluded.recovery_hints_json,
  audit_correlation_id = excluded.audit_correlation_id
RETURNING ${COLUMNS}
`;

function parseJsonArray(json: string): readonly unknown[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed : [];
}

function rowToInstance(row: InstanceRow): WorkspaceInstance {
  const lock = row.lock_json === null ? null : (JSON.parse(row.lock_json) as WorkspaceLock);
  const instance: WorkspaceInstance = {
    schemaVersion: row.schema_version as WorkspaceInstance["schemaVersion"],
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    repositoryId: row.repository_id,
    repositoryRoot: row.repository_root,
    baseBranch: row.base_branch,
    taskBranch: row.task_branch,
    managedWorktreePath: row.managed_worktree_path,
    gitdirIdentity: row.gitdir_identity,
    lifecycleState: row.lifecycle_state as TaskWorkspaceLifecycleState,
    health: row.health as TaskWorkspaceHealth,
    lock,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_verified_at !== null ? { lastVerifiedAt: row.last_verified_at } : {}),
    ...(row.last_verified_head !== null ? { lastVerifiedHead: row.last_verified_head } : {}),
    driftMarkers: parseJsonArray(row.drift_markers_json) as readonly TaskWorkspaceDriftMarker[],
    recoveryHints: parseJsonArray(row.recovery_hints_json) as readonly WorkspaceRecoveryHint[],
    auditCorrelationId: row.audit_correlation_id,
  };
  const validation = validateWorkspaceInstance(instance);
  if (!validation.ok) {
    throw new Error(
      `persisted task-workspace instance is invalid (${row.workspace_id}): ${validation.reasons.join("; ")}`,
    );
  }
  return instance;
}

function upsertParams(instance: WorkspaceInstance): readonly (string | null)[] {
  return [
    instance.workspaceId,
    instance.schemaVersion,
    instance.taskId,
    instance.repositoryId,
    instance.repositoryRoot,
    instance.baseBranch,
    instance.taskBranch,
    instance.managedWorktreePath,
    instance.gitdirIdentity,
    instance.lifecycleState,
    instance.health,
    instance.lock === null ? null : JSON.stringify(instance.lock),
    instance.createdAt,
    instance.updatedAt,
    instance.lastVerifiedAt ?? null,
    instance.lastVerifiedHead ?? null,
    JSON.stringify(instance.driftMarkers),
    JSON.stringify(instance.recoveryHints),
    instance.auditCorrelationId,
  ];
}

export function buildWorkspaceInstanceStoreOverDatabase(db: DatabaseSync): WorkspaceInstanceStore {
  return {
    getById: (workspaceId: string): WorkspaceInstance | undefined => {
      const row = db.prepare(SQL_GET_BY_ID).get(workspaceId) as unknown as InstanceRow | undefined;
      return row === undefined ? undefined : rowToInstance(row);
    },
    findByRepositoryAndTask: (
      repositoryId: string,
      taskId: string,
    ): WorkspaceInstance | undefined => {
      const row = db.prepare(SQL_FIND_BY_REPO_TASK).get(repositoryId, taskId) as unknown as
        InstanceRow | undefined;
      return row === undefined ? undefined : rowToInstance(row);
    },
    listByRepository: (repositoryId: string): readonly WorkspaceInstance[] =>
      (db.prepare(SQL_LIST_BY_REPO).all(repositoryId) as unknown as InstanceRow[]).map(
        rowToInstance,
      ),
    listAll: (): readonly WorkspaceInstance[] =>
      (db.prepare(SQL_LIST_ALL).all() as unknown as InstanceRow[]).map(rowToInstance),
    upsert: (instance: WorkspaceInstance): WorkspaceInstance => {
      const validation = validateWorkspaceInstance(instance);
      if (!validation.ok) {
        throw new Error(
          `refusing to persist invalid workspace instance: ${validation.reasons.join("; ")}`,
        );
      }
      const row = db.prepare(SQL_UPSERT).get(...upsertParams(instance)) as unknown as InstanceRow;
      return rowToInstance(row);
    },
    delete: (workspaceId: string): void => {
      db.prepare(SQL_DELETE).run(workspaceId);
    },
  };
}
