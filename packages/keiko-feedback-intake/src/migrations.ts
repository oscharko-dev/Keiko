import type { PgPoolLike } from "./postgres-types.js";

export interface FeedbackMigration {
  readonly version: number;
  readonly source: string;
}

function assertKnownMigrations(migrations: readonly FeedbackMigration[]): void {
  if (
    migrations.length === 0 ||
    migrations.some((migration, index) => migration.version !== index + 1)
  ) {
    throw new Error("Feedback migrations must be ordered and contiguous from version 1");
  }
}

function assertAppliedVersions(versions: readonly number[], latest: number): number {
  for (const [index, version] of versions.entries()) {
    if (version !== index + 1 || version > latest) {
      throw new Error("Unsupported or non-contiguous feedback schema version");
    }
  }
  return versions.at(-1) ?? 0;
}

export async function applyFeedbackMigrations(
  pool: PgPoolLike,
  migrations: readonly FeedbackMigration[],
): Promise<void> {
  assertKnownMigrations(migrations);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [2_074_001]);
    const exists = await client.query<{ readonly name: string | null }>(
      "SELECT to_regclass('feedback_schema_migrations')::text AS name",
    );
    const versions =
      exists.rows[0]?.name === null
        ? []
        : (
            await client.query<{ readonly version: number }>(
              "SELECT version FROM feedback_schema_migrations ORDER BY version",
            )
          ).rows.map((row) => row.version);
    const current = assertAppliedVersions(versions, migrations.length);
    for (const migration of migrations.slice(current)) await client.query(migration.source);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
