import type { FeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import { describe, expect, it, vi } from "vitest";
import { digestFeedbackTargetPolicyV1 } from "./feedback-publication-projection.js";
import { PostgresFeedbackPublicationQuery } from "./feedback-publication-query.js";
import { FeedbackPublicationError } from "./feedback-publication-types.js";
import type { PgPoolLike } from "./postgres-types.js";

const ITEM = "11111111-1111-4111-8111-111111111111";
const PREPARATION = "22222222-2222-4222-8222-222222222222";
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
const TARGET_DIGEST = digestFeedbackTargetPolicyV1(TARGET);
const ACTOR = {
  issuer: "https://issuer.example",
  subject: "publisher-1",
  permissionPolicyVersion: "publish-policy-v1",
} as const;

function pool(row: object): {
  readonly pool: PgPoolLike;
  readonly query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
  return {
    query,
    pool: {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    },
  };
}

function statusRow(overrides: Readonly<Record<string, unknown>> = {}): object {
  return {
    item_id: ITEM,
    preparation_id: PREPARATION,
    preparation_status: "approved",
    projection_digest: "a".repeat(64),
    target_policy_digest: TARGET_DIGEST,
    target_owner: "owner",
    target_repository: "repository",
    outbox_status: "unclaimed",
    failure_code: null,
    next_attempt_at: null,
    issue_number: null,
    ...overrides,
  };
}

describe("feedback publication maintainer query", () => {
  it("binds content-free terminal replay context to the route and authenticated actor", async () => {
    const fixture = pool({
      command_version: 7,
      payload_digest: "a".repeat(64),
      source_record_version: null,
      projection_digest: "b".repeat(64),
      target_policy_digest: "c".repeat(64),
    });
    const query = new PostgresFeedbackPublicationQuery(fixture.pool, () => TARGET);
    await expect(
      query.commandContext(
        ITEM,
        PREPARATION,
        false,
        "approve-publication",
        "approve-replay-key",
        ACTOR,
      ),
    ).resolves.toEqual({
      version: 7,
      payloadDigest: "a".repeat(64),
      projectionDigest: "b".repeat(64),
      targetPolicyDigest: "c".repeat(64),
    });
    const [sql, values] = fixture.query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toContain("WITH replay_context AS");
    expect(sql).toContain("audit.actor_issuer=$6::text");
    expect(sql).toContain("audit.expires_at=replay.expires_at");
    expect(values).toEqual([
      ITEM,
      PREPARATION,
      false,
      "approve-publication",
      "approve-replay-key",
      ACTOR.issuer,
      ACTOR.subject,
      ACTOR.permissionPolicyVersion,
    ]);
  });

  it("returns deterministic latest and a safe none state without selecting content", async () => {
    const fixture = pool(
      statusRow({
        preparation_id: null,
        preparation_status: null,
        projection_digest: null,
        target_policy_digest: null,
        target_owner: null,
        target_repository: null,
      }),
    );
    const query = new PostgresFeedbackPublicationQuery(fixture.pool, () => TARGET);
    await expect(query.status(ITEM, undefined, false)).resolves.toEqual({
      itemId: ITEM,
      status: "none",
    });
    const [sql, values] = fixture.query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toContain("ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1");
    expect(sql).not.toContain("title_bytes");
    expect(sql).not.toContain("body_bytes");
    expect(sql).not.toContain("canonical_bytes");
    expect(values).toEqual([ITEM, null, false]);
  });

  it.each([
    ["unclaimed", "approved"],
    ["claimed", "approved"],
    ["retryable-failure", "retryable"],
    ["may-have-committed", "may-have-committed"],
    ["manual-reconciliation", "manual-reconciliation"],
    ["succeeded", "succeeded"],
  ] as const)("maps outbox %s to safe status %s", async (outboxStatus, expected) => {
    const fixture = pool(statusRow({ outbox_status: outboxStatus }));
    const query = new PostgresFeedbackPublicationQuery(fixture.pool, () => TARGET);
    await expect(query.status(ITEM, PREPARATION, true)).resolves.toMatchObject({
      status: expected,
    });
  });

  it.each([
    [null, "cancelled-private"],
    ["cancelled-private", "cancelled-private"],
    ["claimed", "manual-reconciliation"],
    ["may-have-committed", "manual-reconciliation"],
    ["manual-reconciliation", "manual-reconciliation"],
  ] as const)("maps cancelled preparation with outbox %s to %s", async (outboxStatus, expected) => {
    const fixture = pool(
      statusRow({ preparation_status: "cancelled-private", outbox_status: outboxStatus }),
    );
    const query = new PostgresFeedbackPublicationQuery(fixture.pool, () => TARGET);
    await expect(query.status(ITEM, PREPARATION, true)).resolves.toMatchObject({
      status: expected,
    });
  });

  it("reports succeeded cancellation as manual remediation and preserves linkage", async () => {
    const fixture = pool(
      statusRow({
        preparation_status: "cancelled-private",
        outbox_status: "succeeded",
        issue_number: 42,
      }),
    );
    const query = new PostgresFeedbackPublicationQuery(fixture.pool, () => TARGET);
    await expect(query.status(ITEM, PREPARATION, true)).resolves.toMatchObject({
      status: "manual-remediation",
      failureCode: "manual-remediation-required",
      linkage: { issueNumber: 42 },
    });
  });

  it("returns only exact stored preview bytes and safe target display", async () => {
    const title = "exact <script> & title";
    const body = "exact ](javascript:alert(1)) body";
    const fixture = pool({
      item_id: ITEM,
      id: PREPARATION,
      status: "prepared",
      projection_digest: "a".repeat(64),
      target_policy_digest: TARGET_DIGEST,
      title_bytes: Buffer.from(title),
      body_bytes: Buffer.from(body),
      target_owner: TARGET.owner,
      target_repository: TARGET.repository,
      target_labels: TARGET.labels,
      label_policy_version: TARGET.labelPolicyVersion,
      target_policy_version: TARGET.targetPolicyVersion,
      target_key: TARGET.targetKey,
      target_api_origin: TARGET.apiOrigin,
      target_repository_id: TARGET.repositoryId,
      target_installation_id: TARGET.installationId,
      expires_at: new Date("2026-08-01T00:00:00Z"),
    });
    const query = new PostgresFeedbackPublicationQuery(fixture.pool, () => TARGET);
    const preview = await query.preview(ITEM, PREPARATION, false);
    expect(preview).toMatchObject({ title, body, targetDisplay: { owner: "owner" } });
    expect(preview).not.toHaveProperty("reconciliationMarker");
    expect(preview).not.toHaveProperty("repositoryId");
    expect(preview).not.toHaveProperty("installationId");
    expect(fixture.query.mock.calls[0]?.[1]).toEqual([ITEM, PREPARATION, false]);
  });

  it("fails preview closed when the current complete target policy drifts", async () => {
    const fixture = pool({
      item_id: ITEM,
      id: PREPARATION,
      status: "prepared",
      projection_digest: "a".repeat(64),
      target_policy_digest: TARGET_DIGEST,
      title_bytes: Buffer.from("title"),
      body_bytes: Buffer.from("body"),
      target_owner: TARGET.owner,
      target_repository: TARGET.repository,
      target_labels: TARGET.labels,
      label_policy_version: TARGET.labelPolicyVersion,
      target_policy_version: TARGET.targetPolicyVersion,
      target_key: TARGET.targetKey,
      target_api_origin: TARGET.apiOrigin,
      target_repository_id: TARGET.repositoryId,
      target_installation_id: TARGET.installationId,
      expires_at: new Date("2026-08-01T00:00:00Z"),
    });
    const query = new PostgresFeedbackPublicationQuery(fixture.pool, () => ({
      ...TARGET,
      repositoryId: "999",
    }));
    await expect(query.preview(ITEM, PREPARATION, false)).rejects.toEqual(
      new FeedbackPublicationError("target-policy-drift"),
    );
  });
});
