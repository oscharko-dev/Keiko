// #3390 — shared driver for the real-model production-composition journey
// (`coding-issue-journey.spec.ts`). Generalizes the pairing/readiness/issue-intake steps the
// original single test already established (blockers A/B documented there) so every scenario
// test can reuse ONE drive-to-draft-PR path instead of five near-duplicates, and parameterizes the
// ADR-0138 mode selection through the SAME `selectCodingIssueMode` helper the scripted
// `coding-issue-commit.spec.ts` / `coding-issue-delivery.spec.ts` siblings already use
// (`./coding-issue-browser.js`) rather than a second "enableFullAccess"-only copy.
//
// Unlike those scripted siblings, there is no fixture `control()` channel here: the real model
// decides its own tool-call sequence (commit, push, draft PR, CI observation and repair are all
// model-visible tools on the head this harness runs against). This module only supplies the task
// instructions, answers approval prompts as they appear, and polls the real, unmocked runtime
// snapshot for the effect the model is expected to eventually produce.

import { expect, type Locator, type Page } from "@playwright/test";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeSnapshot,
  ModelCapability,
} from "@oscharko-dev/keiko-contracts";
import type { GatewayReadinessReport } from "@oscharko-dev/keiko-contracts/bff-wire";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { isCodingWorkbenchModel } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";
import { selectCodingIssueMode } from "./coding-issue-browser.js";

const SURFACE = 'section[aria-label="Coding Workbench"][data-state]';
const AUTH_ENDPOINT = "/api/coding-workbench/github-authorization";
const MODELS_ENDPOINT = "/api/models";
const GATEWAY_READINESS_ENDPOINT = "/api/gateway/readiness";
const GATEWAY_SETUP_ENDPOINT = "/api/gateway/setup";
const READINESS_ENDPOINT = "/api/coding-workbench/runtime/readiness";
const CSRF = { "X-Keiko-CSRF": "1" };

export function workbenchSurface(page: Page): Locator {
  return page.locator(SURFACE);
}

// Live-run blocker (A), generalized from the original single test: the real production
// composition starts every browser session unpaired, so the first authority-gated call 403s
// ("Workbench is not paired") until a launcher pairing attestation is minted against the SAME
// secret the launched server resolves (`KEIKO_QUALIFICATION_LAUNCHER_SECRET`).
export async function pairLiveSession(page: Page): Promise<void> {
  const launcherSecret = process.env.KEIKO_QUALIFICATION_LAUNCHER_SECRET;
  expect(
    launcherSecret,
    "KEIKO_QUALIFICATION_LAUNCHER_SECRET must be resolved by the Playwright config and handed " +
      "to both this process and the launched server",
  ).toBeTruthy();
  if (launcherSecret === undefined) return;
  const fragment = encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: launcherSecret,
      requestId: `coding-issue-journey-${String(Date.now())}-${String(Math.random())}`,
      issuedAtMs: Date.now(),
    }),
  );
  await page.goto(`/${fragment}`);
  await expect.poll(() => page.url()).not.toContain("keiko-app-session");
}

// Review 3941762920: this init script re-runs on EVERY navigation Playwright performs on this
// page, including a later `page.reload()` a scenario issues after appending its own window (e.g.
// `mountGovernedPullRequestCard`). Seeding `keiko.workspace.v4` unconditionally clobbered that
// appended window back to the single "coding" layout on every such reload. Guarding the seed
// behind "not already present" makes it one-shot per browser context: the first navigation of a
// fresh context (empty storage) still seeds the initial layout, but a later reload of the SAME
// context sees the already-populated key and leaves whatever the scenario has since appended.
export async function openLiveWorkbench(page: Page, repositoryRoot: string): Promise<void> {
  await page.addInitScript(
    ({ root }) => {
      localStorage.setItem("keiko.theme", "dark");
      if (localStorage.getItem("keiko.workspace.v4") === null) {
        localStorage.setItem(
          "keiko.workspace.v4",
          JSON.stringify([
            {
              id: "coding-issue-journey-live",
              type: "coding",
              x: 40,
              y: 48,
              w: 1120,
              h: 1400,
              z: 10,
              zoom: 1,
              cfg: { repositoryPath: root },
              max: false,
            },
          ]),
        );
      }
      localStorage.removeItem("keiko.conns.v1");
    },
    { root: repositoryRoot },
  );
  await pairLiveSession(page);
  await expect(workbenchSurface(page)).toBeVisible();
  await expect(page.getByLabel("Repository path")).toHaveValue(repositoryRoot);
}

async function liveModels(page: Page): Promise<readonly ModelCapability[]> {
  const modelsResponse = await page.request.get(MODELS_ENDPOINT);
  expect(modelsResponse.ok()).toBe(true);
  const { models } = (await modelsResponse.json()) as {
    readonly models: readonly ModelCapability[];
  };
  return models;
}

function qualificationChatModel(models: readonly ModelCapability[]): ModelCapability {
  const chatModels = models.filter((model) => model.kind === "chat");
  const eligible = chatModels.filter((model) => model.workflowEligible);
  const candidates = eligible.length > 0 ? eligible : chatModels;
  expect(
    candidates.length,
    "the configured Model Gateway must expose at least one chat model",
  ).toBeGreaterThan(0);
  expect(
    candidates.length,
    "the live qualification config must identify one unambiguous chat model",
  ).toBe(1);
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error("live qualification chat model was unavailable");
  return candidate;
}

async function refreshToolCallingProof(page: Page, modelId: string): Promise<void> {
  const response = await page.request.post(GATEWAY_READINESS_ENDPOINT, {
    headers: CSRF,
    data: { modelId, options: { probes: ["tool_calling"] } },
  });
  expect(
    response.ok(),
    `the guarded readiness call failed with HTTP ${String(response.status())}`,
  ).toBe(true);
  const report = (await response.json()) as GatewayReadinessReport;
  const proof = report.probes.find((probe) => probe.name === "tool_calling");
  expect(proof?.status, "the guarded readiness call must verify tool calling").toBe("passed");
  expect(report.verifiedCapabilities.toolCalling).toBe(true);
}

interface LiveModelQualificationClient {
  readonly loadModels: () => Promise<readonly ModelCapability[]>;
  readonly refreshToolCalling: (modelId: string) => Promise<void>;
  readonly enableWorkflow: (modelId: string) => Promise<void>;
}

export interface LiveWorkbenchIdentity {
  readonly workspaceId: string | null;
  readonly taskId: string | null;
  readonly taskBranch: string | null;
  readonly repositoryControlName: string;
  readonly branchControlName: string;
}

interface LiveWorkbenchReloadClient {
  readonly reload: () => Promise<void>;
  readonly waitForWorkbench: () => Promise<void>;
  readonly waitForWorkspaceIdentity: (identity: LiveWorkbenchIdentity) => Promise<void>;
}

export async function qualifyLiveModel(client: LiveModelQualificationClient): Promise<boolean> {
  let changed = false;
  let model = qualificationChatModel(await client.loadModels());
  if (!model.toolCalling) {
    const selectedModelId = model.id;
    await client.refreshToolCalling(selectedModelId);
    changed = true;
    model = qualificationChatModel(await client.loadModels());
    expect(model.id, "readiness must refresh the selected model").toBe(selectedModelId);
    expect(model.toolCalling, "readiness must publish the refreshed tool-calling proof").toBe(true);
  }
  if (isCodingWorkbenchModel(model)) return changed;
  const selectedModelId = model.id;
  await client.enableWorkflow(selectedModelId);
  model = qualificationChatModel(await client.loadModels());
  expect(model.id, "setup must preserve the selected model identity").toBe(selectedModelId);
  expect(
    isCodingWorkbenchModel(model),
    "setup must publish the selected model as coding-workbench capable",
  ).toBe(true);
  return true;
}

export async function reconcileLiveWorkbenchAfterModelChange(
  changed: boolean,
  workspaceIdentity: LiveWorkbenchIdentity,
  client: LiveWorkbenchReloadClient,
): Promise<void> {
  if (!changed) return;
  await client.reload();
  await client.waitForWorkbench();
  await client.waitForWorkspaceIdentity(workspaceIdentity);
}

interface ActiveTaskWorkspaceResponse {
  readonly active: {
    readonly instance: {
      readonly workspaceId: string;
      readonly taskId: string;
      readonly taskBranch: string;
    };
  } | null;
}

async function activeTaskWorkspace(page: Page): Promise<ActiveTaskWorkspaceResponse["active"]> {
  const response = await page.request.get("/api/task-workspaces/active");
  expect(
    response.ok(),
    `the active-workspace read failed with HTTP ${String(response.status())}`,
  ).toBe(true);
  return ((await response.json()) as ActiveTaskWorkspaceResponse).active;
}

async function controlName(locator: Locator, kind: string): Promise<string> {
  await expect(locator).toBeVisible();
  const name = await locator.getAttribute("aria-label");
  if (name === null) throw new Error(`${kind} control identity was unavailable`);
  return name;
}

async function waitForWorkbenchResources(page: Page): Promise<void> {
  const status = workbenchSurface(page)
    .getByRole("status")
    .filter({ hasText: "Model source ready." });
  await expect(status).toContainText("Workspace ready.", { timeout: 60_000 });
  await expect(status).toContainText("Runtime available", { timeout: 60_000 });
}

async function waitForWorkbenchWorkspace(page: Page): Promise<void> {
  const status = workbenchSurface(page).getByRole("status").filter({ hasText: "Workspace ready." });
  await expect(status).toBeVisible({ timeout: 60_000 });
}

async function currentLiveWorkbenchIdentity(page: Page): Promise<LiveWorkbenchIdentity> {
  // ActiveWorkspaceContext publishes "Workspace ready" only after it has reconciled the server
  // instance and the rendered repository binding. Read the server identity after that boundary,
  // then re-read it after capturing the controls so a concurrent restoration cannot be mistaken
  // for a stable pre-setup identity.
  await waitForWorkbenchWorkspace(page);
  const active = await activeTaskWorkspace(page);
  const taskName = active === null ? "no active workspace" : active.instance.taskId;
  await expect(page.getByRole("button", { name: `Task workspaces: ${taskName}` })).toBeVisible();
  const identity = {
    workspaceId: active?.instance.workspaceId ?? null,
    taskId: active?.instance.taskId ?? null,
    taskBranch: active?.instance.taskBranch ?? null,
    repositoryControlName: await controlName(
      page.locator('button[aria-label^="Manage repository "]'),
      "repository",
    ),
    branchControlName: await controlName(
      page.locator('button[aria-label^="Manage branch "]'),
      "branch",
    ),
  };
  expect(await activeTaskWorkspace(page)).toEqual(active);
  return identity;
}

async function waitForLiveWorkbenchIdentity(
  page: Page,
  identity: LiveWorkbenchIdentity,
): Promise<void> {
  await expect
    .poll(async () => (await activeTaskWorkspace(page))?.instance.workspaceId ?? null, {
      timeout: 60_000,
    })
    .toBe(identity.workspaceId);
  const taskName = identity.taskId ?? "no active workspace";
  await expect(page.getByRole("button", { name: `Task workspaces: ${taskName}` })).toBeVisible();
  await waitForWorkbenchResources(page);
  await expect(page.getByRole("button", { name: identity.repositoryControlName })).toBeVisible();
  await expect(page.getByRole("button", { name: identity.branchControlName })).toBeVisible();
}

// Live-run blocker (B): the real gateway config may hold a chat model whose previously verified
// tool-calling proof has expired, or one that has not yet been marked workflow-eligible. Refreshing
// an expired proof must go through the production readiness route, which is protected by the same
// durable qualification-spend admission as every subsequent provider request. Filtering the stale
// model out before that call made a valid configured profile impossible to qualify.
export async function ensureWorkflowEligibleModel(page: Page): Promise<boolean> {
  const workspaceIdentity = await currentLiveWorkbenchIdentity(page);
  const changed = await qualifyLiveModel({
    loadModels: () => liveModels(page),
    refreshToolCalling: (modelId) => refreshToolCallingProof(page, modelId),
    enableWorkflow: async (modelId): Promise<void> => {
      const setupResponse = await page.request.post(GATEWAY_SETUP_ENDPOINT, {
        headers: CSRF,
        data: { preserveExisting: true, workflowEligibleModelIds: [modelId] },
      });
      expect(
        setupResponse.ok(),
        `the gateway setup call failed with HTTP ${String(setupResponse.status())}`,
      ).toBe(true);
    },
  });
  await reconcileLiveWorkbenchAfterModelChange(changed, workspaceIdentity, {
    reload: () => page.reload().then(() => undefined),
    waitForWorkbench: () => expect(workbenchSurface(page)).toBeVisible(),
    waitForWorkspaceIdentity: (identity) => waitForLiveWorkbenchIdentity(page, identity),
  });
  return changed;
}

export async function grantGithubAccess(page: Page, repositoryRoot: string): Promise<void> {
  const observed = await page.request.get(
    `${AUTH_ENDPOINT}?${new URLSearchParams({ repositoryPath: repositoryRoot }).toString()}`,
  );
  expect(observed.ok()).toBe(true);
  const { revision } = (await observed.json()) as { readonly revision: number };
  const updated = await page.request.put(AUTH_ENDPOINT, {
    headers: CSRF,
    data: { repositoryPath: repositoryRoot, authorized: true, expectedRevision: revision },
  });
  expect(updated.ok()).toBe(true);
}

export async function assertRuntimeReady(page: Page, mode: CodingWorkbenchMode): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `${READINESS_ENDPOINT}?${new URLSearchParams({ requestedMode: mode }).toString()}`,
        );
        if (!response.ok()) return false;
        const body = (await response.json()) as { readonly runtimeAvailable: boolean };
        return body.runtimeAvailable;
      },
      { timeout: 60_000, message: "coding runtime must report ready before a run may start" },
    )
    .toBe(true);
}

async function previewAndAcceptIssue(page: Page, issueRef: string): Promise<void> {
  const issueField = page.getByLabel("Issue URL or #number");
  if (!(await issueField.isVisible())) {
    await page.getByRole("button", { name: "Start from a GitHub issue", exact: true }).click();
  }
  await expect(issueField).toBeVisible();
  await issueField.fill(issueRef);
  await page.getByRole("button", { name: "Preview issue", exact: true }).click();
  await expect(page.getByRole("region", { name: "Issue preview", exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Use this issue", exact: true }).click();
}

export async function previewAndBindIssue(page: Page, issueRef: string): Promise<void> {
  await previewAndAcceptIssue(page, issueRef);
  await page.getByRole("button", { name: "Bind workspace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Code setup", exact: true })).toHaveCount(0);
}

export interface BoundIssueRunPreparation {
  readonly previewAndBind: () => Promise<void>;
  readonly qualifyModel: () => Promise<boolean>;
  readonly previewAndAccept: () => Promise<void>;
}

export async function prepareBoundIssueForRun(steps: BoundIssueRunPreparation): Promise<void> {
  await steps.previewAndBind();
  if (await steps.qualifyModel()) await steps.previewAndAccept();
}

/**
 * The one task-instructions string every mode's run is started with. There is no fixture
 * `control()` channel on the live lane (unlike `coding-issue-commit.spec.ts` and its siblings), so
 * the full commit/push/draft-PR/CI-observe-and-repair sequence issue #3390 AC3 requires must be
 * requested up front and left to the real model's own tool-call planning -- a nondeterministic
 * sequence, per issue #3390 ("do not require one hardcoded tool sequence").
 */
export function issueResolutionTaskInstructions(): string {
  return [
    "Resolve the linked issue end to end, using your available tools:",
    "1) Use keiko_repository_search first to locate the existing production implementation and tests, and use at least one returned hit to choose the files you read.",
    "2) Add the regression test before the production fix, run that targeted test, and observe it fail for the issue's stated behavior.",
    "3) Implement the required fix across the affected production modules without a pre-recorded patch.",
    "4) Rerun the targeted regression and the project's complete verification, and proceed only when both pass.",
    "5) Stage and commit the verification-backed change.",
    "6) Push the commit to a new branch and open a draft pull request describing the change.",
    "7) Observe the pull request's CI status; if a required check fails, diagnose and repair it,",
    "push the fix, and re-observe CI until every required check reports passing.",
    "Leave the workspace clean throughout.",
  ].join(" ");
}

function assertBoundIssueStartPayload(payload: unknown, issueRef: string): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new TypeError("coding-run start payload was unavailable");
  const value = payload as Record<string, unknown>;
  if (
    value.issueRef !== issueRef ||
    typeof value.expectedIssueBindingDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.expectedIssueBindingDigest)
  )
    throw new Error("coding-run start payload was not bound to the accepted issue");
}

export async function startCodingRun(
  page: Page,
  mode: CodingWorkbenchMode,
  issueRef: string,
): Promise<void> {
  await selectCodingIssueMode(page, mode);
  await page.getByLabel("Task instructions").fill(issueResolutionTaskInstructions());
  const startButton = page.getByRole("button", { name: "Start coding run", exact: true });
  await expect(startButton).toBeEnabled({ timeout: 60_000 });
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/coding-workbench/runtime/runs"),
  );
  await startButton.click();
  const response = await started;
  const encodedPayload = response.request().postData();
  assertBoundIssueStartPayload(
    encodedPayload === null ? null : JSON.parse(encodedPayload),
    issueRef,
  );
  expect(
    response.ok(),
    `the coding-run start call failed with HTTP ${String(response.status())}`,
  ).toBe(true);
}

export async function runtimeSnapshot(page: Page): Promise<CodingWorkbenchRuntimeSnapshot> {
  const response = await page.request.get("/api/coding-workbench/runtime/status");
  expect(response.ok()).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}

async function clickIfVisible(control: Locator): Promise<void> {
  if (await control.isVisible()) await control.click();
}

async function answerVisibleApproval(page: Page): Promise<void> {
  await clickIfVisible(page.getByRole("button", { name: "Approve once", exact: true }));
  const changeReview = page.getByRole("region", {
    name: "Review the proposed file change",
    exact: true,
  });
  await clickIfVisible(changeReview.getByRole("button", { name: "Apply change", exact: true }));
}

/**
 * Polls `read()` until `isDone` accepts the value, clicking "Approve once" whenever it is visible
 * on every iteration in between -- the ONE generic answer to both approval surfaces this harness
 * meets on the live lane: mid-run `pendingPermission` prompts (governed-assist workspace effects)
 * and the separate commit/push/PR "Reviewed …" delivery-review prompts (every mode, per the
 * ADR-0138 matrix). Both render the identical "Approve once" control, so one poller answers both
 * without needing to distinguish which surface is currently showing it.
 */
export async function waitWhileAnsweringApprovals<T>(
  page: Page,
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
  options: { readonly timeoutMs: number; readonly message: string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await read();
    if (isDone(value)) return value;
    if (Date.now() > deadline) throw new Error(options.message);
    await answerVisibleApproval(page);
    await page.waitForTimeout(2_000);
  }
}

export interface DeliveredPullRequest {
  readonly runId: string;
  readonly repository: string;
  readonly number: number;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
}

export interface DriveToDraftPrInput {
  readonly repositoryRoot: string;
  readonly issueRef: string;
  readonly mode: CodingWorkbenchMode;
}

/**
 * Drives one live run from a bare, paired browser session through a real committed, pushed, draft
 * pull request (issue #3390 AC3's issue-to-PR effects). Every step below is the SAME real,
 * unmocked route the scripted `coding-issue-intake.spec.ts` / `coding-issue-delivery.spec.ts`
 * siblings exercise against a fixture server -- here against the real production composition.
 */
export async function driveIssueToDraftPullRequest(
  page: Page,
  input: DriveToDraftPrInput,
): Promise<DeliveredPullRequest> {
  await openLiveWorkbench(page, input.repositoryRoot);
  await grantGithubAccess(page, input.repositoryRoot);
  await prepareBoundIssueForRun({
    previewAndBind: () => previewAndBindIssue(page, input.issueRef),
    qualifyModel: () => ensureWorkflowEligibleModel(page),
    previewAndAccept: () => previewAndAcceptIssue(page, input.issueRef),
  });
  await assertRuntimeReady(page, input.mode);
  await startCodingRun(page, input.mode, input.issueRef);
  await expect(workbenchSurface(page)).toHaveAttribute("data-state", "running", {
    timeout: 60_000,
  });
  const snapshot = await waitWhileAnsweringApprovals(
    page,
    () => runtimeSnapshot(page),
    (value) => value.draftDelivery?.phase === "draft-created",
    {
      timeoutMs: 25 * 60_000,
      message: "expected a real draft pull request to be recorded within the live run",
    },
  );
  const runId = snapshot.runId;
  const pullRequest = snapshot.draftDelivery?.pullRequest;
  if (runId === undefined || pullRequest === undefined) {
    throw new Error("expected a recorded run id and pull request after the live drive");
  }
  return {
    runId,
    repository: pullRequest.repository,
    number: pullRequest.number,
    baseRef: pullRequest.baseRef,
    headRef: pullRequest.headRef,
    headSha: pullRequest.headSha,
  };
}
