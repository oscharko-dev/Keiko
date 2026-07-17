// Issue #2387 — governed research journey: the browser drives the REAL approval, grant, and revoke
// surfaces against the production coding-runtime composition. The webServer entry
// (tests/e2e/servers/coding-runtime-2387-server.mts) boots the real buildUiHandlerDeps/createUiServer
// wiring with the scripted OpenCode harness in script mode "research" and a hermetic research
// transport injected at the explicit test seam — no real network is ever touched.
//
// The journey proves, over live routes only:
//   the scripted model asks to fetch one exact public URL → the run halts awaiting a network-egress
//   approval (the fetch itself failed closed) → "Approve once" mints a request-line-bound grant and
//   the "Internet · Research only" chip surfaces the granted domain → a follow-up turn performs the
//   governed fetch for real ("Research performed" in the timeline) → a stale revoke posted over
//   HTTP fails closed and the grant survives → the operator's Revoke drops the grant in one
//   revision bump → the model's next ask needs a FRESH approval (no silent internet reach after
//   revoke) → Deny settles the run failed/revoked.
//
// Skills and read-only child agents (the other #2387 capabilities) are covered by their server
// module suites; their model-facing tool declaration is tracked in the #2387 handoff.

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  RESEARCH_JOURNEY_HOST,
  researchRepositoryRoot,
  researchStateDir,
} from "./support/coding-runtime-2387-research.js";

const stateDir = researchStateDir();
const repositoryRoot = researchRepositoryRoot(stateDir);

function workbench(page: Page): Locator {
  return page.locator('section[aria-label="Coding Workbench"][data-state]');
}

async function openWorkbench(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Coding Workbench" }).click();
  await expect(page.getByRole("heading", { name: "Coding Workbench" })).toBeVisible();
}

async function bindFixtureWorkspace(page: Page): Promise<void> {
  const setup = page.getByRole("region", { name: "Code setup" });
  await expect(setup).toBeVisible();
  await setup.getByLabel("Repository path").fill(repositoryRoot);
  await setup.getByLabel("Target branch").fill("main");
  await setup.getByRole("button", { name: "Bind workspace" }).click();
  await expect(setup).toHaveCount(0);
}

// A fresh binding has no verified head yet — run the REAL #447 reconciliation route so the runtime
// authority can prove the managed worktree head before the run starts.
async function reconcileBoundWorkspace(page: Page): Promise<void> {
  const response = await page.request.post("/api/task-workspaces/reconciliation", {
    headers: { "X-Keiko-CSRF": "1" },
    data: { root: repositoryRoot },
  });
  expect(response.ok()).toBe(true);
}

// The live run snapshot, read from the REAL status route (the same truth the workbench polls).
async function currentSnapshot(page: Page): Promise<{
  readonly runId?: string;
  readonly revision?: number;
  readonly researchGrant?: { readonly grantId: string; readonly domains: readonly string[] };
}> {
  const response = await page.request.get("/api/coding-workbench/runtime/status");
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    readonly runId?: string;
    readonly revision?: number;
    readonly researchGrant?: { readonly grantId: string; readonly domains: readonly string[] };
  };
}

// Waits for the network-egress approval prompt raised by an uncovered research ask.
async function expectResearchApprovalPrompt(page: Page): Promise<void> {
  await expect(workbench(page)).toHaveAttribute("data-state", "awaiting-approval", {
    timeout: 90_000,
  });
  await expect(page.getByRole("heading", { name: "Review the bounded action" })).toBeVisible();
}

// The composer only offers "Send follow-up" while the run is paused (#2386 sticky-pause design):
// pause, admit the follow-up turn, and resume so the scripted model takes its next turn.
async function sendFollowUpTurn(page: Page, instructions: string): Promise<void> {
  await page.getByRole("button", { name: "Pause run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "paused");
  const submitted = page
    .getByRole("list", { name: "Coding run event timeline" })
    .getByText("Task submitted", { exact: true });
  const before = await submitted.count();
  await page.getByLabel("Task instructions").fill(instructions);
  await page.getByRole("button", { name: "Send follow-up" }).click();
  await expect(submitted).toHaveCount(before + 1, { timeout: 90_000 });
  await page.getByRole("button", { name: "Resume run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "running");
}

// The scripted blocking question halts the agent loop server-side until the browser answers it —
// the halt point that keeps the following governed fetch inside a RUNNING run (a paused run's
// sticky ingest guard would drop its events). The single scripted option is labelled "Approve".
async function answerBlockingQuestion(page: Page): Promise<void> {
  const questions = page.getByRole("region", { name: "Runtime questions" });
  await expect(questions.getByRole("heading", { name: "Runtime needs your input" })).toBeVisible({
    timeout: 90_000,
  });
  await questions.getByRole("radio", { name: /Approve/u }).check();
  await questions.getByRole("button", { name: "Send answer" }).click();
}

// A stale revoke posted over HTTP fails closed: wrong revision → 400, the grant survives.
async function expectStaleRevokeFailsClosed(page: Page, runId: string): Promise<void> {
  const live = await currentSnapshot(page);
  expect(live.researchGrant?.domains).toEqual([RESEARCH_JOURNEY_HOST]);
  const stale = await page.request.post(
    `/api/coding-workbench/runtime/runs/${runId}/research/revoke`,
    {
      headers: { "X-Keiko-CSRF": "1" },
      data: {
        requestId: "stale-revoke",
        expectedRevision: 0,
        grantId: live.researchGrant?.grantId ?? "missing",
      },
    },
  );
  expect(stale.status()).toBe(400);
}

test("#2387 research: approval mints the grant, the governed fetch runs, revoke cuts it off", async ({
  page,
}) => {
  await openWorkbench(page);
  await bindFixtureWorkspace(page);
  await reconcileBoundWorkspace(page);

  // Start a supervised run; the scripted model immediately asks to research one public URL. The
  // fetch itself fails closed (no grant yet) and the run halts awaiting the egress approval.
  await expect(page.getByRole("radio", { name: /Supervised workspace/u })).toBeChecked();
  await page.getByLabel("Task instructions").fill("Research the streams backpressure guide");
  const start = page.getByRole("button", { name: "Start coding run" });
  await expect(start).toBeEnabled();
  await start.click();
  await expectResearchApprovalPrompt(page);
  const runId = (await currentSnapshot(page)).runId ?? "";
  expect(runId).not.toBe("");

  // "Approve once" mints the request-line-bound grant: the run resumes and the content-free
  // "Internet · Research only" chip names exactly the approved public domain.
  await page.getByRole("button", { name: "Approve once" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "running");
  const chip = page.getByRole("group", { name: "Internet · Research only" });
  await expect(chip).toBeVisible();
  await expect(chip.getByText(RESEARCH_JOURNEY_HOST, { exact: false })).toBeVisible();

  // Answering the scripted blocking question releases the agent loop: the retry now runs the
  // governed fetch for real (against the hermetic transport) inside the running run and the
  // content-free event reaches the timeline.
  await answerBlockingQuestion(page);
  const timeline = page.getByRole("list", { name: "Coding run event timeline" });
  await expect(timeline.getByText("Research performed", { exact: true }).first()).toBeVisible({
    timeout: 90_000,
  });

  await expectStaleRevokeFailsClosed(page, runId);
  await expect(chip).toBeVisible();

  // The operator's Revoke drops the grant for the run (and any children) in one revision bump.
  await chip
    .getByRole("button", {
      name: "Revoke the internet research grant for this run and its child agents",
    })
    .click();
  await expect(chip).toHaveCount(0);
  expect((await currentSnapshot(page)).researchGrant).toBeUndefined();

  // Revoked means revoked: the model's next ask needs a FRESH human approval — the runtime halts
  // again instead of silently reaching the internet. Deny settles the run failed/revoked.
  await sendFollowUpTurn(page, "Fetch the guide again");
  await answerBlockingQuestion(page);
  await expectResearchApprovalPrompt(page);
  await page.getByRole("button", { name: "Deny" }).click();
  // Deny settles the run terminally: the orchestrator releases the active slot (the workbench
  // returns to idle) and the durable per-run snapshot records failed/revoked.
  await expect(workbench(page)).toHaveAttribute("data-state", "idle");
  const settled = await page.request.get(`/api/coding-workbench/runtime/runs/${runId}`);
  expect(settled.ok()).toBe(true);
  const body = (await settled.json()) as { readonly state?: string; readonly failureCode?: string };
  expect(body.state).toBe("failed");
  expect(body.failureCode).toBe("revoked");
});

test("#2387 research: the grant chip is live server truth, never a static rendering", async ({
  page,
}) => {
  // Intercept only the status route with a contract-valid, grant-free snapshot: the chip must not
  // render, proving it is driven by the live researchGrant projection and not local UI state.
  await page.route("**/api/coding-workbench/runtime/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        state: "idle",
        revision: 0,
        updatedAt: new Date().toISOString(),
      }),
    }),
  );
  await openWorkbench(page);

  await expect(page.getByRole("group", { name: "Internet · Research only" })).toHaveCount(0);
});
