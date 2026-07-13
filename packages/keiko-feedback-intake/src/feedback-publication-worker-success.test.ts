import { describe, expect, it } from "vitest";
import { persistWorkerSuccess } from "./feedback-publication-worker-success.js";
import type { FeedbackPublicationLeaseIdentity } from "./feedback-publication-worker-types.js";
import type { PgClientLike } from "./postgres-types.js";

const LEASE: FeedbackPublicationLeaseIdentity = {
  outboxId: "11111111-1111-4111-8111-111111111111",
  preparationId: "22222222-2222-4222-8222-222222222222",
  itemId: "33333333-3333-4333-8333-333333333333",
  targetPolicyDigest: "a".repeat(64),
  leaseOwner: "worker-1",
  leaseExpiresAt: new Date("2026-07-12T12:01:00.000Z"),
};
const ISSUE = { repositoryId: "123", issueNodeId: "node-1", issueNumber: 7 } as const;

class SuccessClient implements PgClientLike {
  readonly calls: string[] = [];
  linkage: Record<string, unknown> | undefined = {
    preparation_id: LEASE.preparationId,
    target_policy_digest: LEASE.targetPolicyDigest,
    github_repository_id: ISSUE.repositoryId,
    github_issue_node_id: ISSUE.issueNodeId,
    github_issue_number: ISSUE.issueNumber,
  };
  updateCount = 1;

  query: PgClientLike["query"] = (text: string) => {
    this.calls.push(text);
    if (text.startsWith("SELECT preparation_id,target_policy_digest")) {
      return Promise.resolve({
        rows: this.linkage === undefined ? [] : ([this.linkage] as never[]),
        rowCount: this.linkage === undefined ? 0 : 1,
      });
    }
    if (text.startsWith("UPDATE feedback_publication_outbox")) {
      return Promise.resolve({ rows: [], rowCount: this.updateCount });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  };

  release(): void {
    return undefined;
  }
}

describe("feedback publication worker success persistence", () => {
  it("records exact linkage before a created delivery becomes terminal", async () => {
    const client = new SuccessClient();
    let afterInsert = 0;

    await expect(
      persistWorkerSuccess(client, LEASE, ISSUE, (): Promise<void> => {
        afterInsert += 1;
        return Promise.resolve();
      }),
    ).resolves.toBeUndefined();

    expect(afterInsert).toBe(1);
    expect(client.calls).toHaveLength(4);
    expect(client.calls[2]).toContain("reconciled_exact=$2");
    expect(client.calls[3]).toContain("feedback_publication_delivery_audit");
  });

  it("persists reconciliation provenance and fails closed on linkage or transition drift", async () => {
    const reconciled = new SuccessClient();
    await expect(
      persistWorkerSuccess(reconciled, LEASE, ISSUE, undefined, "reconciled"),
    ).resolves.toBeUndefined();
    expect(reconciled.calls[2]).toContain("reconciled_exact=$2");

    const badLinkage = new SuccessClient();
    badLinkage.linkage = { ...badLinkage.linkage, github_issue_number: 8 };
    await expect(persistWorkerSuccess(badLinkage, LEASE, ISSUE, undefined)).rejects.toMatchObject({
      code: "idempotency-mismatch",
    });

    const unavailable = new SuccessClient();
    unavailable.updateCount = 0;
    await expect(persistWorkerSuccess(unavailable, LEASE, ISSUE, undefined)).rejects.toMatchObject({
      code: "claim-unavailable",
    });
  });
});
