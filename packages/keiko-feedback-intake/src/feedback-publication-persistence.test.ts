import type {
  FeedbackPublicationApproveCommandV1,
  FeedbackPublicationCancelCommandV1,
  FeedbackPublicationPrepareCommandV1,
  FeedbackPublicationTargetPolicySnapshotV1,
} from "@oscharko-dev/keiko-contracts/feedback-publication";
import { describe, expect, it } from "vitest";
import {
  persistApproval,
  persistPreparation,
  persistPrivateCancellation,
} from "./feedback-publication-persistence.js";
import type { FeedbackIssueProjectionV1 } from "./feedback-publication-projection.js";
import type { PgClientLike } from "./postgres-types.js";

const ITEM = "11111111-1111-4111-8111-111111111111";
const PREPARATION = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);
const PROJECTION_DIGEST = "b".repeat(64);
const TARGET_DIGEST = "c".repeat(64);
const AT = new Date("2026-07-12T12:00:00.000Z");
const TARGET: FeedbackPublicationTargetPolicySnapshotV1 = {
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
const ACTOR = {
  issuer: "https://issuer.example",
  subject: "publisher-1",
  permissionPolicyVersion: "publish-v1",
} as const;
const PROJECTION: FeedbackIssueProjectionV1 = {
  version: "github-issue-v1",
  title: "Governed title",
  body: "Governed body",
  projectionDigest: PROJECTION_DIGEST,
  reconciliationMarker: `<!-- keiko-feedback-reconciliation-v1:${"a".repeat(43)} -->`,
  targetPolicyDigest: TARGET_DIGEST,
};

class PersistenceClient implements PgClientLike {
  readonly calls: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  nextRowCount: number | undefined;

  query: PgClientLike["query"] = (text: string, values: readonly unknown[] = []) => {
    this.calls.push({ text, values });
    const rowCount = this.nextRowCount ?? 1;
    this.nextRowCount = undefined;
    return Promise.resolve({ rows: [], rowCount });
  };

  release(): void {
    return undefined;
  }
}

function prepare(): FeedbackPublicationPrepareCommandV1 {
  return {
    action: "prepare-publication",
    itemId: ITEM,
    expectedVersion: 1,
    expectedPayloadDigest: DIGEST,
    idempotencyKey: "prepare-key",
    actor: ACTOR,
    targetKey: TARGET.targetKey,
  };
}

function approve(): FeedbackPublicationApproveCommandV1 {
  return {
    action: "approve-publication",
    itemId: ITEM,
    preparationId: PREPARATION,
    expectedVersion: 1,
    expectedPayloadDigest: DIGEST,
    expectedProjectionDigest: PROJECTION_DIGEST,
    expectedTargetPolicyDigest: TARGET_DIGEST,
    idempotencyKey: "approve-key",
    actor: ACTOR,
  };
}

function cancel(): FeedbackPublicationCancelCommandV1 {
  return {
    action: "cancel-publication-route-private",
    itemId: ITEM,
    preparationId: PREPARATION,
    expectedVersion: 1,
    expectedPayloadDigest: DIGEST,
    expectedProjectionDigest: PROJECTION_DIGEST,
    expectedTargetPolicyDigest: TARGET_DIGEST,
    idempotencyKey: "cancel-key",
    actor: ACTOR,
  };
}

describe("feedback publication persistence", () => {
  it("persists preparation bytes, audit context, and idempotency without report content", async () => {
    const client = new PersistenceClient();

    await persistPreparation(
      client,
      prepare(),
      PROJECTION,
      TARGET,
      "request-digest",
      PREPARATION,
      AT,
      new Date("2026-08-01T12:00:00.000Z"),
    );

    expect(client.calls).toHaveLength(3);
    expect(client.calls[0]?.values).toContainEqual(new TextEncoder().encode(PROJECTION.title));
    expect(client.calls.flatMap(({ values }) => values).map(String)).not.toContain("raw report");
    expect(client.calls[1]?.values).toContain("prepared");
    expect(client.calls[2]?.text).toContain("'prepared'");
    expect(client.calls[2]?.values).toEqual(
      expect.arrayContaining(["prepare-key", "request-digest"]),
    );
  });

  it("atomically approves an outbox and retains a deterministic idempotency result", async () => {
    const client = new PersistenceClient();

    const result = await persistApproval(client, approve(), PROJECTION, "request-digest", AT);

    expect(result.version).toBe(2);
    expect(result.outboxId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(client.calls).toHaveLength(7);
    expect(client.calls[0]?.values).toEqual(
      expect.arrayContaining([ITEM, PROJECTION.reconciliationMarker, TARGET_DIGEST]),
    );
    expect(client.calls.at(-1)?.text).toContain("'approved'");
    expect(client.calls.at(-1)?.values).toEqual(
      expect.arrayContaining(["approve-key", "request-digest", result.outboxId]),
    );
  });

  it.each([
    ["cancelled-private", "cancelled-private"],
    ["manual-reconciliation", "manual-reconciliation"],
    ["manual-remediation", "manual-remediation"],
  ] as const)(
    "persists %s cancellation with private routing and terminal evidence",
    async (status, expectedAuditStatus) => {
      const client = new PersistenceClient();

      await expect(
        persistPrivateCancellation(
          client,
          cancel(),
          PROJECTION,
          "request-digest",
          "review-group",
          "semantic-group",
          AT,
          status,
        ),
      ).resolves.toBe(2);

      expect(client.calls.some(({ text }) => text.startsWith("UPDATE feedback_review_items"))).toBe(
        true,
      );
      expect(
        client.calls.some(({ text }) =>
          text.startsWith("INSERT INTO feedback_private_semantic_groups"),
        ),
      ).toBe(true);
      expect(client.calls.flatMap(({ values }) => values)).toContain(expectedAuditStatus);
    },
  );

  it("fails when a compare-and-swap approval update cannot be proven", async () => {
    const client = new PersistenceClient();
    client.nextRowCount = 0;

    await expect(
      persistApproval(client, approve(), PROJECTION, "request-digest", AT),
    ).rejects.toThrow("feedback-publication-cas-mismatch");
    expect(client.calls).toHaveLength(1);
  });
});
