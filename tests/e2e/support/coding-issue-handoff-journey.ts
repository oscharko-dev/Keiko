// #3389 — drives the reused #3387 draft-delivery flow (issue bind, start, verified commit, push,
// PR create) to a confirmed accepted PR, exactly like the #3388 CI lane's own driver, but
// parameterized over THIS lane's own state directory (`handoffStateDir()`) rather than a module-
// level constant, since this lane's server coordinates onto that directory (see
// `playwright.coding-issue-handoff.config.ts`'s `KEIKO_E2E_STATE_DIR`).

import { expect, type Page } from "@playwright/test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { CodingToolResult } from "../../../packages/keiko-server/src/coding-runtime/codingToolIpc.js";
import { openCodingIssueWorkbench, selectCodingIssueMode } from "./coding-issue-browser.js";
import {
  issueResolutionTaskInstructions,
  startStructuredDeliveryRun,
} from "./coding-issue-journey-live.js";
import {
  commitControlPath,
  commitObservationPath,
  type CommitFixtureOperation,
} from "./coding-issue-commit.js";
import {
  DELIVERY_LAUNCHER_SECRET,
  deliveryRepository,
  type DeliveryFixtureOperation,
} from "./coding-issue-delivery.js";
import { handoffStateDir } from "./coding-issue-handoff.js";

export const HANDOFF_WINDOW_ID = "issue-handoff-proof";
const stateDir = handoffStateDir();
export const HANDOFF_REPOSITORY_ROOT = deliveryRepository(stateDir);

export interface StartedHandoffDraft {
  readonly runId: string;
  readonly projectId: string;
}

interface HandoffObservation {
  readonly phase: string;
  readonly lastControl: number;
  readonly completedControls: readonly number[];
  readonly failedControls: readonly number[];
  readonly controlResults: Readonly<Record<string, CodingToolResult | undefined>>;
  readonly result?: CodingToolResult;
}
function observation(): HandoffObservation {
  return JSON.parse(readFileSync(commitObservationPath(stateDir), "utf8")) as HandoffObservation;
}
export async function handoffControl(
  operation: CommitFixtureOperation | DeliveryFixtureOperation,
  proposalId?: string,
): Promise<CodingToolResult | undefined> {
  const id = observation().lastControl + 1;
  const path = commitControlPath(stateDir);
  writeFileSync(
    `${path}.next`,
    JSON.stringify({ id, operation, ...(proposalId === undefined ? {} : { proposalId }) }),
  );
  renameSync(`${path}.next`, path);
  await expect
    .poll(
      () => {
        const current = observation();
        if (current.failedControls.includes(id)) return "failed";
        return current.completedControls.includes(id) ? "completed" : "pending";
      },
      { timeout: 60_000 },
    )
    .toBe("completed");
  return observation().controlResults[String(id)];
}
export async function handoffSnapshot(page: Page): Promise<CodingWorkbenchRuntimeSnapshot> {
  const response = await page.request.get("/api/coding-workbench/runtime/status");
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}
function requireCommitProposalId(result: CodingToolResult | undefined): string {
  if (result === undefined || !("verifiedCommit" in result))
    throw new Error("Expected ready handoff commit proposal");
  return result.verifiedCommit.proposalId;
}
function requireDeliveryProposalId(result: CodingToolResult | undefined, intent: string): string {
  if (
    result === undefined ||
    !("draftDelivery" in result) ||
    result.draftDelivery.status !== "recorded"
  )
    throw new Error(`Expected ready handoff ${intent} proposal`);
  return result.draftDelivery.record.proposalId;
}
/**
 * PR #3625 retired the setup card's own "Issue URL or #number" field and its "Preview issue" /
 * "Use this issue" / "Bind workspace" controls: binding a workspace is now unrelated to resolving
 * any issue (coding-issue-journey-live.ts's `previewAndBindIssue` comment). This provisions the
 * plain repository/branch task workspace directly through the same real API
 * `coding-issue-commit.spec.ts`'s own `provision`, `coding-issue-delivery.spec.ts`'s
 * `provisionDeliveryWorkspace` and `coding-issue-ci-journey.ts`'s `provisionCiWorkspace` already
 * rely on for a fresh workspace per draft, rather than reimplementing the "Code setup" combobox flow
 * yet again. The GitHub issue-reader grant this fixture's repository needs is settled directly too
 * (`startStructuredDeliveryRun`, coding-issue-journey-live.ts, #3625 review) -- this lane starts its
 * run through the structured runtime start API rather than the Workbench prompt, so there is no
 * "Enable GitHub issue access" refusal-triggered retry control to settle it through.
 */
async function provisionHandoffWorkspace(page: Page, taskId: string): Promise<void> {
  const clear = await page.request.delete("/api/task-workspaces/active", {
    headers: { "X-Keiko-CSRF": "1" },
    data: {},
  });
  expect(clear.ok()).toBe(true);
  const response = await page.request.post("/api/task-workspaces", {
    headers: { "X-Keiko-CSRF": "1" },
    data: {
      root: HANDOFF_REPOSITORY_ROOT,
      taskId,
      baseBranch: "main",
      requestedBy: "handoff-browser-fixture",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { instance } = (await response.json()) as {
    readonly instance: { readonly workspaceId: string };
  };
  const repaired = await page.request.post("/api/task-workspaces/reconciliation", {
    headers: { "X-Keiko-CSRF": "1" },
    data: { requestedBy: "handoff-browser-fixture" },
  });
  expect(repaired.ok()).toBe(true);
  const activated = await page.request.post("/api/task-workspaces/active", {
    headers: { "X-Keiko-CSRF": "1" },
    data: {
      workspaceId: instance.workspaceId,
      requestedBy: "handoff-browser-fixture",
      acquireLock: false,
    },
  });
  expect(activated.ok(), await activated.text()).toBe(true);
  await page.reload();
}
async function commitCandidate(page: Page): Promise<void> {
  const proposal = await handoffControl("propose");
  expect(proposal).toHaveProperty("verifiedCommit.status", "approval-required");
  expect(proposal).toHaveProperty("approvalDisposition", "ready");
  expect(await handoffSnapshot(page)).not.toHaveProperty("pendingPermission");
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  const proposalId = requireCommitProposalId(proposal);
  expect(await handoffControl("execute", proposalId)).toHaveProperty(
    "verifiedCommit.status",
    "succeeded",
  );
}
async function pushCandidate(page: Page): Promise<void> {
  const proposal = await handoffControl("push-propose");
  expect(proposal).toHaveProperty("draftDelivery.record.phase", "push-proposed");
  expect(proposal).toHaveProperty("approvalDisposition", "ready");
  expect(await handoffSnapshot(page)).not.toHaveProperty("pendingPermission");
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  const proposalId = requireDeliveryProposalId(proposal, "push");
  expect(await handoffControl("push-execute", proposalId)).toHaveProperty(
    "draftDelivery.status",
    "recorded",
  );
}
async function createPullRequestCandidate(page: Page): Promise<void> {
  const proposal = await handoffControl("pr-propose");
  expect(proposal).toHaveProperty("draftDelivery.record.phase", "pr-proposed");
  expect(proposal).toHaveProperty("approvalDisposition", "ready");
  expect(await handoffSnapshot(page)).not.toHaveProperty("pendingPermission");
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  const proposalId = requireDeliveryProposalId(proposal, "pull-request");
  expect(await handoffControl("pr-execute", proposalId)).toHaveProperty(
    "draftDelivery.record.phase",
    "draft-created",
  );
}
/** Reaches a confirmed accepted PR through the real production flow: intake, start, verified
 * commit, push and PR creation — the exact prerequisite the journey route requires. */
export async function startHandoffDraft(page: Page, issue: number): Promise<StartedHandoffDraft> {
  await openCodingIssueWorkbench(page, {
    repository: HANDOFF_REPOSITORY_ROOT,
    windowId: HANDOFF_WINDOW_ID,
    launcherSecret: DELIVERY_LAUNCHER_SECRET,
  });
  await provisionHandoffWorkspace(page, `handoff-${String(issue)}`);
  await selectCodingIssueMode(page, "autonomous-delivery");
  // ADR-0137 D3 / #3625 review: a Workbench prompt's issue link is task CONTEXT ONLY -- the prompt
  // path always sends `issuePurpose: "context"` by design, so a run started that way never gets the
  // delivery binding this lane's real push/PR draft delivery requires. Start through the structured
  // runtime start API with `issuePurpose: "delivery"` instead (also settles the per-repository
  // GitHub issue-reader grant this freshly-provisioned repository needs).
  await startStructuredDeliveryRun(page, {
    repositoryPath: HANDOFF_REPOSITORY_ROOT,
    requestedMode: "autonomous-delivery",
    issueRef: `#${String(issue)}`,
    taskIntent: issueResolutionTaskInstructions(`#${String(issue)}`),
  });
  await expect.poll(() => observation().phase, { timeout: 120_000 }).toBe("verified-turn-ready");
  await commitCandidate(page);
  await pushCandidate(page);
  await createPullRequestCandidate(page);
  const snapshot = await handoffSnapshot(page);
  const runId = snapshot.runId;
  if (runId === undefined) throw new Error("Expected an active run id after PR creation");
  // The refresh control is rendered from a persisted outcome, so establish the first exact bound
  // observation before proving subsequent refreshes through the visible control.
  const primed = await page.request.post("/api/git-delivery/journey/refresh", {
    headers: { "X-Keiko-CSRF": "1" },
    data: { schemaVersion: "1", runId },
  });
  expect(primed.ok(), await primed.text()).toBe(true);
  await expect(page.getByRole("region", { name: "Issue handoff", exact: true })).toBeVisible();
  const active = await page.request.get("/api/task-workspaces/active");
  expect(active.ok(), await active.text()).toBe(true);
  const projectId = (
    (await active.json()) as {
      readonly active: { readonly binding: { readonly activeRoot: string } };
    }
  ).active.binding.activeRoot;
  return { runId, projectId };
}
