CREATE TABLE feedback_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL
);

CREATE TABLE feedback_semantic_groups (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL
);

CREATE TABLE feedback_dedupe_entries (
  dedupe_key_id text NOT NULL,
  dedupe_hmac bytea NOT NULL,
  semantic_group_id uuid NOT NULL REFERENCES feedback_semantic_groups(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  bounded_count bigint NOT NULL DEFAULT 1 CHECK (bounded_count > 0),
  PRIMARY KEY (dedupe_key_id, dedupe_hmac),
  CHECK (expires_at > created_at)
);

CREATE TABLE feedback_payloads (
  id uuid PRIMARY KEY,
  semantic_group_id uuid NOT NULL REFERENCES feedback_semantic_groups(id) ON DELETE RESTRICT,
  exact_body_sha256 char(64) NOT NULL CHECK (exact_body_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_bytes bytea NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  lifecycle_marker smallint NOT NULL DEFAULT 0 CHECK (lifecycle_marker = 0),
  CHECK (octet_length(canonical_bytes) > 0),
  CHECK (expires_at > created_at)
);

CREATE FUNCTION prevent_feedback_payload_content_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.semantic_group_id <> OLD.semantic_group_id
     OR NEW.exact_body_sha256 <> OLD.exact_body_sha256
     OR NEW.canonical_bytes <> OLD.canonical_bytes
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'feedback payload content is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER feedback_payload_content_immutable
BEFORE UPDATE ON feedback_payloads
FOR EACH ROW EXECUTE FUNCTION prevent_feedback_payload_content_update();

CREATE TABLE feedback_receipts (
  id varchar(22) PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{22}$'),
  payload_id uuid NOT NULL REFERENCES feedback_payloads(id) ON DELETE RESTRICT,
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  closed boolean NOT NULL DEFAULT false,
  CHECK (expires_at > created_at)
);

CREATE TABLE feedback_abuse_buckets (
  bucket_start timestamptz NOT NULL,
  key_id text NOT NULL,
  identity_hmac bytea NOT NULL CHECK (octet_length(identity_hmac) = 32),
  request_count integer NOT NULL CHECK (request_count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (bucket_start, key_id, identity_hmac),
  CHECK (expires_at = bucket_start + interval '48 hours')
);

CREATE TABLE feedback_global_buckets (
  bucket_start timestamptz PRIMARY KEY,
  request_count integer NOT NULL CHECK (request_count > 0),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = bucket_start + interval '48 hours')
);

CREATE TABLE feedback_deletion_ledger (
  class_code text PRIMARY KEY CHECK (class_code IN ('receipt', 'payload', 'dedupe', 'abuse', 'group', 'key-destruction-evidence')),
  cutoff timestamptz NOT NULL,
  deleted_count integer NOT NULL CHECK (deleted_count >= 0),
  completed_at timestamptz NOT NULL
);

CREATE TABLE feedback_key_deletion_evidence (
  key_class text NOT NULL CHECK (key_class IN ('abuse', 'dedupe')),
  key_id text NOT NULL CHECK (
    (key_class = 'abuse' AND key_id ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    OR (key_class = 'dedupe' AND key_id ~ '^dedupe-v1:[0-9]{4}-[0-9]{2}-[0-9]{2}$')
  ),
  event_at timestamptz NOT NULL,
  result text NOT NULL CHECK (result IN ('pending', 'destroyed')),
  PRIMARY KEY (key_class, key_id)
);

CREATE INDEX feedback_payload_expiry_idx ON feedback_payloads (expires_at);
CREATE INDEX feedback_receipt_expiry_idx ON feedback_receipts (expires_at);
CREATE INDEX feedback_dedupe_expiry_idx ON feedback_dedupe_entries (expires_at);
CREATE INDEX feedback_abuse_expiry_idx ON feedback_abuse_buckets (expires_at);

INSERT INTO feedback_schema_migrations (version, applied_at) VALUES (1, now());
