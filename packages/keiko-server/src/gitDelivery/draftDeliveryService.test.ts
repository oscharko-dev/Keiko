import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createVerifiedCommitService } from "./verifiedCommitService.js";
import { commitFacadeFixture } from "./verifiedCommitFacadeTestSupport.js";
import { publishDraftDeliveryRecord } from "../coding-runtime/productionDraftDeliveryRuntime.js";
import { redactLogFields } from "../observability/log-redaction.js";
import { validateCodingWorkbenchRuntimeApprovalReviewChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import { parseCodingToolRequest } from "../coding-runtime/codingToolIpc.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import { DraftDeliveryFixture } from "./draftDeliveryServiceTestSupport.js";
import { DraftDeliveryController } from "./draftDeliveryService.js";

let fixture: DraftDeliveryFixture;
beforeEach(async () => {
  fixture = new DraftDeliveryFixture();
  await fixture.recordVerifiedCommit();
});
afterEach(() => {
  fixture.close();
});
function id(value: CodingRuntimeDeliveryResult): string {
  expect(value.status, JSON.stringify(fixture.events)).toBe("recorded");
  if (value.status !== "recorded") throw new Error("missing record");
  return value.record.proposalId;
}
async function execute(
  value: CodingRuntimeDeliveryResult,
  service = fixture.service,
): Promise<CodingRuntimeDeliveryResult> {
  const proposalId = id(value);
  expect(service.issueApproval(proposalId)).toBeDefined();
  const lease = service.consumeApproval(proposalId);
  expect(lease).toBeDefined();
  if (lease === undefined) throw new Error("missing lease");
  return service.executeApproved(proposalId, lease, { check: () => true });
}
async function pushed(): Promise<CodingRuntimeDeliveryResult> {
  const value = await execute(await fixture.service.proposePush());
  expect(value, JSON.stringify(fixture.events)).toMatchObject({
    status: "recorded",
    record: { phase: "pushed" },
  });
  return value;
}

describe("issue-bound draft delivery controller", () => {
  it("persists intent before each separately approved effect and creates a draft on the real default base", async () => {
    const proposal = await fixture.service.proposePush();
    expect(proposal).toMatchObject({
      record: { phase: "push-proposed", binding: { baseRef: "master" } },
    });
    expect(fixture.pushCount).toBe(0);
    await execute(proposal);
    const pr = await fixture.service.proposePullRequest("feat: bounded change");
    expect(pr).toMatchObject({ record: { phase: "pr-proposed" } });
    expect(fixture.createCount).toBe(0);
    expect(await execute(pr), JSON.stringify(fixture.events)).toMatchObject({
      record: {
        phase: "draft-created",
        pullRequest: { number: 17, isDraft: true, baseRef: "master" },
      },
    });
    expect(fixture.changes.map((value) => value.phase)).toEqual([
      "push-proposed",
      "pushing",
      "pushed",
      "pr-proposed",
      "creating-pr",
      "draft-created",
    ]);
    expect(fixture.createBody.match(/Closes #1/gu)).toHaveLength(1);
    expect(JSON.stringify(fixture.snapshots.get("run-1"))).not.toContain("feat: bounded change");
  });
  it("retains uncertain push outcome until an explicit read-only reconciliation", async () => {
    fixture.failAfterPush = true;
    const result = await execute(await fixture.service.proposePush());
    expect(result).toMatchObject({
      record: { phase: "recovery-required", reason: "provider-failed" },
    });
    const restarted = new DraftDeliveryController(fixture.options);
    expect(await restarted.reconcile()).toMatchObject({ record: { phase: "pushed" } });
    expect(fixture.pushCount).toBe(1);
    expect(fixture.createCount).toBe(0);
  });
  it("retains the known created PR identity when the final remote list becomes unavailable", async () => {
    await pushed();
    fixture.failListAfterCreate = true;
    expect(
      await execute(await fixture.service.proposePullRequest("feat: bounded change")),
    ).toMatchObject({
      record: {
        phase: "recovery-required",
        pullRequest: { number: 17, externalId: "PR_kw_fixture" },
      },
    });
    fixture.failListAfterCreate = false;
    const restarted = new DraftDeliveryController(fixture.options);
    expect(await restarted.reconcile()).toMatchObject({
      record: { phase: "draft-created", pullRequest: { number: 17 } },
    });
    expect(fixture.createCount).toBe(1);
  });
});

describe("draft delivery runtime admission", () => {
  it.each(["push", "pull-request"])("accepts closed %s semantic proposals", (intent) => {
    const request = {
      action: "delivery",
      actionId: "action-1",
      idempotencyKey: "action-1",
      intent,
      phase: "propose",
      ...(intent === "pull-request" ? { title: "feat: bounded change" } : {}),
    };
    expect(parseCodingToolRequest(JSON.stringify(request), 65536)).toEqual(request);
  });
  it("carries a complete authenticated delivery review with honest zero workspace edit counts", async () => {
    const value = await fixture.service.proposePush();
    const review = fixture.service.review(id(value));
    const pending = {
      requestId: id(value),
      paths: [],
      pathsTruncated: false,
      fileCount: 0,
      addedLines: 0,
      deletedLines: 0,
      draftDelivery: review?.review,
    };
    expect(
      validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({ session: "active", pending }).ok,
    ).toBe(true);
  });
});

describe("draft delivery hard boundaries", () => {
  it.each(["authority-denied", "issue-drift", "remote-drift", "provider-failed"] as const)(
    "refuses %s before any effect",
    async (reason) => {
      if (reason === "authority-denied") fixture.live = false;
      else fixture.targetReason = reason;
      expect((await fixture.service.proposePush()).status).toBe("unavailable");
      expect(fixture.pushCount + fixture.createCount).toBe(0);
    },
  );
  it("denies a forged lease and never reuses the actual one", async () => {
    const proposal = await fixture.service.proposePush();
    expect(
      await fixture.service.executeApproved(id(proposal), {}, { check: () => true }),
    ).toMatchObject({ record: { reason: "approval-invalid" } });
    const next = await fixture.service.proposePush();
    fixture.service.issueApproval(id(next));
    const lease = fixture.service.consumeApproval(id(next));
    if (lease === undefined) throw new Error("missing lease");
    expect(
      await fixture.service.executeApproved(id(next), lease, { check: () => true }),
    ).toMatchObject({ record: { phase: "pushed" } });
    expect(
      await fixture.service.executeApproved(id(next), lease, { check: () => true }),
    ).toMatchObject({ status: "unavailable" });
    expect(fixture.pushCount).toBe(1);
  });
  it("rejects expired approval and approval from a replaced process instance", async () => {
    const proposal = await fixture.service.proposePush();
    fixture.service.issueApproval(id(proposal));
    fixture.now += 300_001;
    expect(fixture.service.consumeApproval(id(proposal))).toBeUndefined();
    const restarted = new DraftDeliveryController(fixture.options);
    expect(restarted.issueApproval(id(proposal))).toBeUndefined();
    expect(await restarted.reconcile()).toMatchObject({ record: { phase: "recovery-required" } });
    expect(fixture.pushCount).toBe(0);
  });
  it("does not mint a PR approval until the exact commit was pushed", async () => {
    await fixture.service.proposePush();
    expect(await fixture.service.proposePullRequest("feat: bounded change")).toMatchObject({
      record: { phase: "recovery-required" },
    });
    expect(fixture.createCount).toBe(0);
  });
  it("never adopts an unknown PR after a create timeout", async () => {
    await pushed();
    fixture.failAfterCreate = true;
    expect(
      await execute(await fixture.service.proposePullRequest("feat: bounded change")),
    ).toMatchObject({ record: { phase: "recovery-required", reason: "ambiguous-remote" } });
    const restarted = new DraftDeliveryController(fixture.options);
    expect(await restarted.reconcile()).toMatchObject({
      record: { phase: "recovery-required", reason: "ambiguous-remote" },
    });
    expect(await restarted.proposePullRequest("feat: retry")).toMatchObject({
      record: { phase: "recovery-required" },
    });
    expect(fixture.createCount).toBe(1);
  });
  it.each(["duplicate", "closed", "foreign", "base-drift"])(
    "refuses %s remote PR identity",
    async (variant) => {
      await pushed();
      const known = fixture.identity();
      fixture.prs =
        variant === "duplicate"
          ? [known, { ...known, number: 18 }]
          : [
              {
                ...known,
                ...(variant === "closed" ? { state: "closed" as const } : {}),
                ...(variant === "foreign" ? { headRepository: "other/repository" } : {}),
                ...(variant === "base-drift" ? { baseRef: "main" } : {}),
              },
            ];
      expect(await fixture.service.proposePullRequest("feat: bounded change")).toMatchObject({
        record: { phase: "recovery-required" },
      });
      expect(fixture.createCount).toBe(0);
    },
  );
  it("rejects dirty buffers and authority revocation during the final target await", async () => {
    const proposal = await fixture.service.proposePush();
    fixture.clean = false;
    expect(await execute(proposal)).toMatchObject({ record: { phase: "recovery-required" } });
    fixture.clean = true;
    const next = await fixture.service.proposePush();
    fixture.asyncBeforeTarget = (): Promise<void> => {
      fixture.service.invalidate();
      return Promise.resolve();
    };
    expect(await execute(next)).toMatchObject({
      record: { phase: "recovery-required", reason: "authority-denied" },
    });
    expect(fixture.pushCount).toBe(0);
  });
  it("rejects an extra closing directive from the model title", async () => {
    await pushed();
    expect(await fixture.service.proposePullRequest("Closes #999")).toMatchObject({
      record: { phase: "recovery-required", reason: "payload-changed" },
    });
    expect(fixture.createCount).toBe(0);
  });
  it("copies and freezes the proposal binding before exposing its result to a caller", async () => {
    const proposal = await fixture.service.proposePush();
    if (proposal.status !== "recorded") throw new Error("missing record");
    expect(() => Object.assign(proposal.record.binding, { headSha: "f".repeat(40) })).toThrow(
      TypeError,
    );
    expect(await execute(proposal)).toMatchObject({ record: { phase: "pushed" } });
  });
});

describe.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
  "productive draft facade in %s",
  (mode) => {
    it("requires different exact push and PR approvals and rejects cross-operation grants, revoked runs and replay", async () => {
      const commitService = createVerifiedCommitService({
        ...fixture.options,
        snapshots: fixture.snapshots,
        context: () => fixture.context,
        messageAllowed: () => Promise.resolve(true),
      });
      const runtime = commitFacadeFixture({
        service: commitService,
        draftDeliveryService: fixture.service,
        root: fixture.root,
        mode,
        live: () => fixture.live,
        report: () => {
          throw new Error("unexpected verification");
        },
      });
      let action = 0;
      const call = (
        intent: string,
        phase: string,
        extra = {},
      ): ReturnType<typeof runtime.facade.execute> => {
        action += 1;
        return runtime.facade.execute({
          capability: "runtime-capability",
          body: JSON.stringify({
            action: "delivery",
            actionId: `action-${String(action)}`,
            idempotencyKey: `action-${String(action)}`,
            intent,
            phase,
            ...extra,
          }),
        });
      };
      const proposal = await call("push", "propose");
      expect(proposal, JSON.stringify(fixture.events)).toMatchObject({
        status: "completed",
        draftDelivery: { record: { phase: "push-proposed" } },
      });
      if (!("draftDelivery" in proposal)) throw new Error("missing delivery result");
      const proposalId = id(proposal.draftDelivery);
      expect(await call("push", "execute", { proposalId })).toMatchObject({ status: "denied" });
      expect(runtime.bridge.issueDelivery?.("other-run", proposalId)).toBeUndefined();
      expect(runtime.bridge.issueDelivery?.("run-1", proposalId)).toBeDefined();
      expect(await call("pull-request", "execute", { proposalId })).toMatchObject({
        status: "denied",
      });
      expect(await call("push", "execute", { proposalId })).toMatchObject({
        draftDelivery: { record: { phase: "pushed" } },
      });
      const pr = await call("pull-request", "propose", { title: "feat: bounded change" });
      if (!("draftDelivery" in pr)) throw new Error("missing PR result");
      const prId = id(pr.draftDelivery);
      expect(await call("pull-request", "execute", { proposalId: prId })).toMatchObject({
        status: "denied",
      });
      expect(runtime.bridge.issueDelivery?.("run-1", prId)).toBeDefined();
      expect(await call("pull-request", "execute", { proposalId: prId })).toMatchObject({
        draftDelivery: { record: { phase: "draft-created" } },
      });
      expect(await call("pull-request", "execute", { proposalId: prId })).toMatchObject({
        status: "denied",
      });
      fixture.live = false;
      expect(await call("push", "reconcile")).toMatchObject({ status: "denied" });
      expect(
        runtime.events
          .filter((event) => event.kind === "permission-requested")
          .map((event) => event.permissionRequest?.actionKind),
      ).toEqual(["push", "pull-request"]);
      expect(fixture.pushCount).toBe(1);
      expect(fixture.createCount).toBe(1);
    });
  },
);
describe("draft record notification evidence", () => {
  it("publishes each durable revision through the existing body-free runtime event", async () => {
    await pushed();
    const events: unknown[] = [];
    for (const record of fixture.changes)
      publishDraftDeliveryRecord(record, (event) => {
        events.push(event);
      });
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain("owner/repository");
    const logs = fixture.events
      .filter((event) => event.op === "git.draft-delivery")
      .map((event) => redactLogFields(event));
    expect(logs.at(-1)).toMatchObject({
      correlationId: "draft-delivery-test",
      extra: {
        runId: "run-1",
        phase: "pushed",
        reason: "completed",
        headSha: fixture.git(["rev-parse", "HEAD"]),
        remoteDigest: fixture.issue.remoteDigest,
        issueBindingDigest: fixture.issue.bindingDigest,
        verifiedCommitProposalId: "commit-1",
      },
    });
  });
});

describe("durable delivery continuation", () => {
  it("reconciles an acknowledged predecessor without reminting its approval or requiring a new commit", async () => {
    fixture.failAfterPush = true;
    await execute(await fixture.service.proposePush());
    const options = fixture.successorOptions();
    const source = fixture.snapshots.get("run-1");
    const fresh = new DraftDeliveryController(options);
    expect(await fresh.reconcile()).toMatchObject({
      record: {
        phase: "pushed",
        binding: { runId: "run-2", verifiedCommitProposalId: "commit-1" },
      },
    });
    expect(fixture.snapshots.get("run-2")?.verifiedCommitResult).toBeUndefined();
    const proposal = await fresh.proposePullRequest("feat: bounded change");
    expect(fresh.consumeApproval(id(proposal))).toBeUndefined();
    expect(await execute(proposal, fresh)).toMatchObject({
      record: { phase: "draft-created", binding: { runId: "run-2" } },
    });
    expect(fixture.snapshots.get("run-1")).toEqual(source);
    expect(fixture.pushCount).toBe(1);
    expect(fixture.createCount).toBe(1);
  });
  it("retains the known draft after publishing a newly verified commit to its existing head branch", async () => {
    await pushed();
    await execute(await fixture.service.proposePullRequest("feat: bounded change"));
    writeFileSync(join(fixture.root, "code.js"), "export const value = 3;\n");
    fixture.git(["add", "code.js"]);
    fixture.git(["commit", "-qm", "feat: followup"]);
    await fixture.recordVerifiedCommit("commit-2");
    await execute(await fixture.service.proposePush());
    expect(await fixture.service.proposePullRequest("feat: followup")).toMatchObject({
      record: {
        phase: "draft-created",
        pullRequest: { number: 17 },
        binding: { verifiedCommitProposalId: "commit-2" },
      },
    });
    expect(fixture.createCount).toBe(1);
    expect(fixture.pushCount).toBe(2);
  });
});

describe("pending delivery retry semantics", () => {
  it("returns the same reviewed PR proposal for an identical retry", async () => {
    await pushed();
    const first = await fixture.service.proposePullRequest("feat: bounded change");
    const second = await fixture.service.proposePullRequest("feat: bounded change");
    expect(second).toEqual(first);
    expect(fixture.service.review(id(second))).toBeDefined();
    expect(fixture.createCount).toBe(0);
  });
});
