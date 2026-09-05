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

interface HandoffObservation {
  readonly phase: string;
  readonly lastControl: number;
  readonly result?: CodingToolResult;
}
function observation(): HandoffObservation {
  return JSON.parse(readFileSync(commitObservationPath(stateDir), "utf8")) as HandoffObservation;
}
export async function handoffControl(
  operation: CommitFixtureOperation | DeliveryFixtureOperation,
): Promise<CodingToolResult | undefined> {
  const id = observation().lastControl + 1;
  const path = commitControlPath(stateDir);
  writeFileSync(`${path}.next`, JSON.stringify({ id, operation }));
  renameSync(`${path}.next`, path);
  await expect
    .poll(() => ({ id: observation().lastControl, phase: observation().phase }), {
      timeout: 60_000,
    })
    .toEqual({ id, phase: operation });
  return observation().result;
}
export async function handoffSnapshot(page: Page): Promise<CodingWorkbenchRuntimeSnapshot> {
  const response = await page.request.get("/api/coding-workbench/runtime/status");
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}
async function bindIssue(page: Page, number: number): Promise<void> {
  const clear = await page.request.delete("/api/task-workspaces/active", {
    headers: { "X-Keiko-CSRF": "1" },
    data: {},
  });
  expect(clear.ok()).toBe(true);
  await page.reload();
  const endpoint = "/api/coding-workbench/github-authorization";
  const current = await page.request.get(
    `${endpoint}?${new URLSearchParams({ repositoryPath: HANDOFF_REPOSITORY_ROOT }).toString()}`,
  );
  const { revision } = (await current.json()) as { readonly revision: number };
  const grant = await page.request.put(endpoint, {
    headers: { "X-Keiko-CSRF": "1" },
    data: { repositoryPath: HANDOFF_REPOSITORY_ROOT, authorized: true, expectedRevision: revision },
  });
  expect(grant.ok(), await grant.text()).toBe(true);
  await page.getByLabel("Issue URL or #number").fill(`#${String(number)}`);
  await page.getByRole("button", { name: "Preview issue", exact: true }).click();
  await expect(page.getByRole("region", { name: "Issue preview", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use this issue", exact: true }).click();
  await page.getByRole("button", { name: "Bind workspace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Code setup", exact: true })).toHaveCount(0);
}
async function approveOnce(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
}
async function commitCandidate(page: Page): Promise<void> {
  const proposal = await handoffControl("propose");
  expect(proposal).toHaveProperty("verifiedCommit.status", "approval-required");
  await approveOnce(page);
  expect(await handoffControl("execute")).toHaveProperty("verifiedCommit.status", "succeeded");
}
async function pushCandidate(page: Page): Promise<void> {
  expect(await handoffControl("push-propose")).toHaveProperty(
    "draftDelivery.record.phase",
    "push-proposed",
  );
  await approveOnce(page);
  expect(await handoffControl("push-execute")).toHaveProperty("draftDelivery.status", "recorded");
}
/** Reaches a confirmed accepted PR through the real production flow: intake, start, verified
 * commit, push and PR creation — the exact prerequisite the journey route requires. */
export async function startHandoffDraft(page: Page, issue: number): Promise<string> {
  await openCodingIssueWorkbench(page, {
    repository: HANDOFF_REPOSITORY_ROOT,
    windowId: HANDOFF_WINDOW_ID,
    launcherSecret: DELIVERY_LAUNCHER_SECRET,
  });
  await bindIssue(page, issue);
  await selectCodingIssueMode(page, "autonomous-delivery");
  await page
    .getByLabel("Task instructions")
    .fill("Implement, verify, deliver and observe the handoff for the accepted issue.");
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/coding-workbench/runtime/runs"),
  );
  await page.getByRole("button", { name: "Start coding run", exact: true }).click();
  expect((await started).ok()).toBe(true);
  await expect.poll(() => observation().phase, { timeout: 120_000 }).toBe("verified-turn-ready");
  await commitCandidate(page);
  await pushCandidate(page);
  expect(await handoffControl("pr-propose")).toHaveProperty(
    "draftDelivery.record.phase",
    "pr-proposed",
  );
  await approveOnce(page);
  expect(await handoffControl("pr-execute")).toHaveProperty(
    "draftDelivery.record.phase",
    "draft-created",
  );
  const snapshot = await handoffSnapshot(page);
  const runId = snapshot.runId;
  if (runId === undefined) throw new Error("Expected an active run id after PR creation");
  return runId;
}
