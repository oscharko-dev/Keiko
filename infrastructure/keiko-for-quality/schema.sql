CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tracked_pulls (
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  PRIMARY KEY (owner, repository, pull_number)
) WITHOUT ROWID;
