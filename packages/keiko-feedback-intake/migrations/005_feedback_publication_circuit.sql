CREATE TABLE feedback_publication_installation_circuits (
  installation_id bigint PRIMARY KEY CHECK (installation_id > 0),
  consecutive_failures integer NOT NULL CHECK (consecutive_failures BETWEEN 0 AND 3),
  open_until timestamptz,
  probe_owner uuid,
  probe_expires_at timestamptz,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = updated_at + interval '7 days'),
  CHECK ((probe_owner IS NULL) = (probe_expires_at IS NULL)),
  CHECK (probe_expires_at IS NULL OR probe_expires_at > updated_at),
  CHECK (open_until IS NULL OR open_until > updated_at),
  CHECK (consecutive_failures = 3 OR open_until IS NULL),
  CHECK (consecutive_failures = 3 OR probe_owner IS NULL)
);

CREATE INDEX feedback_publication_installation_circuits_expiry_idx
ON feedback_publication_installation_circuits (expires_at, installation_id);

ALTER TABLE feedback_publication_outbox
  ADD COLUMN reconciled_exact boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT feedback_publication_outbox_reconciled_exact_check CHECK (
    NOT reconciled_exact OR (status = 'succeeded' AND create_eligible = false)
  );

CREATE OR REPLACE FUNCTION validate_feedback_publication_outbox_arm_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('may-have-committed', 'succeeded') AND NOT NEW.reconciled_exact AND (
    NEW.create_eligible
    OR NEW.create_attempt_count = 0
    OR NOT EXISTS (
      SELECT 1 FROM feedback_publication_preparations prep
      WHERE prep.id = NEW.preparation_id AND prep.create_armed_at IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'invalid feedback publication armed outbox state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_feedback_github_issue_linkage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM feedback_publication_preparations prep
    JOIN feedback_publication_outbox outbox ON outbox.preparation_id = prep.id
    WHERE prep.id = NEW.preparation_id
      AND prep.item_id = NEW.item_id
      AND prep.target_policy_digest = NEW.target_policy_digest
      AND prep.target_repository_id = NEW.github_repository_id
      AND outbox.status = 'succeeded'
      AND outbox.create_eligible = false
      AND (prep.create_armed_at IS NOT NULL OR outbox.reconciled_exact)
  ) THEN
    RAISE EXCEPTION 'invalid feedback github issue linkage';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE feedback_deletion_ledger DROP CONSTRAINT feedback_deletion_ledger_class_code_check;
ALTER TABLE feedback_deletion_ledger ADD CONSTRAINT feedback_deletion_ledger_class_code_check CHECK (
  class_code IN (
    'receipt', 'payload', 'dedupe', 'abuse', 'group', 'review-audit',
    'review-idempotency', 'private-review-group', 'oidc-transaction', 'maintainer-session',
    'key-destruction-evidence', 'publication-preparation', 'publication-outbox',
    'publication-audit', 'publication-delivery-audit', 'publication-idempotency',
    'publication-installation-circuit', 'github-issue-linkage'
  )
);

INSERT INTO feedback_schema_migrations (version, applied_at) VALUES (5, now());
