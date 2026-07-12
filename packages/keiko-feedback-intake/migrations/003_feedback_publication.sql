ALTER TABLE feedback_deletion_ledger DROP CONSTRAINT feedback_deletion_ledger_class_code_check;
ALTER TABLE feedback_deletion_ledger ADD CONSTRAINT feedback_deletion_ledger_class_code_check CHECK (
  class_code IN (
    'receipt', 'payload', 'dedupe', 'abuse', 'group', 'review-audit',
    'review-idempotency', 'private-review-group', 'oidc-transaction', 'maintainer-session',
    'key-destruction-evidence', 'publication-preparation', 'publication-outbox',
    'publication-audit', 'publication-idempotency', 'github-issue-linkage'
  )
);

CREATE FUNCTION valid_feedback_publication_labels(labels text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE label text;
BEGIN
  IF labels IS NULL OR cardinality(labels) NOT BETWEEN 0 AND 20
     OR array_position(labels, NULL) IS NOT NULL THEN
    RETURN false;
  END IF;
  FOREACH label IN ARRAY labels LOOP
    IF octet_length(label) NOT BETWEEN 1 AND 50 OR label ~ '[[:cntrl:]]' THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN cardinality(labels) = cardinality(ARRAY(SELECT DISTINCT value FROM unnest(labels) value));
END;
$$;

CREATE TABLE feedback_publication_preparations (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES feedback_review_items(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  source_record_version integer NOT NULL CHECK (source_record_version > 0),
  projection_version text NOT NULL CHECK (projection_version = 'github-issue-v1'),
  title_bytes bytea NOT NULL CHECK (octet_length(title_bytes) BETWEEN 1 AND 256),
  body_bytes bytea NOT NULL CHECK (octet_length(body_bytes) BETWEEN 1 AND 65536),
  projection_digest char(64) NOT NULL CHECK (projection_digest ~ '^[0-9a-f]{64}$'),
  reconciliation_marker text NOT NULL UNIQUE CHECK (
    reconciliation_marker ~ '^<!-- keiko-feedback-reconciliation-v1:[A-Za-z0-9_-]{43} -->$'
  ),
  target_api_origin text NOT NULL CHECK (target_api_origin = 'https://api.github.com'),
  target_repository_id bigint NOT NULL CHECK (target_repository_id > 0),
  target_owner text NOT NULL CHECK (
    length(target_owner) BETWEEN 1 AND 39 AND target_owner ~ '^[A-Za-z0-9-]+$'
  ),
  target_repository text NOT NULL CHECK (
    length(target_repository) BETWEEN 1 AND 100 AND target_repository ~ '^[A-Za-z0-9_.-]+$'
  ),
  target_installation_id bigint NOT NULL CHECK (target_installation_id > 0),
  target_labels text[] NOT NULL CHECK (valid_feedback_publication_labels(target_labels)),
  target_key text NOT NULL CHECK (
    target_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
  ),
  label_policy_version text NOT NULL CHECK (
    label_policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  target_policy_version text NOT NULL CHECK (
    length(target_policy_version) BETWEEN 1 AND 128 AND target_policy_version !~ '[[:cntrl:]]'
  ),
  target_policy_digest char(64) NOT NULL CHECK (target_policy_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('prepared', 'approved', 'cancelled-private')),
  created_at timestamptz NOT NULL,
  approved_at timestamptz,
  cancelled_at timestamptz,
  expires_at timestamptz NOT NULL,
  UNIQUE (item_id, payload_digest, source_record_version, target_policy_digest),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK (
    (status = 'prepared' AND approved_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'approved' AND approved_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled-private' AND cancelled_at IS NOT NULL)
  )
);

CREATE FUNCTION prevent_feedback_publication_preparation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.item_id <> OLD.item_id
     OR NEW.payload_digest <> OLD.payload_digest
     OR NEW.source_record_version <> OLD.source_record_version
     OR NEW.projection_version <> OLD.projection_version
     OR NEW.title_bytes <> OLD.title_bytes OR NEW.body_bytes <> OLD.body_bytes
     OR NEW.projection_digest <> OLD.projection_digest
     OR NEW.reconciliation_marker <> OLD.reconciliation_marker
     OR NEW.target_api_origin <> OLD.target_api_origin
     OR NEW.target_repository_id <> OLD.target_repository_id
     OR NEW.target_owner <> OLD.target_owner OR NEW.target_repository <> OLD.target_repository
     OR NEW.target_installation_id <> OLD.target_installation_id
     OR NEW.target_labels <> OLD.target_labels OR NEW.target_key <> OLD.target_key
     OR NEW.label_policy_version <> OLD.label_policy_version
     OR NEW.target_policy_version <> OLD.target_policy_version
     OR NEW.target_policy_digest <> OLD.target_policy_digest OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'feedback publication preparation is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER feedback_publication_preparation_immutable
BEFORE UPDATE ON feedback_publication_preparations
FOR EACH ROW EXECUTE FUNCTION prevent_feedback_publication_preparation_update();

ALTER TABLE feedback_review_items
  ADD COLUMN approval_preparation_id uuid REFERENCES feedback_publication_preparations(id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN approval_target_policy_digest char(64),
  ADD CONSTRAINT feedback_review_publication_binding CHECK (
    (state = 'approved' AND approval_preparation_id IS NOT NULL
      AND approval_target_policy_digest ~ '^[0-9a-f]{64}$')
    OR (state <> 'approved' AND approval_preparation_id IS NULL
      AND approval_target_policy_digest IS NULL)
  ),
  ADD CONSTRAINT feedback_review_approval_target_key_format CHECK (
    approval_target_key IS NULL
    OR approval_target_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
  ),
  ADD CONSTRAINT feedback_review_approval_label_policy_format CHECK (
    approval_label_policy_version IS NULL
    OR approval_label_policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  );

CREATE TABLE feedback_publication_outbox (
  id uuid PRIMARY KEY,
  preparation_id uuid NOT NULL UNIQUE
    REFERENCES feedback_publication_preparations(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  status text NOT NULL CHECK (status IN (
    'unclaimed', 'claimed', 'may-have-committed', 'retryable-failure',
    'manual-reconciliation', 'succeeded', 'cancelled-private'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 10),
  lease_owner text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  failure_code text CHECK (failure_code IN (
    'permission-denied', 'validation-error', 'rate-limited', 'repository-unavailable',
    'duplicate-candidate', 'target-policy-drift', 'projection-drift', 'payload-private',
    'payload-expired', 'cas-mismatch', 'idempotency-mismatch',
    'manual-reconciliation-required', 'manual-remediation-required'
  )),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CHECK ((status = 'claimed') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (lease_owner IS NULL OR lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  CHECK (
    status <> 'claimed'
    OR (lease_expires_at > updated_at AND lease_expires_at <= updated_at + interval '5 minutes')
  ),
  CHECK (lease_expires_at IS NULL OR lease_expires_at <= expires_at),
  CHECK (status = 'retryable-failure' OR next_attempt_at IS NULL),
  CHECK (status NOT IN ('manual-reconciliation') OR failure_code = 'manual-reconciliation-required')
);

CREATE TABLE feedback_github_issue_linkage (
  item_id uuid PRIMARY KEY,
  preparation_id uuid NOT NULL UNIQUE,
  target_policy_digest char(64) NOT NULL CHECK (target_policy_digest ~ '^[0-9a-f]{64}$'),
  github_repository_id bigint NOT NULL CHECK (github_repository_id > 0),
  github_issue_node_id text NOT NULL UNIQUE CHECK (
    length(github_issue_node_id) BETWEEN 1 AND 255 AND github_issue_node_id !~ '[[:cntrl:]]'
  ),
  github_issue_number integer NOT NULL CHECK (github_issue_number > 0),
  linked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > linked_at AND expires_at <= linked_at + interval '365 days')
);

CREATE FUNCTION validate_feedback_review_publication_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'approved' AND NOT EXISTS (
    SELECT 1 FROM feedback_publication_preparations prep
    WHERE prep.id = NEW.approval_preparation_id
      AND prep.item_id = NEW.id
      AND prep.payload_digest = NEW.payload_digest
      AND prep.projection_digest = NEW.approval_projection_digest
      AND prep.reconciliation_marker = NEW.approval_marker
      AND prep.target_key = NEW.approval_target_key
      AND prep.label_policy_version = NEW.approval_label_policy_version
      AND prep.target_policy_digest = NEW.approval_target_policy_digest
      AND prep.status = 'approved'
      AND prep.source_record_version + 1 = NEW.approval_record_version
      AND NEW.approval_record_version = NEW.version
  ) THEN
    RAISE EXCEPTION 'invalid feedback review publication binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER feedback_review_publication_binding_valid
AFTER INSERT OR UPDATE ON feedback_review_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_feedback_review_publication_binding();

CREATE FUNCTION validate_feedback_preparation_review_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE preparation_id uuid := COALESCE(NEW.id, OLD.id);
BEGIN
  IF EXISTS (
    SELECT 1 FROM feedback_review_items item
    WHERE item.approval_preparation_id = preparation_id AND item.state = 'approved'
  ) AND NOT EXISTS (
    SELECT 1 FROM feedback_review_items item
    JOIN feedback_publication_preparations prep ON prep.id = item.approval_preparation_id
    WHERE prep.id = preparation_id
      AND prep.item_id = item.id
      AND prep.payload_digest = item.payload_digest
      AND prep.projection_digest = item.approval_projection_digest
      AND prep.target_policy_digest = item.approval_target_policy_digest
      AND prep.status = 'approved'
      AND prep.source_record_version + 1 = item.approval_record_version
  ) THEN
    RAISE EXCEPTION 'invalid feedback preparation review binding';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE CONSTRAINT TRIGGER feedback_preparation_review_binding_valid
AFTER UPDATE OR DELETE ON feedback_publication_preparations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_feedback_preparation_review_binding();

CREATE FUNCTION validate_feedback_github_issue_linkage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM feedback_publication_preparations prep
    WHERE prep.id = NEW.preparation_id
      AND prep.item_id = NEW.item_id
      AND prep.target_policy_digest = NEW.target_policy_digest
      AND prep.target_repository_id = NEW.github_repository_id
  ) THEN
    RAISE EXCEPTION 'invalid feedback github issue linkage';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER feedback_github_issue_linkage_valid
AFTER INSERT OR UPDATE ON feedback_github_issue_linkage
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_feedback_github_issue_linkage();

CREATE TABLE feedback_publication_idempotency (
  idempotency_key text PRIMARY KEY CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN (
    'prepare-publication', 'approve-publication', 'cancel-publication-route-private'
  )),
  item_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  outbox_id uuid,
  result_status text NOT NULL CHECK (result_status IN (
    'prepared', 'approved', 'cancelled-private', 'manual-reconciliation', 'manual-remediation'
  )),
  result_version integer NOT NULL CHECK (result_version > 0),
  result_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = result_at + interval '365 days'),
  CHECK ((action = 'approve-publication') = (outbox_id IS NOT NULL))
);

CREATE TABLE feedback_publication_audit (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  projection_digest char(64) NOT NULL CHECK (projection_digest ~ '^[0-9a-f]{64}$'),
  target_policy_digest char(64) NOT NULL CHECK (target_policy_digest ~ '^[0-9a-f]{64}$'),
  prior_version integer NOT NULL CHECK (prior_version > 0),
  result_version integer NOT NULL CHECK (result_version >= prior_version),
  action text NOT NULL CHECK (action IN (
    'prepare-publication', 'approve-publication', 'cancel-publication-route-private'
  )),
  result_status text NOT NULL CHECK (result_status IN (
    'prepared', 'approved', 'cancelled-private', 'manual-reconciliation', 'manual-remediation'
  )),
  event_at timestamptz NOT NULL,
  actor_issuer text NOT NULL CHECK (
    length(actor_issuer) BETWEEN 1 AND 2048 AND actor_issuer !~ '[[:cntrl:]]'
  ),
  actor_sub text NOT NULL CHECK (
    length(actor_sub) BETWEEN 1 AND 255 AND actor_sub !~ '[[:cntrl:]]'
  ),
  permission_policy_version text NOT NULL CHECK (
    length(permission_policy_version) BETWEEN 1 AND 64
    AND permission_policy_version !~ '[[:cntrl:]]'
  ),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = event_at + interval '365 days')
);

CREATE INDEX feedback_publication_preparation_expiry_idx
ON feedback_publication_preparations (expires_at, id);
CREATE INDEX feedback_publication_outbox_dispatch_idx
ON feedback_publication_outbox (status, next_attempt_at, lease_expires_at);
CREATE INDEX feedback_publication_outbox_expiry_idx
ON feedback_publication_outbox (expires_at, id);
CREATE INDEX feedback_github_issue_linkage_expiry_idx
ON feedback_github_issue_linkage (expires_at, item_id);
CREATE INDEX feedback_publication_idempotency_expiry_idx
ON feedback_publication_idempotency (expires_at, idempotency_key);
CREATE INDEX feedback_publication_audit_expiry_idx
ON feedback_publication_audit (expires_at, event_id);
CREATE INDEX feedback_receipts_payload_idx ON feedback_receipts (payload_id);
CREATE INDEX feedback_review_items_approval_preparation_idx
ON feedback_review_items (approval_preparation_id);

INSERT INTO feedback_schema_migrations (version, applied_at) VALUES (3, now());
