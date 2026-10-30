import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import { isDraftDeliveryBranchBinding } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import { DraftDeliveryFixture } from "./draftDeliveryServiceTestSupport.js";
import { DraftDeliveryController } from "./draftDeliveryService.js";
import type { DraftDeliveryRunContext } from "./draftDeliveryTypes.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

// ADR-0085 D1b: a run with no accepted issue delivers by pushing its verified commit to its own task
// branch on `origin`, which may be any Git remote. These tests drive the real controller, the real
// governed publish lifecycle and the real Node publish adapter against a real local bare repository:
// the pinned `git push origin <sha>:refs/heads/<branch>` is the only effect, and it is never forced.
const GIT_FIXTURE_TIMEOUT_MS = 30_000;

let fixture: DraftDeliveryFixture | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});
async function branchFixture(
  options: ConstructorParameters<typeof DraftDeliveryFixture>[0] = {},
  commit = true,
): Promise<DraftDeliveryFixture> {
  const created = new DraftDeliveryFixture({ issueFree: true, realPublish: true, ...options });
  fixture = created;
  if (commit) await created.recordVerifiedCommit();
  return created;
}
function recordedId(subject: DraftDeliveryFixture, value: CodingRuntimeDeliveryResult): string {
  expect(value.status, JSON.stringify(subject.events)).toBe("recorded");
  if (value.status !== "recorded") throw new Error("missing record");
  return value.record.proposalId;
}
async function approveAndExecute(
  subject: DraftDeliveryFixture,
  value: CodingRuntimeDeliveryResult,
): Promise<CodingRuntimeDeliveryResult> {
  const proposalId = recordedId(subject, value);
  expect(subject.service.issueApproval(proposalId)).toBeDefined();
  const lease = subject.service.consumeApproval(proposalId);
  if (lease === undefined) throw new Error("missing lease");
  return subject.service.executeApproved(proposalId, lease, { check: () => true });
}
function refusalLines(subject: DraftDeliveryFixture): readonly Record<string, unknown>[] {
  return subject.events
    .filter((event) => event.op === "git.draft-delivery" && event.extra?.phase === "refused")
    .map((event) => ({ ...event.extra, errorKind: event.errorKind, level: event.level }));
}

describe("issue-free branch push to a local bare origin", () => {
  it(
    "proposes, is approved and pushes the verified commit to the task branch",
    async () => {
      const subject = await branchFixture();
      const head = subject.git(["rev-parse", "HEAD"]);
      const proposal = await subject.service.proposePush();
      expect(proposal).toMatchObject({
        status: "recorded",
        record: { phase: "push-proposed", reason: "approval-required" },
      });
      if (proposal.status !== "recorded") throw new Error("missing record");
      const binding = proposal.record.binding;
      expect(isDraftDeliveryBranchBinding(binding)).toBe(true);
      expect(binding).toMatchObject({
        kind: "branch-push",
        remoteAlias: "origin",
        headRef: subject.branch,
        headSha: head,
      });
      expect(Object.keys(binding)).not.toContain("issueNumber");
      expect(Object.keys(binding)).not.toContain("repository");
      // Intent is durable before the effect and the remote has seen nothing yet.
      expect(subject.remoteHead(subject.branch)).toBeUndefined();
      const command = subject.service.review(proposal.record.proposalId)?.command;
      expect(command).toMatchObject({
        kind: "push",
        verifiedCommitSha: head,
        sourceBranchName: subject.branch,
        remoteAlias: "origin",
        remoteBranchName: subject.branch,
        forcePush: false,
      });

      const result = await approveAndExecute(subject, proposal);
      expect(result, JSON.stringify(subject.events)).toMatchObject({
        status: "recorded",
        record: { phase: "pushed", reason: "completed" },
      });
      expect(subject.remoteHead(subject.branch)).toBe(head);
      expect(subject.changes.map((record) => record.phase)).toEqual([
        "push-proposed",
        "pushing",
        "pushed",
      ]);
      // `origin` is re-verified before the proposal and again before the effect.
      expect(subject.branchTargetCalls).toBeGreaterThanOrEqual(2);
      // No GitHub read exists for a branch push, and no issue fact reaches the Activity Log.
      expect(subject.events.some((event) => event.op === "git.draft-remote.observed")).toBe(false);
      const delivery = subject.events.filter((event) => event.op === "git.draft-delivery");
      expect(delivery.length).toBeGreaterThan(0);
      for (const event of delivery) expect(event.extra).not.toHaveProperty("issueNumber");
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "never substitutes a later local commit for the approved one",
    async () => {
      const subject = await branchFixture();
      const proposal = await subject.service.proposePush();
      const id = recordedId(subject, proposal);
      writeFileSync(join(subject.root, "code.js"), "export const value = 3;\n");
      subject.git(["add", "code.js"]);
      subject.git(["commit", "-qm", "fix: unapproved later change"]);
      subject.git(["update-index", "--refresh", "-q"]);
      expect(subject.service.issueApproval(id)).toBeDefined();
      const lease = subject.service.consumeApproval(id);
      const result = await subject.service.executeApproved(id, lease, { check: () => true });
      expect(result).toMatchObject({
        record: { phase: "recovery-required", reason: "remote-drift" },
      });
      expect(subject.remoteHead(subject.branch)).toBeUndefined();
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "refuses a non-fast-forward push when the remote branch has diverged and leaves it untouched",
    async () => {
      const subject = await branchFixture();
      const diverged = subject.git(["commit-tree", "HEAD^{tree}", "-m", "diverged remote history"]);
      subject.git(["push", "-q", subject.remote, `${diverged}:refs/heads/${subject.branch}`]);
      const result = await approveAndExecute(subject, await subject.service.proposePush());
      expect(result).toMatchObject({
        status: "recorded",
        record: { phase: "recovery-required", reason: "provider-failed" },
      });
      expect(subject.remoteHead(subject.branch)).toBe(diverged);
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it.each(["dev", "main", "release/1.0"])(
    "blocks a push whose target is the protected branch %s and never creates it",
    async (branch) => {
      const subject = await branchFixture({ branch });
      const result = await approveAndExecute(subject, await subject.service.proposePush());
      expect(result).toMatchObject({
        status: "recorded",
        record: { phase: "recovery-required", reason: "preflight-failed" },
      });
      expect(subject.remoteHead(branch)).toBeUndefined();
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "stops before the effect when origin is no longer the remote the run was admitted with",
    async () => {
      const subject = await branchFixture();
      const proposal = await subject.service.proposePush();
      subject.branchTarget = { ok: false, reason: "remote-drift" };
      const result = await approveAndExecute(subject, proposal);
      expect(result).toMatchObject({
        record: { phase: "recovery-required", reason: "remote-drift" },
      });
      expect(subject.remoteHead(subject.branch)).toBeUndefined();
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "settles an interrupted attempt as recovery and proposes the same commit again",
    async () => {
      const subject = await branchFixture();
      const first = recordedId(subject, await subject.service.proposePush());
      const restarted = new DraftDeliveryController(subject.options);
      expect(await restarted.reconcile()).toMatchObject({
        record: { phase: "recovery-required", reason: "restart-reconciliation" },
      });
      const second = await restarted.proposePush();
      expect(recordedId(subject, second)).not.toBe(first);
      expect(second).toMatchObject({ record: { phase: "push-proposed" } });
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );
});

describe("issue-free delivery refusals name their true cause", () => {
  it(
    "refuses a pull request with issue-binding-required and logs the refusal",
    async () => {
      const subject = await branchFixture();
      await approveAndExecute(subject, await subject.service.proposePush());
      subject.events.length = 0;
      expect(await subject.service.proposePullRequest("feat: bounded change")).toEqual({
        status: "unavailable",
        reason: "issue-binding-required",
      });
      expect(subject.createCount).toBe(0);
      expect(refusalLines(subject)).toEqual([
        expect.objectContaining({
          runId: "run-1",
          reason: "issue-binding-required",
          errorKind: "unavailable",
          level: "warn",
        }),
      ]);
      const line = subject.events.find((event) => event.op === "git.draft-delivery");
      expect(line?.correlationId).toBe("draft-delivery-test");
      const persisted = expectActivityLogProof(
        "git.draft-delivery.emitted-line",
        formatActivityLogProofLine(line ?? {}),
      );
      expect(persisted).toMatchObject({
        phase: "refused",
        reason: "issue-binding-required",
        errorKind: "unavailable",
        correlationId: "draft-delivery-test",
      });
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "refuses a repository with no origin as remote-required without any effect",
    async () => {
      const subject = await branchFixture();
      const local = new DraftDeliveryController({
        ...subject.options,
        context: (): DraftDeliveryRunContext => ({ ...subject.context, repositoryKind: "local" }),
      });
      expect(await local.proposePush()).toEqual({
        status: "unavailable",
        reason: "remote-required",
      });
      expect(refusalLines(subject)).toEqual([
        expect.objectContaining({ reason: "remote-required", errorKind: "unavailable" }),
      ]);
      expect(subject.changes).toEqual([]);
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "refuses a run with no verified context as repository-required, under the run's correlation",
    async () => {
      const subject = await branchFixture();
      const runId = "run-0001-abcdef";
      const without = new DraftDeliveryController({
        ...subject.options,
        runId,
        context: (): undefined => undefined,
      });
      expect(await without.proposePush()).toEqual({
        status: "unavailable",
        reason: "repository-required",
      });
      const line = subject.events.find((event) => event.op === "git.draft-delivery");
      expect(line).toMatchObject({
        correlationId: runId,
        level: "warn",
        errorKind: "unavailable",
        extra: { runId, phase: "refused", reason: "repository-required" },
      });
      expectActivityLogProof(
        "git.draft-delivery.emitted-line",
        formatActivityLogProofLine(line ?? {}),
      );
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "tells a failed caller guard from a missing context",
    async () => {
      const subject = await branchFixture();
      const proposalId = recordedId(subject, await subject.service.proposePush());
      subject.events.length = 0;
      expect(
        await subject.service.executeApproved(proposalId, undefined, { check: () => false }),
      ).toEqual({ status: "unavailable", reason: "authority-denied" });
      expect(refusalLines(subject)).toEqual([
        expect.objectContaining({ reason: "authority-denied", errorKind: "authority-denied" }),
      ]);
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "logs a push proposed before any verified commit exists",
    async () => {
      const subject = await branchFixture({}, false);
      expect(await subject.service.proposePush()).toEqual({
        status: "unavailable",
        reason: "verified-commit-required",
      });
      expect(refusalLines(subject)).toEqual([
        expect.objectContaining({ reason: "verified-commit-required", errorKind: "unavailable" }),
      ]);
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );
});
