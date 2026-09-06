// #3390 — a paid model response can fail after it has already produced useful, operator-approved
// workspace changes. A qualification retry must reuse that exact managed workspace through the
// product's normal issue bind/start controls; deleting it or copying its diff would replace the
// observed model work with a fixture artifact. This module verifies the persisted, body-free
// workspace/run identities and the tracked-worktree digest on both sides of Bind before starting
// an independently issue-bound continuation run.

import { expect, type Page } from "@playwright/test";
import type {
  CodingWorkbenchIssueBinding,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  assertRuntimeReady,
  ensureWorkflowEligibleModel,
  issueResolutionTaskInstructions,
  openLiveWorkbench,
  reacceptBoundIssue,
  runtimeSnapshot,
  waitWhileAnsweringApprovals,
  workbenchSurface,
  type DeliveredPullRequest,
} from "./coding-issue-journey-live.js";
import { selectCodingIssueMode } from "./coding-issue-browser.js";

const RUN_ENDPOINT = "/api/coding-workbench/runtime/runs";
const ACTIVE_WORKSPACE_ENDPOINT = "/api/task-workspaces/active";
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const EMPTY_WORKTREE_DIGEST = createHash("sha256").digest("hex");

export interface QualificationResumeBinding {
  readonly priorRunId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly baseBranch: string;
  readonly taskBranch: string;
  readonly managedWorktreePath: string;
  readonly headSha: string;
  readonly issueBindingDigest: string;
  readonly worktreeDigest: string;
}

interface ActiveWorkspaceIdentity {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly baseBranch: string;
  readonly taskBranch: string;
  readonly managedWorktreePath: string;
  readonly lastVerifiedHead?: string | undefined;
}

interface ResumeWorkspaceClient {
  readonly readActiveWorkspace: () => Promise<ActiveWorkspaceIdentity | null>;
  readonly readPriorRun: (runId: string) => Promise<CodingWorkbenchRuntimeSnapshot>;
  readonly readWorktree: (path: string) => WorktreeIdentity;
  readonly bindIssue: () => Promise<void>;
  readonly start: () => Promise<CodingWorkbenchRuntimeSnapshot>;
}

interface WorktreeIdentity {
  readonly headSha: string;
  readonly digest: string;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`${key} is required for qualification workspace continuation`);
  }
  return value;
}

export function qualificationResumeBinding(
  env: Readonly<Record<string, string | undefined>> = process.env,
): QualificationResumeBinding | undefined {
  if (env.KEIKO_QUALIFICATION_RESUME_WORKSPACE !== "1") return undefined;
  const binding = {
    priorRunId: requiredEnv(env, "KEIKO_QUALIFICATION_RESUME_PRIOR_RUN_ID"),
    workspaceId: requiredEnv(env, "KEIKO_QUALIFICATION_RESUME_WORKSPACE_ID"),
    taskId: requiredEnv(env, "KEIKO_QUALIFICATION_RESUME_TASK_ID"),
    repositoryId: requiredEnv(env, "KEIKO_QUALIFICATION_RESUME_REPOSITORY_ID"),
    baseBranch: requiredEnv(env, "KEIKO_QUALIFICATION_RESUME_BASE_BRANCH"),
    taskBranch: requiredEnv(env, "KEIKO_QUALIFICATION_RESUME_TASK_BRANCH"),
    managedWorktreePath: requiredEnv(env, "KEIKO_QUALIFICATION_RESUME_WORKTREE_PATH"),
    headSha: requiredEnv(env, "KEIKO_QUALIFICATION_RESUME_HEAD_SHA"),
    issueBindingDigest: requiredEnv(env, "KEIKO_QUALIFICATION_RESUME_ISSUE_BINDING_DIGEST"),
    worktreeDigest: requiredEnv(env, "KEIKO_QUALIFICATION_RESUME_WORKTREE_DIGEST"),
  };
  if (!GIT_SHA.test(binding.headSha) || !SHA256.test(binding.issueBindingDigest)) {
    throw new Error("qualification continuation binding has an invalid digest");
  }
  if (!SHA256.test(binding.worktreeDigest) || binding.worktreeDigest === EMPTY_WORKTREE_DIGEST) {
    throw new Error("qualification continuation worktree digest is invalid");
  }
  return binding;
}

function sameWorkspace(
  active: ActiveWorkspaceIdentity,
  expected: QualificationResumeBinding,
): boolean {
  return (
    active.workspaceId === expected.workspaceId &&
    active.taskId === expected.taskId &&
    active.repositoryId === expected.repositoryId &&
    active.baseBranch === expected.baseBranch &&
    active.taskBranch === expected.taskBranch &&
    active.managedWorktreePath === expected.managedWorktreePath &&
    active.lastVerifiedHead === expected.headSha
  );
}

function matchingIssue(
  issue: CodingWorkbenchIssueBinding | undefined,
  expectedDigest: string,
  issueNumber: number,
): boolean {
  return issue?.bindingDigest === expectedDigest && issue.issueNumber === issueNumber;
}

function sameIssueBinding(
  current: CodingWorkbenchIssueBinding | undefined,
  prior: CodingWorkbenchIssueBinding,
): boolean {
  return (
    current?.schemaVersion === prior.schemaVersion &&
    current.repositoryId === prior.repositoryId &&
    current.remoteDigest === prior.remoteDigest &&
    current.issueNumber === prior.issueNumber &&
    current.issueIdDigest === prior.issueIdDigest &&
    current.defaultBaseRef === prior.defaultBaseRef &&
    current.contentRevisionDigest === prior.contentRevisionDigest &&
    current.bindingDigest === prior.bindingDigest
  );
}

function assertPriorRun(
  snapshot: CodingWorkbenchRuntimeSnapshot,
  expected: QualificationResumeBinding,
  issueNumber: number,
): CodingWorkbenchIssueBinding {
  if (
    snapshot.runId !== expected.priorRunId ||
    snapshot.state !== "failed" ||
    !matchingIssue(snapshot.issueBinding, expected.issueBindingDigest, issueNumber)
  ) {
    throw new Error("qualification continuation prior run binding is unavailable");
  }
  if (snapshot.issueBinding === undefined) {
    throw new Error("qualification continuation prior issue binding is unavailable");
  }
  return snapshot.issueBinding;
}

function assertNewRun(
  snapshot: CodingWorkbenchRuntimeSnapshot,
  expected: QualificationResumeBinding,
  priorIssue: CodingWorkbenchIssueBinding,
  mode: CodingWorkbenchMode,
): void {
  if (
    snapshot.runId === undefined ||
    snapshot.runId === expected.priorRunId ||
    snapshot.requestedMode !== mode ||
    snapshot.effectiveMode !== mode ||
    !sameIssueBinding(snapshot.issueBinding, priorIssue)
  ) {
    throw new Error("qualification continuation did not start a newly issue-bound run");
  }
}

export async function resumeExistingIssueWorkspace(
  client: ResumeWorkspaceClient,
  expected: QualificationResumeBinding,
  issueNumber: number,
  mode: CodingWorkbenchMode,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  const activeBefore = await client.readActiveWorkspace();
  if (activeBefore === null || !sameWorkspace(activeBefore, expected)) {
    throw new Error("qualification continuation active workspace identity changed");
  }
  const priorIssue = assertPriorRun(
    await client.readPriorRun(expected.priorRunId),
    expected,
    issueNumber,
  );
  if (priorIssue.repositoryId !== expected.repositoryId) {
    throw new Error("qualification continuation repository binding changed");
  }
  const before = client.readWorktree(expected.managedWorktreePath);
  if (before.headSha !== expected.headSha || before.digest !== expected.worktreeDigest) {
    throw new Error("qualification continuation worktree changed before issue bind");
  }
  await client.bindIssue();
  const activeAfter = await client.readActiveWorkspace();
  if (activeAfter === null || !sameWorkspace(activeAfter, expected)) {
    throw new Error("qualification continuation issue bind replaced the active workspace");
  }
  const after = client.readWorktree(expected.managedWorktreePath);
  if (after.headSha !== expected.headSha || after.digest !== expected.worktreeDigest) {
    throw new Error("qualification continuation issue bind changed model-authored files");
  }
  const started = await client.start();
  assertNewRun(started, expected, priorIssue, mode);
  return started;
}

function readTrackedWorktree(path: string): WorktreeIdentity {
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: path,
    timeout: 30_000,
  });
  if (untracked.length > 0) {
    throw new Error("qualification continuation refuses an untracked worktree");
  }
  const diff = execFileSync("git", ["diff", "--no-ext-diff", "--binary", "HEAD", "--"], {
    cwd: path,
    timeout: 30_000,
  });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
  return { headSha, digest: createHash("sha256").update(diff).digest("hex") };
}

interface ActiveWorkspaceResponse {
  readonly active: { readonly instance: ActiveWorkspaceIdentity } | null;
}

async function readActiveWorkspace(page: Page): Promise<ActiveWorkspaceIdentity | null> {
  const response = await page.request.get(ACTIVE_WORKSPACE_ENDPOINT);
  expect(response.ok(), `active workspace read failed with HTTP ${String(response.status())}`).toBe(
    true,
  );
  return ((await response.json()) as ActiveWorkspaceResponse).active?.instance ?? null;
}

async function readRun(page: Page, runId: string): Promise<CodingWorkbenchRuntimeSnapshot> {
  const response = await page.request.get(`${RUN_ENDPOINT}/${encodeURIComponent(runId)}`);
  expect(response.ok(), `prior run read failed with HTTP ${String(response.status())}`).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}

function continuationInstructions(): string {
  return [
    "Continue the linked issue from the existing operator-approved workspace changes.",
    "Inspect the current diff first; retain correct prior work and repair it where needed.",
    issueResolutionTaskInstructions(),
  ].join(" ");
}

async function startContinuation(
  page: Page,
  mode: CodingWorkbenchMode,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  await selectCodingIssueMode(page, mode);
  await page.getByLabel("Task instructions").fill(continuationInstructions());
  const startButton = page.getByRole("button", { name: "Start coding run", exact: true });
  await expect(startButton).toBeEnabled({ timeout: 60_000 });
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(RUN_ENDPOINT),
  );
  await startButton.click();
  const response = await responsePromise;
  expect(response.ok(), `continuation start failed with HTTP ${String(response.status())}`).toBe(
    true,
  );
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}

async function waitForDraftPullRequest(page: Page, runId: string): Promise<DeliveredPullRequest> {
  const snapshot = await waitWhileAnsweringApprovals(
    page,
    () => runtimeSnapshot(page),
    (value) => value.runId === runId && value.draftDelivery?.phase === "draft-created",
    {
      timeoutMs: 25 * 60_000,
      message: "expected the continued model run to create a real draft pull request",
    },
  );
  const pullRequest = snapshot.draftDelivery?.pullRequest;
  if (pullRequest === undefined)
    throw new Error("continued run draft pull request was unavailable");
  return { runId, ...pullRequest };
}

export async function resumeIssueToDraftPullRequest(
  page: Page,
  input: {
    readonly repositoryRoot: string;
    readonly issueRef: string;
    readonly issueNumber: number;
    readonly mode: CodingWorkbenchMode;
    readonly resume: QualificationResumeBinding;
  },
): Promise<DeliveredPullRequest> {
  await openLiveWorkbench(page, input.repositoryRoot);
  const started = await resumeExistingIssueWorkspace(
    {
      readActiveWorkspace: () => readActiveWorkspace(page),
      readPriorRun: (runId) => readRun(page, runId),
      readWorktree: readTrackedWorktree,
      bindIssue: async (): Promise<void> => {
        await reacceptBoundIssue(page, input.issueRef);
        if (await ensureWorkflowEligibleModel(page)) {
          await reacceptBoundIssue(page, input.issueRef);
        }
      },
      start: async (): Promise<CodingWorkbenchRuntimeSnapshot> => {
        await assertRuntimeReady(page, input.mode);
        return startContinuation(page, input.mode);
      },
    },
    input.resume,
    input.issueNumber,
    input.mode,
  );
  const runId = started.runId;
  if (runId === undefined) throw new Error("qualification continuation run id was unavailable");
  await expect(workbenchSurface(page)).toHaveAttribute("data-state", "running", {
    timeout: 60_000,
  });
  return waitForDraftPullRequest(page, runId);
}
