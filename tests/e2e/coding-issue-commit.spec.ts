import { openCodingIssueWorkbench, selectCodingIssueMode } from "./support/coding-issue-browser.js";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureCommitModes,
  writeCommitJourneyReceipt,
} from "./support/coding-issue-commit-evidence.js";
import { execFileSync } from "node:child_process";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeSnapshot,
  VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts";
import {
  COMMIT_LAUNCHER_SECRET,
  COMMIT_MESSAGE,
  COMMIT_TARGET,
  commitControlPath,
  commitObservationPath,
  commitRepository,
  commitStateDir,
  type CommitFixtureOperation,
} from "./support/coding-issue-commit.js";

const stateDir = commitStateDir();
const repository = commitRepository(stateDir);
const WINDOW_ID = "verified-commit-proof";
const SURFACE = 'section[aria-label="Coding Workbench"][data-state]';
const CSRF = { "X-Keiko-CSRF": "1" };
// These journeys deliberately share one real server and its single active runtime.
// Stop on a failure so its still-active run cannot contaminate later scenarios.
test.describe.configure({ mode: "serial" });
const completedCases: string[] = [];
test.afterAll(() => {
  if (completedCases.length === 6) writeCommitJourneyReceipt(stateDir, completedCases);
});
interface Observation {
  readonly phase: string;
  readonly runId?: string;
  readonly lastControl: number;
  readonly completedControls: readonly number[];
  readonly failedControls: readonly number[];
  readonly controlResults: Readonly<Record<string, Observation["result"]>>;
  readonly result?: { readonly status: string; readonly verifiedCommit?: VerifiedCommitResult };
  readonly rawContentRecorded: boolean;
}
function observe(): Observation {
  return JSON.parse(readFileSync(commitObservationPath(stateDir), "utf8")) as Observation;
}
async function control(
  operation: CommitFixtureOperation,
  proposalId?: string,
): Promise<Observation> {
  return waitControl(await startControl(operation, proposalId));
}
async function startControl(
  operation: CommitFixtureOperation,
  proposalId?: string,
): Promise<number> {
  const id = observe().lastControl + 1;
  const path = commitControlPath(stateDir);
  writeFileSync(
    `${path}.next`,
    JSON.stringify({ id, operation, ...(proposalId === undefined ? {} : { proposalId }) }),
  );
  renameSync(`${path}.next`, path);
  await expect.poll(() => observe().lastControl).toBe(id);
  return id;
}
async function waitControl(id: number): Promise<Observation> {
  await expect
    .poll(() => {
      const current = observe();
      if (current.failedControls.includes(id)) return "failed";
      return current.completedControls.includes(id) ? "completed" : "pending";
    })
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
async function startPendingCommit(page: Page): Promise<{
  readonly controlId: number;
  readonly proposalId: string;
}> {
  const controlId = await startControl("propose");
  await expect
    .poll(async () => (await snapshot(page)).pendingPermission?.actionKind)
    .toBe("commit");
  const proposalId = (await snapshot(page)).pendingPermission?.requestId;
  if (proposalId === undefined) throw new Error("Expected canonical pending commit proposal");
  return { controlId, proposalId };
}
async function readyCommitProposal(
  page: Page,
  mode: CodingWorkbenchMode,
  beforeApproval?: () => Promise<void>,
): Promise<{ readonly proposed: Observation; readonly proposalId: string }> {
  if (mode === "autonomous-delivery") {
    const proposed = await control("propose");
    const proposalId = proposed.result?.verifiedCommit?.proposalId;
    if (proposalId === undefined) throw new Error("Expected ready commit proposal");
    expect(proposed.result).toHaveProperty("approvalDisposition", "ready");
    expect((await snapshot(page)).pendingPermission).toBeUndefined();
    await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
    return { proposed, proposalId };
  }
  const pending = await startPendingCommit(page);
  expect((await control("execute", pending.proposalId)).result?.status).toBe("denied");
  const message = page.getByRole("region", { name: "Reviewed commit message" });
  await expect(message.locator("pre")).toHaveText(COMMIT_MESSAGE, { useInnerText: false });
  await expect(message.locator("script")).toHaveCount(0);
  await beforeApproval?.();
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  const proposed = await waitControl(pending.controlId);
  expect(proposed.result).toHaveProperty("approvalDisposition", "ready");
  return { proposed, proposalId: pending.proposalId };
}
function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8", timeout: 30_000 }).trim();
}
async function openWorkbench(page: Page): Promise<void> {
  await openCodingIssueWorkbench(page, {
    repository,
    windowId: WINDOW_ID,
    launcherSecret: COMMIT_LAUNCHER_SECRET,
  });
}

async function provision(page: Page, taskId: string): Promise<string> {
  const response = await page.request.post("/api/task-workspaces", {
    headers: CSRF,
    data: {
      root: repository,
      taskId,
      baseBranch: "main",
      requestedBy: "commit-browser-fixture",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { instance } = (await response.json()) as {
    readonly instance: { readonly workspaceId: string; readonly managedWorktreePath: string };
  };
  const repaired = await page.request.post("/api/task-workspaces/reconciliation", {
    headers: CSRF,
    data: { requestedBy: "commit-browser-fixture" },
  });
  expect(repaired.ok()).toBe(true);
  const activated = await page.request.post("/api/task-workspaces/active", {
    headers: CSRF,
    data: {
      workspaceId: instance.workspaceId,
      requestedBy: "commit-browser-fixture",
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
  scenario: string,
): Promise<string> {
  const approvedKinds = new Set<string>();
  const root = await provision(page, `commit-${mode}-${scenario}`);
  await selectCodingIssueMode(page, mode);
  await page
    .getByLabel("Task instructions")
    .fill("Update the source constant, verify it and review its commit.");
  await expect(page.getByRole("button", { name: "Start coding run", exact: true })).toBeEnabled();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/coding-workbench/runtime/runs"),
  );
  await page.getByRole("button", { name: "Start coding run", exact: true }).click();
  const startResponse = await started;
  expect(startResponse.ok(), await startResponse.text()).toBe(true);
  await expect
    .poll(
      async () => {
        const current = await snapshot(page);
        if (
          current.pendingPermission !== undefined &&
          current.pendingPermission.actionKind !== "commit"
        ) {
          const approve = page.getByRole("button", { name: "Approve once", exact: true });
          await expect(approve).toBeEnabled();
          await approve.click();
          approvedKinds.add(current.pendingPermission.actionKind ?? "missing");
        }
        return observe().phase;
      },
      { timeout: 90_000 },
    )
    .toBe("verified-turn-ready");
  expect((await snapshot(page)).effectiveMode).toBe(mode);
  expect([...approvedKinds].sort()).toEqual(
    mode === "governed-assist" ? ["file-edit", "git-stage", "verification-command"] : [],
  );
  expect(git(root, ["diff", "--cached", "--name-only"])).toBe(COMMIT_TARGET);
  return root;
}

async function finish(page: Page, expected: "succeeded" | "revoked" = "succeeded"): Promise<void> {
  await control("finish");
  const current = await snapshot(page);
  if (expected === "revoked") {
    expect(current).toMatchObject({ state: "failed", failureCode: "revoked" });
    return;
  }
  // Same terminal cleanup as the existing functional harness: a scripted child can settle its
  // stop before the operator request lands. Neither outcome establishes live-model qualification.
  if (current.state !== "succeeded") {
    const stopped = await page.request.post(
      `/api/coding-workbench/runtime/runs/${current.runId ?? ""}/stop`,
      {
        headers: CSRF,
        data: { requestId: current.runId },
      },
    );
    expect(stopped.ok(), await stopped.text()).toBe(true);
  }
  await expect.poll(async () => (await snapshot(page)).state).toMatch(/^(?:succeeded|cancelled)$/u);
}

for (const mode of ["autonomous-delivery", "supervised-coding", "governed-assist"] as const) {
  test(`#3386 @coding-issue-commit actual reviewed commit in ${mode}`, async ({
    page,
    request,
  }) => {
    await openWorkbench(page);
    const root = await startVerified(page, mode, "success");
    const before = git(root, ["rev-parse", "HEAD"]);
    const { proposed, proposalId } = await readyCommitProposal(
      page,
      mode,
      mode === "supervised-coding"
        ? async (): Promise<void> => {
            await captureCommitModes(page, WINDOW_ID, SURFACE);
          }
        : undefined,
    );
    expect(proposed.result?.verifiedCommit?.status).toBe("approval-required");
    const unpaired = await request.get(
      `/api/coding-workbench/runtime/runs/${proposed.runId ?? ""}/approval-review`,
    );
    expect(await unpaired.json()).toEqual({ session: "unpaired" });
    expect(git(root, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(before);
    const executed = await control("execute", proposalId);
    expect(executed.result?.verifiedCommit?.status).toBe("succeeded");
    expect(git(root, ["rev-list", "--count", `${before}..HEAD`])).toBe("1");
    expect(git(root, ["show", "-s", "--format=%B", "HEAD"])).toBe(COMMIT_MESSAGE);
    await page.reload();
    await expect(page.getByRole("region", { name: "Commit result" })).toContainText(
      "Commit created",
    );
    await expect(page.getByRole("region", { name: "Reviewed commit message" })).toHaveCount(0);
    expect((await snapshot(page)).verifiedCommitResult).toEqual(executed.result?.verifiedCommit);
    const replay = await control("execute", proposalId);
    expect(replay.result?.status).toBe(mode === "autonomous-delivery" ? "failed" : "denied");
    expect(git(root, ["rev-list", "--count", `${before}..HEAD`])).toBe("1");
    await finish(page);
    completedCases.push(`approved-exactly-once-and-reloaded-${mode}`);
  });
}

test("#3386 @coding-issue-commit dirty worktree cannot become an approvable proposal", async ({
  page,
}) => {
  await openWorkbench(page);
  const root = await startVerified(page, "autonomous-delivery", "dirty");
  const before = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "untracked-fixture.txt"), "Unverified fixture state.\n");
  const proposed = await control("propose");
  expect(proposed.result?.verifiedCommit).toMatchObject({
    status: "drift",
    reason: "verification-stale",
  });
  await page.reload();
  await expect(page.getByRole("region", { name: "Commit result" })).toContainText(
    "Commit proposal changed",
  );
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  expect(git(root, ["rev-parse", "HEAD"])).toBe(before);
  await finish(page);
  completedCases.push("dirty-worktree-refused");
});

test("#3386 @coding-issue-commit staged drift after review cannot execute", async ({ page }) => {
  await openWorkbench(page);
  const root = await startVerified(page, "autonomous-delivery", "drift");
  const before = git(root, ["rev-parse", "HEAD"]);
  const proposed = await control("propose");
  expect(proposed.result?.verifiedCommit?.status).toBe("approval-required");
  expect(proposed.result).toHaveProperty("approvalDisposition", "ready");
  const proposalId = proposed.result?.verifiedCommit?.proposalId;
  if (proposalId === undefined) throw new Error("Expected ready commit proposal");
  expect((await snapshot(page)).pendingPermission).toBeUndefined();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  writeFileSync(join(root, COMMIT_TARGET), "export const value = 'DRIFTED_COMMIT_3386';\n");
  git(root, ["add", "--", COMMIT_TARGET]);
  const executed = await control("execute", proposalId);
  expect(executed.result?.verifiedCommit).toMatchObject({
    status: "drift",
    reason: "candidate-drift",
  });
  expect(git(root, ["rev-parse", "HEAD"])).toBe(before);
  await page.reload();
  await expect(page.getByRole("region", { name: "Commit result" })).toContainText(
    "Commit proposal changed",
  );
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  await finish(page);
  completedCases.push("staged-drift-refused");
});

test("#3386 @coding-issue-commit actual UI denial revokes the execution path", async ({ page }) => {
  await openWorkbench(page);
  const root = await startVerified(page, "governed-assist", "denied");
  const before = git(root, ["rev-parse", "HEAD"]);
  const pending = await startPendingCommit(page);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.locator(SURFACE)).toHaveAttribute("data-state", "failed");
  expect(await snapshot(page)).toMatchObject({ failureCode: "revoked" });
  expect((await waitControl(pending.controlId)).result?.status).toBe("cancelled");
  expect((await control("execute", pending.proposalId)).result?.status).toBe("denied");
  expect(git(root, ["rev-parse", "HEAD"])).toBe(before);
  await expect(page.getByRole("region", { name: "Reviewed commit message" })).toHaveCount(0);
  await finish(page, "revoked");
  completedCases.push("explicit-ui-denial-revokes-execution");
});
