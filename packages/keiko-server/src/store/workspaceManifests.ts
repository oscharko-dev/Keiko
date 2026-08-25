// Issue #2524, ADR-0147 D1/D8/D9 — ordered workspace-manifest persistence over the existing uiDb.
// The authoritative contract is stored as validated JSON while relational root rows preserve the
// project registry reference and make membership/ordering constraints transactional.

import type { DatabaseSync } from "node:sqlite";
import {
  validateWorkspaceManifest,
  workspaceTrustRootBindingsMatch,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import {
  createSingleRootWorkspaceManifest,
  inspectWorkspaceRootDescriptor,
  reviseWorkspaceManifest,
} from "../workspace-manifest-identity.js";
import { inspectWorkspaceRootIdentity } from "../workspace-root-identity.js";
import { projectExists } from "./errors.js";
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
SELECT root_ref, identity_digest, object_identity_digest FROM workspace_manifest_roots
WHERE workspace_id = ?
`;
const SQL_ROOT_PROJECTS = `
SELECT root_ref, project_path, object_identity_digest FROM workspace_manifest_roots
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
  workspace_id, root_ref, position, project_path, canonical_root, identity_digest,
  object_identity_digest
) VALUES (?, ?, ?, ?, ?, ?, ?)
`;

const MAX_WORKSPACE_IDENTITY_ATTEMPTS = 8;

function rootProjects(
  db: DatabaseSync,
  workspaceId: string,
): readonly WorkspaceManifestRootProject[] {
  const rows = db.prepare(SQL_ROOT_PROJECTS).all(workspaceId) as unknown as readonly {
    readonly root_ref: string;
    readonly project_path: string;
    readonly object_identity_digest: string | null;
  }[];
  return rows.map((row) => ({
    rootRef: row.root_ref,
    projectPath: row.project_path,
    objectIdentityDigest: row.object_identity_digest,
  }));
}

interface StoredRootIdentity {
  readonly identityDigest: string;
  readonly objectIdentityDigest: string | null;
}

function rootIdentities(
  db: DatabaseSync,
  workspaceId: string,
): ReadonlyMap<string, StoredRootIdentity> {
  const rows = db.prepare(SQL_ROOT_IDENTITIES).all(workspaceId) as unknown as readonly {
    readonly root_ref: string;
    readonly identity_digest: string;
    readonly object_identity_digest: string | null;
  }[];
  return new Map(
    rows.map((row) => [
      row.root_ref,
      {
        identityDigest: row.identity_digest,
        objectIdentityDigest: row.object_identity_digest,
      },
    ]),
  );
}

/**
 * Trust is invalidated only where the workspace actually changed shape: a root that left, a root
 * that joined, or a root whose filesystem identity was replaced under the same reference. A
 * mutation that merely reorders roots or moves focus changes no authority and must preserve every
 * grant — invalidating the union of previous and next members revoked trust on every root for a
 * plain focus click, which made persisted trust (#2521) unobservable in practice.
 */
function trustRootBinding(
  rootRef: string,
  identity: StoredRootIdentity | undefined,
):
  | {
      readonly rootRef: string;
      readonly rootIdentityDigest: string;
      readonly rootIdentityProvenanceDigest: string | null;
    }
  | undefined {
  return identity === undefined
    ? undefined
    : {
        rootRef,
        rootIdentityDigest: identity.identityDigest,
        rootIdentityProvenanceDigest: identity.objectIdentityDigest,
      };
}

export function invalidatedRootRefs(
  previous: ReadonlyMap<string, StoredRootIdentity>,
  next: ReadonlyMap<string, StoredRootIdentity>,
): ReadonlySet<string> {
  const invalidated = new Set<string>();
  for (const rootRef of new Set([...previous.keys(), ...next.keys()])) {
    if (
      !workspaceTrustRootBindingsMatch(
        trustRootBinding(rootRef, previous.get(rootRef)),
        trustRootBinding(rootRef, next.get(rootRef)),
      )
    ) {
      invalidated.add(rootRef);
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
    const inspected = inspectWorkspaceRootIdentity(root.canonicalRoot);
    if (inspected.rootRef !== root.rootRef || inspected.identityDigest !== root.identityDigest) {
      throw new Error("WORKSPACE_ROOT_IDENTITY_CHANGED");
    }
    insert.run(
      manifest.workspaceId,
      root.rootRef,
      position,
      projectPath,
      root.canonicalRoot,
      root.identityDigest,
      inspected.objectIdentityDigest ?? null,
    );
  });
}

interface LegacyRootIdentityRow {
  readonly root_ref: string;
  readonly canonical_root: string;
  readonly identity_digest: string;
}

function liveObjectIdentity(row: LegacyRootIdentityRow): string | undefined {
  try {
    const live = inspectWorkspaceRootIdentity(row.canonical_root);
    if (live.rootRef !== row.root_ref || live.identityDigest !== row.identity_digest) {
      return undefined;
    }
    return live.objectIdentityDigest;
  } catch {
    return undefined;
  }
}

export function migrateWorkspaceRootObjectIdentities(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT root_ref, canonical_root, identity_digest FROM workspace_manifest_roots")
    .all() as unknown as readonly LegacyRootIdentityRow[];
  const candidates = rows
    .map((row) => ({ row, digest: liveObjectIdentity(row) }))
    .filter(
      (candidate): candidate is { readonly row: LegacyRootIdentityRow; readonly digest: string } =>
        candidate.digest !== undefined,
    );
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.digest, (counts.get(candidate.digest) ?? 0) + 1);
  }
  const update = db.prepare(
    "UPDATE workspace_manifest_roots SET object_identity_digest = ? WHERE root_ref = ?",
  );
  for (const candidate of candidates) {
    if (counts.get(candidate.digest) === 1) update.run(candidate.digest, candidate.row.root_ref);
  }
  db.prepare("DELETE FROM workspace_trust_records").run();
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

/**
 * The first workspace identity for this root that no live workspace already holds. A workspace
 * keeps the identity derived from its founding root even after that root leaves, so restoring a
 * departed founding root collides with its own former workspace — and a swallowed UNIQUE violation
 * would orphan exactly the root the restore exists to rescue (#2620). Discriminator 0 reproduces
 * the original digest byte for byte, so project creation and the D9 migration are unchanged.
 */
function freeWorkspaceManifest(
  db: DatabaseSync,
  projectPath: string,
  projectName: string,
): WorkspaceManifest {
  for (let discriminator = 0; discriminator < MAX_WORKSPACE_IDENTITY_ATTEMPTS; discriminator += 1) {
    const manifest = createSingleRootWorkspaceManifest(projectPath, projectName, discriminator);
    if (readWorkspaceManifestRecord(db, manifest.workspaceId) === undefined) return manifest;
  }
  throw new Error("WORKSPACE_IDENTITY_UNAVAILABLE");
}

export function ensureProjectWorkspaceManifest(
  db: DatabaseSync,
  projectPath: string,
  projectName: string,
  now: number,
): void {
  if (findWorkspaceManifestRecordByProject(db, projectPath) !== undefined) return;
  // Propagate a manifest-creation failure so the enclosing
  // createProjectRecord transaction (store/db.ts) rolls back instead of
  // committing a project row with no workspace manifest — the paired-write
  // invariant every downstream lookup assumes. AGENTS.md §7: do not swallow
  // errors on trust-boundary paths.
  const manifest = freeWorkspaceManifest(db, projectPath, projectName);
  const root = manifest.roots[0];
  if (root === undefined) throw new Error("WORKSPACE_MANIFEST_ROOT_MISSING");
  // `root.rootRef` is a pure function of the OS-canonicalized path (#2615): on a case-insensitive
  // filesystem, two spellings of the same directory resolve to the same rootRef even though
  // `freeWorkspaceManifest` just minted a fresh, unused workspaceId for this project path.
  // Returning here without inserting would finish successfully while leaving this project paired
  // with no manifest at all — exactly the invariant violation the comment above exists to prevent.
  // Throwing instead rolls the transaction back and gives the caller a typed 409 to act on.
  if (findWorkspaceManifestRecordByRoot(db, root.rootRef) !== undefined) throw projectExists();
  insertManifest(db, manifest, [{ rootRef: root.rootRef, projectPath }], now);
}

function storedManifest(record: WorkspaceManifestRecordRow): WorkspaceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.recordJson);
  } catch {
    throw new Error("WORKSPACE_MANIFEST_INVALID");
  }
  if (!validateWorkspaceManifest(parsed).ok) throw new Error("WORKSPACE_MANIFEST_INVALID");
  const manifest = parsed as WorkspaceManifest;
  if (
    manifest.workspaceId !== record.workspaceId ||
    manifest.schemaVersion !== record.schemaVersion ||
    manifest.manifestRef !== record.manifestRef ||
    manifest.revision !== record.revision ||
    manifest.manifestDigest !== record.manifestDigest ||
    manifest.roots.length !== record.rootProjects.length ||
    manifest.roots.some(
      (root, index): boolean => root.rootRef !== record.rootProjects[index]?.rootRef,
    )
  ) {
    throw new Error("WORKSPACE_MANIFEST_INVALID");
  }
  return manifest;
}

/**
 * An explicit reconnect accepts the filesystem object currently occupying a registered
 * single-root project's path. It never rewrites a multi-root workspace, and replacement always
 * revokes the former root's trust before the refreshed identity becomes dispatchable.
 */
export function reconnectProjectWorkspaceManifest(
  db: DatabaseSync,
  projectPath: string,
  projectName: string,
  now: number,
): void {
  const record = findWorkspaceManifestRecordByProject(db, projectPath);
  if (record === undefined) {
    ensureProjectWorkspaceManifest(db, projectPath, projectName, now);
    return;
  }
  if (record.rootProjects.length !== 1) return;
  const manifest = storedManifest(record);
  const previousRoot = manifest.roots[0];
  const projectRoot = record.rootProjects[0];
  if (previousRoot === undefined || projectRoot?.projectPath !== projectPath) {
    throw new Error("WORKSPACE_MANIFEST_INVALID");
  }
  const inspected = inspectWorkspaceRootIdentity(projectPath);
  if (
    inspected.rootRef === previousRoot.rootRef &&
    inspected.identityDigest === previousRoot.identityDigest &&
    inspected.objectIdentityDigest === (projectRoot.objectIdentityDigest ?? undefined)
  ) {
    return;
  }
  const refreshedRoot = inspectWorkspaceRootDescriptor(projectPath, projectName);
  const refreshed = reviseWorkspaceManifest(manifest, [refreshedRoot], refreshedRoot.rootRef);
  updateTargetManifest(
    db,
    {
      manifest: refreshed,
      expectedRevision: manifest.revision,
      absorbedWorkspaceIds: [],
      rootProjects: [{ rootRef: refreshedRoot.rootRef, projectPath }],
      releasedProjectPaths: [],
    },
    now,
  );
  db.prepare("DELETE FROM workspace_trust_records WHERE root_ref = ?").run(previousRoot.rootRef);
}

export function migrateLegacyProjectManifests(db: DatabaseSync): void {
  const projects = db
    .prepare("SELECT path, name FROM projects ORDER BY last_opened_at DESC, path LIMIT 1")
    .all() as unknown as readonly ProjectRow[];
  for (const project of projects) {
    // Per-row tolerance is the migration's own invariant, deliberately narrower than the
    // fail-closed `createProjectRecord` path: a legacy project row whose directory no longer
    // exists on disk must not brick the forward-only schema upgrade for the whole store. The
    // skipped project simply stays pre-manifest, which downstream code already handles (#2613).
    try {
      ensureProjectWorkspaceManifest(db, project.path, project.name, 0);
    } catch {
      continue;
    }
  }
  const count = db.prepare("SELECT COUNT(*) AS count FROM workspace_manifests").get() as {
    readonly count?: number;
  };
  if ((count.count ?? 0) > 0) {
    db.prepare("DELETE FROM workspace_trust_records").run();
  }
}

/**
 * The inverse of absorption. `addRoot` deletes the single-root manifest a joining root arrived
 * with, so a later removal used to leave that project registered with no workspace of its own —
 * permanently orphaned and undispatchable (#2620). Restoring it here, inside the membership
 * transaction, is what makes the round trip lossless.
 *
 * Restoration returns membership only, never authority: the departed root's trust row is deleted in
 * this same commit, and the manifest is minted fresh from live filesystem identity at revision 1,
 * so no grant, order, or focus from the multi-root era survives (ADR-0147 D8, ADR-0155).
 */
function restoreReleasedProjects(
  db: DatabaseSync,
  input: WorkspaceManifestMutationInput,
  now: number,
): void {
  const read = db.prepare("SELECT path, name FROM projects WHERE path = ?");
  for (const projectPath of input.releasedProjectPaths) {
    // A savepoint keeps a failed restore from committing a half-written manifest (the row inserted
    // without its root rows) while leaving the membership change itself intact.
    db.exec("SAVEPOINT keiko_restore_released_root");
    try {
      const project = read.get(projectPath) as unknown as ProjectRow | undefined;
      if (project !== undefined) {
        ensureProjectWorkspaceManifest(db, project.path, project.name, now);
      }
      db.exec("RELEASE keiko_restore_released_root");
    } catch (error) {
      // The same per-row tolerance the D9 migration documents: a root whose directory no longer
      // exists cannot be re-inspected, and a root that is already gone from disk must stay
      // removable. That project then stays pre-manifest, which downstream code already fails closed
      // on (#2613). The failure is not swallowed — it is handed to the caller's sink, which turns
      // it into a redacted operator diagnostic carrying the reason, not just a count.
      db.exec("ROLLBACK TO keiko_restore_released_root");
      db.exec("RELEASE keiko_restore_released_root");
      input.onReleasedRestoreFailure?.(projectPath, error);
    }
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
    // `insertRootRows` already performed the fail-closed live inspection. Compare the identities
    // that transaction actually persisted instead of probing the filesystem a second time.
    const nextIdentities = rootIdentities(db, input.manifest.workspaceId);
    const removeTrust = db.prepare("DELETE FROM workspace_trust_records WHERE root_ref = ?");
    for (const rootRef of invalidatedRootRefs(previousIdentities, nextIdentities)) {
      removeTrust.run(rootRef);
    }
    // After the trust rows are gone, so a restored workspace can never carry a grant forward.
    restoreReleasedProjects(db, input, now);
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
  // Re-verify the singleton invariant HERE, inside the enclosing write lock,
  // rather than trusting the caller's pre-transaction guard alone. Between
  // the caller's rootCount check and BEGIN IMMEDIATE another connection can
  // add a root to the workspace; without this second check the cascade below
  // would then also delete siblings that never belonged to `projectPath`
  // (CR #3640066698 — legitimate TOCTOU window).
  const rootCount = db
    .prepare("SELECT COUNT(*) AS count FROM workspace_manifest_roots WHERE workspace_id = ?")
    .get(membership.workspace_id) as { readonly count?: number } | undefined;
  if ((rootCount?.count ?? 0) > 1) {
    throw new Error("WORKSPACE_NOT_SINGLETON");
  }
  db.prepare("DELETE FROM workspace_trust_records WHERE root_ref = ?").run(membership.root_ref);
  db.prepare("DELETE FROM workspace_manifests WHERE workspace_id = ?").run(membership.workspace_id);
}
