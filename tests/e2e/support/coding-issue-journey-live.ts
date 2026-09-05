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
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";
import { selectCodingIssueMode } from "./coding-issue-browser.js";

const SURFACE = 'section[aria-label="Coding Workbench"][data-state]';
const AUTH_ENDPOINT = "/api/coding-workbench/github-authorization";
const MODELS_ENDPOINT = "/api/models";
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

export async function openLiveWorkbench(page: Page, repositoryRoot: string): Promise<void> {
  await page.addInitScript(
    ({ root }) => {
      localStorage.setItem("keiko.theme", "dark");
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
      localStorage.removeItem("keiko.conns.v1");
    },
    { root: repositoryRoot },
  );
  await pairLiveSession(page);
  await expect(workbenchSurface(page)).toBeVisible();
  await expect(page.getByLabel("Repository path")).toHaveValue(repositoryRoot);
}

// Live-run blocker (B), unchanged from the original single test: the real gateway config may hold
// a tool-calling chat model that is not yet marked workflow-eligible.
export async function ensureWorkflowEligibleModel(page: Page): Promise<void> {
  const modelsResponse = await page.request.get(MODELS_ENDPOINT);
  expect(modelsResponse.ok()).toBe(true);
  const { models } = (await modelsResponse.json()) as {
    readonly models: readonly ModelCapability[];
  };
  const toolCallingChatModels = models.filter(
    (model) => model.kind === "chat" && model.toolCalling,
  );
  expect(
    toolCallingChatModels.length,
    "the configured Model Gateway must expose at least one tool-calling chat model",
  ).toBeGreaterThan(0);
  if (toolCallingChatModels.some((model) => model.workflowEligible)) return;
  const modelId = toolCallingChatModels[0]?.id;
  const setupResponse = await page.request.post(GATEWAY_SETUP_ENDPOINT, {
    headers: CSRF,
    data: { preserveExisting: true, workflowEligibleModelIds: [modelId] },
  });
  expect(setupResponse.ok()).toBe(true);
  await page.reload();
  await expect(workbenchSurface(page)).toBeVisible();
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

export async function previewAndBindIssue(page: Page, issueRef: string): Promise<void> {
  await page.getByLabel("Issue URL or #number").fill(issueRef);
  await page.getByRole("button", { name: "Preview issue", exact: true }).click();
  await expect(page.getByRole("region", { name: "Issue preview", exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Use this issue", exact: true }).click();
  await page.getByRole("button", { name: "Bind workspace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Code setup", exact: true })).toHaveCount(0);
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
    "1) Implement the required fix across the affected modules and add regression test coverage.",
    "2) Run the project's verification and confirm it passes before proceeding.",
    "3) Stage and commit the verified change.",
    "4) Push the commit to a new branch and open a draft pull request describing the change.",
    "5) Observe the pull request's CI status; if a required check fails, diagnose and repair it,",
    "push the fix, and re-observe CI until every required check reports passing.",
    "Leave the workspace clean throughout.",
  ].join(" ");
}

export async function startCodingRun(page: Page, mode: CodingWorkbenchMode): Promise<void> {
  await selectCodingIssueMode(page, mode);
  await page.getByLabel("Task instructions").fill(issueResolutionTaskInstructions());
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/coding-workbench/runtime/runs"),
  );
  await page.getByRole("button", { name: "Start coding run", exact: true }).click();
  const response = await started;
  expect(response.ok(), await response.text()).toBe(true);
}

export async function runtimeSnapshot(page: Page): Promise<CodingWorkbenchRuntimeSnapshot> {
  const response = await page.request.get("/api/coding-workbench/runtime/status");
  expect(response.ok()).toBe(true);
  return (await response.json()) as CodingWorkbenchRuntimeSnapshot;
}

async function clickApproveOnceIfVisible(page: Page): Promise<void> {
  const approve = page.getByRole("button", { name: "Approve once", exact: true });
  const visible = await approve.isVisible().catch(() => false);
  if (!visible) return;
  await approve.click().catch(() => undefined);
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
    await clickApproveOnceIfVisible(page);
    await page.waitForTimeout(2_000);
  }
}

export interface DeliveredPullRequest {
  readonly runId: string;
  readonly repository: string;
  readonly number: number;
  readonly headRef: string;
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
  await ensureWorkflowEligibleModel(page);
  await grantGithubAccess(page, input.repositoryRoot);
  await assertRuntimeReady(page, input.mode);
  await previewAndBindIssue(page, input.issueRef);
  await startCodingRun(page, input.mode);
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
    headRef: pullRequest.headRef,
  };
}
