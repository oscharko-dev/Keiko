import { afterEach, beforeEach, expect, it } from "vitest";
import type { CodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import { DraftDeliveryFixture } from "../gitDelivery/draftDeliveryServiceTestSupport.js";
import { DraftDeliveryController } from "../gitDelivery/draftDeliveryService.js";

let fixture: DraftDeliveryFixture;
beforeEach(async () => {
  fixture = new DraftDeliveryFixture();
  await fixture.recordVerifiedCommit();
});
afterEach(() => {
  fixture.close();
});

async function approveAndExecute(
  service: DraftDeliveryController,
  value: CodingRuntimeDeliveryResult,
): Promise<CodingRuntimeDeliveryResult> {
  if (value.status !== "recorded") throw new Error("missing delivery proposal");
  const proposalId = value.record.proposalId;
  expect(service.consumeApproval(proposalId)).toBeUndefined();
  expect(service.issueApproval(proposalId)).toBeDefined();
  const lease = service.consumeApproval(proposalId);
  if (lease === undefined) throw new Error("missing delivery approval");
  return service.executeApproved(proposalId, lease, { check: () => true });
}

function laterBlockedCommit(): void {
  const original = fixture.snapshots.get("run-1")?.verifiedCommitResult;
  if (original === undefined) throw new Error("missing original verified commit");
  const { headSha, committedTreeDigest, ...binding } = original;
  expect(committedTreeDigest).toBe(original.stagedTreeDigest);
  fixture.snapshots.recordVerifiedCommit({
    ...binding,
    proposalId: "commit-later",
    status: "blocked",
    reason: "message-policy",
  });
  expect(fixture.git(["rev-parse", "HEAD"])).toBe(headSha);
}

it("recovers the existing draft after a later refused commit without restoring approval or creating another PR", async () => {
  const service = fixture.service;
  await approveAndExecute(service, await service.proposePush());
  const created = await approveAndExecute(
    service,
    await service.proposePullRequest("feat: bounded change"),
  );
  expect(created).toMatchObject({
    record: { phase: "draft-created", pullRequest: { number: 17 } },
  });
  laterBlockedCommit();
  const restored = new DraftDeliveryController(fixture.successorOptions());
  expect(await restored.reconcile()).toMatchObject({
    record: { phase: "draft-created", binding: { runId: "run-2" }, pullRequest: { number: 17 } },
  });
  expect(fixture.pushCount).toBe(1);
  expect(fixture.createCount).toBe(1);
  expect(fixture.snapshots.get("run-2")?.verifiedCommitResult).toBeUndefined();
  if (created.status !== "recorded") throw new Error("missing created draft");
  expect(restored.issueApproval(created.record.proposalId)).toBeUndefined();
  expect(restored.consumeApproval(created.record.proposalId)).toBeUndefined();
  expect(await restored.proposePush()).toMatchObject({ record: { phase: "draft-created" } });
  expect(fixture.pushCount).toBe(1);
  expect(fixture.createCount).toBe(1);
  const event = fixture.events.find(
    (line) =>
      line.op === "git.draft-delivery" &&
      line.extra?.phase === "draft-created" &&
      line.extra.runId === "run-2",
  );
  expect(event?.correlationId).toBe(fixture.context.correlationId);
  expect(event?.extra).toMatchObject({
    verifiedCommitProposalId: "commit-1",
    runtimeAuthorityDigest: "b".repeat(64),
  });
  restored.invalidate();
});

it("requires a fresh PR approval after a later blocked commit and acknowledged push recovery", async () => {
  await approveAndExecute(fixture.service, await fixture.service.proposePush());
  laterBlockedCommit();
  const restored = new DraftDeliveryController(fixture.successorOptions());
  expect(await restored.reconcile()).toMatchObject({ record: { phase: "pushed" } });
  expect(fixture.createCount).toBe(0);
  const proposal = await restored.proposePullRequest("feat: bounded change");
  expect(proposal).toMatchObject({ record: { phase: "pr-proposed", binding: { runId: "run-2" } } });
  expect(await approveAndExecute(restored, proposal)).toMatchObject({
    record: { phase: "draft-created", pullRequest: { number: 17 } },
  });
  expect(fixture.pushCount).toBe(1);
  expect(fixture.createCount).toBe(1);
  restored.invalidate();
});
