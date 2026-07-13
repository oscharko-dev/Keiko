import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertApprovalPreparation,
  assertCancellationPreparation,
  assertPrepareReplay,
  assertPublicationReplay,
  findPublicationReplay,
  lockPublicationPreparation,
  lockPublicationReview,
  verifyPublicationReview,
} from "./feedback-publication-records.js";
import type { PgClientLike } from "./postgres-types.js";

const AT = new Date("2026-07-12T12:00:00.000Z");
const ITEM = "11111111-1111-4111-8111-111111111111";
const PREPARATION = "22222222-2222-4222-8222-222222222222";
const bytes = new TextEncoder().encode("{}");
const digest = createHash("sha256").update(bytes).digest("hex");
const review = {
  semantic_group_id: "group",
  review_group_id: "review",
  payload_digest: digest,
  state: "pending",
  version: 1,
  canonical_bytes: bytes,
  payload_exact_digest: digest,
  payload_expires_at: new Date("2026-08-01T00:00:00.000Z"),
  private_group_id: null,
};
const prep = {
  id: PREPARATION,
  item_id: ITEM,
  payload_digest: digest,
  source_record_version: 1,
  title_bytes: Buffer.from("title"),
  body_bytes: Buffer.from("body"),
  projection_digest: "b".repeat(64),
  reconciliation_marker: `<!-- keiko-feedback-reconciliation-v1:${"a".repeat(43)} -->`,
  target_api_origin: "https://api.github.com" as const,
  target_repository_id: "123",
  target_owner: "owner",
  target_repository: "repository",
  target_installation_id: "456",
  target_labels: ["feedback"],
  target_key: "public",
  label_policy_version: "labels-v1",
  target_policy_version: "target-v1",
  target_policy_digest: "c".repeat(64),
  status: "prepared" as const,
  expires_at: new Date("2026-08-01T00:00:00.000Z"),
};
const approve = {
  action: "approve-publication" as const,
  itemId: ITEM,
  preparationId: PREPARATION,
  expectedVersion: 1,
  expectedPayloadDigest: digest,
  expectedProjectionDigest: prep.projection_digest,
  expectedTargetPolicyDigest: prep.target_policy_digest,
  idempotencyKey: "approval-record-key",
  actor: {
    issuer: "https://issuer.example",
    subject: "publisher",
    permissionPolicyVersion: "policy-v1",
  },
};
const cancel = {
  ...approve,
  action: "cancel-publication-route-private" as const,
  idempotencyKey: "cancel-record-key",
};

class Client implements PgClientLike {
  constructor(private readonly rows: readonly object[]) {}
  query: PgClientLike["query"] = () => {
    return Promise.resolve({ rows: this.rows as never[], rowCount: this.rows.length });
  };
  release(): void {
    return undefined;
  }
}

describe("feedback publication records", () => {
  it("locks complete review, preparation, and replay records", async () => {
    await expect(lockPublicationReview(new Client([review]), ITEM)).resolves.toEqual(review);
    await expect(lockPublicationPreparation(new Client([prep]), PREPARATION)).resolves.toEqual(
      prep,
    );
    const replay = {
      request_digest: "request",
      item_id: ITEM,
      preparation_id: PREPARATION,
      outbox_id: null,
      result_status: "prepared" as const,
      result_version: 1,
    };
    await expect(findPublicationReplay(new Client([replay]), "record-key")).resolves.toEqual(
      replay,
    );
    await expect(lockPublicationReview(new Client([]), ITEM)).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(lockPublicationPreparation(new Client([]), PREPARATION)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("validates immutable snapshots and fails closed on private, expired, stale, and replay-drift states", () => {
    expect(() => {
      verifyPublicationReview(review, 1, digest, AT);
    }).not.toThrow();
    expect(() => {
      verifyPublicationReview({ ...review, private_group_id: "private" }, 1, digest, AT);
    }).toThrow("payload-private");
    expect(() => {
      verifyPublicationReview({ ...review, payload_expires_at: AT }, 1, digest, AT);
    }).toThrow("payload-expired");
    expect(() => {
      verifyPublicationReview({ ...review, version: 2 }, 1, digest, AT);
    }).toThrow("cas-mismatch");
    expect(() => {
      verifyPublicationReview({ ...review, payload_exact_digest: "0".repeat(64) }, 1, digest, AT);
    }).toThrow("projection-drift");
    expect(() => {
      assertPublicationReplay(
        {
          request_digest: "other",
          item_id: ITEM,
          preparation_id: PREPARATION,
          outbox_id: null,
          result_status: "prepared",
          result_version: 1,
        },
        "request",
      );
    }).toThrow("idempotency-mismatch");
  });

  it("requires matching prepared, approval, and cancellation bindings", () => {
    expect(() => {
      assertPrepareReplay(prep, ITEM, digest, 1, AT);
    }).not.toThrow();
    expect(() => {
      assertApprovalPreparation(prep, approve, AT);
    }).not.toThrow();
    expect(() => {
      assertCancellationPreparation(prep, review, cancel, AT);
    }).not.toThrow();
    expect(() => {
      assertPrepareReplay({ ...prep, status: "approved" }, ITEM, digest, 1, AT);
    }).toThrow("cas-mismatch");
    expect(() => {
      assertApprovalPreparation({ ...prep, expires_at: AT }, approve, AT);
    }).toThrow("payload-expired");
    expect(() => {
      assertCancellationPreparation({ ...prep, item_id: "other" }, review, cancel, AT);
    }).toThrow("cas-mismatch");
    expect(() => {
      assertCancellationPreparation(
        { ...prep, source_record_version: 0, status: "approved" },
        { ...review, state: "approved", version: 2 },
        cancel,
        AT,
      );
    }).not.toThrow();
  });
});
