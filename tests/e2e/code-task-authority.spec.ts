// Issue #2386 — Code Task real-authority journey: the browser drives the mounted question / pause /
// resume / follow-up surfaces against the REAL coding runtime composition. The webServer entry
// (tests/e2e/servers/coding-runtime-2386-server.mts) boots the real buildUiHandlerDeps/createUiServer
// wiring with the scripted OpenCode harness injected at the production `codingRuntimeResolver` seam —
// unlike the #2385 tracer entry, the scripted `question` turn is NOT skipped, so the required
// question must reach the browser for real and halt the agent loop until answered.
//
// The journey proves, over live routes only:
//   the boot URL fragment pairs the app session through the REAL launcher pairing port and is
//   stripped from the address bar (#2478) → the workbench defaults to the supervised-coding mode
//   (#2386 default) → bind + reconcile the fixture checkout → start a supervised run → the
//   scripted required question surfaces in the "Runtime questions" section over the authenticated
//   channel; while it is pending, an unpaired client with correct loopback/Origin/CSRF/runId
//   receives NO question text and no blind-answer authority (#2478 negative step) → the question
//   is answered → the contained edit lands in the managed worktree and the vetted verification is
//   summarized → Pause flips the run to the sticky paused state → requesting a WIDER mode while
//   the run is live is rejected against the server-confirmed effective mode → a follow-up sent
//   while paused is admitted as a new task turn WITHOUT auto-resuming the run (pause stays
//   sticky) → Resume returns the run to running → revoking the session surfaces the honest
//   re-pair state on the questions surface (#2478) → Stop settles the durable snapshot as
//   cancelled.
//
// The negative test proves the surface is live, not static: intercepting only the readiness route
// with a contract-valid `runtimeAvailable: false` body must flip the workbench to "Runtime not
// confirmed" and disable Start.

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";
import {
  FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX,
  FUNCTIONAL_PLAN_STEP_READ,
  FUNCTIONAL_PLAN_STEP_VERIFY,
} from "../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.js";

import {
  AUTHORITY_APP_SESSION_LAUNCHER_SECRET,
  AUTHORITY_EDITED_CONTENT,
  AUTHORITY_TARGET_RELATIVE_PATH,
  authorityManagedWorkspaceRoot,
  authorityRepositoryRoot,
  authorityStateDir,
} from "./support/coding-runtime-2386-authority.js";

const stateDir = authorityStateDir();
const repositoryRoot = authorityRepositoryRoot(stateDir);
const managedRoot = authorityManagedWorkspaceRoot(stateDir);

function workbench(page: Page): Locator {
  return page.locator('section[aria-label="Coding Workbench"][data-state]');
}

// #2478: the journey acts as the trusted launcher — it mints a fresh single-use attestation with
// the REAL launcher claim construction and hands it to the browser in the boot URL fragment,
// exactly as `keiko start --open` does. The desktop shell redeems it against the pair endpoint and
// strips it from the address bar before any surface renders.
function launcherPairingFragment(): string {
  return encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: AUTHORITY_APP_SESSION_LAUNCHER_SECRET,
      requestId: `req_journey-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`,
      issuedAtMs: Date.now(),
    }),
  );
}

async function openWorkbench(page: Page, pairingFragment?: string): Promise<void> {
  await page.goto(pairingFragment === undefined ? "/" : `/${pairingFragment}`);
  if (pairingFragment !== undefined) {
    // Bearer hygiene: the pairing fragment must leave the address bar (and the history entry)
    // before the workbench is even opened.
    await expect.poll(() => page.url()).not.toContain("keiko-app-session");
  }
  await page.getByRole("button", { name: "Coding Workbench" }).click();
  await expect(page.getByRole("heading", { name: "Coding Workbench" })).toBeVisible();
}

// Drives the "Code setup" section end to end through UI interactions only: binding the fixture
// checkout now provisions, runs the #447 reconciliation pass that stamps the verified head the runtime
// launch authority requires, and only then activates — no out-of-band `page.request` reconciliation
// call (#2476 AC1). The section yields once the verified binding lands.
async function bindFixtureWorkspace(page: Page): Promise<void> {
  const setup = page.getByRole("region", { name: "Code setup" });
  await expect(setup).toBeVisible();
  await setup.getByLabel("Repository path").fill(repositoryRoot);
  await setup.getByLabel("Target branch").fill("main");
  await setup.getByRole("button", { name: "Bind workspace" }).click();
  // The bind performs real filesystem + git reconciliation before it yields, so allow for that IO.
  await expect(setup).toHaveCount(0, { timeout: 30_000 });
}

// Locates the file the scripted runtime edited inside the Keiko-managed worktree root. The worktree
// directory name is a content-free derived id, so the fixture file is found by bounded search.
function findManagedTargetFiles(dir: string, depth: number): readonly string[] {
  if (depth < 0) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findManagedTargetFiles(full, depth - 1));
  }
  const candidate = join(dir, AUTHORITY_TARGET_RELATIVE_PATH);
  try {
    readFileSync(candidate);
    found.push(candidate);
  } catch {
    // Not a worktree root; keep searching.
  }
  return found;
}

// The live run id, read from the REAL status route (the same truth the workbench polls).
async function currentRunId(page: Page): Promise<string> {
  const response = await page.request.get("/api/coding-workbench/runtime/status");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { readonly runId?: string };
  expect(typeof body.runId).toBe("string");
  return body.runId ?? "";
}

function runtimeQuestions(page: Page): Locator {
  return page.getByRole("region", { name: "Runtime questions" });
}

// The scripted required question halts the agent loop server-side until the browser answers it
// through the mounted question routes. The single scripted option is labelled "Approve".
async function awaitRequiredQuestion(page: Page): Promise<void> {
  await expect(
    runtimeQuestions(page).getByRole("heading", { name: "Runtime needs your input" }),
  ).toBeVisible({ timeout: 90_000 });
}

async function answerVisibleQuestion(page: Page): Promise<void> {
  const questions = runtimeQuestions(page);
  await questions.getByRole("radio", { name: /Approve/u }).check();
  await questions.getByRole("button", { name: "Send answer" }).click();
}

// #2478 negative step, executed WHILE the real question is pending so the refusal is meaningful:
// an unpaired local client presenting every routing fact — loopback reachability, a same-origin
// `Origin`, the CSRF envelope, and the observed runId — receives the constant content-free
// projection on the list route and the existence-concealing not-found on the answer route. The
// `request` fixture is a fresh cookie-less API context, deliberately NOT `page.request` (which
// shares the paired browser cookie jar).
async function proveUnpairedClientReadsNoQuestionText(
  stranger: APIRequestContext,
  origin: string,
  runId: string,
): Promise<void> {
  const headers = { origin, "x-keiko-csrf": "1" };
  const activity = await stranger.get("/api/coding-workbench/app-session/channel");
  expect(activity.status()).toBe(200);
  expect(await activity.json()).toEqual({ schemaVersion: "1", content: null });
  const listed = await stranger.post(`/api/coding-workbench/runtime/runs/${runId}/questions`, {
    headers,
    data: { requestId: "req_stranger-list", expectedRevision: 0 },
  });
  expect(listed.status()).toBe(200);
  expect(await listed.json()).toEqual({ session: "unpaired", questions: [] });

  const answered = await stranger.post(
    `/api/coding-workbench/runtime/runs/${runId}/questions/answer`,
    {
      headers,
      data: {
        requestId: "req_stranger-answer",
        expectedRevision: 0,
        questionId: "que_1",
        answers: [["Approve"]],
      },
    },
  );
  expect(answered.status()).toBe(404);
}

function worktreeRootForTarget(target: string): string {
  return AUTHORITY_TARGET_RELATIVE_PATH.split("/").reduce((root) => dirname(root), target);
}

// #2482 negative step: the generic Git routes resolve the managed worktree and require the same
// launcher-attested app session before they execute Git. The fresh cookie-less client knows the
// exact root and path but still receives only schema-valid empty projections.
async function proveUnpairedClientReadsNoManagedDiff(
  stranger: APIRequestContext,
  origin: string,
  target: string,
): Promise<void> {
  const root = worktreeRootForTarget(target);
  const query = new URLSearchParams({ root, path: AUTHORITY_TARGET_RELATIVE_PATH, scope: "all" });
  const diff = await stranger.get(`/api/git/diff?${query.toString()}`, { headers: { origin } });
  expect(diff.status()).toBe(200);
  expect(await diff.json()).toMatchObject({ available: false, diff: "" });

  const status = await stranger.get(`/api/git/status?${new URLSearchParams({ root }).toString()}`, {
    headers: { origin },
  });
  expect(status.status()).toBe(200);
  expect(await status.json()).toMatchObject({ available: false, changes: [] });
}

async function proveRunChangesView(
  page: Page,
  stranger: APIRequestContext,
  target: string,
): Promise<void> {
  const changes = page.getByRole("region", { name: "Run changes" });
  await expect(
    changes.getByRole("button", { name: new RegExp(AUTHORITY_TARGET_RELATIVE_PATH, "u") }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(changes.getByRole("region", { name: "Run-scoped file diff" })).toContainText(
    AUTHORITY_EDITED_CONTENT.trim(),
  );
  await expect(changes.getByText(/^As of [0-9a-f]{7,40}$/u)).toBeVisible();
  await proveUnpairedClientReadsNoManagedDiff(stranger, new URL(page.url()).origin, target);
}

// #2478: revoking the app session (sign-out through the paired cookie jar) must surface as the
// honest re-pair state on the questions surface at the next resync (the pause transition), never
// a silent empty list — while the content-free run controls keep working without a session.
async function proveRevocationSurfacesRepairState(page: Page): Promise<void> {
  const signedOut = await page.request.post("/api/coding-workbench/app-session/sign-out", {
    headers: { "x-keiko-csrf": "1" },
    data: {},
  });
  expect(signedOut.ok()).toBe(true);
  await page.getByRole("button", { name: "Pause run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "paused");
  await expect(runtimeQuestions(page)).toHaveAttribute("data-question-state", "unpaired", {
    timeout: 15_000,
  });
  await expect(
    runtimeQuestions(page).getByText("not paired for question content", { exact: false }),
  ).toBeVisible();
  const changes = page.getByRole("region", { name: "Run changes" });
  await expect(changes.getByRole("alert")).toContainText("app session may need to be paired", {
    timeout: 15_000,
  });
  await expect(changes.getByRole("region", { name: "Run-scoped file diff" })).toHaveCount(0);
  await expect(changes).not.toContainText(AUTHORITY_EDITED_CONTENT.trim());
  await page.getByRole("button", { name: "Resume run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "running");
}

async function proveLiveActivityTimeline(
  page: Page,
  request: APIRequestContext,
  timeline: Locator,
  runId: string,
): Promise<void> {
  await awaitRequiredQuestion(page);
  await expect(timeline.getByRole("region", { name: "Runtime questions" })).toBeVisible();
  await expect(timeline.getByText(FUNCTIONAL_PLAN_STEP_READ, { exact: true })).toBeVisible();
  await expect(timeline.locator('[data-tool-state="succeeded"]')).toContainText("workspace");
  await proveUnpairedClientReadsNoQuestionText(request, new URL(page.url()).origin, runId);
  await answerVisibleQuestion(page);
  await expect(timeline.getByText("Verification summarized", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await expect(
    timeline.getByText(FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX, { exact: false }),
  ).toBeVisible();
  const browserRetention = await page.evaluate(() => ({
    url: window.location.href,
    local: Object.keys(window.localStorage).map((key) => window.localStorage.getItem(key)),
    session: Object.keys(window.sessionStorage).map((key) => window.sessionStorage.getItem(key)),
  }));
  expect(JSON.stringify(browserRetention)).not.toContain(FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX);
  await expect(timeline.getByText(FUNCTIONAL_PLAN_STEP_VERIFY, { exact: true })).toBeVisible();
  await expect(timeline.getByText("Output truncated", { exact: false })).toBeVisible();
  const edited = findManagedTargetFiles(managedRoot, 4);
  expect(edited).toHaveLength(1);
  expect(readFileSync(edited[0] ?? "", "utf8")).toBe(AUTHORITY_EDITED_CONTENT);
  await proveRunChangesView(page, request, edited[0] ?? "");
}

// Runs FIRST: this readiness probe asserts the #2476 AC4 setup surface, which only renders while
// no workspace binding is active — the authority journey below binds and activates the fixture
// workspace on the shared webServer, after which "Code setup" is legitimately replaced by the
// binding summary (the exact ordering break behind nightly run 29635737112).
test("#2386 authority: the workbench readiness surface is live, not static", async ({ page }) => {
  await page.route("**/api/coding-workbench/runtime/readiness*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        requestedMode: "supervised-coding",
        deploymentCeiling: "supervised-coding",
        effectiveMode: "supervised-coding",
        runtimeAvailable: false,
        runtimeUnavailableReason: "platform-unqualified",
      }),
    }),
  );
  await openWorkbench(page);

  await expect(page.getByText("Runtime not confirmed", { exact: true })).toBeVisible();
  // #2476 AC4 — the setup surface stays reachable and honestly explains why start is unavailable
  // instead of disappearing behind the unconfirmed runtime.
  await expect(page.getByRole("region", { name: "Code setup" })).toBeVisible();
  await expect(page.getByTestId("coding-workbench-setup-runtime-note")).toBeVisible();
  await page.getByLabel("Task instructions").fill("Must stay blocked without a confirmed runtime");
  await expect(page.getByRole("button", { name: "Start coding run" })).toBeDisabled();
});

test("#2386 authority: question, sticky pause, widening rejection, follow-up, settle", async ({
  page,
  request,
}) => {
  // #2478: the boot URL carries the launcher-minted pairing attestation; question text is served
  // only to this paired window from here on.
  await openWorkbench(page, launcherPairingFragment());
  await bindFixtureWorkspace(page);

  // #2386 changed the workbench default from full access to the supervised middle mode.
  await expect(page.getByRole("radio", { name: /Supervised workspace/u })).toBeChecked();
  await page.getByLabel("Task instructions").fill("Rename the authority constant under src/");
  const start = page.getByRole("button", { name: "Start coding run" });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(workbench(page)).toHaveAttribute("data-state", "running");
  const runId = await currentRunId(page);
  const timeline = page.getByRole("list", { name: "Coding run event timeline" });

  // The required question must surface in the paired browser (#2478: the round-trip now runs over
  // the authenticated app-session channel); while it is pending, an unpaired local client with
  // every routing fact must receive no question text and no blind-answer authority.
  // #2481: the question is part of the authenticated activity transcript itself, after the
  // completed read tool and the plan snapshot that causally preceded it — not a detached widget.
  await proveLiveActivityTimeline(page, request, timeline, runId);

  // Pause is sticky: the run must stay paused across runtime activity until an explicit Resume.
  await page.getByRole("button", { name: "Pause run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "paused");

  // Widening past the server-confirmed effective mode while the run is live is rejected; the
  // paused run keeps its authority. Restoring the supervised request clears the rejection.
  await page.getByRole("radio", { name: /Full access/u }).check();
  await expect(
    page.getByText("The server rejected this change: widening authority requires stopping", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(workbench(page)).toHaveAttribute("data-state", "paused");
  await page.getByRole("radio", { name: /Supervised workspace/u }).check();

  // A follow-up drafted while paused is admitted as a new task turn — and must NOT auto-resume.
  const taskSubmitted = timeline.getByText("Task submitted", { exact: true });
  const submittedBefore = await taskSubmitted.count();
  await page.getByLabel("Task instructions").fill("Follow up: tighten the constant name");
  await page.getByRole("button", { name: "Send follow-up" }).click();
  await expect(taskSubmitted).toHaveCount(submittedBefore + 1, { timeout: 90_000 });
  await expect(workbench(page)).toHaveAttribute("data-state", "paused");

  await page.getByRole("button", { name: "Resume run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "running");

  // #2478: revocation flips the questions surface to the honest re-pair state.
  await proveRevocationSurfacesRepairState(page);

  // Settle through Stop: the orchestrator releases the active slot and the durable per-run
  // snapshot records the terminal cancelled state.
  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "idle");
  const settled = await page.request.get(`/api/coding-workbench/runtime/runs/${runId}`);
  expect(settled.ok()).toBe(true);
  expect(((await settled.json()) as { readonly state?: string }).state).toBe("cancelled");
});
