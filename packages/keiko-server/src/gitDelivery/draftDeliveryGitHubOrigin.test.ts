import { afterEach, describe, expect, it } from "vitest";
import type { CodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import {
  isDraftDeliveryRepositoryBinding,
  isDraftDeliveryRecord,
  isIssueBoundDraftDeliveryRecord,
  isPullRequestDraftDeliveryRecord,
} from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import { PR_DESCRIPTION_REGION_START } from "@oscharko-dev/keiko-contracts/runtime/pr-description-region";
import { DraftDeliveryFixture } from "./draftDeliveryServiceTestSupport.js";
import { DraftDeliveryController } from "./draftDeliveryService.js";
import type { DraftDeliveryRunContext } from "./draftDeliveryTypes.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

// ADR-0086 D13 (owner decision, 2026-10-30): a Workbench pull request never depends on an issue. A run
// on a verified github.com origin opens a draft pull request from its own task branch whether or not
// an issue is bound; an accepted issue only links it. These tests drive the real controller and the
// real governed publish lifecycle against a local bare repository that stands in for GitHub.
const GIT_FIXTURE_TIMEOUT_MS = 30_000;
const TITLE = "feat: bounded change";

let fixture: DraftDeliveryFixture | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});
async function githubFixture(
  options: ConstructorParameters<typeof DraftDeliveryFixture>[0] = {},
): Promise<DraftDeliveryFixture> {
  const created = new DraftDeliveryFixture({ issueFree: true, githubOrigin: true, ...options });
  fixture = created;
  await created.recordVerifiedCommit();
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
async function pushed(subject: DraftDeliveryFixture): Promise<void> {
  expect(await approveAndExecute(subject, await subject.service.proposePush())).toMatchObject({
    record: { phase: "pushed" },
  });
}
function refusalLines(subject: DraftDeliveryFixture): readonly Record<string, unknown>[] {
  return subject.events
    .filter((event) => event.op === "git.draft-delivery" && event.extra?.phase === "refused")
    .map((event) => ({ ...event.extra, errorKind: event.errorKind, level: event.level }));
}

describe("an issue-free run on a verified github.com origin opens a draft pull request", () => {
  it(
    "binds its push to the repository and opens exactly one draft pull request with no closing line",
    async () => {
      const subject = await githubFixture();
      const head = subject.git(["rev-parse", "HEAD"]);
      const proposal = await subject.service.proposePush();
      if (proposal.status !== "recorded") throw new Error("missing record");
      const binding = proposal.record.binding;
      expect(isDraftDeliveryRepositoryBinding(binding)).toBe(true);
      expect(binding).toMatchObject({
        kind: "github-repository",
        repository: "owner/repository",
        headRef: subject.branch,
        baseRef: "master",
        headSha: head,
      });
      expect(Object.keys(binding)).not.toContain("issueNumber");
      expect(await approveAndExecute(subject, proposal)).toMatchObject({
        record: { phase: "pushed", reason: "completed" },
      });
      // A push reads nothing from the provider: the pinned non-force push is its only evidence.
      expect(subject.events.some((event) => event.op === "git.draft-remote.observed")).toBe(false);

      const prProposal = await subject.service.proposePullRequest(TITLE);
      expect(prProposal).toMatchObject({ record: { phase: "pr-proposed" } });
      expect(subject.createCount).toBe(0);
      const proposalId = recordedId(subject, prProposal);
      const reviewed = subject.service.review(proposalId);
      const command = reviewed?.command;
      expect(command).toEqual({
        kind: "pr-create",
        ownerAndRepo: "owner/repository",
        headBranchName: subject.branch,
        baseBranchName: "master",
        title: TITLE,
        body: expect.any(String) as string,
        isDraft: true,
        canonicalGitHubIdentity: true,
        verifiedCommitSha: head,
      });
      if (command?.kind !== "pr-create") throw new Error("missing pull request command");
      expect(reviewed?.review).toMatchObject({ title: TITLE, body: command.body });

      const created = await approveAndExecute(subject, prProposal);
      expect(created, JSON.stringify(subject.events)).toMatchObject({
        record: {
          phase: "draft-created",
          reason: "completed",
          pullRequest: { number: 17, isDraft: true, baseRef: "master", headRef: subject.branch },
        },
      });
      expect(subject.createCount).toBe(1);
      expect(subject.changes.map((record) => record.phase)).toEqual([
        "push-proposed",
        "pushing",
        "pushed",
        "pr-proposed",
        "creating-pr",
        "draft-created",
      ]);
      // No issue exists, so the server-composed body links none; the checks section and the framed
      // description region remain.
      expect(subject.createBody).not.toMatch(/Closes #|Related issues/u);
      expect(subject.createBody).toContain(PR_DESCRIPTION_REGION_START);
      if (created.status !== "recorded") throw new Error("missing record");
      expect(isDraftDeliveryRecord(created.record)).toBe(true);
      expect(isPullRequestDraftDeliveryRecord(created.record)).toBe(true);
      expect(isIssueBoundDraftDeliveryRecord(created.record)).toBe(false);
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "logs the pull request journey on the Activity Log without any issue fact",
    async () => {
      const subject = await githubFixture();
      await pushed(subject);
      subject.events.length = 0;
      await approveAndExecute(subject, await subject.service.proposePullRequest(TITLE));
      const delivery = subject.events.filter((event) => event.op === "git.draft-delivery");
      expect(delivery.map((event) => event.extra?.phase)).toEqual(
        expect.arrayContaining(["pr-proposed", "creating-pr", "draft-created"]),
      );
      for (const event of delivery) {
        expect(event.correlationId).toBe("draft-delivery-test");
        expect(event.extra).not.toHaveProperty("issueNumber");
        expect(event.extra).not.toHaveProperty("issueBindingDigest");
      }
      const created = delivery.find((event) => event.extra?.phase === "draft-created");
      expect(
        expectActivityLogProof(
          "git.draft-delivery.emitted-line",
          formatActivityLogProofLine(created ?? {}),
        ),
      ).toMatchObject({ phase: "draft-created", reason: "completed" });
      expect(subject.events.find((event) => event.op === "git.draft-template")).toMatchObject({
        extra: { state: "ready", relatedIssueCount: 0 },
      });
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "keeps the record and the pull request identity across a later push, without a second create",
    async () => {
      const subject = await githubFixture();
      await pushed(subject);
      await approveAndExecute(subject, await subject.service.proposePullRequest(TITLE));
      const later = await subject.recordLaterCommit();
      const second = await approveAndExecute(subject, await subject.service.proposePush());
      expect(second).toMatchObject({
        record: {
          phase: "pushed",
          binding: { kind: "github-repository", headSha: later },
          pullRequest: { number: 17 },
        },
      });
      const settled = await subject.service.proposePullRequest(TITLE);
      expect(settled).toMatchObject({
        record: { phase: "draft-created", pullRequest: { number: 17, headSha: later } },
      });
      expect(subject.createCount).toBe(1);
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "stops before the create when the repository is no longer the one the run was admitted with",
    async () => {
      const subject = await githubFixture();
      await pushed(subject);
      const proposal = await subject.service.proposePullRequest(TITLE);
      subject.targetReason = "remote-drift";
      expect(await approveAndExecute(subject, proposal)).toMatchObject({
        record: { phase: "recovery-required", reason: "remote-drift" },
      });
      expect(subject.createCount).toBe(0);
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "refuses a pull request before any push as verified-commit-required",
    async () => {
      const subject = await githubFixture();
      expect(await subject.service.proposePullRequest(TITLE)).toEqual({
        status: "unavailable",
        reason: "verified-commit-required",
      });
      expect(subject.createCount).toBe(0);
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "leaves CI observation to issue-bound runs and says so",
    async () => {
      const subject = await githubFixture();
      await pushed(subject);
      expect(await new DraftDeliveryController(subject.options).reconcileForObservation()).toEqual({
        status: "unavailable",
        reason: "issue-binding-required",
      });
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );
});

describe("a run without a GitHub origin names the true reason for a refused pull request", () => {
  it(
    "refuses a foreign origin with github-origin-required, zero create calls and the refusal line",
    async () => {
      const subject = new DraftDeliveryFixture({ issueFree: true, realPublish: true });
      fixture = subject;
      await subject.recordVerifiedCommit();
      await pushed(subject);
      subject.events.length = 0;
      expect(await subject.service.proposePullRequest(TITLE)).toEqual({
        status: "unavailable",
        reason: "github-origin-required",
      });
      expect(subject.createCount).toBe(0);
      expect(refusalLines(subject)).toEqual([
        expect.objectContaining({
          runId: "run-1",
          reason: "github-origin-required",
          errorKind: "unavailable",
          level: "warn",
        }),
      ]);
      const line = subject.events.find((event) => event.op === "git.draft-delivery");
      expect(line?.correlationId).toBe("draft-delivery-test");
      expect(
        expectActivityLogProof(
          "git.draft-delivery.emitted-line",
          formatActivityLogProofLine(line ?? {}),
        ),
      ).toMatchObject({
        phase: "refused",
        reason: "github-origin-required",
        errorKind: "unavailable",
        correlationId: "draft-delivery-test",
      });
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );

  it(
    "refuses a repository with no origin with remote-required, without any effect",
    async () => {
      const subject = await githubFixture();
      const local = new DraftDeliveryController({
        ...subject.options,
        context: (): DraftDeliveryRunContext => ({ ...subject.context, repositoryKind: "local" }),
      });
      expect(await local.proposePullRequest(TITLE)).toEqual({
        status: "unavailable",
        reason: "remote-required",
      });
      expect(subject.createCount).toBe(0);
      expect(refusalLines(subject)).toEqual([
        expect.objectContaining({ reason: "remote-required", errorKind: "unavailable" }),
      ]);
    },
    GIT_FIXTURE_TIMEOUT_MS,
  );
});
