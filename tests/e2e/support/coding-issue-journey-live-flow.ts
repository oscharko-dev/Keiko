// #3390 — five independently bound real Issue -> Keiko task -> PR -> governed merge -> closed
// issue qualification flows. The browser drive uses only mounted production routes and controls;
// the artifact is written only after the journey observer reports the provider merge and issue
// closure on the exact run/head. Failed attempts remain represented by the durable spend delta of
// the next completed flow.

import { expect, type Page } from "@playwright/test";
import type {
  CodeTaskQualificationFlowArtifactV1,
  CodingWorkbenchMode,
  JourneyOutcome,
} from "@oscharko-dev/keiko-contracts";
import {
  CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND,
  CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS,
  validateCodeTaskQualificationFlowArtifact,
} from "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";
import { isJourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-validation";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { writeCodingIssueJourneyFlowEvidenceReceipt } from "../../../scripts/lib/qualification-evidence-receipt.mjs";
import { driveOrReuseDraftPullRequest } from "./coding-issue-journey-live-cache.js";
import {
  applyAutoDraftDescriptionThroughPrCard,
  mountGovernedPullRequestCard,
  waitForAutoDraftDescription,
} from "./coding-issue-journey-live-description.js";
import { waitForCiRepairOutcome } from "./coding-issue-journey-live-ci.js";
import { proposeJourneyReady } from "./coding-issue-journey-live-mark-ready.js";
import {
  type DeliveredPullRequest,
  openLiveWorkbench,
  runtimeSnapshot,
  waitWhileAnsweringApprovals,
} from "./coding-issue-journey-live.js";
import { resolveLiveJourneyEnv } from "./coding-issue-journey-live-runners.js";
import { currentPlatformKey, receiptsDir } from "./coding-issue-journey-scenarios.js";

const DESCRIPTOR_PATH = join("docs", "acceptance", "coding-issue-journey-3390.json");
const GIT_WINDOW_ID = "coding-issue-journey-governed-git";
const MERGE_WINDOW_ID = "coding-issue-journey-governed-merge";
const CSRF = { "X-Keiko-CSRF": "1" };
const MAX_AUTHORIZED_BUDGET_NANO_USD = 50_000_000_000;
const NANO_USD = 1_000_000_000;

export interface QualificationFlowBinding {
  readonly flowId: string;
  readonly ordinal: number;
  readonly repository: string;
  readonly issueNumber: number;
  readonly mode: CodingWorkbenchMode;
}

interface FlowArtifactInput {
  readonly flow: QualificationFlowBinding;
  readonly outcome: JourneyOutcome;
  readonly readiness: NonNullable<JourneyOutcome["readiness"]>;
  readonly sourceCommitSha: string;
  readonly budgetNanoUsd: number;
  readonly previousCumulativeChargedNanoUsd: number;
  readonly cumulativeChargedNanoUsd: number;
}

export interface SpendSnapshot {
  readonly ceiling: number;
  readonly charged: number;
}

export interface FinalDeliverySnapshot {
  readonly runId: string | undefined;
  readonly phase: string | undefined;
  readonly reason: string | undefined;
  readonly bindingHeadSha: string | undefined;
  readonly pullRequest:
    | {
        readonly repository: string;
        readonly number: number;
        readonly baseRef: string;
        readonly headRef: string;
        readonly headSha: string;
      }
    | undefined;
}

type CompletedRemoteOutcome = JourneyOutcome & {
  readonly remote: NonNullable<JourneyOutcome["remote"]> & {
    readonly mergedAt: string;
    readonly mergeCommitSha: string;
    readonly issue: NonNullable<JourneyOutcome["remote"]>["issue"] & {
      readonly state: "closed";
      readonly closedAt: string;
    };
  };
};

function hasCompletedRemote(outcome: JourneyOutcome): outcome is CompletedRemoteOutcome {
  return (
    outcome.state === "completed" &&
    outcome.reason === "merge-and-closure-observed" &&
    typeof outcome.remote?.mergedAt === "string" &&
    typeof outcome.remote.mergeCommitSha === "string" &&
    outcome.remote.issue.state === "closed" &&
    typeof outcome.remote.issue.closedAt === "string"
  );
}

function outcomeMatchesFlow(outcome: JourneyOutcome, flow: QualificationFlowBinding): boolean {
  return (
    outcome.binding.repository === flow.repository &&
    outcome.binding.issueNumber === flow.issueNumber &&
    outcome.remote?.issue.number === flow.issueNumber
  );
}

function readinessMatchesCompletedHead(
  readiness: NonNullable<JourneyOutcome["readiness"]>,
  outcome: JourneyOutcome,
): boolean {
  return (
    readiness.runId === outcome.binding.runId &&
    readiness.repository === outcome.binding.repository &&
    readiness.prNumber === outcome.binding.prNumber &&
    readiness.baseRef === outcome.binding.baseRef &&
    readiness.headRef === outcome.binding.headRef &&
    readiness.headSha === outcome.binding.headSha
  );
}

function readinessHasPassingChecks(readiness: NonNullable<JourneyOutcome["readiness"]>): boolean {
  const checks = readiness.requiredChecks;
  return (
    readiness.complete &&
    readiness.state === "technical-ready" &&
    checks.total > 0 &&
    checks.passed === checks.total &&
    checks.failed === 0 &&
    checks.pending === 0 &&
    checks.blocked === 0 &&
    checks.unknown === 0
  );
}

function completedOutcome(input: FlowArtifactInput): {
  readonly remote: NonNullable<JourneyOutcome["remote"]>;
  readonly readiness: NonNullable<JourneyOutcome["readiness"]>;
} {
  const { flow, outcome } = input;
  if (!hasCompletedRemote(outcome)) {
    throw new Error("qualification flow requires completed merge and issue closure observations");
  }
  if (!outcomeMatchesFlow(outcome, flow)) {
    throw new Error("qualification flow outcome does not match its issue binding");
  }
  const { readiness } = input;
  if (!readinessMatchesCompletedHead(readiness, outcome) || !readinessHasPassingChecks(readiness)) {
    throw new Error("qualification flow requires passing checks on the exact merged head");
  }
  if (!outcome.keikoDescriptionApplied) {
    throw new Error("qualification flow requires the governed description application");
  }
  return { remote: outcome.remote, readiness };
}

function spendFacts(input: FlowArtifactInput): CodeTaskQualificationFlowArtifactV1["spend"] {
  const { budgetNanoUsd, previousCumulativeChargedNanoUsd, cumulativeChargedNanoUsd } = input;
  if (
    ![budgetNanoUsd, previousCumulativeChargedNanoUsd, cumulativeChargedNanoUsd].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    throw new TypeError("qualification flow spend values must be safe non-negative integers");
  }
  if (cumulativeChargedNanoUsd < previousCumulativeChargedNanoUsd) {
    throw new Error("durable spend cumulative regressed between qualification flows");
  }
  if (cumulativeChargedNanoUsd > budgetNanoUsd) {
    throw new Error("qualification flow exceeded the durable spend ceiling");
  }
  return {
    budgetNanoUsd,
    chargedDeltaNanoUsd: cumulativeChargedNanoUsd - previousCumulativeChargedNanoUsd,
    cumulativeChargedNanoUsd,
    remainingNanoUsd: budgetNanoUsd - cumulativeChargedNanoUsd,
  };
}

export function buildQualificationFlowArtifact(
  input: FlowArtifactInput,
): CodeTaskQualificationFlowArtifactV1 {
  const { remote, readiness } = completedOutcome(input);
  const checks = readiness.requiredChecks;
  const candidate: unknown = {
    evidenceKind: CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND,
    schemaVersion: 1,
    ...input.flow,
    issueReference: `https://github.com/${input.flow.repository}/issues/${String(input.flow.issueNumber)}`,
    issueState: "closed",
    issueClosedAt: remote.issue.closedAt,
    taskRunId: input.outcome.binding.runId,
    pullRequestReference: remote.identity.url,
    pullRequestNumber: remote.identity.number,
    pullRequestHeadSha: input.outcome.binding.headSha,
    pullRequestState: "merged",
    pullRequestMergedAt: remote.mergedAt,
    mergeCommitSha: remote.mergeCommitSha,
    requiredChecks: {
      observation: "observed",
      headSha: readiness.headSha,
      total: checks.total,
      passed: checks.passed,
      failed: checks.failed,
      pending: checks.pending,
    },
    transitions: CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS,
    observedAt: input.outcome.observedAt,
    sourceCommitSha: input.sourceCommitSha,
    spend: spendFacts(input),
  };
  const validated = validateCodeTaskQualificationFlowArtifact(candidate);
  if (!validated.ok) {
    throw new Error(`qualification flow artifact invalid: ${validated.errors.join("; ")}`);
  }
  return validated.value;
}

const CODING_MODES = new Set<CodingWorkbenchMode>([
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
]);

function isCodingMode(value: unknown): value is CodingWorkbenchMode {
  return typeof value === "string" && CODING_MODES.has(value as CodingWorkbenchMode);
}

function descriptorFlow(value: unknown, ordinal: number): QualificationFlowBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("qualification flow descriptor entry must be an object");
  }
  const entry = value as Readonly<Record<string, unknown>>;
  const mode = entry.mode;
  if (
    entry.ordinal !== ordinal ||
    typeof entry.flowId !== "string" ||
    typeof entry.repository !== "string" ||
    !Number.isSafeInteger(entry.issueNumber) ||
    !isCodingMode(mode)
  ) {
    throw new Error("qualification flow descriptor entry is invalid");
  }
  return {
    flowId: entry.flowId,
    ordinal,
    repository: entry.repository,
    issueNumber: Number(entry.issueNumber),
    mode,
  };
}

export function selectedQualificationFlow(
  env: Readonly<Record<string, string | undefined>> = process.env,
): QualificationFlowBinding | undefined {
  const raw = env.KEIKO_QUALIFICATION_FLOW_ORDINAL;
  if (raw === undefined || raw.trim().length === 0) return undefined;
  if (!/^[1-5]$/u.test(raw)) {
    throw new Error("KEIKO_QUALIFICATION_FLOW_ORDINAL must select one flow from 1 through 5");
  }
  const ordinal = Number(raw);
  const descriptor = JSON.parse(readFileSync(DESCRIPTOR_PATH, "utf8")) as unknown;
  if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
    throw new TypeError("qualification descriptor must be an object");
  }
  const flows = (descriptor as Readonly<Record<string, unknown>>).flows;
  if (!Array.isArray(flows)) throw new Error("qualification descriptor flows are unavailable");
  const entry: unknown = (flows as readonly unknown[]).find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      (candidate as Readonly<Record<string, unknown>>).ordinal === ordinal,
  );
  return descriptorFlow(entry, ordinal);
}

function spendSnapshot(path: string): SpendSnapshot {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row: unknown = database
      .prepare("SELECT ceiling, charged FROM model_spend WHERE id = 1")
      .get();
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("durable qualification spend row is unavailable");
    }
    const { ceiling, charged } = row as Readonly<Record<string, unknown>>;
    if (
      !Number.isSafeInteger(ceiling) ||
      Number(ceiling) < 0 ||
      !Number.isSafeInteger(charged) ||
      Number(charged) < 0
    ) {
      throw new Error("durable qualification spend row is invalid");
    }
    return { ceiling: Number(ceiling), charged: Number(charged) };
  } finally {
    database.close();
  }
}

function authorizedBudgetNanoUsd(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.KEIKO_QUALIFICATION_SPEND_BUDGET_USD;
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw) * NANO_USD;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_AUTHORIZED_BUDGET_NANO_USD) {
    throw new Error("qualification spend authorization exceeds the USD 50 aggregate ceiling");
  }
  return value;
}

export function assertQualificationSpendEnvelope(
  before: SpendSnapshot,
  after: SpendSnapshot | undefined,
  env: Readonly<Record<string, string | undefined>>,
): number {
  const authorized = authorizedBudgetNanoUsd(env);
  if (before.ceiling > MAX_AUTHORIZED_BUDGET_NANO_USD) {
    throw new Error("durable spend ledger exceeds the authorized aggregate ceiling");
  }
  if (before.ceiling !== authorized || before.charged > before.ceiling) {
    throw new Error("durable spend ledger does not match the authorized aggregate ceiling");
  }
  if (
    after !== undefined &&
    (after.ceiling !== before.ceiling ||
      after.charged > after.ceiling ||
      after.charged < before.charged)
  ) {
    throw new Error("durable spend ledger changed outside the authorized monotonic envelope");
  }
  return before.ceiling;
}

function previousFlowCumulative(flow: QualificationFlowBinding): number {
  if (flow.ordinal === 1) return 0;
  const previousId = `issue-to-pr-flow-0${String(flow.ordinal - 1)}`;
  const artifactPath = join(receiptsDir(), `${previousId}.artifact`);
  const parsed: unknown = JSON.parse(readFileSync(artifactPath, "utf8"));
  const validated = validateCodeTaskQualificationFlowArtifact(parsed);
  if (!validated.ok || validated.value.ordinal !== flow.ordinal - 1) {
    throw new Error("prior completed qualification flow evidence is unavailable");
  }
  return validated.value.spend.cumulativeChargedNanoUsd;
}

async function pushGovernedGitWindow(page: Page, repositoryRoot: string): Promise<void> {
  await page.evaluate(
    ({ windowId, projectPath }) => {
      const raw = window.localStorage.getItem("keiko.workspace.v4");
      const windows: unknown[] = raw === null ? [] : (JSON.parse(raw) as unknown[]);
      windows.push({
        id: windowId,
        type: "governedGit",
        x: 70,
        y: 70,
        w: 1120,
        h: 900,
        z: 35,
        cfg: { projectPath },
        max: false,
      });
      window.localStorage.setItem("keiko.workspace.v4", JSON.stringify(windows));
    },
    { windowId: GIT_WINDOW_ID, projectPath: repositoryRoot },
  );
  await page.reload();
  await expect(page.locator(`[data-window-id="${GIT_WINDOW_ID}"]`)).toBeVisible({
    timeout: 60_000,
  });
}

async function waitForSyncExecute(page: Page, operation: "fetch" | "pull"): Promise<void> {
  const response = await page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      candidate.url().endsWith(`/api/git-delivery/${operation}/execute`),
  );
  expect(response.ok(), `governed ${operation} failed with HTTP ${String(response.status())}`).toBe(
    true,
  );
}

async function updateControlledBaseThroughGovernedGit(
  page: Page,
  flow: QualificationFlowBinding,
  repositoryRoot: string,
): Promise<void> {
  if (flow.ordinal === 1) return;
  await openLiveWorkbench(page, repositoryRoot);
  await pushGovernedGitWindow(page, repositoryRoot);
  const gitWindow = page.locator(`[data-window-id="${GIT_WINDOW_ID}"]`);
  const fetched = waitForSyncExecute(page, "fetch");
  await gitWindow.getByRole("button", { name: "Run sync: Fetch" }).click();
  await fetched;
  const pull = gitWindow.getByRole("button", { name: "Run sync: Pull" });
  await expect(pull).toBeVisible({ timeout: 60_000 });
  const pulled = waitForSyncExecute(page, "pull");
  await pull.click();
  await page
    .getByRole("dialog", { name: "Confirm pull" })
    .getByRole("button", { name: "Pull changes" })
    .click();
  await pulled;
  await expect(gitWindow.getByRole("button", { name: "Run sync: Fetch" })).toBeVisible({
    timeout: 60_000,
  });
}

async function pushGovernedMergeWindow(
  page: Page,
  repositoryRoot: string,
  delivered: DeliveredPullRequest,
): Promise<void> {
  await page.evaluate(
    ({ windowId, projectPath, headBranchName }) => {
      const raw = window.localStorage.getItem("keiko.workspace.v4");
      const windows: unknown[] = raw === null ? [] : (JSON.parse(raw) as unknown[]);
      windows.push({
        id: windowId,
        type: "governedMerge",
        x: 80,
        y: 80,
        w: 760,
        h: 900,
        z: 40,
        cfg: { projectPath, headBranchName },
        max: false,
      });
      window.localStorage.setItem("keiko.workspace.v4", JSON.stringify(windows));
    },
    { windowId: MERGE_WINDOW_ID, projectPath: repositoryRoot, headBranchName: delivered.headRef },
  );
  await page.reload();
  await expect(page.locator(`[data-window-id="${MERGE_WINDOW_ID}"]`)).toBeVisible({
    timeout: 60_000,
  });
}

async function executeGovernedMerge(
  page: Page,
  repositoryRoot: string,
  delivered: DeliveredPullRequest,
): Promise<void> {
  await pushGovernedMergeWindow(page, repositoryRoot, delivered);
  const card = page.locator(`[data-window-id="${MERGE_WINDOW_ID}"]`);
  await card.getByLabel("Repository (owner/repo)").fill(delivered.repository);
  await card.getByLabel("Pull Request number").fill(String(delivered.number));
  await card.getByLabel("Base branch").fill(delivered.baseRef);
  const previewed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/git-delivery/merge/preview"),
  );
  await card.getByRole("button", { name: "Preview", exact: true }).click();
  const previewResponse = await previewed;
  expect(
    previewResponse.ok(),
    `merge preview failed with HTTP ${String(previewResponse.status())}`,
  ).toBe(true);
  await expect(card.getByTestId("gm-readiness")).toContainText("Mergeable: yes");
  const confirmation = card.getByLabel("I confirm this high-risk merge");
  if ((await confirmation.count()) > 0) await confirmation.check();
  await expect(card.getByTestId("gm-submit")).toBeEnabled();
  const executed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/git-delivery/merge/execute"),
  );
  await card.getByTestId("gm-submit").click();
  const executeResponse = await executed;
  expect(
    executeResponse.ok(),
    `governed merge failed with HTTP ${String(executeResponse.status())}`,
  ).toBe(true);
  await expect(card.getByTestId("gm-outcome")).toContainText("merge: succeeded");
  await expect(card.getByTestId("gm-outcome")).toContainText("merged: yes");
}

async function readJourneyOutcome(page: Page, runId: string): Promise<JourneyOutcome | undefined> {
  const response = await page.request.post("/api/git-delivery/journey/refresh", {
    headers: CSRF,
    data: { runId },
  });
  expect(response.ok(), `journey refresh failed with HTTP ${String(response.status())}`).toBe(true);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TypeError("journey refresh response must be an object");
  }
  const record = body as Readonly<Record<string, unknown>>;
  if (record.status === "unavailable") return undefined;
  if (record.status !== "observed" || !isJourneyOutcome(record.outcome)) {
    throw new Error("journey refresh did not return a valid observed outcome");
  }
  if (
    record.outcome.state === "blocked" ||
    record.outcome.state === "cancelled" ||
    record.outcome.state === "recovery-required"
  ) {
    throw new Error(`journey completion failed closed in state ${record.outcome.state}`);
  }
  return record.outcome;
}

async function waitForCompletedJourney(page: Page, runId: string): Promise<JourneyOutcome> {
  const observed = await waitWhileAnsweringApprovals(
    page,
    () => readJourneyOutcome(page, runId),
    (outcome) => outcome?.state === "completed",
    {
      timeoutMs: 10 * 60_000,
      message: "expected governed merge and bound issue closure to be observed",
    },
  );
  if (observed?.state !== "completed") {
    throw new Error("completed journey outcome was unavailable");
  }
  return observed;
}

async function waitForPreMergeReadiness(
  page: Page,
  delivered: DeliveredPullRequest,
): Promise<NonNullable<JourneyOutcome["readiness"]>> {
  const observed = await waitWhileAnsweringApprovals(
    page,
    () => readJourneyOutcome(page, delivered.runId),
    (outcome) =>
      outcome?.readiness?.state === "technical-ready" &&
      outcome.readiness.complete &&
      outcome.readiness.repository === delivered.repository &&
      outcome.readiness.prNumber === delivered.number &&
      outcome.readiness.baseRef === delivered.baseRef &&
      outcome.readiness.headRef === delivered.headRef &&
      outcome.readiness.headSha === delivered.headSha,
    {
      timeoutMs: 2 * 60_000,
      message: "expected exact-head readiness before governed merge",
    },
  );
  if (observed?.readiness === null || observed?.readiness === undefined) {
    throw new Error("pre-merge readiness evidence was unavailable");
  }
  return observed.readiness;
}

function assertConfiguredIssue(flow: QualificationFlowBinding, configured: string): void {
  const expectedUrl = `https://github.com/${flow.repository}/issues/${String(flow.issueNumber)}`;
  if (configured !== expectedUrl && configured !== `#${String(flow.issueNumber)}`) {
    throw new Error("configured issue reference does not match the selected qualification flow");
  }
}

function sourceCommitSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function sameStablePullRequest(
  initial: DeliveredPullRequest,
  current: NonNullable<FinalDeliverySnapshot["pullRequest"]>,
): boolean {
  return (
    current.repository === initial.repository &&
    current.number === initial.number &&
    current.baseRef === initial.baseRef &&
    current.headRef === initial.headRef
  );
}

export function resolveFinalDeliveredPullRequest(
  initial: DeliveredPullRequest,
  snapshot: FinalDeliverySnapshot,
  finalHeadSha: string,
): DeliveredPullRequest {
  const current = snapshot.pullRequest;
  if (
    snapshot.runId !== initial.runId ||
    snapshot.phase !== "draft-created" ||
    snapshot.reason !== "completed" ||
    current === undefined ||
    !sameStablePullRequest(initial, current) ||
    snapshot.bindingHeadSha !== finalHeadSha ||
    current.headSha !== finalHeadSha
  ) {
    throw new Error("final draft delivery is not bound to the exact CI-ready pull request head");
  }
  return {
    runId: initial.runId,
    repository: current.repository,
    number: current.number,
    baseRef: current.baseRef,
    headRef: current.headRef,
    headSha: current.headSha,
  };
}

function parseActivityLine(line: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

function activityEventsForRun(runId: string): readonly Readonly<Record<string, unknown>>[] {
  const path = process.env.KEIKO_QUALIFICATION_ACTIVITY_LOG_PATH;
  if (path === undefined || path.length === 0) {
    throw new Error("qualification activity log path is unavailable");
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map(parseActivityLine)
    .filter((event): event is Readonly<Record<string, unknown>> => event?.correlationId === runId);
}

export function isUsefulRepositorySearchEvent(event: Readonly<Record<string, unknown>>): boolean {
  return (
    event.op === "coding-repository-handler.settled" &&
    event.state === "completed" &&
    Number(event.resultCount) > 0
  );
}

export function hasRedGreenVerificationSequence(
  events: readonly Readonly<Record<string, unknown>>[],
): boolean {
  const failedIndex = events.findIndex(
    (event) =>
      event.op === "coding-runtime.verification-summarized" &&
      event.verificationStatus === "failed" &&
      Number(event.failedCount) > 0,
  );
  return (
    failedIndex >= 0 &&
    events
      .slice(failedIndex + 1)
      .some(
        (event) =>
          event.op === "coding-runtime.verification-summarized" &&
          event.verificationStatus === "passed" &&
          Number(event.passedCount) > 0 &&
          Number(event.failedCount) === 0,
      )
  );
}

function assertUsefulRepositorySearch(events: readonly Readonly<Record<string, unknown>>[]): void {
  if (!events.some(isUsefulRepositorySearchEvent)) {
    throw new Error("model run did not consume a useful governed repository-search result");
  }
}

function assertVerificationBackedCommit(
  events: readonly Readonly<Record<string, unknown>>[],
  verificationEvidenceId: string,
): void {
  const matched = events.find(
    (event) =>
      event.op === "git.verified-commit" &&
      event.phase === "verification" &&
      event.passed === true &&
      event.verificationEvidenceId === verificationEvidenceId,
  );
  if (matched === undefined) {
    throw new Error("model run did not retain passing verification for the exact committed proof");
  }
}

function assertRedGreenVerification(events: readonly Readonly<Record<string, unknown>>[]): void {
  if (!hasRedGreenVerificationSequence(events)) {
    throw new Error(
      "model run did not retain an actual failing-before and passing-after verifier sequence",
    );
  }
}

async function assertVerifiedModelChange(
  page: Page,
  delivered: DeliveredPullRequest,
): Promise<void> {
  const snapshot = await runtimeSnapshot(page);
  const verified = snapshot.verifiedCommitResult;
  if (
    snapshot.result?.status !== "succeeded" ||
    verified?.status !== "succeeded" ||
    verified.reason !== "completed" ||
    verified.runId !== delivered.runId ||
    verified.headSha !== delivered.headSha ||
    verified.verificationEvidenceId.length === 0
  ) {
    throw new Error("model run did not produce a verification-backed exact-head commit");
  }
  const events = activityEventsForRun(delivered.runId);
  assertUsefulRepositorySearch(events);
  assertRedGreenVerification(events);
  assertVerificationBackedCommit(events, verified.verificationEvidenceId);
}

function qualificationSpendLedgerPath(): string {
  const path = process.env.KEIKO_QUALIFICATION_SPEND_LEDGER_PATH;
  if (path === undefined || path.length === 0) {
    throw new Error("durable qualification spend ledger path is unavailable");
  }
  return path;
}

async function driveFlowToCompletedOutcome(
  page: Page,
  flow: QualificationFlowBinding,
  repositoryRoot: string,
): Promise<{
  readonly outcome: JourneyOutcome;
  readonly readiness: NonNullable<JourneyOutcome["readiness"]>;
}> {
  const issueRef = `https://github.com/${flow.repository}/issues/${String(flow.issueNumber)}`;
  const delivered = await driveOrReuseDraftPullRequest(page, {
    repositoryRoot,
    issueRef,
    mode: flow.mode,
  });
  const ci = await waitForCiRepairOutcome(page);
  if (ci.finalState !== "technical-ready") {
    throw new Error("qualification flow did not reach exact-head technical readiness");
  }
  const finalSnapshot = await runtimeSnapshot(page);
  const finalDelivered = resolveFinalDeliveredPullRequest(
    delivered,
    {
      runId: finalSnapshot.runId,
      phase: finalSnapshot.draftDelivery?.phase,
      reason: finalSnapshot.draftDelivery?.reason,
      bindingHeadSha: finalSnapshot.draftDelivery?.binding.headSha,
      pullRequest: finalSnapshot.draftDelivery?.pullRequest,
    },
    ci.finalHeadSha,
  );
  await assertVerifiedModelChange(page, finalDelivered);
  const description = await waitForAutoDraftDescription(page);
  const retained = await mountGovernedPullRequestCard(
    page,
    repositoryRoot,
    finalDelivered,
    description,
  );
  await applyAutoDraftDescriptionThroughPrCard(page, retained);
  await proposeJourneyReady(page);
  const readiness = await waitForPreMergeReadiness(page, finalDelivered);
  await executeGovernedMerge(page, repositoryRoot, finalDelivered);
  const outcome = await waitForCompletedJourney(page, finalDelivered.runId);
  return { outcome, readiness };
}

function recordFlowArtifact(
  flow: QualificationFlowBinding,
  outcome: JourneyOutcome,
  readiness: NonNullable<JourneyOutcome["readiness"]>,
  budgetNanoUsd: number,
  previousCumulativeChargedNanoUsd: number,
  after: SpendSnapshot,
): CodeTaskQualificationFlowArtifactV1 {
  const artifact = buildQualificationFlowArtifact({
    flow,
    outcome,
    readiness,
    sourceCommitSha: sourceCommitSha(),
    budgetNanoUsd,
    previousCumulativeChargedNanoUsd,
    cumulativeChargedNanoUsd: after.charged,
  });
  const dir = receiptsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const platform = currentPlatformKey();
  if (platform !== "macos-arm64") {
    throw new Error("real five-flow qualification is bound to the authorized macos-arm64 host");
  }
  writeCodingIssueJourneyFlowEvidenceReceipt({
    receiptsDir: dir,
    artifact,
    platform,
    recordedAt: new Date().toISOString(),
  });
  return artifact;
}

export async function runSelectedQualificationFlow(
  page: Page,
  flow: QualificationFlowBinding,
): Promise<CodeTaskQualificationFlowArtifactV1> {
  const env = resolveLiveJourneyEnv();
  assertConfiguredIssue(flow, env.issueRef);
  const previousCumulativeChargedNanoUsd = previousFlowCumulative(flow);
  const ledgerPath = qualificationSpendLedgerPath();
  const before = spendSnapshot(ledgerPath);
  const budgetNanoUsd = assertQualificationSpendEnvelope(before, undefined, process.env);
  if (before.charged < previousCumulativeChargedNanoUsd) {
    throw new Error("durable spend ledger predates the prior completed qualification flow");
  }
  await updateControlledBaseThroughGovernedGit(page, flow, env.repositoryRoot);
  const completed = await driveFlowToCompletedOutcome(page, flow, env.repositoryRoot);
  const after = spendSnapshot(ledgerPath);
  assertQualificationSpendEnvelope(before, after, process.env);
  return recordFlowArtifact(
    flow,
    completed.outcome,
    completed.readiness,
    budgetNanoUsd,
    previousCumulativeChargedNanoUsd,
    after,
  );
}
