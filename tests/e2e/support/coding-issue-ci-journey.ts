import { expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { CodingToolResult } from "../../../packages/keiko-server/src/coding-runtime/codingToolIpc.js";
import { openCodingIssueWorkbench, selectCodingIssueMode } from "./coding-issue-browser.js";
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
  readonly result?: CodingToolResult;
}
export function ciObservation(): CiJourneyObservation {
  return JSON.parse(readFileSync(commitObservationPath(stateDir), "utf8")) as CiJourneyObservation;
}
export async function ciControl(
  operation: CommitFixtureOperation | DeliveryFixtureOperation | CiFixtureOperation,
): Promise<CodingToolResult | undefined> {
  const id = ciObservation().lastControl + 1;
  const path = commitControlPath(stateDir);
  writeFileSync(`${path}.next`, JSON.stringify({ id, operation }));
  renameSync(`${path}.next`, path);
  await expect
    .poll(() => ({ id: ciObservation().lastControl, phase: ciObservation().phase }), {
      timeout: 60_000,
    })
    .toEqual({ id, phase: operation });
  return ciObservation().result;
}
export async function ciSnapshot(page: Page): Promise<CodingWorkbenchRuntimeSnapshot> {
  const response = await page.request.get("/api/coding-workbench/runtime/status");
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}
async function bind(page: Page, number: number): Promise<void> {
  const clear = await page.request.delete("/api/task-workspaces/active", {
    headers: { "X-Keiko-CSRF": "1" },
    data: {},
  });
  expect(clear.ok()).toBe(true);
  await page.reload();
  const endpoint = "/api/coding-workbench/github-authorization";
  const current = await page.request.get(
    `${endpoint}?${new URLSearchParams({ repositoryPath: repository }).toString()}`,
  );
  const { revision } = (await current.json()) as { readonly revision: number };
  const grant = await page.request.put(endpoint, {
    headers: { "X-Keiko-CSRF": "1" },
    data: { repositoryPath: repository, authorized: true, expectedRevision: revision },
  });
  expect(grant.ok(), await grant.text()).toBe(true);
  await page.getByLabel("Issue URL or #number").fill(`#${String(number)}`);
  await page.getByRole("button", { name: "Preview issue", exact: true }).click();
  await expect(page.getByRole("region", { name: "Issue preview", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use this issue", exact: true }).click();
  await page.getByRole("button", { name: "Bind workspace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Code setup", exact: true })).toHaveCount(0);
}
export async function approveCiDelivery(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
}
export async function commitCiCandidate(page: Page): Promise<void> {
  const proposal = await ciControl("propose");
  expect(proposal).toHaveProperty("verifiedCommit.status", "approval-required");
  await approveCiDelivery(page);
  expect(await ciControl("execute")).toHaveProperty("verifiedCommit.status", "succeeded");
}
export async function pushCiCandidate(page: Page): Promise<void> {
  expect(await ciControl("push-propose")).toHaveProperty(
    "draftDelivery.record.phase",
    "push-proposed",
  );
  await approveCiDelivery(page);
  const pushed = await ciControl("push-execute");
  expect(pushed).toHaveProperty("draftDelivery.status", "recorded");
  expect(await ciSnapshot(page)).not.toHaveProperty("ciReadiness");
}
export async function startCiDraft(page: Page, issue: number): Promise<void> {
  await openCodingIssueWorkbench(page, {
    repository,
    windowId: CI_WINDOW_ID,
    launcherSecret: DELIVERY_LAUNCHER_SECRET,
  });
  await bind(page, issue);
  await selectCodingIssueMode(page, "autonomous-delivery");
  await page
    .getByLabel("Task instructions")
    .fill("Implement, verify, deliver and observe CI for the accepted issue.");
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/coding-workbench/runtime/runs"),
  );
  await page.getByRole("button", { name: "Start coding run", exact: true }).click();
  expect((await started).ok()).toBe(true);
  await expect.poll(() => ciObservation().phase, { timeout: 120_000 }).toBe("verified-turn-ready");
  await commitCiCandidate(page);
  await pushCiCandidate(page);
  expect(await ciControl("pr-propose")).toHaveProperty("draftDelivery.record.phase", "pr-proposed");
  await approveCiDelivery(page);
  expect(await ciControl("pr-execute")).toHaveProperty(
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
