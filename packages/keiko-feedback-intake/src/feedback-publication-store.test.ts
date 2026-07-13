import type { FeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replay: undefined as Record<string, unknown> | undefined,
  outboxStatus: undefined as string | undefined,
  findPublicationReplay: vi.fn(),
  lockPublicationPreparation: vi.fn(),
  lockPublicationReview: vi.fn(),
  persistApproval: vi.fn(),
  persistPreparation: vi.fn(),
  persistPrivateCancellation: vi.fn(),
  preparedPublicationResponse: vi.fn(),
  readGithubIssueLinkage: vi.fn(),
  verifyStoredProjection: vi.fn(),
}));

vi.mock("./feedback-publication-command.js", () => ({
  assertFeedbackPublicationClaim: vi.fn(),
  assertFeedbackPublicationCommand: vi.fn(),
  feedbackPublicationCommandDigest: (): string => "command-digest",
}));

vi.mock("./feedback-publication-persistence.js", () => ({
  persistApproval: mocks.persistApproval,
  persistPreparation: mocks.persistPreparation,
  persistPrivateCancellation: mocks.persistPrivateCancellation,
}));

vi.mock("./feedback-publication-projection.js", () => ({
  createFeedbackIssueProjectionV1: vi.fn(() => ({ projectionDigest: "projection-digest" })),
  digestFeedbackTargetPolicyV1: (): string => "target-digest",
}));

vi.mock("./feedback-publication-dispatch.js", () => ({
  claimFeedbackPublication: vi.fn(),
}));

vi.mock("./feedback-publication-records.js", () => ({
  assertApprovalPreparation: vi.fn(),
  assertCancellationPreparation: vi.fn(),
  assertPrepareReplay: vi.fn(),
  assertPublicationReplay: vi.fn(),
  findPublicationReplay: mocks.findPublicationReplay,
  lockPublicationPreparation: mocks.lockPublicationPreparation,
  lockPublicationReview: mocks.lockPublicationReview,
  preparedPublicationResponse: mocks.preparedPublicationResponse,
  readGithubIssueLinkage: mocks.readGithubIssueLinkage,
  reportFromReview: vi.fn(() => ({ title: "redacted report" })),
  verifyPublicationReview: vi.fn(),
  verifyStoredProjection: mocks.verifyStoredProjection,
}));

import { PostgresFeedbackPublicationRepository } from "./feedback-publication-store.js";
import type { PgClientLike } from "./postgres-types.js";

const ITEM = "11111111-1111-4111-8111-111111111111";
const PREPARATION = "22222222-2222-4222-8222-222222222222";
const OUTBOX = "33333333-3333-4333-8333-333333333333";
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

class PublicationClient implements PgClientLike {
  readonly calls: string[] = [];
  released = false;

  query: PgClientLike["query"] = (text: string) => {
    this.calls.push(text);
    if (text.startsWith("SELECT status FROM feedback_publication_outbox")) {
      return Promise.resolve({
        rows: mocks.outboxStatus === undefined ? [] : ([{ status: mocks.outboxStatus }] as never[]),
        rowCount: mocks.outboxStatus === undefined ? 0 : 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  };

  release(): void {
    this.released = true;
  }
}

function preparation(): Record<string, unknown> {
  return {
    id: PREPARATION,
    item_id: ITEM,
    payload_digest: "a".repeat(64),
    source_record_version: 1,
    target_key: TARGET.targetKey,
    target_policy_digest: "target-digest",
    status: "prepared",
    expires_at: new Date("2026-08-01T00:00:00.000Z"),
  };
}

function repository(client: PublicationClient): PostgresFeedbackPublicationRepository {
  return new PostgresFeedbackPublicationRepository(
    { connect: (): Promise<PgClientLike> => Promise.resolve(client) },
    ACTOR.permissionPolicyVersion,
    (): FeedbackPublicationTargetPolicySnapshotV1 => TARGET,
    5_000,
    (): Date => new Date("2026-07-12T12:00:00.000Z"),
    (): Uint8Array => new Uint8Array(32),
    (): string => PREPARATION,
  );
}

function prepare(): Parameters<PostgresFeedbackPublicationRepository["prepare"]>[0] {
  return {
    action: "prepare-publication",
    itemId: ITEM,
    expectedVersion: 1,
    expectedPayloadDigest: "a".repeat(64),
    idempotencyKey: "prepare-key",
    actor: ACTOR,
    targetKey: TARGET.targetKey,
  };
}

function approve(): Parameters<PostgresFeedbackPublicationRepository["approve"]>[0] {
  return {
    action: "approve-publication",
    itemId: ITEM,
    preparationId: PREPARATION,
    expectedVersion: 1,
    expectedPayloadDigest: "a".repeat(64),
    expectedProjectionDigest: "b".repeat(64),
    expectedTargetPolicyDigest: "target-digest",
    idempotencyKey: "approve-key",
    actor: ACTOR,
  };
}

function cancel(): Parameters<PostgresFeedbackPublicationRepository["cancelAndRoutePrivate"]>[0] {
  return {
    action: "cancel-publication-route-private",
    itemId: ITEM,
    preparationId: PREPARATION,
    expectedVersion: 1,
    expectedPayloadDigest: "a".repeat(64),
    expectedProjectionDigest: "b".repeat(64),
    expectedTargetPolicyDigest: "target-digest",
    idempotencyKey: "cancel-key",
    actor: ACTOR,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.replay = undefined;
  mocks.outboxStatus = undefined;
  mocks.findPublicationReplay.mockImplementation(() => Promise.resolve(mocks.replay));
  mocks.lockPublicationPreparation.mockImplementation(() => Promise.resolve(preparation()));
  mocks.lockPublicationReview.mockResolvedValue({
    state: "pending",
    version: 1,
    payload_expires_at: new Date("2026-08-01T00:00:00.000Z"),
    review_group_id: "review-group",
    semantic_group_id: "semantic-group",
  });
  mocks.persistApproval.mockResolvedValue({ version: 2, outboxId: OUTBOX });
  mocks.persistPreparation.mockResolvedValue(undefined);
  mocks.persistPrivateCancellation.mockResolvedValue(2);
  mocks.preparedPublicationResponse.mockReturnValue({
    status: "prepared",
    itemId: ITEM,
    preparationId: PREPARATION,
    recordVersion: 1,
    replayed: false,
  });
  mocks.readGithubIssueLinkage.mockResolvedValue(undefined);
  mocks.verifyStoredProjection.mockReturnValue({ projectionDigest: "b".repeat(64) });
});

describe("Postgres feedback publication repository orchestration", () => {
  it("prepares and approves a current target inside serializable transactions", async () => {
    const client = new PublicationClient();
    const store = repository(client);

    await expect(store.prepare(prepare())).resolves.toMatchObject({ status: "prepared" });
    await expect(store.approve(approve())).resolves.toEqual({
      status: "approved",
      itemId: ITEM,
      preparationId: PREPARATION,
      recordVersion: 2,
      outboxId: OUTBOX,
      replayed: false,
    });

    expect(mocks.persistPreparation).toHaveBeenCalledWith(
      expect.anything(),
      prepare(),
      expect.anything(),
      TARGET,
      "command-digest",
      PREPARATION,
      expect.any(Date),
      expect.any(Date),
    );
    expect(mocks.persistApproval).toHaveBeenCalledWith(
      expect.anything(),
      approve(),
      expect.anything(),
      "command-digest",
      expect.any(Date),
    );
    expect(client.calls.filter((call) => call.startsWith("BEGIN"))).toHaveLength(2);
    expect(client.calls.filter((call) => call === "COMMIT")).toHaveLength(2);
    expect(client.released).toBe(true);
  });

  it("returns exact idempotency replays without a second persistence mutation", async () => {
    const client = new PublicationClient();
    const store = repository(client);
    mocks.replay = {
      request_digest: "command-digest",
      item_id: ITEM,
      preparation_id: PREPARATION,
      result_version: 2,
      outbox_id: OUTBOX,
      result_status: "cancelled-private",
    };

    await expect(store.approve(approve())).resolves.toMatchObject({
      replayed: true,
      outboxId: OUTBOX,
    });
    await expect(store.cancelAndRoutePrivate(cancel())).resolves.toEqual({
      status: "cancelled-private",
      itemId: ITEM,
      preparationId: PREPARATION,
      recordVersion: 2,
      replayed: true,
    });
    expect(mocks.persistApproval).not.toHaveBeenCalled();
    expect(mocks.persistPrivateCancellation).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "cancelled-private", undefined],
    ["unclaimed", "cancelled-private", undefined],
    ["claimed", "manual-reconciliation", "manual-reconciliation-required"],
    ["succeeded", "manual-remediation", "manual-remediation-required"],
  ] as const)(
    "routes cancellation safely for outbox status %s",
    async (outboxStatus, status, failure) => {
      const client = new PublicationClient();
      const store = repository(client);
      mocks.outboxStatus = outboxStatus;

      await expect(store.cancelAndRoutePrivate(cancel())).resolves.toEqual({
        status,
        itemId: ITEM,
        preparationId: PREPARATION,
        recordVersion: 2,
        replayed: false,
        ...(failure === undefined ? {} : { failure }),
      });
    },
  );

  it("rejects an actor whose policy version is no longer authorized before opening a transaction", async () => {
    const client = new PublicationClient();
    await expect(
      repository(client).prepare({
        ...prepare(),
        actor: { ...ACTOR, permissionPolicyVersion: "old" },
      }),
    ).rejects.toMatchObject({ code: "permission-denied" });
    expect(client.calls).toEqual([]);
  });
});
