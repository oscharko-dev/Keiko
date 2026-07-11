import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("feedback review migration 002", () => {
  it("backfills existing payloads and admits future payloads atomically", async () => {
    const source = await readFile(
      new URL("../migrations/002_feedback_review.sql", import.meta.url),
      "utf8",
    );
    expect(source).toContain("SELECT id, id, semantic_group_id, exact_body_sha256, 'pending'");
    expect(source).toContain("AFTER INSERT ON feedback_payloads");
    expect(source).toContain("CREATE FUNCTION create_feedback_review_item()");
    expect(source).toContain("LOCK TABLE feedback_payloads IN SHARE ROW EXCLUSIVE MODE");
  });

  it("reserves complete approval, closed audit, duplicate, private, and hold constraints", async () => {
    const source = await readFile(
      new URL("../migrations/002_feedback_review.sql", import.meta.url),
      "utf8",
    );
    for (const field of [
      "approval_payload_digest",
      "approval_marker",
      "approval_projection_digest",
      "approval_target_key",
      "approval_label_policy_version",
      "approval_actor_issuer",
      "approval_actor_sub",
      "approval_record_version",
    ])
      expect(source).toContain(field);
    expect(source).toContain("validate_feedback_manual_duplicate_link");
    expect(source).toContain("feedback_review_identity_immutable");
    expect(source).toContain(
      "target_item_id uuid NOT NULL REFERENCES feedback_review_items(id) ON DELETE CASCADE",
    );
    expect(source).toContain("feedback_private_semantic_groups");
    expect(source).toContain("feedback_private_review_group_tombstones");
    expect(source).toContain("review_group_id uuid NOT NULL");
    expect(source).toContain("feedback_legal_holds");
    expect(source).toContain("feedback_legal_hold_unexpired");
    expect(source).toContain("feedback_review_audit");
    expect(source).not.toMatch(
      /annotation|receipt_secret|dedupe_hmac|identity_hmac|ip_address|token|claim_json/iu,
    );
    expect(source).toContain("approval_projection_digest IS NOT NULL");
    expect(source).toContain("approval_record_version IS NOT NULL");
    expect(source).toContain("length(actor_issuer) BETWEEN 1 AND 2048");
    expect(source).toContain("length(actor_sub) BETWEEN 1 AND 255");
    expect(source).toContain("length(permission_policy_version) BETWEEN 1 AND 64");
  });
});
