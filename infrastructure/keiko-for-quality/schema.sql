CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tracked_pulls (
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  last_head_sha TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  last_evaluated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, repository, pull_number)
) WITHOUT ROWID;

-- Reconcile metadata (Issue #2507): last_head_sha, settled, and last_evaluated_at let the scheduled
-- sweep skip re-evaluating a settled pull request whose exact head is unchanged, re-evaluating only
-- the pull requests that can still move plus a liveness backstop. A database created before these
-- columns existed must add them once (ADD COLUMN fails if the column is already present, so run these
-- only against a pre-existing deployment, not a fresh one from the CREATE above):
--   ALTER TABLE tracked_pulls ADD COLUMN last_head_sha TEXT;
--   ALTER TABLE tracked_pulls ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE tracked_pulls ADD COLUMN last_evaluated_at INTEGER NOT NULL DEFAULT 0;
