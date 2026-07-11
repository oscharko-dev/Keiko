ALTER TABLE feedback_receipts ADD COLUMN closed_at timestamptz;
UPDATE feedback_receipts SET closed_at = LEAST(expires_at, now()) WHERE closed;
ALTER TABLE feedback_receipts ADD CONSTRAINT feedback_receipt_closed_at_consistent CHECK (
  (closed AND closed_at IS NOT NULL) OR (NOT closed AND closed_at IS NULL)
);

ALTER TABLE feedback_deletion_ledger DROP CONSTRAINT feedback_deletion_ledger_class_code_check;
ALTER TABLE feedback_deletion_ledger ADD CONSTRAINT feedback_deletion_ledger_class_code_check CHECK (
  class_code IN (
    'receipt', 'payload', 'dedupe', 'abuse', 'group', 'review-audit',
    'review-idempotency', 'private-review-group', 'oidc-transaction', 'maintainer-session',
    'key-destruction-evidence'
  )
);

CREATE TABLE feedback_private_semantic_groups (
  semantic_group_id uuid PRIMARY KEY REFERENCES feedback_semantic_groups(id) ON DELETE CASCADE,
  restricted_at timestamptz NOT NULL
);

CREATE TABLE feedback_review_groups (
  semantic_group_id uuid PRIMARY KEY REFERENCES feedback_semantic_groups(id) ON DELETE CASCADE,
  opaque_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);

CREATE TABLE feedback_private_review_group_tombstones (
  review_group_id uuid PRIMARY KEY,
  restricted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = restricted_at + interval '365 days')
);

LOCK TABLE feedback_payloads IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO feedback_review_groups (semantic_group_id)
SELECT id FROM feedback_semantic_groups;

CREATE TABLE feedback_review_items (
  id uuid PRIMARY KEY,
  payload_id uuid NOT NULL UNIQUE REFERENCES feedback_payloads(id) ON DELETE CASCADE,
  semantic_group_id uuid NOT NULL REFERENCES feedback_semantic_groups(id) ON DELETE RESTRICT,
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN (
    'pending', 'approved', 'duplicate', 'rejected', 'archived', 'private-security', 'expired'
  )),
  rejection_reason text CHECK (rejection_reason IN (
    'insufficient-information', 'not-actionable', 'out-of-scope', 'policy-violation'
  )),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  approval_payload_digest char(64),
  approval_marker text,
  approval_projection_digest char(64),
  approval_target_key text,
  approval_label_policy_version text,
  approval_actor_issuer text,
  approval_actor_sub text,
  approval_permission_policy_version text,
  approval_record_version integer,
  CHECK ((state = 'rejected') = (rejection_reason IS NOT NULL)),
  CHECK (
    (state = 'approved' AND approval_payload_digest IS NOT NULL
      AND approval_payload_digest = payload_digest
      AND approval_payload_digest ~ '^[0-9a-f]{64}$'
      AND approval_marker IS NOT NULL AND length(approval_marker) BETWEEN 16 AND 200
      AND approval_projection_digest IS NOT NULL
      AND approval_projection_digest ~ '^[0-9a-f]{64}$'
      AND approval_target_key IS NOT NULL AND length(approval_target_key) BETWEEN 1 AND 100
      AND approval_label_policy_version IS NOT NULL
      AND length(approval_label_policy_version) BETWEEN 1 AND 64
      AND approval_actor_issuer IS NOT NULL AND approval_actor_sub IS NOT NULL
      AND length(approval_actor_issuer) BETWEEN 1 AND 2048
      AND length(approval_actor_sub) BETWEEN 1 AND 255
      AND approval_actor_issuer !~ '[[:cntrl:]]'
      AND approval_actor_sub !~ '[[:cntrl:]]'
      AND approval_permission_policy_version IS NOT NULL
      AND length(approval_permission_policy_version) BETWEEN 1 AND 64
      AND approval_permission_policy_version !~ '[[:cntrl:]]'
      AND approval_record_version IS NOT NULL
      AND approval_record_version = version)
    OR
    (state <> 'approved' AND approval_payload_digest IS NULL AND approval_marker IS NULL
      AND approval_projection_digest IS NULL AND approval_target_key IS NULL
      AND approval_label_policy_version IS NULL AND approval_actor_issuer IS NULL
      AND approval_actor_sub IS NULL AND approval_permission_policy_version IS NULL
      AND approval_record_version IS NULL)
  )
);

CREATE FUNCTION prevent_feedback_review_identity_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.payload_id <> OLD.payload_id
     OR NEW.semantic_group_id <> OLD.semantic_group_id
     OR NEW.payload_digest <> OLD.payload_digest OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'feedback review identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER feedback_review_identity_immutable
BEFORE UPDATE ON feedback_review_items
FOR EACH ROW EXECUTE FUNCTION prevent_feedback_review_identity_update();

CREATE TABLE feedback_manual_duplicate_links (
  source_item_id uuid PRIMARY KEY REFERENCES feedback_review_items(id) ON DELETE CASCADE,
  target_item_id uuid NOT NULL REFERENCES feedback_review_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  CHECK (source_item_id <> target_item_id)
);

CREATE FUNCTION validate_feedback_manual_duplicate_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM feedback_manual_duplicate_links WHERE source_item_id = NEW.target_item_id)
     OR EXISTS (SELECT 1 FROM feedback_manual_duplicate_links WHERE target_item_id = NEW.source_item_id)
     OR NOT EXISTS (
       SELECT 1 FROM feedback_review_items
       WHERE id = NEW.target_item_id AND state <> 'duplicate'
     ) THEN
    RAISE EXCEPTION 'invalid feedback manual duplicate link';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER feedback_manual_duplicate_link_valid
BEFORE INSERT OR UPDATE ON feedback_manual_duplicate_links
FOR EACH ROW EXECUTE FUNCTION validate_feedback_manual_duplicate_link();

CREATE TABLE feedback_legal_holds (
  item_id uuid PRIMARY KEY REFERENCES feedback_review_items(id) ON DELETE CASCADE,
  policy_key text NOT NULL CHECK (policy_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  placed_at timestamptz NOT NULL,
  review_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
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
  CHECK (review_at > placed_at AND expires_at > review_at)
);

CREATE FUNCTION validate_feedback_legal_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payload_expiry timestamptz;
BEGIN
  SELECT p.expires_at INTO payload_expiry
  FROM feedback_review_items i JOIN feedback_payloads p ON p.id = i.payload_id
  WHERE i.id = NEW.item_id FOR SHARE OF p;
  IF payload_expiry IS NULL OR payload_expiry <= transaction_timestamp() THEN
    RAISE EXCEPTION 'feedback legal hold payload is expired';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER feedback_legal_hold_unexpired
BEFORE INSERT ON feedback_legal_holds
FOR EACH ROW EXECUTE FUNCTION validate_feedback_legal_hold();

CREATE TABLE feedback_review_idempotency (
  idempotency_key text PRIMARY KEY CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  item_id uuid NOT NULL,
  review_group_id uuid NOT NULL,
  result_state text NOT NULL CHECK (result_state IN (
    'pending', 'approved', 'duplicate', 'rejected', 'archived', 'private-security', 'expired'
  )),
  result_version integer NOT NULL CHECK (result_version > 0),
  result_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = result_at + interval '365 days')
);

CREATE TABLE feedback_review_audit (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id uuid NOT NULL,
  review_group_id uuid NOT NULL,
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  prior_version integer NOT NULL CHECK (prior_version > 0),
  result_version integer NOT NULL CHECK (result_version >= prior_version),
  action text NOT NULL CHECK (action IN (
    'mark-duplicate', 'reject', 'archive', 'route-private-security', 'expire',
    'place-legal-hold', 'release-legal-hold', 'expire-legal-hold'
  )),
  prior_state text NOT NULL CHECK (prior_state IN (
    'pending', 'approved', 'duplicate', 'rejected', 'archived', 'private-security', 'expired'
  )),
  result_state text NOT NULL CHECK (result_state IN (
    'pending', 'approved', 'duplicate', 'rejected', 'archived', 'private-security', 'expired'
  )),
  result text NOT NULL CHECK (result = 'applied'),
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
  policy_key text CHECK (policy_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = event_at + interval '365 days'),
  CHECK ((action IN ('place-legal-hold', 'release-legal-hold', 'expire-legal-hold')) =
    (policy_key IS NOT NULL))
);

CREATE FUNCTION create_feedback_review_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO feedback_review_groups (semantic_group_id)
  VALUES (NEW.semantic_group_id) ON CONFLICT (semantic_group_id) DO NOTHING;
  INSERT INTO feedback_review_items (
    id, payload_id, semantic_group_id, payload_digest, state, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.id, NEW.semantic_group_id, NEW.exact_body_sha256,
    CASE WHEN EXISTS (
      SELECT 1 FROM feedback_private_semantic_groups
      WHERE semantic_group_id = NEW.semantic_group_id
    ) THEN 'private-security' ELSE 'pending' END,
    NEW.created_at, NEW.created_at
  );
  RETURN NEW;
END;
$$;

INSERT INTO feedback_review_items (
  id, payload_id, semantic_group_id, payload_digest, state, created_at, updated_at
)
SELECT id, id, semantic_group_id, exact_body_sha256, 'pending', created_at, created_at
FROM feedback_payloads;

CREATE TRIGGER feedback_payload_review_admission
AFTER INSERT ON feedback_payloads
FOR EACH ROW EXECUTE FUNCTION create_feedback_review_item();

CREATE INDEX feedback_review_state_idx ON feedback_review_items (state, updated_at, id);
CREATE INDEX feedback_review_group_idx ON feedback_review_items (semantic_group_id);
CREATE INDEX feedback_review_audit_expiry_idx ON feedback_review_audit (expires_at);
CREATE INDEX feedback_review_idempotency_expiry_idx ON feedback_review_idempotency (expires_at);
CREATE INDEX feedback_private_review_group_expiry_idx
ON feedback_private_review_group_tombstones (expires_at);
CREATE INDEX feedback_legal_hold_expiry_idx ON feedback_legal_holds (expires_at);

CREATE TABLE feedback_oidc_transactions (
  state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash) = 32),
  browser_hash bytea NOT NULL CHECK (octet_length(browser_hash) = 32),
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 32 AND 256),
  pkce_verifier text NOT NULL CHECK (length(pkce_verifier) BETWEEN 43 AND 128),
  redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 12 AND 2048),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes')
);

CREATE TABLE feedback_maintainer_sessions (
  capability_hash bytea PRIMARY KEY CHECK (octet_length(capability_hash) = 32),
  csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048 AND issuer !~ '[[:cntrl:]]'),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255 AND subject !~ '[[:cntrl:]]'),
  permissions text[] NOT NULL CHECK (
    cardinality(permissions) BETWEEN 1 AND 5 AND permissions <@ ARRAY[
      'feedback.review', 'feedback.security', 'feedback.legal-hold',
      'feedback.publish', 'feedback.audit'
    ]::text[]
  ),
  permission_policy_version text NOT NULL CHECK (
    length(permission_policy_version) BETWEEN 1 AND 64
    AND permission_policy_version !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (last_seen_at >= created_at),
  CHECK (idle_expires_at > last_seen_at AND absolute_expires_at > created_at),
  CHECK (absolute_expires_at <= created_at + interval '15 minutes'),
  CHECK (idle_expires_at <= absolute_expires_at)
);

CREATE INDEX feedback_oidc_transaction_expiry_idx ON feedback_oidc_transactions (expires_at);
CREATE INDEX feedback_maintainer_session_expiry_idx ON feedback_maintainer_sessions (
  absolute_expires_at, idle_expires_at
);

INSERT INTO feedback_schema_migrations (version, applied_at) VALUES (2, now());
