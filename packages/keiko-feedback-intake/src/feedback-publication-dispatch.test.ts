import type { FeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgClientLike, PgPoolLike } from "./postgres-types.js";

const mocks = vi.hoisted(() => ({
  projection: {
    projectionDigest: "b".repeat(64),
    reconciliationMarker: `<!-- keiko-feedback-reconciliation-v1:${"a".repeat(43)} -->`,
  },
}));

vi.mock("./feedback-publication-records.js", () => ({
  FEEDBACK_PUBLICATION_PREPARATION_COLUMNS: "prep.id",
  targetFromPreparation: (): FeedbackPublicationTargetPolicySnapshotV1 => TARGET,
  verifyStoredProjection: (): typeof mocks.projection => mocks.projection,
}));

import {
  claimFeedbackPublication,
  leasedProjectionFromRow,
} from "./feedback-publication-dispatch.js";

const AT = new Date("2026-07-12T12:00:00.000Z");
const LEASE_EXPIRES = new Date("2026-07-12T12:01:00.000Z");
const CLAIM = {
  outboxId: "11111111-1111-4111-8111-111111111111",
  workerId: "worker-1",
  leaseDurationMs: 60_000,
} as const;
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

function row(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    item_id: "33333333-3333-4333-8333-333333333333",
    payload_digest: "a".repeat(64),
    source_record_version: 1,
    projection_digest: mocks.projection.projectionDigest,
    reconciliation_marker: mocks.projection.reconciliationMarker,
    label_policy_version: TARGET.labelPolicyVersion,
    target_policy_digest: "c".repeat(64),
    target_key: TARGET.targetKey,
    outbox_id: CLAIM.outboxId,
    outbox_status: "unclaimed",
    outbox_expires_at: new Date("2026-08-01T00:00:00.000Z"),
    lease_owner: null,
    lease_expires_at: null,
    create_attempt_count: 0,
    create_armed_at: null,
    review_state: "approved",
    review_version: 2,
    review_payload_digest: "a".repeat(64),
    approval_payload_digest: "a".repeat(64),
    approval_marker: mocks.projection.reconciliationMarker,
    approval_projection_digest: mocks.projection.projectionDigest,
    approval_target_key: TARGET.targetKey,
    approval_label_policy_version: TARGET.labelPolicyVersion,
    approval_record_version: 2,
    approval_preparation_id: "22222222-2222-4222-8222-222222222222",
    approval_target_policy_digest: "c".repeat(64),
    canonical_bytes: new Uint8Array(),
    payload_exact_digest: "a".repeat(64),
    payload_expires_at: new Date("2026-08-01T00:00:00.000Z"),
    private_group_id: null,
    status: "approved",
    ...overrides,
  };
}

class DispatchClient implements PgClientLike {
  readonly calls: string[] = [];
  candidate: Record<string, unknown> | undefined = row();
  failBeginOnce = false;
  committedLeaseLive = true;

  query: PgClientLike["query"] = (text: string) => {
    this.calls.push(text);
    if (text.startsWith("BEGIN") && this.failBeginOnce) {
      this.failBeginOnce = false;
      return Promise.reject(Object.assign(new Error("retry"), { code: "40001" }));
    }
    if (text.startsWith("SELECT prep.id")) {
      return Promise.resolve({
        rows: this.candidate === undefined ? [] : ([this.candidate] as never[]),
        rowCount: this.candidate === undefined ? 0 : 1,
      });
    }
    if (text === "SELECT clock_timestamp() AS database_now") {
      return Promise.resolve({ rows: [{ database_now: AT } as never], rowCount: 1 });
    }
    if (text.startsWith("UPDATE feedback_publication_outbox SET status='claimed'")) {
      return Promise.resolve({ rows: [{ lease_expires_at: LEASE_EXPIRES } as never], rowCount: 1 });
    }
    if (text.startsWith("SELECT clock_timestamp() AS database_now,status")) {
      return Promise.resolve({
        rows: [
          {
            database_now: AT,
            status: this.committedLeaseLive ? "claimed" : "unclaimed",
            lease_owner: CLAIM.workerId,
            lease_expires_at: LEASE_EXPIRES,
          } as never,
        ],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  };

  release(): void {
    return undefined;
  }
}

function dependencies(client: DispatchClient): {
  readonly pool: PgPoolLike;
  readonly deadlineMs: number;
  readonly maxRetries: number;
  readonly claim: typeof CLAIM;
  readonly assertCurrentTarget: () => void;
} {
  return {
    pool: { connect: (): Promise<PgClientLike> => Promise.resolve(client) } satisfies PgPoolLike,
    deadlineMs: 5_000,
    maxRetries: 2,
    claim: CLAIM,
    assertCurrentTarget: (): void => undefined,
  };
}

beforeEach(() => {
  mocks.projection = {
    projectionDigest: "b".repeat(64),
    reconciliationMarker: `<!-- keiko-feedback-reconciliation-v1:${"a".repeat(43)} -->`,
  };
});

describe("feedback publication dispatch claims", () => {
  it("claims one approved, unexpired projection and verifies its committed lease", async () => {
    const client = new DispatchClient();

    await expect(claimFeedbackPublication(dependencies(client))).resolves.toMatchObject({
      outboxId: CLAIM.outboxId,
      leaseOwner: CLAIM.workerId,
      leaseExpiresAt: LEASE_EXPIRES,
      target: TARGET,
    });
    expect(client.calls.filter((call) => call.startsWith("BEGIN"))).toHaveLength(1);
    expect(client.calls).toContain("COMMIT");
  });

  it("retries serialization failures and safely returns no projection when no candidate exists", async () => {
    const retry = new DispatchClient();
    retry.failBeginOnce = true;
    await expect(claimFeedbackPublication(dependencies(retry))).resolves.toMatchObject({
      leaseOwner: CLAIM.workerId,
    });
    expect(retry.calls.filter((call) => call.startsWith("BEGIN"))).toHaveLength(2);

    const empty = new DispatchClient();
    empty.candidate = undefined;
    await expect(claimFeedbackPublication(dependencies(empty))).resolves.toBeUndefined();
  });

  it("releases an expired post-commit claim and fails closed when lease ownership cannot be verified", async () => {
    const client = new DispatchClient();
    client.committedLeaseLive = false;

    await expect(claimFeedbackPublication(dependencies(client))).rejects.toMatchObject({
      code: "claim-unavailable",
    });
    expect(
      client.calls.some((call) =>
        call.startsWith("UPDATE feedback_publication_outbox SET status='unclaimed'"),
      ),
    ).toBe(true);
  });

  it("rejects private or expired rows before constructing a leased projection", () => {
    expect(() =>
      leasedProjectionFromRow(
        row({ private_group_id: "private" }) as never,
        AT,
        "worker-1",
        LEASE_EXPIRES,
        "claimed",
      ),
    ).toThrow("payload-private");
    expect(() =>
      leasedProjectionFromRow(
        row({ payload_expires_at: AT }) as never,
        AT,
        "worker-1",
        LEASE_EXPIRES,
        "claimed",
      ),
    ).toThrow("payload-expired");
  });
});
