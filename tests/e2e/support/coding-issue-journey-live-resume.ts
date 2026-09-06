// #3390 — a paid model response can fail after it has already produced useful, operator-approved
// workspace changes. A qualification retry must reuse that exact managed workspace through the
// product's normal issue bind/start controls; deleting it or copying its diff would replace the
// observed model work with a fixture artifact. This module verifies the persisted, body-free
// workspace/run identities and the tracked/untracked worktree digest on both sides of Bind before starting
// an independently issue-bound continuation run.

import { expect, type Page } from "@playwright/test";
import type {
  CodingWorkbenchIssueBinding,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeSnapshot,
} from "@oscharko-dev/keiko-contracts";
import {
  readGitStageFile,
  type GitStageFile,
} from "@oscharko-dev/keiko-workspace/internal/git-index";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
const MAX_IDENTITY_FILES = 4_096;
const MAX_IDENTITY_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CORRECTION_INSTRUCTIONS_CHARS = 4_096;

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
  readonly priorState: "failed" | "cancelled" | "recovery-required";
  readonly correctionInstructions?: string | undefined;
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
  readonly readWorktree: (path: string) => Promise<WorktreeIdentity>;
  readonly bindIssue: () => Promise<void>;
  readonly start: () => Promise<CodingWorkbenchRuntimeSnapshot>;
  readonly acknowledgeRecovery: () => Promise<CodingWorkbenchRuntimeSnapshot>;
  readonly retry: () => Promise<CodingWorkbenchRuntimeSnapshot>;
  readonly readPredecessorRunId: (runId: string) => string | undefined;
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

function correctionInstructions(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env.KEIKO_QUALIFICATION_RESUME_CORRECTION_INSTRUCTIONS;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CORRECTION_INSTRUCTIONS_CHARS) {
    throw new Error("qualification continuation correction instructions are invalid");
  }
  return trimmed;
}

function priorState(value: string): QualificationResumeBinding["priorState"] {
  const states: ReadonlySet<string> = new Set(["failed", "cancelled", "recovery-required"]);
  if (!states.has(value)) throw new Error("qualification continuation prior state is invalid");
  return value as QualificationResumeBinding["priorState"];
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
    priorState: priorState(requiredEnv(env, "KEIKO_QUALIFICATION_RESUME_PRIOR_STATE")),
  };
  if (!GIT_SHA.test(binding.headSha) || !SHA256.test(binding.issueBindingDigest)) {
    throw new Error("qualification continuation binding has an invalid digest");
  }
  if (!SHA256.test(binding.worktreeDigest) || binding.worktreeDigest === EMPTY_WORKTREE_DIGEST) {
    throw new Error("qualification continuation worktree digest is invalid");
  }
  const correction = correctionInstructions(env);
  return {
    ...binding,
    priorState: binding.priorState,
    ...(correction === undefined ? {} : { correctionInstructions: correction }),
  };
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
    snapshot.state !== expected.priorState ||
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
): string {
  if (
    snapshot.runId === undefined ||
    snapshot.runId === expected.priorRunId ||
    snapshot.requestedMode !== mode ||
    snapshot.effectiveMode !== mode ||
    !sameIssueBinding(snapshot.issueBinding, priorIssue)
  ) {
    throw new Error("qualification continuation did not start a newly issue-bound run");
  }
  return snapshot.runId;
}

function assertRecoveryAcknowledged(
  snapshot: CodingWorkbenchRuntimeSnapshot,
  expected: QualificationResumeBinding,
  priorIssue: CodingWorkbenchIssueBinding,
): void {
  if (
    snapshot.runId !== expected.priorRunId ||
    snapshot.state !== "recovery-required" ||
    snapshot.recoveryAcknowledged !== true ||
    !sameIssueBinding(snapshot.issueBinding, priorIssue)
  ) {
    throw new Error("qualification continuation recovery acknowledgement is unavailable");
  }
}

async function assertWorkspaceUnchanged(
  client: ResumeWorkspaceClient,
  expected: QualificationResumeBinding,
  action: string,
): Promise<void> {
  const active = await client.readActiveWorkspace();
  if (active === null || !sameWorkspace(active, expected)) {
    throw new Error(`qualification continuation ${action} replaced the active workspace`);
  }
  const worktree = await client.readWorktree(expected.managedWorktreePath);
  if (worktree.headSha !== expected.headSha || worktree.digest !== expected.worktreeDigest) {
    throw new Error(`qualification continuation ${action} changed model-authored files`);
  }
}

async function continueRecoveryRequired(
  client: ResumeWorkspaceClient,
  expected: QualificationResumeBinding,
  priorIssue: CodingWorkbenchIssueBinding,
  mode: CodingWorkbenchMode,
  priorSnapshot: CodingWorkbenchRuntimeSnapshot,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  const acknowledged =
    priorSnapshot.recoveryAcknowledged === true
      ? priorSnapshot
      : await client.acknowledgeRecovery();
  assertRecoveryAcknowledged(acknowledged, expected, priorIssue);
  await assertWorkspaceUnchanged(client, expected, "recovery acknowledgement");
  const started = await client.retry();
  const startedRunId = assertNewRun(started, expected, priorIssue, mode);
  if (client.readPredecessorRunId(startedRunId) !== expected.priorRunId) {
    throw new Error("qualification continuation predecessor binding is unavailable");
  }
  return started;
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
  const priorSnapshot = await client.readPriorRun(expected.priorRunId);
  const priorIssue = assertPriorRun(priorSnapshot, expected, issueNumber);
  if (priorIssue.repositoryId !== expected.repositoryId) {
    throw new Error("qualification continuation repository binding changed");
  }
  const before = await client.readWorktree(expected.managedWorktreePath);
  if (before.headSha !== expected.headSha || before.digest !== expected.worktreeDigest) {
    throw new Error("qualification continuation worktree changed before issue bind");
  }
  if (expected.priorState === "recovery-required") {
    return continueRecoveryRequired(client, expected, priorIssue, mode, priorSnapshot);
  }
  await client.bindIssue();
  await assertWorkspaceUnchanged(client, expected, "issue bind");
  const started = await client.start();
  assertNewRun(started, expected, priorIssue, mode);
  return started;
}

function gitOutput(path: string, args: readonly string[]): Buffer {
  return execFileSync("git", [...args], {
    cwd: path,
    timeout: 30_000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
}

function gitPaths(path: string, args: readonly string[]): readonly string[] {
  const output = gitOutput(path, args);
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw new Error("qualification continuation Git paths are incomplete");
  const encodedPaths = output.subarray(0, -1);
  const decodedPaths = encodedPaths.toString("utf8");
  if (!Buffer.from(decodedPaths, "utf8").equals(encodedPaths)) {
    throw new Error("qualification continuation Git paths are invalid");
  }
  const paths = decodedPaths.split("\0");
  if (paths.some((value) => value.length === 0)) {
    throw new Error("qualification continuation Git paths are invalid");
  }
  return paths;
}

async function boundedFile(
  root: string,
  path: string,
  remainingBytes: number,
): Promise<GitStageFile> {
  try {
    return await readGitStageFile(root, path, remainingBytes);
  } catch {
    throw new Error("qualification continuation file is unsafe or too large");
  }
}

async function hashFiles(
  hash: ReturnType<typeof createHash>,
  root: string,
  kind: "tracked" | "untracked",
  paths: readonly string[],
  initialBytes: number,
): Promise<number> {
  let total = 0;
  for (const path of paths) {
    const remaining = MAX_IDENTITY_BYTES - initialBytes - total;
    const file = await boundedFile(root, path, remaining);
    if (file.mode === "120000" || (kind === "untracked" && file.mode === "0")) {
      throw new Error("qualification continuation only accepts stable regular files");
    }
    total += file.bytes.length;
    const contentDigest = createHash("sha256").update(file.bytes).digest("hex");
    hash.update(
      `${kind}\0${file.mode}\0${String(Buffer.byteLength(path))}\0${path}\0${contentDigest}\0`,
    );
  }
  return total;
}

async function readQualificationWorktreePass(path: string): Promise<WorktreeIdentity> {
  const root = realpathSync(path);
  const tracked = gitPaths(root, ["ls-files", "--cached", "-z", "--"]);
  const untracked = gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"]);
  if (tracked.length + untracked.length > MAX_IDENTITY_FILES) {
    throw new Error("qualification continuation worktree identity has too many files");
  }
  const hash = createHash("sha256").update("keiko-qualification-worktree-v2\0");
  hash.update(gitOutput(root, ["ls-files", "--stage", "-z", "--"]));
  const trackedBytes = await hashFiles(hash, root, "tracked", tracked, 0);
  await hashFiles(hash, root, "untracked", untracked, trackedBytes);
  const headSha = gitOutput(root, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])
    .toString("utf8")
    .trim();
  if (!GIT_SHA.test(headSha)) throw new Error("qualification continuation HEAD is invalid");
  return { headSha, digest: hash.digest("hex") };
}

export async function readQualificationWorktree(path: string): Promise<WorktreeIdentity> {
  const before = await readQualificationWorktreePass(path);
  const after = await readQualificationWorktreePass(path);
  if (before.headSha !== after.headSha || before.digest !== after.digest) {
    throw new Error("qualification continuation worktree changed during identity read");
  }
  return after;
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

function continuationInstructions(correction: string | undefined): string {
  const instructions = [
    "Continue the linked issue from the existing operator-approved workspace changes.",
    "Inspect the current diff first; retain correct prior work and repair it where needed.",
    issueResolutionTaskInstructions(),
  ];
  if (correction !== undefined) {
    instructions.push(`Apply this operator-observed correction: ${correction}`);
  }
  return instructions.join(" ");
}

async function startContinuation(
  page: Page,
  mode: CodingWorkbenchMode,
  correction: string | undefined,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  await selectCodingIssueMode(page, mode);
  await page.getByLabel("Task instructions").fill(continuationInstructions(correction));
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

async function acknowledgeRecovery(
  page: Page,
  runId: string,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  const endpoint = `${RUN_ENDPOINT}/${encodeURIComponent(runId)}/recovery-ack`;
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(endpoint),
  );
  const button = page.getByRole("button", { name: "Acknowledge recovery", exact: true });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  const response = await responsePromise;
  expect(
    response.ok(),
    `recovery acknowledgement failed with HTTP ${String(response.status())}`,
  ).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}

async function retryRecovery(
  page: Page,
  runId: string,
  mode: CodingWorkbenchMode,
  correction: string | undefined,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  await selectCodingIssueMode(page, mode);
  await page.getByLabel("Task instructions").fill(continuationInstructions(correction));
  const endpoint = `${RUN_ENDPOINT}/${encodeURIComponent(runId)}/retry`;
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(endpoint),
  );
  const button = page.getByRole("button", { name: "Retry as a fresh run", exact: true });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  const response = await responsePromise;
  expect(response.ok(), `recovery retry failed with HTTP ${String(response.status())}`).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}

function readPredecessorRunId(runId: string): string | undefined {
  const stateDirectory = requiredEnv(process.env, "KEIKO_E2E_STATE_DIR");
  const database = new DatabaseSync(join(stateDirectory, "ui-db", "keiko-ui.db"), {
    readOnly: true,
  });
  try {
    const row: unknown = database
      .prepare("SELECT predecessor_run_id FROM coding_runtime_snapshots WHERE run_id = ?")
      .get(runId);
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("qualification continuation successor snapshot is unavailable");
    }
    const predecessor = (row as Readonly<Record<string, unknown>>).predecessor_run_id;
    if (predecessor === null) return undefined;
    if (typeof predecessor !== "string" || predecessor.length === 0) {
      throw new Error("qualification continuation predecessor snapshot is invalid");
    }
    return predecessor;
  } finally {
    database.close();
  }
}

export function assertContinuationCanReachDraft(
  snapshot: CodingWorkbenchRuntimeSnapshot,
  runId: string,
): void {
  if (snapshot.runId !== runId || snapshot.draftDelivery?.phase === "draft-created") return;
  if (
    snapshot.state !== "failed" &&
    snapshot.state !== "cancelled" &&
    snapshot.state !== "recovery-required"
  )
    return;
  throw new Error(
    `continued run ${runId} reached ${snapshot.state} before creating a draft pull request`,
  );
}

async function waitForDraftPullRequest(page: Page, runId: string): Promise<DeliveredPullRequest> {
  const snapshot = await waitWhileAnsweringApprovals(
    page,
    async () => {
      const current = await runtimeSnapshot(page);
      assertContinuationCanReachDraft(current, runId);
      return current;
    },
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
      readWorktree: readQualificationWorktree,
      acknowledgeRecovery: () => acknowledgeRecovery(page, input.resume.priorRunId),
      retry: () =>
        retryRecovery(
          page,
          input.resume.priorRunId,
          input.mode,
          input.resume.correctionInstructions,
        ),
      readPredecessorRunId,
      bindIssue: async (): Promise<void> => {
        await reacceptBoundIssue(page, input.issueRef);
        if (await ensureWorkflowEligibleModel(page)) {
          await reacceptBoundIssue(page, input.issueRef);
        }
      },
      start: async (): Promise<CodingWorkbenchRuntimeSnapshot> => {
        await assertRuntimeReady(page, input.mode);
        return startContinuation(page, input.mode, input.resume.correctionInstructions);
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
