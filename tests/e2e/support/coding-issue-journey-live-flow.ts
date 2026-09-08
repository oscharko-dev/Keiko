// #3390 — five independently bound real Issue -> Keiko task -> PR -> governed merge -> closed
// issue qualification flows. The browser drive uses only mounted production routes and controls;
// the artifact is written only after the journey observer reports the provider merge and issue
// closure on the exact run/head. Failed attempts remain represented by the durable spend delta of
// the next completed flow.

import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  CodeTaskGitCommitSha,
  CodeTaskQualificationAuthorityObservationV1,
  CodeTaskQualificationFlowArtifactV1,
  CodeTaskQualificationFlowStageEvidenceV1,
  CodeTaskQualificationRubricReview,
  CodeTaskQualificationStageReceiptV1,
  CodeTaskScenarioId,
  CodingWorkbenchMode,
  JourneyOutcome,
} from "@oscharko-dev/keiko-contracts";
import {
  CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND,
  CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS,
  isCodeTaskGitCommitSha,
  isCodeTaskScenarioId,
  isCodeTaskSha256Digest,
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
  qualificationResumeBinding,
  resumeIssueToDraftPullRequest,
} from "./coding-issue-journey-live-resume.js";
import {
  applyAutoDraftDescriptionThroughPrCard,
  mountGovernedPullRequestCard,
  reconcileAppliedDescriptionAfterMarkReady,
  waitForAutoDraftDescription,
} from "./coding-issue-journey-live-description.js";
import {
  evaluateCiRepairLoopOutcome,
  type CiRepairOutcome,
  waitForCiRepairOutcome,
} from "./coding-issue-journey-live-ci.js";
import { awaitIndependentQualificationReview } from "./coding-issue-journey-independent-review.js";
import { observeQualificationFlowAuthority } from "./coding-issue-journey-live-authority.js";
import { proposeJourneyReady } from "./coding-issue-journey-live-mark-ready.js";
import {
  type DeliveredPullRequest,
  openLiveWorkbench,
  readObservedRunWhileAwaitingSuccess,
  waitWhileAnsweringApprovals,
} from "./coding-issue-journey-live.js";
import {
  observedDelivery,
  observedDiagnosis,
  observedRun,
} from "./coding-issue-journey-live-observed.js";
import type { RetainedDescriptionBinding } from "./coding-issue-journey-live-description.js";
import { resolveLiveJourneyEnv } from "./coding-issue-journey-live-runners.js";
import { currentPlatformKey, receiptsDir } from "./coding-issue-journey-scenarios.js";
import {
  ciRepairAssertions,
  descriptionAssertions,
  governedMergeAndClosureEvidence,
  issueToPrAssertions,
  markReadyAssertions,
  modeScenarioId,
} from "./coding-issue-journey-stage-assertions.js";
import { recordSuccessfulJourneyStage } from "./coding-issue-journey-stage-receipts.js";

const DESCRIPTOR_PATH = join("docs", "acceptance", "coding-issue-journey-3390.json");
const MAX_AUTHORIZED_BUDGET_NANO_USD = 50_000_000_000;
const NANO_USD = 1_000_000_000;
const JOURNEY_REGION_NAME = "Issue handoff";
const JOURNEY_REFRESH_BUTTON_NAME = "Refresh observed status";

export interface QualificationFlowBinding {
  readonly flowId: CodeTaskScenarioId;
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
  readonly authorityObservation: CodeTaskQualificationAuthorityObservationV1;
  readonly rubricReview: CodeTaskQualificationRubricReview;
  readonly stageEvidence: CodeTaskQualificationFlowStageEvidenceV1;
}

export interface SpendSnapshot {
  readonly ceiling: number;
  readonly charged: number;
}

// #3390: `runId` is gone from this shape. It was compared against the initial delivery's run id to
// prove the final delivery belonged to the same attempt -- a fact no window displays. The same
// guarantee now comes from what the interface DOES show: the awaiting-success guard fails the
// moment the delivery card stops naming this pull request, and `sameStablePullRequest` below still
// pins repository, number and both refs against the initial delivery.
export interface FinalDeliverySnapshot {
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
      requirementsVersion: readiness.requirementsVersion,
      requirementsDigest: readiness.requirementsDigest,
      evidenceRef: readiness.evidenceRef,
      total: checks.total,
      passed: checks.passed,
      failed: checks.failed,
      pending: checks.pending,
    },
    authorityObservation: input.authorityObservation,
    rubricReview: input.rubricReview,
    stageEvidence: input.stageEvidence,
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
    !isCodeTaskScenarioId(entry.flowId) ||
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

// The last non-empty "/"-or-"\"-separated segment of a repository path -- mirrors
// `repositoryLabel()` in CodingWorkbenchWindow.tsx (~line 1111), which derives the composer's
// "Manage repository {repository}" accessible name (i18n
// "codingWorkbench.composer.repository.open") from the SAME algorithm.
function repositoryButtonLabel(repositoryRoot: string): string {
  const parts = repositoryRoot.split(/[\\/]/u);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part !== undefined && part.length > 0) return part;
  }
  return repositoryRoot;
}

// Real production affordance for opening the governed Git window (binding rule: every user action
// goes through the browser exactly as a normal user would -- never a seeded `keiko.workspace.v4`
// window). The Coding Workbench composer's own repository chip
// (CodingWorkbenchSections.tsx ~193-204, aria-label "Manage repository {repository}") calls
// `onOpenGit({ root: repositoryRoot, binding: "repository" })` (CodingWorkbenchWindow.tsx ~909,
// proven by CodingWorkbenchWindow.test.tsx's "opens Git on the active task worktree" case), which
// widgets/index.tsx's "coding" registerWindowRender (~602-620) turns into
// `ctx.openWindow("governedGit", { projectPath: root, ... })`. The prefix selector below is
// the SAME one `coding-issue-journey-live.ts`'s `currentLiveWorkbenchIdentity` already uses
// (`button[aria-label^="Manage repository "]`) to identify this exact control.
//
// `governedGit` is a SINGLETON window type (WindowsRegistry.ts `governedGit: { singleton: true }`),
// so repeated calls across one flow raise/refresh the ONE real Git window instead of stacking
// duplicates. The desktop assigns its id, so the window is located by its accessible region name
// ("Git", `window.type.governedGit.title`, no sub-text for this window type) rather than a fixed
// `data-window-id`.
async function openGovernedGitWindow(page: Page, repositoryRoot: string): Promise<Locator> {
  const manageRepository = page.locator('button[aria-label^="Manage repository "]');
  await expect(manageRepository).toBeVisible({ timeout: 60_000 });
  await expect(manageRepository).toHaveAccessibleName(
    `Manage repository ${repositoryButtonLabel(repositoryRoot)}`,
  );
  await manageRepository.click();
  const gitWindow = page.getByRole("region", { name: "Git", exact: true });
  await expect(gitWindow).toBeVisible({ timeout: 60_000 });
  return gitWindow;
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
  const gitWindow = await openGovernedGitWindow(page, repositoryRoot);
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

// Real production affordance for the governed merge action. The SAME singleton "Git" window
// `openGovernedGitWindow` opens embeds the merge command center as its own right-pane panel:
// `GitClientWindow.tsx`'s `CommitComposer` renders a "Merge" button
// (`onMerge={() => openRightPane("merge")}`, ~line 1596) that switches the window's right pane to
// `mergePane` (a `GovernedMergeCard`, ~line 1739-1747), a region named "Merge"
// (`gitClientWindow.panel.merge`, i18n). This exact selector pair -- `getByRole("tab", {name:
// "Changes"})` -> `getByRole("button", {name: /Merge/u})` -> `getByRole("region", {name: "Merge",
// exact: true})` -- is already proven against the real production window by
// `tests/e2e/git-pr-merge-1577.spec.ts` (~line 371-403) and
// `tests/e2e/git-client-closeout-1578.spec.ts`'s `verifyPrAndMerge` (~line 771-798). "changes" is
// the panel's own default tab (GitClientWindow.tsx's `useState<ChangesTab>("changes")`), so the
// explicit click only mirrors those proven specs' defensive habit, never a required precondition.
async function executeGovernedMerge(
  page: Page,
  repositoryRoot: string,
  delivered: DeliveredPullRequest,
): Promise<void> {
  const gitWindow = await openGovernedGitWindow(page, repositoryRoot);
  await gitWindow.getByRole("tab", { name: "Changes" }).click();
  await gitWindow.getByRole("button", { name: /Merge/u }).click();
  const card = gitWindow.getByRole("region", { name: "Merge", exact: true });
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
  // The controlled base requires linear history, so a merge-commit-shaped strategy is not offered
  // (deriveEligibleMergeStrategies). Name squash explicitly, as an operator merging into such a
  // branch does, instead of leaving the provider to choose the method.
  await card.getByTestId("gm-strategy").selectOption("squash");
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

// Real production affordance for observing the journey outcome. The Coding Workbench's own "Issue
// handoff" card (CodingWorkbenchJourneyOutcome.tsx, region name from i18n
// "codingWorkbench.journey.title") carries the "Refresh observed status" button (i18n
// "codingWorkbench.journey.refresh") that invokes the SAME production hook
// (`useCodingWorkbenchJourney`'s `refresh`, CodingWorkbenchWindow.tsx ~235-260), which POSTs this
// exact route (`fetchCodingWorkbenchJourneyRefresh`, coding-workbench-lazy-fetchers.ts:273). The
// route is server-documented as read-only (journeyRoutes.ts: "Never mutates, never grants merge or
// issue-close authority") yet load-bearing for progress: its own comment states the persisted
// CI-readiness projection "is written only while the run is live and expires 60s later, so a
// settled run's handoff would otherwise report readiness-stale forever" -- so this cannot be
// dropped as a pure assertion-only read, it must actually be triggered through the real control.
// The identical region/button names are already proven driving this SAME card in
// `coding-issue-journey-live-mark-ready.ts`'s `proposeJourneyReady`.
function parseJourneyRefreshBody(body: unknown): Readonly<Record<string, unknown>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TypeError("journey refresh response must be an object");
  }
  return body as Readonly<Record<string, unknown>>;
}

// Split out of `readJourneyOutcome` to keep both functions under the complexity bar (AGENTS.md §6).
function resolveObservedJourneyOutcome(
  record: Readonly<Record<string, unknown>>,
  runId: string,
): JourneyOutcome | undefined {
  if (record.status === "unavailable") return undefined;
  if (record.status !== "observed" || !isJourneyOutcome(record.outcome)) {
    throw new Error("journey refresh did not return a valid observed outcome");
  }
  if (record.outcome.binding.runId !== runId) {
    throw new Error("journey refresh observed a different run than the one being awaited");
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

async function readJourneyOutcome(page: Page, runId: string): Promise<JourneyOutcome | undefined> {
  const journey = page.getByRole("region", { name: JOURNEY_REGION_NAME, exact: true });
  // CodingWorkbenchJourneyOutcome renders nothing (returns null) until its OWN mount-time refresh
  // has already produced a valid outcome, so "not visible yet" is the real-UI equivalent of the
  // server's "unavailable" status -- the caller's own polling loop
  // (`waitWhileAnsweringApprovals`) keeps retrying every 2s until the card appears on its own.
  if (!(await journey.isVisible())) return undefined;
  const refreshed = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      candidate.url().endsWith("/api/git-delivery/journey/refresh"),
  );
  await journey.getByRole("button", { name: JOURNEY_REFRESH_BUTTON_NAME }).click();
  const response = await refreshed;
  expect(response.ok(), `journey refresh failed with HTTP ${String(response.status())}`).toBe(true);
  const record = parseJourneyRefreshBody(await response.json());
  return resolveObservedJourneyOutcome(record, runId);
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

function sourceCommitSha(): CodeTaskGitCommitSha {
  const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!isCodeTaskGitCommitSha(source)) throw new Error("qualification source commit is invalid");
  return source;
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

export function activityEventTree(
  events: readonly Readonly<Record<string, unknown>>[],
  rootCorrelationId: string,
): readonly Readonly<Record<string, unknown>>[] {
  const children = new Map<string, Set<string>>();
  for (const event of events) {
    const parent = event.parentCorrelationId;
    const correlation = event.correlationId;
    if (typeof parent !== "string" || typeof correlation !== "string") continue;
    const siblings = children.get(parent) ?? new Set<string>();
    siblings.add(correlation);
    children.set(parent, siblings);
  }
  const related = new Set([rootCorrelationId]);
  const pending = [rootCorrelationId];
  for (const correlation of pending) {
    for (const child of children.get(correlation) ?? []) {
      if (related.has(child)) continue;
      related.add(child);
      pending.push(child);
    }
  }
  return events.filter(
    (event) =>
      (typeof event.correlationId === "string" && related.has(event.correlationId)) ||
      (typeof event.parentCorrelationId === "string" && related.has(event.parentCorrelationId)),
  );
}

export function activityEventsForRun(runId: string): readonly Readonly<Record<string, unknown>>[] {
  const path = process.env.KEIKO_QUALIFICATION_ACTIVITY_LOG_PATH;
  if (path === undefined || path.length === 0) {
    throw new Error("qualification activity log path is unavailable");
  }
  const events = readFileSync(path, "utf8")
    .split("\n")
    .map(parseActivityLine)
    .filter((event): event is Readonly<Record<string, unknown>> => event !== undefined);
  return activityEventTree(events, runId);
}

export function isUsefulRepositorySearchEvent(event: Readonly<Record<string, unknown>>): boolean {
  return (
    event.op === "coding-repository-handler.settled" &&
    event.state === "completed" &&
    Number(event.resultCount) > 0
  );
}

export function hasUsefulRepositorySearchSequence(
  events: readonly Readonly<Record<string, unknown>>[],
): boolean {
  return events.some((event, searchIndex) => {
    if (
      !isUsefulRepositorySearchEvent(event) ||
      typeof event.correlationId !== "string" ||
      event.correlationId.length === 0
    )
      return false;
    const invoked = events
      .slice(0, searchIndex)
      .some(
        (candidate) =>
          candidate.op === "tool-catalog.invocation-started" &&
          canonicalToolId(candidate) === "keiko.repo.search" &&
          candidate.correlationId === event.correlationId,
      );
    if (!invoked) return false;
    const paths = digestSet(event.resultPathSha256);
    return (
      paths.size > 0 &&
      events
        .slice(searchIndex + 1)
        .some(
          (read) =>
            read.op === "coding-runtime.workspace-read" &&
            read.state === "completed" &&
            read.correlationId === event.correlationId &&
            typeof read.targetPathSha256 === "string" &&
            paths.has(read.targetPathSha256),
        )
    );
  });
}

function canonicalToolId(event: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const toolRef = event?.toolRef;
  return typeof toolRef === "object" && toolRef !== null && !Array.isArray(toolRef)
    ? String((toolRef as Readonly<Record<string, unknown>>).canonicalId)
    : undefined;
}

function digestSet(value: unknown): ReadonlySet<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item),
        )
      : [],
  );
}

export function hasRedGreenVerificationSequence(
  events: readonly Readonly<Record<string, unknown>>[],
): boolean {
  return events.some((event, failedIndex) => {
    const target = verificationTarget(event, "failed");
    if (target === undefined) return false;
    const following = events.slice(failedIndex + 1);
    const editIndex = following.findIndex(isSuccessfulEditorMutation);
    return (
      editIndex >= 0 &&
      following
        .slice(editIndex + 1)
        .some((candidate) => verificationTarget(candidate, "passed") === target)
    );
  });
}

function verificationTarget(
  event: Readonly<Record<string, unknown>>,
  status: "failed" | "passed",
): string | undefined {
  const digest = event.verificationTargetDigest;
  const count = status === "failed" ? Number(event.failedCount) : Number(event.passedCount);
  const opposite = status === "failed" ? Number(event.passedCount) : Number(event.failedCount);
  return event.op === "coding-runtime.verification-summarized" &&
    event.verificationStatus === status &&
    count > 0 &&
    opposite === 0 &&
    typeof digest === "string" &&
    /^[a-f0-9]{64}$/u.test(digest)
    ? digest
    : undefined;
}

function isSuccessfulEditorMutation(event: Readonly<Record<string, unknown>>): boolean {
  return event.op === "coding-runtime.editor-mutation.settled" && event.state === "succeeded";
}

function assertUsefulRepositorySearch(events: readonly Readonly<Record<string, unknown>>[]): void {
  if (!hasUsefulRepositorySearchSequence(events)) {
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

// #3390: the run's own `result.status` reaches no rendered element, and the receipt's run id is
// never displayed either. Neither is missed. The window shows the run reaching `succeeded`, and the
// commit-result card renders ONLY for the run the window is currently showing
// (`result.runId === runId`, CodingWorkbenchCommitResult.tsx), so the receipt's presence IS the
// interface's own proof that it belongs to this run -- the check the run-id comparison performed.
async function assertVerifiedModelChange(
  page: Page,
  delivered: DeliveredPullRequest,
): Promise<void> {
  const observed = await waitWhileAnsweringApprovals(
    page,
    () =>
      readObservedRunWhileAwaitingSuccess(
        () => observedRun(page),
        delivered.number,
        () => observedDiagnosis(page),
      ),
    (value) => value.state === "succeeded" && value.commitReceipt?.status === "succeeded",
    {
      timeoutMs: 25 * 60_000,
      message: "model run did not settle successfully after creating its draft pull request",
    },
  );
  const verified = observed.commitReceipt;
  if (
    verified?.status !== "succeeded" ||
    verified.reason !== "completed" ||
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

function stageFlowBinding(
  flow: QualificationFlowBinding,
  delivered: DeliveredPullRequest,
): NonNullable<Parameters<typeof recordSuccessfulJourneyStage>[4]> {
  if (delivered.repository !== flow.repository) {
    throw new Error("qualification stage repository does not match the selected flow");
  }
  return {
    flowId: flow.flowId,
    taskRunId: delivered.runId,
    repository: flow.repository,
    issueNumber: flow.issueNumber,
    pullRequestNumber: delivered.number,
    pullRequestHeadSha: delivered.headSha,
  };
}

function completedCatalogToolCount(runId: string): number {
  return activityEventsForRun(runId).filter(
    (event) => event.op === "tool-catalog.invocation-settled" && event.status === "completed",
  ).length;
}

function stageReceiptIdentity(
  scenarioId: string,
  receiptDigest: string,
): CodeTaskQualificationStageReceiptV1 {
  if (!isCodeTaskScenarioId(scenarioId) || !isCodeTaskSha256Digest(receiptDigest)) {
    throw new Error("qualification stage receipt identity is invalid");
  }
  return { scenarioId, receiptDigest };
}

export function qualifiedCiRepairAssertions(
  outcome: CiRepairOutcome,
): readonly string[] | undefined {
  return evaluateCiRepairLoopOutcome(outcome).result === "passed"
    ? ciRepairAssertions(outcome)
    : undefined;
}

async function recordDeliveryAndCiStages(
  page: Page,
  flow: QualificationFlowBinding,
  delivered: DeliveredPullRequest,
  ciAssertions: readonly string[] | undefined,
  startedAt: number,
  toolCallCount: number,
): Promise<Pick<CodeTaskQualificationFlowStageEvidenceV1, "issueToPr" | "ciRepair">> {
  const flowBinding = stageFlowBinding(flow, delivered);
  const issueToPrScenario = modeScenarioId(flow.mode);
  const issueToPrDigest = await recordSuccessfulJourneyStage(
    page,
    issueToPrScenario,
    issueToPrAssertions(delivered, flow.mode),
    startedAt,
    flowBinding,
    toolCallCount,
  );
  let ciRepair: CodeTaskQualificationFlowStageEvidenceV1["ciRepair"] = null;
  if (ciAssertions !== undefined) {
    const receiptDigest = await recordSuccessfulJourneyStage(
      page,
      "ci-repair-loop",
      ciAssertions,
      startedAt,
      flowBinding,
      toolCallCount,
    );
    ciRepair = stageReceiptIdentity("ci-repair-loop", receiptDigest);
  }
  return {
    issueToPr: stageReceiptIdentity(issueToPrScenario, issueToPrDigest),
    ciRepair,
  };
}

async function applyAndRecordDescription(
  page: Page,
  repositoryRoot: string,
  delivered: DeliveredPullRequest,
  flow: QualificationFlowBinding,
  startedAt: number,
  toolCallCount: number,
): Promise<{
  readonly stage: CodeTaskQualificationFlowStageEvidenceV1["description"];
  readonly retained: RetainedDescriptionBinding;
}> {
  const description = await waitForAutoDraftDescription(page);
  // The card opens on the run's own task workspace scope, which is where the server retained the
  // proposal -- never on the repository root. That scope is READ BACK from the card's own review
  // request rather than compared against a path the product deliberately never displays, and the
  // post-mark-ready refresh is then pinned to the same one.
  const retained = await mountGovernedPullRequestCard(page, repositoryRoot, delivered, description);
  await applyAutoDraftDescriptionThroughPrCard(page, retained);
  const receiptDigest = await recordSuccessfulJourneyStage(
    page,
    "description-auto-draft-and-apply",
    descriptionAssertions(description, retained),
    startedAt,
    stageFlowBinding(flow, delivered),
    toolCallCount,
  );
  return {
    stage: stageReceiptIdentity("description-auto-draft-and-apply", receiptDigest),
    retained,
  };
}

async function driveSelectedDraftPullRequest(
  page: Page,
  flow: QualificationFlowBinding,
  repositoryRoot: string,
  issueRef: string,
): Promise<DeliveredPullRequest> {
  const resume = qualificationResumeBinding();
  if (resume === undefined) {
    return driveOrReuseDraftPullRequest(page, { repositoryRoot, issueRef, mode: flow.mode });
  }
  return resumeIssueToDraftPullRequest(page, {
    repositoryRoot,
    issueRef,
    issueNumber: flow.issueNumber,
    mode: flow.mode,
    resume,
  });
}

async function resolveExactHeadDelivery(
  page: Page,
  flow: QualificationFlowBinding,
  repositoryRoot: string,
): Promise<{
  readonly delivered: DeliveredPullRequest;
  readonly ciAssertions: readonly string[] | undefined;
  readonly toolCallCount: number;
}> {
  const issueRef = `https://github.com/${flow.repository}/issues/${String(flow.issueNumber)}`;
  const delivered = await driveSelectedDraftPullRequest(page, flow, repositoryRoot, issueRef);
  const ci = await waitForCiRepairOutcome(page);
  const ciAssertions = qualifiedCiRepairAssertions(ci);
  if (ci.finalState !== "technical-ready") {
    throw new Error("qualification flow did not reach exact-head technical readiness");
  }
  const delivery = await observedDelivery(page);
  const exactHead = resolveFinalDeliveredPullRequest(
    delivered,
    {
      phase: delivery?.phase,
      reason: delivery?.reason,
      bindingHeadSha: delivery?.headSha,
      pullRequest:
        delivery?.pullRequest === undefined
          ? undefined
          : {
              repository: delivery.repository,
              number: delivery.pullRequest.number,
              baseRef: delivery.baseRef,
              headRef: delivery.headRef,
              headSha: delivery.pullRequest.headSha,
            },
    },
    ci.finalHeadSha,
  );
  await assertVerifiedModelChange(page, exactHead);
  return {
    delivered: exactHead,
    ciAssertions,
    toolCallCount: completedCatalogToolCount(exactHead.runId),
  };
}

async function recordPreMergeStages(
  page: Page,
  flow: QualificationFlowBinding,
  repositoryRoot: string,
  startedAt: number,
  exactHead: Awaited<ReturnType<typeof resolveExactHeadDelivery>>,
): Promise<{
  readonly readiness: NonNullable<JourneyOutcome["readiness"]>;
  readonly flowBinding: ReturnType<typeof stageFlowBinding>;
  readonly stages: Omit<CodeTaskQualificationFlowStageEvidenceV1, "governedMerge">;
}> {
  const { delivered, ciAssertions, toolCallCount } = exactHead;
  const delivery = await recordDeliveryAndCiStages(
    page,
    flow,
    delivered,
    ciAssertions,
    startedAt,
    toolCallCount,
  );
  const description = await applyAndRecordDescription(
    page,
    repositoryRoot,
    delivered,
    flow,
    startedAt,
    toolCallCount,
  );
  await proposeJourneyReady(page);
  await reconcileAppliedDescriptionAfterMarkReady(page, description.retained, delivered);
  const flowBinding = stageFlowBinding(flow, delivered);
  const markReadyDigest = await recordSuccessfulJourneyStage(
    page,
    "mark-ready-intent",
    markReadyAssertions(),
    startedAt,
    flowBinding,
    toolCallCount,
  );
  return {
    readiness: await waitForPreMergeReadiness(page, delivered),
    flowBinding,
    stages: {
      ...delivery,
      description: description.stage,
      markReady: stageReceiptIdentity("mark-ready-intent", markReadyDigest),
    },
  };
}

async function reviewExactHead(
  flow: QualificationFlowBinding,
  delivered: DeliveredPullRequest,
  qualifiedSourceCommitSha: CodeTaskGitCommitSha,
): Promise<CodeTaskQualificationRubricReview> {
  if (!isCodeTaskGitCommitSha(delivered.headSha)) {
    throw new Error("qualification final pull-request head is invalid");
  }
  // The flow parks here until the reviewer answers, so the outer Playwright clock must stop
  // governing it; every remaining stage keeps its own bounded wait. A review is human-paced work
  // and must never be lost to a wall-clock expiry that looks identical to a reviewer who said no.
  test.setTimeout(0);
  return awaitIndependentQualificationReview({
    flowId: flow.flowId,
    taskRunId: delivered.runId,
    repository: flow.repository,
    issueNumber: flow.issueNumber,
    pullRequestNumber: delivered.number,
    pullRequestHeadSha: delivered.headSha,
    sourceCommitSha: qualifiedSourceCommitSha,
  });
}

async function driveFlowToCompletedOutcome(
  page: Page,
  flow: QualificationFlowBinding,
  repositoryRoot: string,
  startedAt: number,
  qualifiedSourceCommitSha: CodeTaskGitCommitSha,
): Promise<{
  readonly outcome: JourneyOutcome;
  readonly readiness: NonNullable<JourneyOutcome["readiness"]>;
  readonly authorityObservation: CodeTaskQualificationAuthorityObservationV1;
  readonly rubricReview: CodeTaskQualificationRubricReview;
  readonly stageEvidence: CodeTaskQualificationFlowStageEvidenceV1;
}> {
  const exactHead = await resolveExactHeadDelivery(page, flow, repositoryRoot);
  const preMerge = await recordPreMergeStages(page, flow, repositoryRoot, startedAt, exactHead);
  const finalDelivered = exactHead.delivered;
  const rubricReview = await reviewExactHead(flow, finalDelivered, qualifiedSourceCommitSha);
  await executeGovernedMerge(page, repositoryRoot, finalDelivered);
  const outcome = await waitForCompletedJourney(page, finalDelivered.runId);
  const mergeEvidence = governedMergeAndClosureEvidence(outcome);
  const mergeReceiptDigest = await recordSuccessfulJourneyStage(
    page,
    "human-merge-and-closure",
    mergeEvidence.assertions,
    startedAt,
    { ...preMerge.flowBinding, mergeCommitSha: mergeEvidence.mergeCommitSha },
    exactHead.toolCallCount,
  );
  return {
    outcome,
    readiness: preMerge.readiness,
    authorityObservation: observeQualificationFlowAuthority(
      activityEventsForRun(finalDelivered.runId),
      {
        runId: finalDelivered.runId,
        mode: flow.mode,
      },
    ),
    rubricReview,
    stageEvidence: {
      ...preMerge.stages,
      governedMerge: stageReceiptIdentity("human-merge-and-closure", mergeReceiptDigest),
    },
  };
}

function recordFlowArtifact(
  flow: QualificationFlowBinding,
  outcome: JourneyOutcome,
  readiness: NonNullable<JourneyOutcome["readiness"]>,
  budgetNanoUsd: number,
  previousCumulativeChargedNanoUsd: number,
  after: SpendSnapshot,
  completed: Pick<
    Awaited<ReturnType<typeof driveFlowToCompletedOutcome>>,
    "authorityObservation" | "rubricReview" | "stageEvidence"
  >,
  qualifiedSourceCommitSha: CodeTaskGitCommitSha,
): CodeTaskQualificationFlowArtifactV1 {
  const artifact = buildQualificationFlowArtifact({
    flow,
    outcome,
    readiness,
    sourceCommitSha: qualifiedSourceCommitSha,
    budgetNanoUsd,
    previousCumulativeChargedNanoUsd,
    cumulativeChargedNanoUsd: after.charged,
    ...completed,
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
  const startedAt = Date.now();
  const qualifiedSourceCommitSha = sourceCommitSha();
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
  const completed = await driveFlowToCompletedOutcome(
    page,
    flow,
    env.repositoryRoot,
    startedAt,
    qualifiedSourceCommitSha,
  );
  const after = spendSnapshot(ledgerPath);
  assertQualificationSpendEnvelope(before, after, process.env);
  if (sourceCommitSha() !== qualifiedSourceCommitSha) {
    throw new Error("qualification source changed while the real flow was running");
  }
  return recordFlowArtifact(
    flow,
    completed.outcome,
    completed.readiness,
    budgetNanoUsd,
    previousCumulativeChargedNanoUsd,
    after,
    completed,
    qualifiedSourceCommitSha,
  );
}
