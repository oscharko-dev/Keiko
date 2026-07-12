import type { FeedbackPublicationCancelCommandV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import { describe, expect, it } from "vitest";
import {
  assertCancellationPreparation,
  type FeedbackPublicationPreparationRow,
  type FeedbackPublicationReviewRow,
} from "./feedback-publication-records.js";
import { FeedbackPublicationError } from "./feedback-publication-types.js";

const ITEM = "11111111-1111-4111-8111-111111111111";
const PREPARATION = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);
const PROJECTION_DIGEST = "b".repeat(64);
const TARGET_DIGEST = "c".repeat(64);
const EXPIRES = new Date("2026-08-01T00:00:00.000Z");

const review: FeedbackPublicationReviewRow = {
  semantic_group_id: "33333333-3333-4333-8333-333333333333",
  review_group_id: "group",
  payload_digest: DIGEST,
  state: "pending",
  version: 1,
  canonical_bytes: new Uint8Array(),
  payload_exact_digest: DIGEST,
  payload_expires_at: EXPIRES,
  private_group_id: null,
};

const preparation: FeedbackPublicationPreparationRow = {
  id: PREPARATION,
  item_id: ITEM,
  payload_digest: DIGEST,
  source_record_version: 1,
  title_bytes: Buffer.from("title"),
  body_bytes: Buffer.from("body"),
  projection_digest: PROJECTION_DIGEST,
  reconciliation_marker: `<!-- keiko-feedback-reconciliation-v1:${"A".repeat(43)} -->`,
  target_api_origin: "https://api.github.com",
  target_repository_id: "1",
  target_owner: "owner",
  target_repository: "repository",
  target_installation_id: "2",
  target_labels: [],
  target_key: "public",
  label_policy_version: "labels-v1",
  target_policy_version: "target-v1",
  target_policy_digest: TARGET_DIGEST,
  status: "prepared",
  expires_at: EXPIRES,
};

const command: FeedbackPublicationCancelCommandV1 = {
  action: "cancel-publication-route-private",
  itemId: ITEM,
  preparationId: PREPARATION,
  expectedVersion: 1,
  expectedPayloadDigest: DIGEST,
  expectedProjectionDigest: PROJECTION_DIGEST,
  expectedTargetPolicyDigest: TARGET_DIGEST,
  idempotencyKey: "expired-boundary-key",
  actor: {
    issuer: "https://issuer.example",
    subject: "maintainer",
    permissionPolicyVersion: "policy-v1",
  },
};

describe("feedback publication cancellation preparation", () => {
  it("accepts the last instant before expiry and rejects exact expiry", () => {
    expect(() =>
      assertCancellationPreparation(preparation, review, command, new Date(EXPIRES.getTime() - 1)),
    ).not.toThrow();
    expect(() => assertCancellationPreparation(preparation, review, command, EXPIRES)).toThrow(
      new FeedbackPublicationError("payload-expired"),
    );
  });
});
