// Issue #2524, ADR-0147 D1/D8/D9 — ordered workspace-manifest persistence over the existing uiDb.
// The authoritative contract is stored as validated JSON while relational root rows preserve the
// project registry reference and make membership/ordering constraints transactional.

import type { DatabaseSync } from "node:sqlite";
import { validateWorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import { createSingleRootWorkspaceManifest } from "../workspace-manifest-identity.js";
import type {
  WorkspaceManifestMutationInput,
  WorkspaceManifestRecordRow,
  WorkspaceManifestRootProject,
} from "./types.js";

interface ManifestRow {
  readonly workspace_id: string;
  readonly schema_version: number;
  readonly manifest_ref: string;
  readonly revision: number;
  readonly manifest_digest: string;
  readonly record_json: string;
  readonly updated_at: number;
}

interface ProjectRow {
  readonly path: string;
  readonly name: string;
}

const SQL_SELECT = `
SELECT workspace_id, schema_version, manifest_ref, revision, manifest_digest, record_json, updated_at
FROM workspace_manifests
`;
const SQL_LIST = `${SQL_SELECT.trim()} ORDER BY workspace_id`;
const SQL_READ = `${SQL_SELECT.trim()} WHERE workspace_id = ?`;
const SQL_FIND_BY_ROOT = `${SQL_SELECT.trim()} WHERE workspace_id = (
  SELECT workspace_id FROM workspace_manifest_roots WHERE root_ref = ?
)`;
const SQL_FIND_BY_PROJECT = `${SQL_SELECT.trim()} WHERE workspace_id = (
  SELECT workspace_id FROM workspace_manifest_roots WHERE project_path = ?
)`;
const SQL_ROOT_IDENTITIES = `
SELECT root_ref, identity_digest FROM workspace_manifest_roots
WHERE workspace_id = ?
`;
const SQL_ROOT_PROJECTS = `
SELECT root_ref, project_path FROM workspace_manifest_roots
WHERE workspace_id = ? ORDER BY position
`;
const SQL_INSERT_MANIFEST = `
INSERT INTO workspace_manifests (
  workspace_id, schema_version, manifest_ref, revision, manifest_digest,
  focused_root_ref, record_json, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;
const SQL_INSERT_ROOT = `
INSERT INTO workspace_manifest_roots (
  workspace_id, root_ref, position, project_path, canonical_root, identity_digest
) VALUES (?, ?, ?, ?, ?, ?)
`;

function rootProjects(
  db: DatabaseSync,
  workspaceId: string,
): readonly WorkspaceManifestRootProject[] {
  const rows = db.prepare(SQL_ROOT_PROJECTS).all(workspaceId) as unknown as readonly {
    readonly root_ref: string;
    readonly project_path: string;
  }[];
  return rows.map((row) => ({ rootRef: row.root_ref, projectPath: row.project_path }));
}

function rootIdentities(db: DatabaseSync, workspaceId: string): ReadonlyMap<string, string> {
  const rows = db.prepare(SQL_ROOT_IDENTITIES).all(workspaceId) as unknown as readonly {
    readonly root_ref: string;
    readonly identity_digest: string;
  }[];
  return new Map(rows.map((row) => [row.root_ref, row.identity_digest]));
}

/**
 * Trust is invalidated only where the workspace actually changed shape: a root that left, a root
 * that joined, or a root whose filesystem identity was replaced under the same reference. A
 * mutation that merely reorders roots or moves focus changes no authority and must preserve every
 * grant — invalidating the union of previous and next members revoked trust on every root for a
 * plain focus click, which made persisted trust (#2521) unobservable in practice.
 */
function invalidatedRootRefs(
  previous: ReadonlyMap<string, string>,
  next: readonly { readonly rootRef: string; readonly identityDigest: string }[],
): ReadonlySet<string> {
  const invalidated = new Set<string>();
  const nextRefs = new Set(next.map((root) => root.rootRef));
  for (const rootRef of previous.keys()) {
    if (!nextRefs.has(rootRef)) invalidated.add(rootRef);
  }
  for (const root of next) {
    const previousIdentity = previous.get(root.rootRef);
    if (previousIdentity === undefined || previousIdentity !== root.identityDigest) {
      invalidated.add(root.rootRef);
    }
  }
  return invalidated;
}

function rowToRecord(db: DatabaseSync, row: ManifestRow): WorkspaceManifestRecordRow {
  return {
    workspaceId: row.workspace_id,
    schemaVersion: row.schema_version,
    manifestRef: row.manifest_ref,
    revision: row.revision,
    manifestDigest: row.manifest_digest,
    recordJson: row.record_json,
    updatedAt: row.updated_at,
    rootProjects: rootProjects(db, row.workspace_id),
  };
}

function rowBySql(
  db: DatabaseSync,
  sql: string,
  value: string,
): WorkspaceManifestRecordRow | undefined {
  const row = db.prepare(sql).get(value) as unknown as ManifestRow | undefined;
  return row === undefined ? undefined : rowToRecord(db, row);
}

export function listWorkspaceManifestRecords(
  db: DatabaseSync,
): readonly WorkspaceManifestRecordRow[] {
  const rows = db.prepare(SQL_LIST).all() as unknown as readonly ManifestRow[];
  return rows.map((row) => rowToRecord(db, row));
}

export function readWorkspaceManifestRecord(
  db: DatabaseSync,
  workspaceId: string,
): WorkspaceManifestRecordRow | undefined {
  return rowBySql(db, SQL_READ, workspaceId);
}

export function findWorkspaceManifestRecordByRoot(
  db: DatabaseSync,
  rootRef: string,
): WorkspaceManifestRecordRow | undefined {
  return rowBySql(db, SQL_FIND_BY_ROOT, rootRef);
}

export function findWorkspaceManifestRecordByProject(
  db: DatabaseSync,
  projectPath: string,
): WorkspaceManifestRecordRow | undefined {
  return rowBySql(db, SQL_FIND_BY_PROJECT, projectPath);
}

function insertRootRows(
  db: DatabaseSync,
  manifest: WorkspaceManifest,
  projects: ReadonlyMap<string, string>,
): void {
  const insert = db.prepare(SQL_INSERT_ROOT);
  manifest.roots.forEach((root, position) => {
    const projectPath = projects.get(root.rootRef);
    if (projectPath === undefined) throw new Error("WORKSPACE_ROOT_PROJECT_MISSING");
    insert.run(
      manifest.workspaceId,
      root.rootRef,
      position,
      projectPath,
      root.canonicalRoot,
      root.identityDigest,
    );
  });
}

function insertManifest(
  db: DatabaseSync,
  manifest: WorkspaceManifest,
  projects: readonly WorkspaceManifestRootProject[],
  now: number,
): void {
  db.prepare(SQL_INSERT_MANIFEST).run(
    manifest.workspaceId,
    manifest.schemaVersion,
    manifest.manifestRef,
    manifest.revision,
    manifest.manifestDigest,
    manifest.focusedRootRef,
    JSON.stringify(manifest),
    now,
  );
  insertRootRows(
    db,
    manifest,
    new Map(projects.map((root) => [root.rootRef, root.projectPath] as const)),
  );
}

export function ensureProjectWorkspaceManifest(
  db: DatabaseSync,
  projectPath: string,
  projectName: string,
  now: number,
): void {
  if (findWorkspaceManifestRecordByProject(db, projectPath) !== undefined) return;
  let manifest: WorkspaceManifest;
  try {
    manifest = createSingleRootWorkspaceManifest(projectPath, projectName);
  } catch {
    return;
  }
  if (findWorkspaceManifestRecordByRoot(db, manifest.roots[0]?.rootRef ?? "") !== undefined) return;
  const root = manifest.roots[0];
  if (root === undefined) return;
  insertManifest(db, manifest, [{ rootRef: root.rootRef, projectPath }], now);
}

export function migrateLegacyProjectManifests(db: DatabaseSync): void {
  const projects = db
    .prepare("SELECT path, name FROM projects ORDER BY last_opened_at DESC, path LIMIT 1")
    .all() as unknown as readonly ProjectRow[];
  for (const project of projects) {
    ensureProjectWorkspaceManifest(db, project.path, project.name, 0);
  }
  if (listWorkspaceManifestRecords(db).length > 0) {
    db.prepare("DELETE FROM workspace_trust_records").run();
  }
}

function absorbedWorkspaceIsValid(
  db: DatabaseSync,
  workspaceId: string,
  nextRootRefs: ReadonlySet<string>,
): boolean {
  const roots = rootProjects(db, workspaceId);
  return roots.length === 1 && nextRootRefs.has(roots[0]?.rootRef ?? "");
}

function updateTargetManifest(
  db: DatabaseSync,
  input: WorkspaceManifestMutationInput,
  now: number,
): void {
  db.prepare("DELETE FROM workspace_manifest_roots WHERE workspace_id = ?").run(
    input.manifest.workspaceId,
  );
  const info = db
    .prepare(
      `UPDATE workspace_manifests SET revision = ?, manifest_digest = ?, focused_root_ref = ?,
       record_json = ?, updated_at = ? WHERE workspace_id = ? AND revision = ?`,
    )
    .run(
      input.manifest.revision,
      input.manifest.manifestDigest,
      input.manifest.focusedRootRef,
      JSON.stringify(input.manifest),
      now,
      input.manifest.workspaceId,
      input.expectedRevision,
    );
  if (info.changes !== 1) throw new Error("WORKSPACE_REVISION_CONFLICT");
  insertRootRows(
    db,
    input.manifest,
    new Map(input.rootProjects.map((root) => [root.rootRef, root.projectPath] as const)),
  );
}

export function replaceWorkspaceManifest(
  db: DatabaseSync,
  input: WorkspaceManifestMutationInput,
  now: number,
): boolean {
  if (!validateWorkspaceManifest(input.manifest).ok) return false;
  const nextRootRefs = new Set(input.manifest.roots.map((root) => root.rootRef));
  if (
    input.absorbedWorkspaceIds.some(
      (workspaceId) => !absorbedWorkspaceIsValid(db, workspaceId, nextRootRefs),
    )
  ) {
    return false;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    // Read before the absorbed manifests are dropped and before the target is rewritten, so this
    // is the pre-mutation membership. Roots arriving from an absorbed workspace are absent here
    // and therefore invalidate, which is the fail-closed outcome for a root joining a workspace.
    const previousIdentities = rootIdentities(db, input.manifest.workspaceId);
    for (const workspaceId of input.absorbedWorkspaceIds) {
      db.prepare("DELETE FROM workspace_manifests WHERE workspace_id = ?").run(workspaceId);
    }
    updateTargetManifest(db, input, now);
    const removeTrust = db.prepare("DELETE FROM workspace_trust_records WHERE root_ref = ?");
    for (const rootRef of invalidatedRootRefs(previousIdentities, input.manifest.roots)) {
      removeTrust.run(rootRef);
    }
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    if (error instanceof Error && error.message === "WORKSPACE_REVISION_CONFLICT") return false;
    throw error;
  }
}

export function workspaceManifestRootCountForProject(
  db: DatabaseSync,
  projectPath: string,
): number | undefined {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM workspace_manifest_roots WHERE workspace_id =
       (SELECT workspace_id FROM workspace_manifest_roots WHERE project_path = ?)`,
    )
    .get(projectPath) as { readonly count?: number } | undefined;
  return typeof row?.count === "number" ? row.count : undefined;
}

export function deleteSingletonWorkspaceManifestForProject(
  db: DatabaseSync,
  projectPath: string,
): void {
  const membership = db
    .prepare("SELECT workspace_id, root_ref FROM workspace_manifest_roots WHERE project_path = ?")
    .get(projectPath) as { readonly workspace_id?: string; readonly root_ref?: string } | undefined;
  if (membership?.workspace_id === undefined || membership.root_ref === undefined) return;
  db.prepare("DELETE FROM workspace_trust_records WHERE root_ref = ?").run(membership.root_ref);
  db.prepare("DELETE FROM workspace_manifests WHERE workspace_id = ?").run(membership.workspace_id);
}
