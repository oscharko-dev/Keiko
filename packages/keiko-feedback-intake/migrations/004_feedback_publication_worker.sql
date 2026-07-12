ALTER TABLE feedback_publication_outbox
  DROP CONSTRAINT feedback_publication_outbox_status_check,
  DROP CONSTRAINT feedback_publication_outbox_attempt_count_check,
  DROP CONSTRAINT feedback_publication_outbox_check1,
  DROP CONSTRAINT feedback_publication_outbox_check2,
  DROP CONSTRAINT feedback_publication_outbox_check3,
  DROP CONSTRAINT feedback_publication_outbox_check4,
  DROP CONSTRAINT feedback_publication_outbox_check5,
  DROP CONSTRAINT feedback_publication_outbox_failure_code_check;

ALTER TABLE feedback_publication_outbox
  ADD COLUMN create_eligible boolean NOT NULL DEFAULT true,
  ADD COLUMN create_attempt_count integer NOT NULL DEFAULT 0;

UPDATE feedback_publication_outbox
SET status = CASE WHEN status = 'claimed' THEN 'may-have-committed' ELSE status END,
    create_eligible = false,
    create_attempt_count = CASE
      WHEN status IN ('claimed', 'may-have-committed', 'manual-reconciliation', 'succeeded')
        THEN GREATEST(create_attempt_count, 1)
      ELSE create_attempt_count
    END,
    lease_owner = CASE WHEN status = 'claimed' THEN NULL ELSE lease_owner END,
    lease_expires_at = CASE WHEN status = 'claimed' THEN NULL ELSE lease_expires_at END,
    next_attempt_at = CASE WHEN status = 'claimed' THEN NULL ELSE next_attempt_at END,
    failure_code = CASE
      WHEN status = 'claimed' THEN 'ambiguous-reconciliation'
      ELSE failure_code
    END
WHERE status IN (
  'claimed', 'may-have-committed', 'manual-reconciliation', 'succeeded', 'cancelled-private'
);

ALTER TABLE feedback_publication_outbox
  ADD CONSTRAINT feedback_publication_outbox_status_check CHECK (status IN (
    'unclaimed', 'claimed', 'may-have-committed', 'retryable-failure',
    'manual-reconciliation', 'succeeded', 'cancelled-private'
  )),
  ADD CONSTRAINT feedback_publication_outbox_attempt_count_check
    CHECK (attempt_count >= 0 AND attempt_count <= 10),
  ADD CONSTRAINT feedback_publication_outbox_create_attempt_count_check
    CHECK (create_attempt_count BETWEEN 0 AND 3),
  ADD CONSTRAINT feedback_publication_outbox_lease_shape_check CHECK (
    (status = 'claimed' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status = 'may-have-committed'
      AND ((lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)))
    OR (status NOT IN ('claimed', 'may-have-committed')
      AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  ADD CONSTRAINT feedback_publication_outbox_lease_window_check CHECK (
    lease_expires_at IS NULL
    OR (lease_expires_at > updated_at
      AND lease_expires_at <= updated_at + interval '5 minutes'
      AND lease_expires_at <= expires_at)
  ),
  ADD CONSTRAINT feedback_publication_outbox_next_attempt_check CHECK (
    status IN ('retryable-failure', 'may-have-committed') OR next_attempt_at IS NULL
  ),
  ADD CONSTRAINT feedback_publication_outbox_create_eligibility_check CHECK (
    (create_eligible AND status IN ('unclaimed', 'claimed', 'retryable-failure'))
    OR (NOT create_eligible AND status IN (
      'may-have-committed', 'manual-reconciliation', 'succeeded', 'cancelled-private'
    ))
  ),
  ADD CONSTRAINT feedback_publication_outbox_failure_code_check CHECK (failure_code IN (
    'permission-denied', 'validation-error', 'rate-limited', 'repository-unavailable',
    'provider-unavailable', 'duplicate-candidate', 'target-policy-drift',
    'projection-drift', 'payload-private', 'payload-expired', 'cas-mismatch',
    'idempotency-mismatch', 'retry-exhausted', 'lease-expired',
    'ambiguous-reconciliation', 'manual-reconciliation-required',
    'manual-remediation-required'
  )),
  ADD CONSTRAINT feedback_publication_outbox_manual_failure_check CHECK (
    status <> 'manual-reconciliation'
    OR failure_code IN (
      'manual-reconciliation-required', 'retry-exhausted', 'lease-expired',
      'ambiguous-reconciliation', 'permission-denied', 'validation-error',
      'repository-unavailable', 'target-policy-drift', 'projection-drift',
      'payload-private', 'payload-expired', 'duplicate-candidate'
    )
  );

ALTER TABLE feedback_publication_preparations
  ADD COLUMN create_armed_at timestamptz,
  ADD CONSTRAINT feedback_publication_preparation_create_armed_at_check CHECK (
    create_armed_at IS NULL OR (create_armed_at >= created_at AND create_armed_at < expires_at)
  );

UPDATE feedback_publication_preparations prep
SET create_armed_at = LEAST(
  GREATEST(outbox.updated_at, prep.created_at),
  prep.expires_at - interval '1 microsecond'
)
FROM feedback_publication_outbox outbox
WHERE outbox.preparation_id = prep.id
  AND outbox.status IN ('may-have-committed', 'manual-reconciliation', 'succeeded');

CREATE FUNCTION prevent_feedback_publication_arm_evidence_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.create_armed_at IS NOT NULL
     AND NEW.create_armed_at IS DISTINCT FROM OLD.create_armed_at THEN
    RAISE EXCEPTION 'feedback publication arm evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER feedback_publication_arm_evidence_immutable
BEFORE UPDATE OF create_armed_at ON feedback_publication_preparations
FOR EACH ROW EXECUTE FUNCTION prevent_feedback_publication_arm_evidence_change();

CREATE FUNCTION validate_feedback_publication_arm_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.create_armed_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM feedback_publication_outbox outbox
    WHERE outbox.preparation_id = NEW.id
      AND outbox.status IN ('may-have-committed', 'manual-reconciliation', 'succeeded')
      AND outbox.create_eligible = false
      AND outbox.create_attempt_count > 0
  ) THEN
    RAISE EXCEPTION 'invalid feedback publication arm evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER feedback_publication_arm_evidence_valid
AFTER INSERT OR UPDATE ON feedback_publication_preparations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_feedback_publication_arm_evidence();

CREATE FUNCTION validate_feedback_publication_outbox_arm_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('may-have-committed', 'succeeded') AND (
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

CREATE CONSTRAINT TRIGGER feedback_publication_outbox_arm_state_valid
AFTER INSERT OR UPDATE ON feedback_publication_outbox
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_feedback_publication_outbox_arm_state();

CREATE FUNCTION prevent_feedback_publication_recreate_after_arm() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.create_eligible AND EXISTS (
    SELECT 1 FROM feedback_publication_preparations prep
    WHERE prep.id = NEW.preparation_id AND prep.create_armed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'feedback publication preparation was already armed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER feedback_publication_no_recreate_after_arm
BEFORE INSERT OR UPDATE OF create_eligible, preparation_id ON feedback_publication_outbox
FOR EACH ROW EXECUTE FUNCTION prevent_feedback_publication_recreate_after_arm();

CREATE TABLE feedback_publication_delivery_audit (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbox_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  action text NOT NULL CHECK (action IN (
    'claimed-create', 'claimed-reconcile', 'create-armed', 'retry-scheduled',
    'reconciliation-scheduled', 'manual-reconciliation', 'succeeded'
  )),
  result_code text NOT NULL CHECK (
    length(result_code) BETWEEN 1 AND 64 AND result_code ~ '^[a-z0-9-]+$'
  ),
  create_attempt_count integer NOT NULL CHECK (create_attempt_count BETWEEN 0 AND 3),
  event_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = event_at + interval '365 days')
);

CREATE FUNCTION prevent_feedback_publication_create_reenable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.create_eligible = false AND NEW.create_eligible = true THEN
    RAISE EXCEPTION 'feedback publication create eligibility is monotonic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER feedback_publication_create_eligibility_monotonic
BEFORE UPDATE OF create_eligible ON feedback_publication_outbox
FOR EACH ROW EXECUTE FUNCTION prevent_feedback_publication_create_reenable();

ALTER TABLE feedback_github_issue_linkage
  ADD CONSTRAINT feedback_github_issue_linkage_repository_number_key
  UNIQUE (github_repository_id, github_issue_number);

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
      AND prep.create_armed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'invalid feedback github issue linkage';
  END IF;
  RETURN NEW;
END;
$$;

DROP INDEX feedback_publication_outbox_dispatch_idx;
CREATE INDEX feedback_publication_outbox_worker_unclaimed_idx
ON feedback_publication_outbox (created_at, id)
WHERE status = 'unclaimed';
CREATE INDEX feedback_publication_outbox_worker_retry_idx
ON feedback_publication_outbox (next_attempt_at, created_at, id)
WHERE status = 'retryable-failure';
CREATE INDEX feedback_publication_outbox_worker_reconcile_ready_idx
ON feedback_publication_outbox (next_attempt_at NULLS FIRST, created_at, id)
WHERE status = 'may-have-committed' AND lease_expires_at IS NULL;
CREATE INDEX feedback_publication_outbox_worker_reconcile_lease_idx
ON feedback_publication_outbox (lease_expires_at, next_attempt_at NULLS FIRST, created_at, id)
WHERE status = 'may-have-committed' AND lease_expires_at IS NOT NULL;
CREATE INDEX feedback_publication_outbox_worker_claimed_lease_idx
ON feedback_publication_outbox (lease_expires_at, created_at, id)
WHERE status = 'claimed';
CREATE INDEX feedback_publication_delivery_audit_expiry_idx
ON feedback_publication_delivery_audit (expires_at, event_id);

ALTER TABLE feedback_deletion_ledger DROP CONSTRAINT feedback_deletion_ledger_class_code_check;
ALTER TABLE feedback_deletion_ledger ADD CONSTRAINT feedback_deletion_ledger_class_code_check CHECK (
  class_code IN (
    'receipt', 'payload', 'dedupe', 'abuse', 'group', 'review-audit',
    'review-idempotency', 'private-review-group', 'oidc-transaction', 'maintainer-session',
    'key-destruction-evidence', 'publication-preparation', 'publication-outbox',
    'publication-audit', 'publication-delivery-audit', 'publication-idempotency',
    'github-issue-linkage'
  )
);

INSERT INTO feedback_schema_migrations (version, applied_at) VALUES (4, now());
