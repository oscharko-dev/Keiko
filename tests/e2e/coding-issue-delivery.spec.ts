import { writeDeliveryJourneyReceipt } from "./support/coding-issue-delivery-evidence.js";
import { captureDeliveryModes } from "./support/coding-issue-commit-evidence.js";
import { join } from "node:path";
import { buildPrReadBranchHeadArgv } from "../../packages/keiko-tools/src/git-pr-gateway.js";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { readActivityLogText } from "../../scripts/lib/activity-log-files.mjs";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeApprovalReviewChannelPayload,
  VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import { openCodingIssueWorkbench, selectCodingIssueMode } from "./support/coding-issue-browser.js";
import {
  issueResolutionTaskInstructions,
  startStructuredDeliveryRun,
} from "./support/coding-issue-journey-live.js";
import {
  commitControlPath,
  commitObservationPath,
  COMMIT_MESSAGE,
  type CommitFixtureOperation,
} from "./support/coding-issue-commit.js";
import {
  DELIVERY_LAUNCHER_SECRET,
  DELIVERY_REPOSITORY,
  DELIVERY_TEMPLATE,
  DELIVERY_TITLE,
  deliveryDescriptionModelState,
  deliveryRemote,
  deliveryRepository,
  deliveryRevisionPath,
  deliveryStateDir,
  type DeliveryFixtureOperation,
} from "./support/coding-issue-delivery.js";
import {
  readState,
  writeState,
  type DeliveryProviderState,
} from "./servers/coding-issue-delivery-transport.mjs";
import type { DeliveryDescriptionModelState } from "./servers/coding-issue-description-model.mjs";

const stateDir = deliveryStateDir();
const repository = deliveryRepository(stateDir);
const WINDOW_ID = "draft-delivery-proof";
const CSRF = { "X-Keiko-CSRF": "1" };
test.describe.configure({ mode: "serial" });
const completedCases: string[] = [];
test.afterEach((): void => {
  const info = test.info();
  if (info.status === "passed") completedCases.push(info.title);
});
test.afterAll((): void => {
  if (completedCases.length === 12) writeDeliveryJourneyReceipt(stateDir, completedCases);
});
interface Observation {
  readonly phase: string;
  readonly runId?: string;
  readonly lastControl: number;
  readonly completedControls: readonly number[];
  readonly failedControls: readonly number[];
  readonly controlResults: Readonly<Record<string, Observation["result"]>>;
  readonly result?: {
    readonly status: string;
    readonly verifiedCommit?: VerifiedCommitResult;
    readonly draftDelivery?: { readonly status: string; readonly record?: DraftDeliveryRecord };
  };
  readonly rawContentRecorded: boolean;
}
function observe(): Observation {
  return JSON.parse(readFileSync(commitObservationPath(stateDir), "utf8")) as Observation;
}
function provider(): DeliveryProviderState {
  return readState(stateDir);
}
function descriptionModel(): DeliveryDescriptionModelState {
  return JSON.parse(
    readFileSync(deliveryDescriptionModelState(stateDir), "utf8"),
  ) as DeliveryDescriptionModelState;
}
async function control(
  operation: CommitFixtureOperation | DeliveryFixtureOperation,
  proposalId?: string,
): Promise<Observation> {
  return waitControl(await startControl(operation, proposalId));
}
async function startControl(
  operation: CommitFixtureOperation | DeliveryFixtureOperation,
  proposalId?: string,
): Promise<number> {
  const id = observe().lastControl + 1;
  const path = commitControlPath(stateDir);
  writeFileSync(
    `${path}.next`,
    JSON.stringify({ id, operation, ...(proposalId === undefined ? {} : { proposalId }) }),
  );
  renameSync(`${path}.next`, path);
  await expect.poll(() => observe().lastControl, { timeout: 60_000 }).toBe(id);
  return id;
}
async function waitControl(id: number): Promise<Observation> {
  await expect
    .poll(
      () => {
        const current = observe();
        if (current.failedControls.includes(id)) return "failed";
        return current.completedControls.includes(id) ? "completed" : "pending";
      },
      { timeout: 60_000 },
    )
    .toBe("completed");
  const current = observe();
  const result = current.controlResults[String(id)];
  return { ...current, ...(result === undefined ? {} : { result }) };
}
async function snapshot(page: Page): Promise<CodingWorkbenchRuntimeSnapshot> {
  const response = await page.request.get("/api/coding-workbench/runtime/status");
  expect(response.ok()).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}
async function startPendingProposal(
  page: Page,
  operation: "propose" | "push-propose" | "pr-propose",
  actionKind: "commit" | "push" | "pull-request",
): Promise<{ readonly controlId: number; readonly proposalId: string }> {
  const controlId = await startControl(operation);
  await expect
    .poll(async () => (await snapshot(page)).pendingPermission?.actionKind)
    .toBe(actionKind);
  const proposalId = (await snapshot(page)).pendingPermission?.requestId;
  if (proposalId === undefined)
    throw new Error(`Expected canonical pending ${actionKind} proposal`);
  return { controlId, proposalId };
}
type ProposalOperation = "propose" | "push-propose" | "pr-propose";
function proposalIdFor(operation: ProposalOperation, proposed: Observation): string | undefined {
  return operation === "propose"
    ? proposed.result?.verifiedCommit?.proposalId
    : proposed.result?.draftDelivery?.record?.proposalId;
}
async function readyProposal(
  page: Page,
  mode: CodingWorkbenchMode,
  operation: ProposalOperation,
  actionKind: "commit" | "push" | "pull-request",
  approve: () => Promise<void>,
  beforeApproval?: (proposalId: string) => Promise<void>,
): Promise<{ readonly proposed: Observation; readonly proposalId: string }> {
  if (mode === "autonomous-delivery") {
    const proposed = await control(operation);
    const proposalId = proposalIdFor(operation, proposed);
    if (proposalId === undefined) throw new Error(`Expected ready ${actionKind} proposal`);
    expect(proposed.result).toHaveProperty("approvalDisposition", "ready");
    expect((await snapshot(page)).pendingPermission).toBeUndefined();
    await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
    return { proposed, proposalId };
  }
  const pending = await startPendingProposal(page, operation, actionKind);
  await beforeApproval?.(pending.proposalId);
  await approve();
  const proposed = await waitControl(pending.controlId);
  expect(proposed.result).toHaveProperty("approvalDisposition", "ready");
  return { proposed, proposalId: pending.proposalId };
}
function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8", timeout: 30_000 }).trim();
}

function activityLogLines(): readonly Record<string, unknown>[] {
  return readActivityLogText(join(stateDir, "bff-state", "state", "logs"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * ADR-0124 D6 (owner decision, 2026-09-26): a file edit raises no governed ask in ANY mode any
 * more, so `approved` below can never observe `"file-edit"` -- the edit's one human approval is now
 * the change review the mode policy requires before anything is written
 * (governed-assist/supervised-coding review every edit; autonomous-delivery applies without one),
 * never the retired pre-write ask. "Closing the review card is routine and reports nothing from the
 * browser; the server line above is the review's evidence" (ADR-0124 D6): this reads that server
 * line -- `coding-runtime.editor-mutation.settled` (codingToolReadEditPorts.ts's `completedEdit`) --
 * to relocate what the retired ask used to prove: an edit was actually gated through the mutation
 * lease and applied, under this run's own correlation, never silently bypassed. Same helper as
 * `coding-issue-commit.spec.ts`'s own `editorMutationsSettledFor`, kept local rather than shared:
 * each reads its own file's `stateDir` constant, and the whole check is three lines.
 */
function editorMutationsSettledFor(runId: string): readonly Record<string, unknown>[] {
  return activityLogLines().filter(
    (line) => line.op === "coding-runtime.editor-mutation.settled" && line.correlationId === runId,
  );
}

/**
 * ADR-0124 D6 (owner decision, 2026-09-26): "a human's 'no' rejects one step, not the run" -- a
 * denial no longer settles the run `failed`/`revoked` (codingRuntimeOrchestrator.ts's
 * `decideApproval` transitions unconditionally to `running` once a decision settles, whichever way
 * it went). The decision itself is what the activity log records instead
 * (`coding-runtime.approval.decided`, `recordRuntimeApprovalDecided`), keyed by the exact approval
 * `requestId` (the same value the pending permission's own `requestId` carries) so this is tied to
 * the specific denied proposal, never any other decision on the run.
 */
function approvalDecisionsFor(
  requestId: string,
  decision: "approved" | "denied",
): readonly Record<string, unknown>[] {
  return activityLogLines().filter(
    (line) =>
      line.op === "coding-runtime.approval.decided" &&
      line.requestId === requestId &&
      line.decision === decision,
  );
}

/**
 * PR #3625 retired the setup card's own "Issue URL or #number" field and its "Preview issue" /
 * "Use this issue" / "Bind workspace" controls: binding a workspace is now unrelated to resolving
 * any issue (coding-issue-journey-live.ts's `previewAndBindIssue` comment). This provisions the
 * plain repository/branch task workspace directly through the same real, already-relied-on API the
 * sibling `coding-issue-commit.spec.ts`'s own `provision` uses for its (issue-less) workspace,
 * rather than reimplementing the "Code setup" combobox flow `coding-issue-intake.spec.ts`'s
 * `bindPlainWorkspace` drives for a DIFFERENT fixture -- both are real product affordances for the
 * same effect; this file already trusted the API one before PR #3625 (via the retired flow's own
 * `bindIssue`, which cleared and rebound through it too) and every test case here needs its own
 * fresh workspace (`serial` mode reuses one server across all of them).
 */
async function provisionDeliveryWorkspace(page: Page, taskId: string): Promise<string> {
  const cleared = await page.request.delete("/api/task-workspaces/active", {
    headers: CSRF,
    data: {},
  });
  expect(cleared.ok(), await cleared.text()).toBe(true);
  const response = await page.request.post("/api/task-workspaces", {
    headers: CSRF,
    data: { root: repository, taskId, baseBranch: "main", requestedBy: "delivery-browser-fixture" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { instance } = (await response.json()) as {
    readonly instance: { readonly workspaceId: string; readonly managedWorktreePath: string };
  };
  const repaired = await page.request.post("/api/task-workspaces/reconciliation", {
    headers: CSRF,
    data: { requestedBy: "delivery-browser-fixture" },
  });
  expect(repaired.ok()).toBe(true);
  const activated = await page.request.post("/api/task-workspaces/active", {
    headers: CSRF,
    data: {
      workspaceId: instance.workspaceId,
      requestedBy: "delivery-browser-fixture",
      acquireLock: false,
    },
  });
  expect(activated.ok(), await activated.text()).toBe(true);
  await page.reload();
  return instance.managedWorktreePath;
}
async function startVerified(
  page: Page,
  mode: CodingWorkbenchMode,
  number: number,
): Promise<string> {
  await openCodingIssueWorkbench(page, {
    repository,
    windowId: WINDOW_ID,
    launcherSecret: DELIVERY_LAUNCHER_SECRET,
  });
  const root = await provisionDeliveryWorkspace(page, `delivery-${mode}-${String(number)}`);
  await selectCodingIssueMode(page, mode);
  // ADR-0137 D3 / #3625 review: a Workbench prompt's issue link is task CONTEXT ONLY --
  // `previewAndAcceptIssue` always sends `issuePurpose: "context"` by design
  // (coding-workbench-runtime-mutations.ts), so a run started that way never gets the delivery
  // binding draft delivery (push/PR proposals) requires. This suite exercises real push/PR
  // delivery, so it starts through the structured runtime start API with `issuePurpose: "delivery"`
  // instead (`startStructuredDeliveryRun`, coding-issue-journey-live.ts), which also settles the
  // per-repository GitHub issue-reader grant this fixture's freshly-provisioned repository needs.
  await startStructuredDeliveryRun(page, {
    // The grant is keyed by the canonical registered repository, never a managed worktree's own
    // path (githubIssueReaderAuthorization.ts's `githubIssueReaderGrantRoot`: a task worktree
    // inherits ITS repository's grant; a run's own auth check already reads the active workspace's
    // repository root, which for a managed worktree is this canonical path, not `root` above).
    repositoryPath: repository,
    requestedMode: mode,
    issueRef: `#${String(number)}`,
    taskIntent: issueResolutionTaskInstructions(`#${String(number)}`),
  });
  const approved = new Set<string>();
  await expect
    .poll(
      async () => {
        const current = await snapshot(page);
        if (current.pendingPermission !== undefined) {
          await expect(
            page.getByRole("button", { name: "Approve once", exact: true }),
          ).toBeEnabled();
          approved.add(current.pendingPermission.actionKind ?? "missing");
          await page.getByRole("button", { name: "Approve once", exact: true }).click();
        }
        return observe().phase;
      },
      { timeout: 120_000 },
    )
    .toBe("verified-turn-ready");
  const afterTurn = await snapshot(page);
  expect([...approved].sort()).toEqual(
    mode === "governed-assist" ? ["git-stage", "verification-command"] : [],
  );
  if (afterTurn.runId === undefined) throw new Error("Expected an active run id");
  const settled = editorMutationsSettledFor(afterTurn.runId);
  expect(settled.length).toBeGreaterThan(0);
  expect(settled.every((line) => line.state === "succeeded" && line.actionKind === "edit")).toBe(
    true,
  );
  expect(afterTurn.issueBinding?.issueNumber).toBe(number);
  const { proposed, proposalId } = await readyProposal(
    page,
    mode,
    "propose",
    "commit",
    async () => {
      await page.getByRole("button", { name: "Approve once", exact: true }).click();
      await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
    },
    async () => {
      await expect(
        page.getByRole("region", { name: "Reviewed commit message" }).locator("pre"),
      ).toHaveText(COMMIT_MESSAGE, { useInnerText: false });
    },
  );
  expect(proposed.result?.verifiedCommit?.status).toBe("approval-required");
  expect((await control("execute", proposalId)).result?.verifiedCommit?.status).toBe("succeeded");
  return root;
}
async function finish(page: Page, revoked = false): Promise<void> {
  await control("finish");
  const current = await snapshot(page);
  if (revoked) {
    expect(current).toMatchObject({ state: "failed", failureCode: "revoked" });
    return;
  }
  await expect.poll(async () => (await snapshot(page)).state).toBe("succeeded");
}

async function approveDelivery(page: Page): Promise<void> {
  await expect(page.getByRole("region", { name: "Reviewed delivery target" })).toContainText(
    DELIVERY_REPOSITORY,
  );
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
}
async function review(
  page: Page,
  runId: string,
): Promise<CodingWorkbenchRuntimeApprovalReviewChannelPayload> {
  const response = await page.request.get(
    `/api/coding-workbench/runtime/runs/${runId}/approval-review`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeApprovalReviewChannelPayload;
}
async function expectReviewedPullRequest(
  page: Page,
  runId: string,
  issueNumber: number,
): Promise<{ readonly title: string; readonly body: string }> {
  const pending = (await review(page, runId)).pending?.draftDelivery;
  if (pending === undefined || !("title" in pending)) throw new Error("Expected actual PR review");
  expect(pending.title).toBe(DELIVERY_TITLE);
  expect(pending.body.startsWith(DELIVERY_TEMPLATE)).toBe(true);
  expect(pending.body.match(/Closes #\d+/gu)).toEqual([`Closes #${String(issueNumber)}`]);
  await expect(
    page.getByRole("region", { name: "Reviewed pull request description" }).locator("pre"),
  ).toHaveText(pending.body, { useInnerText: false });
  return pending;
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
async function expectFullUnpairedReview(
  request: APIRequestContext,
  mode: CodingWorkbenchMode,
  runId: string,
): Promise<void> {
  if (mode !== "autonomous-delivery") return;
  const unpaired = await request.get(`/api/coding-workbench/runtime/runs/${runId}/approval-review`);
  expect(await unpaired.json()).toEqual({ session: "unpaired" });
}
async function captureFirstDeliveryMode(page: Page, index: number): Promise<void> {
  if (index !== 1) return;
  await captureDeliveryModes(page, WINDOW_ID, 'section[aria-label="Coding Workbench"][data-state]');
}
function requiredCreatedBody(
  reviewed: { readonly body: string } | undefined,
  createdNumber: number | undefined,
): string {
  const body = reviewed?.body ?? provider().pullRequestBodies[String(createdNumber)]?.body;
  if (body === undefined) throw new Error("Expected created pull-request body");
  return body;
}
function requiredPullRequestNumber(record: DraftDeliveryRecord): number {
  const number = record.pullRequest?.number;
  if (number === undefined) throw new Error("Expected created pull request number");
  return number;
}

test("#3387 @coding-issue-delivery hermetic provider refuses foreign hosts repositories and refs", () => {
  const before = provider();
  const githubRead = buildPrReadBranchHeadArgv({
    ownerAndRepo: DELIVERY_REPOSITORY,
    headBranchName: "main",
  });
  const cases = [
    {
      tool: "gh",
      args: githubRead.map((arg) => (arg === "github.com" ? "attacker.example" : arg)),
    },
    {
      tool: "gh",
      args: buildPrReadBranchHeadArgv({ ownerAndRepo: "fixture/foreign", headBranchName: "main" }),
    },
    {
      tool: "gh",
      args: buildPrReadBranchHeadArgv({
        ownerAndRepo: DELIVERY_REPOSITORY,
        headBranchName: "forbidden-ref",
      }),
    },
    {
      tool: "git",
      args: [
        "push",
        "https://attacker.example/fixture/issue-delivery.git",
        `${"a".repeat(40)}:refs/heads/main`,
      ],
    },
    {
      tool: "git",
      args: [
        "push",
        `https://github.com/${DELIVERY_REPOSITORY}.git`,
        `${"a".repeat(40)}:refs/heads/main`,
      ],
    },
  ];
  for (const entry of cases) {
    const result = spawnSync(join(stateDir, "provider-bin", entry.tool), [...entry.args], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(73);
  }
  expect(provider()).toMatchObject({
    pushes: before.pushes,
    creates: before.creates,
    rejections: before.rejections + cases.length,
    rejectionReasons: {
      "branch-query": 1,
      "gh-target": 2,
      "push-target": 2,
    },
  });
  expect(git(deliveryRemote(stateDir), ["for-each-ref", "--format=%(refname)"])).toBe(
    "refs/heads/main",
  );
});

function recordFor(
  observation: Observation,
  phase: DraftDeliveryRecord["phase"],
): DraftDeliveryRecord {
  const record = observation.result?.draftDelivery?.record;
  if (record === undefined)
    throw new Error(`Expected delivery record: ${JSON.stringify(observation.result)}`);
  expect(record.phase).toBe(phase);
  return record;
}
function runFor(observation: Observation): string {
  if (observation.runId === undefined) throw new Error("Expected run observation");
  return observation.runId;
}
async function expectDenied(
  operation: DeliveryFixtureOperation,
  proposalId?: string,
): Promise<void> {
  expect((await control(operation, proposalId)).result?.status).toBe("denied");
}
async function expectReplayRejected(
  mode: CodingWorkbenchMode,
  operation: DeliveryFixtureOperation,
  proposalId: string,
): Promise<void> {
  const expected = mode === "autonomous-delivery" ? "failed" : "denied";
  expect((await control(operation, proposalId)).result?.status).toBe(expected);
}

async function expectGeneratedDescription(
  page: Page,
  root: string,
  prNumber: number,
  beforeRequests: number,
): Promise<void> {
  await expect
    .poll(async () => (await snapshot(page)).descriptionStatus?.reason, { timeout: 60_000 })
    .toBe("generated");
  const status = (await snapshot(page)).descriptionStatus;
  if (
    status?.proposalId === undefined ||
    status.snapshotDigest === null ||
    status.draftDigest === null
  ) {
    throw new Error("Expected a retained generated description");
  }
  expect(status).toMatchObject({
    state: "current",
    reason: "generated",
    generationVersion: 1,
    artifactOutcome: "complete",
  });
  expect(status.snapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(status.draftDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(descriptionModel()).toMatchObject({
    requests: beforeRequests + 1,
    rejections: 0,
    lastEvidenceCount: 1,
  });
  const staleReview = await page.request.post("/api/git-delivery/pr-description/review", {
    headers: CSRF,
    data: {
      schemaVersion: "1",
      projectId: root,
      ownerAndRepo: DELIVERY_REPOSITORY,
      prNumber,
      snapshotDigest: "0".repeat(64),
      proposalId: status.proposalId,
    },
  });
  expect(staleReview.status()).toBe(403);
  expect(await staleReview.json()).toMatchObject({
    // The retained description authority is bound to the generated snapshot. A substituted digest
    // must fail at admission before the proposal holder can reveal whether that key exists.
    error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" },
  });
  const generatedReview = await page.request.post("/api/git-delivery/pr-description/review", {
    headers: CSRF,
    data: {
      schemaVersion: "1",
      projectId: root,
      ownerAndRepo: DELIVERY_REPOSITORY,
      prNumber,
      snapshotDigest: status.snapshotDigest,
      proposalId: status.proposalId,
    },
  });
  expect(generatedReview.ok(), await generatedReview.text()).toBe(true);
  const generated = (await generatedReview.json()) as {
    readonly outcome: string;
    readonly preview: {
      readonly managedRegion: string;
      readonly status: { readonly binding: { readonly draftDigest: string } };
    };
  };
  expect(generated.outcome).toBe("preview");
  expect(generated.preview.managedRegion).toContain(
    "Updates the accepted implementation and its verification fixture.",
  );
  expect(generated.preview.status.binding.draftDigest).toBe(status.draftDigest);
}

for (const [index, mode] of (
  ["autonomous-delivery", "supervised-coding", "governed-assist"] as const
).entries()) {
  test(`#3387 @coding-issue-delivery actual issue to reviewed draft PR in ${mode}`, async ({
    page,
    request,
  }) => {
    const beforeProvider = provider();
    const root = await startVerified(page, mode, 42 + index);
    const head = git(root, ["rev-parse", "HEAD"]);
    const { proposed, proposalId: pushProposalId } = await readyProposal(
      page,
      mode,
      "push-propose",
      "push",
      () => approveDelivery(page),
      async (proposalId) => {
        expect(provider().pushes).toBe(beforeProvider.pushes);
        await expectDenied("push-execute", proposalId);
        const unpaired = await request.get(
          `/api/coding-workbench/runtime/runs/${(await snapshot(page)).runId ?? ""}/approval-review`,
        );
        expect(await unpaired.json()).toEqual({ session: "unpaired" });
      },
    );
    recordFor(proposed, "push-proposed");
    expect(provider().pushes).toBe(beforeProvider.pushes);
    await expectFullUnpairedReview(request, mode, runFor(proposed));
    recordFor(await control("push-execute", pushProposalId), "pushed");
    expect(provider().lastPush).toMatchObject({
      sha: head,
      privateView: true,
      pinnedCredentialHost: true,
    });
    expect(git(deliveryRemote(stateDir), ["rev-parse", `refs/heads/${provider().headRef}`])).toBe(
      head,
    );
    expect(provider().pushes).toBe(beforeProvider.pushes + 1);
    if (mode !== "autonomous-delivery")
      await expectReplayRejected(mode, "push-execute", pushProposalId);
    let reviewedPullRequest: { readonly title: string; readonly body: string } | undefined;
    const { proposed: pr, proposalId: prProposalId } = await readyProposal(
      page,
      mode,
      "pr-propose",
      "pull-request",
      () => approveDelivery(page),
      async (proposalId) => {
        await expectDenied("pr-execute", proposalId);
        expect(provider().creates).toBe(beforeProvider.creates);
        reviewedPullRequest = await expectReviewedPullRequest(
          page,
          (await snapshot(page)).runId ?? "",
          42 + index,
        );
        await captureFirstDeliveryMode(page, index);
      },
    );
    recordFor(pr, "pr-proposed");
    expect(provider().creates).toBe(beforeProvider.creates);
    const created = await control("pr-execute", prProposalId);
    const createdRecord = recordFor(created, "draft-created");
    const createdNumber = createdRecord.pullRequest?.number;
    const createdBody = requiredCreatedBody(reviewedPullRequest, createdNumber);
    expect(createdBody.startsWith(DELIVERY_TEMPLATE)).toBe(true);
    expect(createdBody.match(/Closes #\d+/gu)).toEqual([`Closes #${String(42 + index)}`]);
    expect(provider()).toMatchObject({
      creates: beforeProvider.creates + 1,
      lastTitleDigest: digest(reviewedPullRequest?.title ?? DELIVERY_TITLE),
      lastBodyDigest: digest(createdBody),
    });
    if (mode !== "autonomous-delivery")
      await expectReplayRejected(mode, "pr-execute", prProposalId);
    const number = requiredPullRequestNumber(createdRecord);
    const beforeDescriptions = descriptionModel().requests;
    await finish(page);
    await page.reload();
    await expect(
      page
        .getByRole("region", { name: "Repository delivery" })
        .getByRole("link", { name: `Pull request #${String(number)}`, exact: true }),
    ).toHaveAttribute("href", `https://github.com/${DELIVERY_REPOSITORY}/pull/${String(number)}`);
    await expect(
      page.getByRole("region", { name: "Reviewed pull request description" }),
    ).toHaveCount(0);
    expect((await snapshot(page)).draftDelivery).toEqual(createdRecord);
    // #3401: the terminal transition dispatches through deps.ts's real production dispatcher and
    // Model Gateway. The lower loopback provider derives its citations from the captured snapshot's
    // actual evidence ids; the retained proposal below proves this is a reviewable bound artifact.
    await expectGeneratedDescription(page, root, number, beforeDescriptions);
  });
}

test("#3387 @coding-issue-delivery Full consumed proposals fail closed on replay", async ({
  page,
}) => {
  const before = provider();
  await startVerified(page, "autonomous-delivery", 52);
  const push = await readyProposal(page, "autonomous-delivery", "push-propose", "push", () =>
    approveDelivery(page),
  );
  recordFor(await control("push-execute", push.proposalId), "pushed");
  const pullRequest = await readyProposal(
    page,
    "autonomous-delivery",
    "pr-propose",
    "pull-request",
    () => approveDelivery(page),
  );
  recordFor(await control("pr-execute", pullRequest.proposalId), "draft-created");
  const effects = provider();
  await expectReplayRejected("autonomous-delivery", "push-execute", push.proposalId);
  await expectReplayRejected("autonomous-delivery", "pr-execute", pullRequest.proposalId);
  expect(provider()).toMatchObject({
    pushes: before.pushes + 1,
    creates: before.creates + 1,
  });
  expect(provider()).toEqual(effects);
  await control("finish");
});

function setProviderMode(mode: DeliveryProviderState["mode"]): void {
  writeState(stateDir, { ...provider(), mode });
}
async function pushApproved(
  page: Page,
  mode: "autonomous-delivery" | "supervised-coding" = "autonomous-delivery",
): Promise<void> {
  const { proposed, proposalId } = await readyProposal(page, mode, "push-propose", "push", () =>
    approveDelivery(page),
  );
  recordFor(proposed, "push-proposed");
  recordFor(await control("push-execute", proposalId), "pushed");
}

test("#3387 @coding-issue-delivery explicit push denial rejects only that step", async ({
  page,
}) => {
  const before = provider();
  await startVerified(page, "governed-assist", 45);
  const pending = await startPendingProposal(page, "push-propose", "push");
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  // ADR-0124 D6 (owner decision, 2026-09-26): "a human's 'no' rejects one step, not the run" -- the
  // run returns to `running`, never `failed`/`revoked`.
  await expect.poll(async () => (await snapshot(page)).state).toBe("running");
  expect((await waitControl(pending.controlId)).result?.status).toBe("cancelled");
  await expectDenied("push-execute", pending.proposalId);
  expect(provider()).toMatchObject({ pushes: before.pushes, creates: before.creates });
  expect(approvalDecisionsFor(pending.proposalId, "denied").length).toBeGreaterThan(0);
  await finish(page);
});

test("#3387 @coding-issue-delivery dirty worktree after approval cannot publish", async ({
  page,
}) => {
  const before = provider();
  const root = await startVerified(page, "autonomous-delivery", 46);
  const proposed = await control("push-propose");
  recordFor(proposed, "push-proposed");
  expect(proposed.result).toHaveProperty("approvalDisposition", "ready");
  const proposalId = proposed.result?.draftDelivery?.record?.proposalId;
  if (proposalId === undefined) throw new Error("Expected ready push proposal");
  writeFileSync(join(root, "unverified.txt"), "Unverified fixture content.");
  expect(recordFor(await control("push-execute", proposalId), "recovery-required").reason).toBe(
    "remote-drift",
  );
  expect(provider()).toMatchObject({ pushes: before.pushes, creates: before.creates });
  await page.reload();
  await expect(page.getByRole("region", { name: "Repository delivery" })).toContainText(
    "Delivery needs reconciliation",
  );
  await finish(page);
});

test("#3387 @coding-issue-delivery changed frozen issue refuses the approved push", async ({
  page,
}) => {
  const before = provider();
  await startVerified(page, "autonomous-delivery", 47);
  const proposed = await control("push-propose");
  recordFor(proposed, "push-proposed");
  expect(proposed.result).toHaveProperty("approvalDisposition", "ready");
  const proposalId = proposed.result?.draftDelivery?.record?.proposalId;
  if (proposalId === undefined) throw new Error("Expected ready push proposal");
  writeFileSync(deliveryRevisionPath(stateDir), "2");
  expect(recordFor(await control("push-execute", proposalId), "recovery-required").reason).toBe(
    "issue-drift",
  );
  expect(provider()).toMatchObject({ pushes: before.pushes, creates: before.creates });
  writeFileSync(deliveryRevisionPath(stateDir), "1");
  await finish(page);
});

test("#3387 @coding-issue-delivery changed effective push URL refuses before provider dispatch", async ({
  page,
}) => {
  const before = provider();
  const root = await startVerified(page, "autonomous-delivery", 48);
  const proposed = await control("push-propose");
  recordFor(proposed, "push-proposed");
  expect(proposed.result).toHaveProperty("approvalDisposition", "ready");
  const proposalId = proposed.result?.draftDelivery?.record?.proposalId;
  if (proposalId === undefined) throw new Error("Expected ready push proposal");
  git(root, ["config", "remote.origin.pushurl", "https://github.com/fixture/foreign.git"]);
  expect(recordFor(await control("push-execute", proposalId), "recovery-required").reason).toBe(
    "remote-drift",
  );
  expect(provider()).toMatchObject({
    pushes: before.pushes,
    creates: before.creates,
    rejections: before.rejections,
  });
  git(root, ["config", "--unset", "remote.origin.pushurl"]);
  await finish(page);
});

test("#3387 @coding-issue-delivery uncertain push is reconciled without another mutation", async ({
  page,
}) => {
  const before = provider();
  await startVerified(page, "autonomous-delivery", 49);
  const proposed = await control("push-propose");
  recordFor(proposed, "push-proposed");
  expect(proposed.result).toHaveProperty("approvalDisposition", "ready");
  const proposalId = proposed.result?.draftDelivery?.record?.proposalId;
  if (proposalId === undefined) throw new Error("Expected ready push proposal");
  setProviderMode("push-response-loss");
  recordFor(await control("push-execute", proposalId), "recovery-required");
  expect(provider().pushes).toBe(before.pushes + 1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  setProviderMode("normal");
  recordFor(await control("reconcile"), "pushed");
  expect(provider()).toMatchObject({ pushes: before.pushes + 1, creates: before.creates });
  await finish(page);
});

test("#3387 @coding-issue-delivery unknown PR after response loss is not adopted or recreated", async ({
  page,
}) => {
  const before = provider();
  await startVerified(page, "autonomous-delivery", 50);
  await pushApproved(page);
  const proposed = await control("pr-propose");
  recordFor(proposed, "pr-proposed");
  expect(proposed.result).toHaveProperty("approvalDisposition", "ready");
  const proposalId = proposed.result?.draftDelivery?.record?.proposalId;
  if (proposalId === undefined) throw new Error("Expected ready pull-request proposal");
  setProviderMode("create-response-loss");
  expect(recordFor(await control("pr-execute", proposalId), "recovery-required").reason).toBe(
    "ambiguous-remote",
  );
  expect(provider().creates).toBe(before.creates + 1);
  setProviderMode("normal");
  expect(recordFor(await control("reconcile"), "recovery-required").reason).toBe(
    "ambiguous-remote",
  );
  recordFor(await control("pr-propose"), "recovery-required");
  expect(provider()).toMatchObject({ pushes: before.pushes + 1, creates: before.creates + 1 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  await finish(page);
});

test("#3387 @coding-issue-delivery PR denial keeps the pushed commit but creates no PR", async ({
  page,
}) => {
  const before = provider();
  await startVerified(page, "supervised-coding", 51);
  await pushApproved(page, "supervised-coding");
  const pending = await startPendingProposal(page, "pr-propose", "pull-request");
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  // ADR-0124 D6 (owner decision, 2026-09-26): "a human's 'no' rejects one step, not the run" -- the
  // run returns to `running`, never `failed`/`revoked`.
  await expect.poll(async () => (await snapshot(page)).state).toBe("running");
  expect((await waitControl(pending.controlId)).result?.status).toBe("cancelled");
  await expectDenied("pr-execute", pending.proposalId);
  expect(provider()).toMatchObject({ pushes: before.pushes + 1, creates: before.creates });
  expect(approvalDecisionsFor(pending.proposalId, "denied").length).toBeGreaterThan(0);
  await finish(page);
});
