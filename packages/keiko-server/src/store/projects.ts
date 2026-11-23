// ADR-0013 — projects CRUD. All SQL is module-scope constants; no string-interpolation into SQL.

import type { DatabaseSync } from "node:sqlite";
import type { Project, UpdateProjectPatch } from "./types.js";
import { notFound, UiStoreError } from "./errors.js";
import { numberColumn, textColumn, type UiStoreSqlRow } from "./sql-row.js";

function rowToProject(row: UiStoreSqlRow): Project {
  return {
    path: textColumn(row, "path"),
    name: textColumn(row, "name"),
    favorite: numberColumn(row, "favorite") !== 0,
    createdAt: numberColumn(row, "created_at"),
    lastOpenedAt: numberColumn(row, "last_opened_at"),
  };
}

const SQL_LIST =
  "SELECT path, name, favorite, created_at, last_opened_at FROM projects ORDER BY path";
const SQL_GET =
  "SELECT path, name, favorite, created_at, last_opened_at FROM projects WHERE path = ?";
// UPSERT: if path already exists, bump last_opened_at; createdAt is preserved by ON CONFLICT DO UPDATE.
// A re-add with an explicit name repairs the display name; implicit basename derivation never
// overwrites a user-chosen existing name.
const SQL_UPSERT = `
INSERT INTO projects (path, name, favorite, created_at, last_opened_at)
VALUES (?, ?, 0, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  name = CASE WHEN ? THEN excluded.name ELSE name END,
  last_opened_at = excluded.last_opened_at
RETURNING path, name, favorite, created_at, last_opened_at
`;
const SQL_UPDATE = `
UPDATE projects
SET name = COALESCE(?, name),
    favorite = COALESCE(?, favorite),
    last_opened_at = ?
WHERE path = ?
RETURNING path, name, favorite, created_at, last_opened_at
`;
const SQL_DELETE = "DELETE FROM projects WHERE path = ?";

export function listProjects(db: DatabaseSync): readonly Project[] {
  return db.prepare(SQL_LIST).all().map(rowToProject);
}

export function getProject(db: DatabaseSync, path: string): Project | undefined {
  const row = db.prepare(SQL_GET).get(path);
  return row === undefined ? undefined : rowToProject(row);
}

export function upsertProject(
  db: DatabaseSync,
  normalizedPath: string,
  name: string,
  hasExplicitName: boolean,
  now: number,
): Project {
  const row = db.prepare(SQL_UPSERT).get(normalizedPath, name, now, now, hasExplicitName ? 1 : 0);
  if (row === undefined) throw new UiStoreError("INTERNAL", "Stored project is unavailable.", 500);
  return rowToProject(row);
}

function resolveFavoriteParam(favorite: boolean | undefined): number | null {
  if (favorite === undefined) {
    return null;
  }
  return favorite ? 1 : 0;
}

export function updateProject(
  db: DatabaseSync,
  path: string,
  patch: UpdateProjectPatch,
  now: number,
): Project {
  const nameParam = patch.name ?? null;
  const favoriteParam = resolveFavoriteParam(patch.favorite);
  const row = db.prepare(SQL_UPDATE).get(nameParam, favoriteParam, now, path);
  if (row === undefined) throw notFound("Project");
  return rowToProject(row);
}

export function deleteProject(db: DatabaseSync, path: string): void {
  const info = db.prepare(SQL_DELETE).run(path);
  if (info.changes === 0) throw notFound("Project");
}
