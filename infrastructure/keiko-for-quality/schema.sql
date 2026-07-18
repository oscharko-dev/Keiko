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
-- the pull requests that can still move plus a liveness backstop. The worker self-heals a database
-- created before these columns existed — on a missing-column error it adds any absent column and
-- retries the operation — so deploying the new gate logic does not have to be ordered after this
-- migration. The statements below are the same migration for operators who prefer to apply it
-- explicitly first (ADD COLUMN fails if the column already exists, so run them only against a
-- pre-existing deployment, not a fresh one from the CREATE above):
--   ALTER TABLE tracked_pulls ADD COLUMN last_head_sha TEXT;
--   ALTER TABLE tracked_pulls ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE tracked_pulls ADD COLUMN last_evaluated_at INTEGER NOT NULL DEFAULT 0;
