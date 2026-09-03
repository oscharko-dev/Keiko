// Issue #2387 — governed research journey: the browser drives the REAL approval, grant, and revoke
// surfaces against the production coding-runtime composition. The webServer entry
// (tests/e2e/servers/coding-runtime-2387-server.mts) boots the real buildUiHandlerDeps/createUiServer
// wiring with the scripted OpenCode harness in script mode "research" and a hermetic research
// transport injected at the explicit test seam — no real network is ever touched.
//
// The journey proves, over live routes only:
// #2637 rides the same journey: the hermetic transport answers with a HOSTILE page whose visible
// prose instructs the model to mutate the workspace, with the same directive repeated in a <script>
// body and an HTML comment. The scripted model obeys instructions only where they carry authority,
// so it complies exactly when the directive reaches it outside a quarantine fence. The run must
// complete with no mutation attempted, and the timeline must show the read as untrusted content.
//
//   the scripted model asks to fetch one exact public URL → the run halts awaiting a network-egress
//   approval (the fetch itself failed closed) → "Approve once" mints a request-line-bound grant and
//   the "Internet · Research only" chip surfaces the granted domain → a follow-up turn performs the
//   governed fetch for real ("Research performed" in the timeline) → a stale revoke posted over
//   HTTP fails closed and the grant survives → the operator's Revoke drops the grant in one
//   revision bump → the model's next ask needs a FRESH approval (no silent internet reach after
//   revoke) → Deny settles the run failed/revoked.
//
// The successful research turn then invokes a server-approved skill and one bounded read-only
// child through the same production tool facade; both lifecycle records must reach the timeline.

import { readFileSync } from "node:fs";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";

import {
  RESEARCH_APP_SESSION_LAUNCHER_SECRET,
  RESEARCH_INJECTION_PAYLOAD,
  RESEARCH_JOURNEY_HOST,
  RESEARCH_JOURNEY_REQUEST_LINE,
  researchRepositoryRoot,
  researchScriptedToolCallLog,
  researchStateDir,
} from "./support/coding-runtime-2387-research.js";

const stateDir = researchStateDir();
const repositoryRoot = researchRepositoryRoot(stateDir);

function workbench(page: Page): Locator {
  return page.locator('section[aria-label="Coding Workbench"][data-state]');
}

function launcherPairingFragment(): string {
  return encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: RESEARCH_APP_SESSION_LAUNCHER_SECRET,
      requestId: `req_research-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`,
      issuedAtMs: Date.now(),
    }),
  );
}

async function openWorkbench(page: Page, pairingFragment?: string): Promise<void> {
  await page.goto(pairingFragment === undefined ? "/" : `/${pairingFragment}`);
  if (pairingFragment !== undefined) {
    await expect.poll(() => page.url()).not.toContain("keiko-app-session");
  }
  await page.getByRole("button", { name: "Coding Workbench", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Coding Workbench", exact: true })).toBeVisible();
}

async function bindFixtureWorkspace(page: Page): Promise<void> {
  const setup = page.getByRole("region", { name: "Code setup" });
  await expect(setup).toBeVisible();
  await setup.getByLabel("Repository path").fill(repositoryRoot);
  await setup.getByLabel("Target branch").fill("main");
  await setup.getByRole("button", { name: "Bind workspace" }).click();
  await expect(setup).toHaveCount(0);
}

// The live run snapshot, read from the REAL status route (the same truth the workbench polls).
async function currentSnapshot(page: Page): Promise<{
  readonly runId?: string;
  readonly revision?: number;
}> {
  const response = await page.request.get("/api/coding-workbench/runtime/status");
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    readonly runId?: string;
    readonly revision?: number;
  };
}

async function currentResearch(
  page: Page,
  runId: string,
): Promise<{
  readonly grant?: { readonly grantId: string; readonly domains: readonly string[] };
}> {
  const response = await page.request.get(
    `/api/coding-workbench/runtime/runs/${encodeURIComponent(runId)}/research`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    readonly grant?: { readonly grantId: string; readonly domains: readonly string[] };
  };
}

// Waits for the network-egress approval prompt raised by an uncovered research ask.
async function expectResearchApprovalPrompt(page: Page): Promise<void> {
  await expect(workbench(page)).toHaveAttribute("data-state", "awaiting-approval", {
    timeout: 90_000,
  });
  await expect(page.getByRole("heading", { name: "Review the bounded action" })).toBeVisible();
  // #2387: the operator must be able to READ the destination before deciding — approving a request
  // line nobody was shown would make the grant's request-line binding meaningless. The host and the
  // sanitized request line arrive over the authenticated app-session channel, never on the
  // content-free runtime event that raised the ask.
  const destination = page.getByRole("group", { name: "Research destination" });
  await expect(destination).toBeVisible();
  await expect(destination.getByText(RESEARCH_JOURNEY_HOST, { exact: false })).toBeVisible();
  await expect(
    destination.getByText(RESEARCH_JOURNEY_REQUEST_LINE, { exact: false }),
  ).toBeVisible();
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
  const snapshot = await currentSnapshot(page);
  const live = await currentResearch(page, runId);
  expect(live.grant?.domains).toEqual([RESEARCH_JOURNEY_HOST]);
  const stale = await page.request.post(
    `/api/coding-workbench/runtime/runs/${runId}/research/revoke`,
    {
      headers: { "X-Keiko-CSRF": "1" },
      data: {
        requestId: "stale-revoke",
        expectedRevision: 0,
        grantId: live.grant?.grantId ?? "missing",
      },
    },
  );
  expect(stale.status()).toBe(400);
  expect((await currentSnapshot(page)).revision).toBe(snapshot.revision);
}

// All three #2387 auxiliary capabilities must reach the governed timeline as content-free labels:
// the research fetch, the explicit skill invocation, and the read-only child agent's start and
// completion. The generous timeout covers a full real agent loop, not a fixed delay.
//
// #2637: "Skill invoked" now carries a second meaning. The scripted model invokes the skill ONLY
// after it has seen the granted page's directive arrive INSIDE a quarantine fence — an unfenced
// directive makes it comply with the page instead, and never observing the page text at all makes
// it do neither. So this wait is also the proof that the acceptance journey is not passing
// vacuously on a transcript that lost the research tool result.
async function expectAuxiliaryTimelineActivity(page: Page): Promise<void> {
  const timeline = page.getByRole("list", { name: "Coding run event timeline" });
  for (const label of [
    "Research performed",
    "Skill invoked",
    "Child agent started",
    "Child agent completed",
  ]) {
    await expect(timeline.getByText(label, { exact: true }).first()).toBeVisible({
      timeout: 90_000,
    });
  }
}

// #2637: the timeline must show the research read AS untrusted content. The operator approved a
// destination, never what the page would say, so a bare "Research performed" would understate what
// the run just took in.
async function expectResearchReadShownAsUntrusted(page: Page): Promise<void> {
  await expect(
    page
      .getByRole("list", { name: "Coding run event timeline" })
      .getByText(/Untrusted content/u)
      .first(),
  ).toBeVisible({ timeout: 90_000 });
}

// #2637: the granted page asked, in visible prose, for a workspace mutation. The compliant scripted
// model has demonstrably read that text (it reached the skill step), so this is the boundary
// holding — not the model failing to look.
//
// The load-bearing assertion is that the edit was never REQUESTED. A diff-free workspace alone
// would also be satisfied by an edit that was requested and then denied downstream, which is a
// different (and weaker) property than the one #2637 requires.
async function expectNoMutationWasAttempted(page: Page): Promise<void> {
  const requested = readFileSync(researchScriptedToolCallLog(stateDir), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  expect(requested).not.toContain("keiko_changeset_edit");
  // The scripted model did reach the decision step and did ask for something, so the absence above
  // is a decision, not an empty transcript.
  expect(requested).toContain("keiko_research_fetch");
  expect(requested).toContain("keiko_skill");

  const timeline = page.getByRole("list", { name: "Coding run event timeline" });
  await expect(timeline.getByText("Diff summarized", { exact: true })).toHaveCount(0);
  const changes = page.getByRole("region", { name: "Changes" });
  if ((await changes.count()) > 0) {
    await expect(changes.getByText(RESEARCH_INJECTION_PAYLOAD, { exact: false })).toHaveCount(0);
  }
}

test("#2387 research: approval mints the grant, the governed fetch runs, revoke cuts it off", async ({
  page,
}) => {
  await openWorkbench(page, launcherPairingFragment());
  await bindFixtureWorkspace(page);

  // Start a supervised run; the scripted model immediately asks to research one public URL. The
  // fetch itself fails closed (no grant yet) and the run halts awaiting the egress approval.
  // #2644 moved the mode selector into Settings; the Workbench reports the server-confirmed mode.
  await expect(
    page.locator('section[aria-label="Coding Workbench"][data-state]').locator("[data-mode]"),
  ).toHaveAttribute("data-mode", "governed-assist");
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
  await expectAuxiliaryTimelineActivity(page);
  await expectResearchReadShownAsUntrusted(page);
  await expectNoMutationWasAttempted(page);

  await expectStaleRevokeFailsClosed(page, runId);
  await expect(chip).toBeVisible();

  // The operator's Revoke drops the grant for the run (and any children) in one revision bump.
  await chip
    .getByRole("button", {
      name: "Revoke the internet research grant for this run and its child agents",
    })
    .click();
  await expect(chip).toHaveCount(0);
  expect((await currentResearch(page, runId)).grant).toBeUndefined();

  // Revoked means revoked: the agent's very next fetch inside the SAME task (released by
  // answering its blocking question) needs a FRESH human approval — the runtime halts again
  // instead of silently reaching the internet. Deny settles the run failed/revoked. The paused
  // follow-up mechanics stay covered by the #2386 authority lane; under the causal-terminal
  // contract a read-only run has no pending mutation to hold a settled turn open for one here.
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
  // Present a live run but a grant-free authenticated research payload: the chip must not render,
  // proving it is driven by channel truth and not the general runtime snapshot or local UI state.
  await page.route("**/api/coding-workbench/runtime/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        state: "running",
        revision: 4,
        updatedAt: "2026-07-20T00:00:00.000Z",
        runId: "run-1",
      }),
    }),
  );
  await page.route("**/api/coding-workbench/runtime/runs/run-1/research", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session: "active" }),
    }),
  );
  await openWorkbench(page);

  await expect(page.getByRole("group", { name: "Internet · Research only" })).toHaveCount(0);
});
