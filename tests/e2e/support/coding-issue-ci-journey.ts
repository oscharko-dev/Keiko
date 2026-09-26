import { expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { CodingToolResult } from "../../../packages/keiko-server/src/coding-runtime/codingToolIpc.js";
import { openCodingIssueWorkbench, selectCodingIssueMode } from "./coding-issue-browser.js";
import {
  issueResolutionTaskInstructions,
  previewAndAcceptIssue,
} from "./coding-issue-journey-live.js";
import {
  DELIVERY_LAUNCHER_SECRET,
  deliveryRepository,
  type DeliveryFixtureOperation,
} from "./coding-issue-delivery.js";
import {
  commitControlPath,
  commitObservationPath,
  type CommitFixtureOperation,
} from "./coding-issue-commit.js";
import { ciStateDir, type CiFixtureOperation } from "./coding-issue-ci.js";

export const CI_WINDOW_ID = "ci-readiness-proof";
const stateDir = ciStateDir();
const repository = deliveryRepository(stateDir);
export interface CiJourneyObservation {
  readonly phase: string;
  readonly lastControl: number;
  readonly completedControls: readonly number[];
  readonly failedControls: readonly number[];
  readonly controlResults: Readonly<Record<string, CodingToolResult | undefined>>;
  readonly result?: CodingToolResult;
}
export function ciObservation(): CiJourneyObservation {
  return JSON.parse(readFileSync(commitObservationPath(stateDir), "utf8")) as CiJourneyObservation;
}
export async function ciControl(
  operation: CommitFixtureOperation | DeliveryFixtureOperation | CiFixtureOperation,
  proposalId?: string,
): Promise<CodingToolResult | undefined> {
  const id = ciObservation().lastControl + 1;
  const path = commitControlPath(stateDir);
  writeFileSync(
    `${path}.next`,
    JSON.stringify({ id, operation, ...(proposalId === undefined ? {} : { proposalId }) }),
  );
  renameSync(`${path}.next`, path);
  await expect
    .poll(
      () => {
        const current = ciObservation();
        if (current.failedControls.includes(id)) return "failed";
        return current.completedControls.includes(id) ? "completed" : "pending";
      },
      { timeout: 60_000 },
    )
    .toBe("completed");
  return ciObservation().controlResults[String(id)];
}
export async function ciSnapshot(page: Page): Promise<CodingWorkbenchRuntimeSnapshot> {
  const response = await page.request.get("/api/coding-workbench/runtime/status");
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}
function requireCommitProposalId(result: CodingToolResult | undefined): string {
  if (result === undefined || !("verifiedCommit" in result))
    throw new Error("Expected ready CI commit proposal");
  return result.verifiedCommit.proposalId;
}
function requireDeliveryProposalId(result: CodingToolResult | undefined, intent: string): string {
  if (
    result === undefined ||
    !("draftDelivery" in result) ||
    result.draftDelivery.status !== "recorded"
  )
    throw new Error(`Expected ready CI ${intent} proposal`);
  return result.draftDelivery.record.proposalId;
}
/**
 * PR #3625 retired the setup card's own "Issue URL or #number" field and its "Preview issue" /
 * "Use this issue" / "Bind workspace" controls: binding a workspace is now unrelated to resolving
 * any issue (coding-issue-journey-live.ts's `previewAndBindIssue` comment). This provisions the
 * plain repository/branch task workspace directly through the same real API
 * `coding-issue-commit.spec.ts`'s own `provision` and `coding-issue-delivery.spec.ts`'s
 * `provisionDeliveryWorkspace` already rely on for a fresh workspace per draft, rather than
 * reimplementing the "Code setup" combobox flow a third time. The GitHub issue-reader grant this
 * fixture's repository needs is no longer a separate direct-API step either: `previewAndAcceptIssue`
 * settles the identical auth-required grant-retry dance through the real "Enable GitHub issue
 * access" control at Send time.
 */
async function provisionCiWorkspace(page: Page, taskId: string): Promise<void> {
  const clear = await page.request.delete("/api/task-workspaces/active", {
    headers: { "X-Keiko-CSRF": "1" },
    data: {},
  });
  expect(clear.ok()).toBe(true);
  const response = await page.request.post("/api/task-workspaces", {
    headers: { "X-Keiko-CSRF": "1" },
    data: { root: repository, taskId, baseBranch: "main", requestedBy: "ci-browser-fixture" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { instance } = (await response.json()) as {
    readonly instance: { readonly workspaceId: string };
  };
  const repaired = await page.request.post("/api/task-workspaces/reconciliation", {
    headers: { "X-Keiko-CSRF": "1" },
    data: { requestedBy: "ci-browser-fixture" },
  });
  expect(repaired.ok()).toBe(true);
  const activated = await page.request.post("/api/task-workspaces/active", {
    headers: { "X-Keiko-CSRF": "1" },
    data: {
      workspaceId: instance.workspaceId,
      requestedBy: "ci-browser-fixture",
      acquireLock: false,
    },
  });
  expect(activated.ok(), await activated.text()).toBe(true);
  await page.reload();
}
export async function commitCiCandidate(page: Page): Promise<void> {
  const proposal = await ciControl("propose");
  expect(proposal).toHaveProperty("verifiedCommit.status", "approval-required");
  expect(proposal).toHaveProperty("approvalDisposition", "ready");
  expect(await ciSnapshot(page)).not.toHaveProperty("pendingPermission");
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  const proposalId = requireCommitProposalId(proposal);
  expect(await ciControl("execute", proposalId)).toHaveProperty(
    "verifiedCommit.status",
    "succeeded",
  );
}
export async function pushCiCandidate(page: Page): Promise<void> {
  const proposal = await ciControl("push-propose");
  expect(proposal).toHaveProperty("draftDelivery.record.phase", "push-proposed");
  expect(proposal).toHaveProperty("approvalDisposition", "ready");
  expect(await ciSnapshot(page)).not.toHaveProperty("pendingPermission");
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  const proposalId = requireDeliveryProposalId(proposal, "push");
  const pushed = await ciControl("push-execute", proposalId);
  expect(pushed).toHaveProperty("draftDelivery.status", "recorded");
  expect(await ciSnapshot(page)).not.toHaveProperty("ciReadiness");
}
export async function startCiDraft(page: Page, issue: number): Promise<void> {
  await openCodingIssueWorkbench(page, {
    repository,
    windowId: CI_WINDOW_ID,
    launcherSecret: DELIVERY_LAUNCHER_SECRET,
  });
  await provisionCiWorkspace(page, `ci-${String(issue)}`);
  await selectCodingIssueMode(page, "autonomous-delivery");
  await previewAndAcceptIssue(page, issueResolutionTaskInstructions(`#${String(issue)}`));
  await expect.poll(() => ciObservation().phase, { timeout: 120_000 }).toBe("verified-turn-ready");
  await commitCiCandidate(page);
  await pushCiCandidate(page);
  const proposal = await ciControl("pr-propose");
  expect(proposal).toHaveProperty("draftDelivery.record.phase", "pr-proposed");
  expect(proposal).toHaveProperty("approvalDisposition", "ready");
  expect(await ciSnapshot(page)).not.toHaveProperty("pendingPermission");
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  const proposalId = requireDeliveryProposalId(proposal, "pull-request");
  expect(await ciControl("pr-execute", proposalId)).toHaveProperty(
    "draftDelivery.record.phase",
    "draft-created",
  );
  await expect(page.getByRole("region", { name: "CI readiness", exact: true })).toBeVisible();
}
export async function stopCiRun(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Stop run", exact: true }).click();
  await ciControl("finish");
  await expect
    .poll(async () => (await ciSnapshot(page)).state)
    .toMatch(/^(?:succeeded|cancelled)$/u);
}
