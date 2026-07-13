import type { FeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import { describe, expect, it } from "vitest";
import {
  createFeedbackIssueProjectionV1,
  digestFeedbackTargetPolicyV1,
} from "./feedback-publication-projection.js";
import { verifyStoredProjection } from "./feedback-publication-records.js";
import { preparedReport } from "./postgres-integration-helpers.js";

const target: FeedbackPublicationTargetPolicySnapshotV1 = {
  apiOrigin: "https://api.github.com",
  repositoryId: "123",
  owner: "owner",
  repository: "repository",
  installationId: "456",
  labels: ["feedback"],
  targetKey: "public",
  labelPolicyVersion: "labels-v1",
  targetPolicyVersion: "target-v1",
};
const fixture = preparedReport("Stored projection");
const issue = createFeedbackIssueProjectionV1(fixture.report, target, () => new Uint8Array(32));
const prep = {
  id: "22222222-2222-4222-8222-222222222222",
  item_id: "11111111-1111-4111-8111-111111111111",
  payload_digest: fixture.exactBodySha256,
  source_record_version: 1,
  title_bytes: Buffer.from(issue.title),
  body_bytes: Buffer.from(issue.body),
  projection_digest: issue.projectionDigest,
  reconciliation_marker: issue.reconciliationMarker,
  target_api_origin: target.apiOrigin,
  target_repository_id: target.repositoryId,
  target_owner: target.owner,
  target_repository: target.repository,
  target_installation_id: target.installationId,
  target_labels: target.labels,
  target_key: target.targetKey,
  label_policy_version: target.labelPolicyVersion,
  target_policy_version: target.targetPolicyVersion,
  target_policy_digest: digestFeedbackTargetPolicyV1(target),
  status: "prepared" as const,
  expires_at: new Date("2026-08-01T00:00:00.000Z"),
};
const review = {
  semantic_group_id: "group",
  review_group_id: "review",
  payload_digest: fixture.exactBodySha256,
  state: "pending",
  version: 1,
  canonical_bytes: fixture.canonicalBody.copyBytes(),
  payload_exact_digest: fixture.exactBodySha256,
  payload_expires_at: prep.expires_at,
  private_group_id: null,
};

describe("stored feedback publication projection", () => {
  it("accepts only a byte-for-byte and digest-for-digest recomputation", () => {
    expect(verifyStoredProjection(review, prep)).toEqual(issue);
  });

  it.each([
    ["projection digest", { projection_digest: "0".repeat(64) }],
    ["target policy digest", { target_policy_digest: "0".repeat(64) }],
    ["title bytes", { title_bytes: Buffer.from("forged title") }],
    ["body bytes", { body_bytes: Buffer.from("forged body") }],
  ])("fails closed when stored %s drift", (_name, drift) => {
    expect(() => verifyStoredProjection(review, { ...prep, ...drift })).toThrow("projection-drift");
  });
});
