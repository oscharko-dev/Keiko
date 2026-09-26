import type { DatabaseSync } from "node:sqlite";

import type { GitHubIssueReaderAuthorizationRecord } from "./types.js";

// The repository identity the task workspace already derives (`deriveRepositoryId`): a fixed prefix
// plus a truncated sha256 of the repository root. Bounding it here keeps an unbounded or
// path-shaped value out of the database even if a caller above ever stops deriving it.
const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function isStorableRepositoryId(value: string): boolean {
  return REPOSITORY_ID.test(value);
}

function authorizationRecord(row: unknown): GitHubIssueReaderAuthorizationRecord | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const candidate = row as Record<string, unknown>;
  const authorized = candidate.authorized;
  const revision = candidate.revision;
  if (
    typeof candidate.repository_id !== "string" ||
    (authorized !== 0 && authorized !== 1) ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 0
  ) {
    return undefined;
  }
  return {
    repositoryId: candidate.repository_id,
    authorized: authorized === 1,
    revision: Number(revision),
  };
}

export function readGitHubIssueReaderAuthorization(
  db: DatabaseSync,
  repositoryId: string,
): GitHubIssueReaderAuthorizationRecord | undefined {
  if (!isStorableRepositoryId(repositoryId)) return undefined;
  const row = db
    .prepare(
      "SELECT repository_id, authorized, revision FROM github_issue_reader_authorization WHERE repository_id = ?",
    )
    .get(repositoryId);
  return authorizationRecord(row);
}

/**
 * Conditional write against the caller's observed revision.
 *
 * Revoking is always admitted, whatever revision the caller last saw. Only GRANTING requires the
 * caller to have seen the current state, so a stale client cannot re-authorize a repository whose
 * authorization someone else has just withdrawn, while a stale revoke — which can only ever narrow
 * access — is never rejected on staleness grounds. This is the same asymmetry
 * `updateMemoryAutonomyPolicy` applies to a strictly safer downgrade.
 */
export function updateGitHubIssueReaderAuthorization(
  db: DatabaseSync,
  repositoryId: string,
  authorized: boolean,
  expectedRevision: number,
  updatedAt: string,
): GitHubIssueReaderAuthorizationRecord | undefined {
  if (!isStorableRepositoryId(repositoryId)) return undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = readGitHubIssueReaderAuthorization(db, repositoryId);
    const currentRevision = current?.revision ?? 0;
    const stale = expectedRevision !== currentRevision;
    if (stale && authorized) {
      db.exec("COMMIT");
      return undefined;
    }
    const revision = currentRevision + 1;
    db.prepare(
      `INSERT INTO github_issue_reader_authorization (repository_id, authorized, revision, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repository_id) DO UPDATE SET authorized = excluded.authorized,
         revision = excluded.revision, updated_at = excluded.updated_at`,
    ).run(repositoryId, authorized ? 1 : 0, revision, updatedAt);
    db.exec("COMMIT");
    return { repositoryId, authorized, revision };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
