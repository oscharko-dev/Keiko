import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("feedback publication worker migration 004", () => {
  it("adds one-way create eligibility, bounded attempts, due dispatch and content-free audit", async () => {
    const source = await readFile(
      new URL("../migrations/004_feedback_publication_worker.sql", import.meta.url),
      "utf8",
    );
    expect(source).toContain("create_eligible boolean NOT NULL DEFAULT true");
    expect(source).toContain("create_attempt_count BETWEEN 0 AND 3");
    for (const index of [
      "feedback_publication_outbox_worker_unclaimed_idx",
      "feedback_publication_outbox_worker_retry_idx",
      "feedback_publication_outbox_worker_reconcile_ready_idx",
      "feedback_publication_outbox_worker_reconcile_lease_idx",
      "feedback_publication_outbox_worker_claimed_lease_idx",
    ]) {
      expect(source).toContain(index);
    }
    expect(source).toContain("feedback_publication_create_eligibility_monotonic");
    expect(source).toContain("OLD.create_eligible = false AND NEW.create_eligible = true");
    expect(source).toContain("UNIQUE (github_repository_id, github_issue_number)");
    expect(source).toContain("ADD COLUMN create_armed_at timestamptz");
    expect(source).toContain("feedback_publication_arm_evidence_immutable");
    expect(source).toContain("feedback_publication_no_recreate_after_arm");
    expect(source).toContain("feedback_publication_outbox_arm_state_valid");
    expect(source).toContain(
      "WHEN status IN ('claimed', 'may-have-committed', 'manual-reconciliation', 'succeeded')",
    );
    expect(source).toContain("WHEN status = 'claimed' THEN 'may-have-committed'");
    expect(source).toContain("WHEN status = 'claimed' THEN NULL ELSE lease_owner");
    expect(source).toContain("prep.expires_at - interval '1 microsecond'");
    expect(source).toContain("outbox.status = 'succeeded'");
    expect(source).toContain("prep.create_armed_at IS NOT NULL");
    expect(source).toContain("feedback_publication_delivery_audit");
    expect(source).not.toMatch(/title_bytes|body_bytes|canonical_bytes|token|secret/iu);
    expect(source).toContain(
      "INSERT INTO feedback_schema_migrations (version, applied_at) VALUES (4, now())",
    );
  });
});
