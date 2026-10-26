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
//   while paused is admitted as a new task turn and resumes the run through the one resume path
//   (#3452) → revoking the session surfaces the honest re-pair state on the questions surface
//   (#2478) and refuses the unpaired browser's Pause (#2802) → a fresh launcher pairing restores
//   Pause and Resume → Stop settles the durable snapshot as cancelled.
//
// The negative test proves the surface is live, not static: intercepting only the readiness route
// with a contract-valid `runtimeAvailable: false` body must flip the workbench to "Runtime not
// confirmed" and disable Start.

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";
import {
  FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX,
  FUNCTIONAL_PLAN_STEP_READ,
  FUNCTIONAL_PLAN_STEP_VERIFY,
} from "../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.js";
import {
  activityLogDirectory,
  readActivityLogText,
} from "../../scripts/lib/activity-log-files.mjs";
import { FUNCTIONAL_REPOSITORY_SKILL_NAME } from "../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/skillDiscoveryProof.js";

import {
  AUTHORITY_APP_SESSION_LAUNCHER_SECRET,
  AUTHORITY_EDITED_CONTENT,
  AUTHORITY_ORIGINAL_CONTENT,
  AUTHORITY_TARGET_RELATIVE_PATH,
  authorityManagedWorkspaceRoot,
  authorityRepositoryRoot,
  authorityStateDir,
} from "./support/coding-runtime-2386-authority.js";
import { openEditorWorkspace, openTreeFile } from "./support/editorWorkspace.js";
import { activateWindow } from "./support/window-chrome.js";

const stateDir = authorityStateDir();
const repositoryRoot = authorityRepositoryRoot(stateDir);
const managedRoot = authorityManagedWorkspaceRoot(stateDir);
const realBinaryJourney = process.env.KEIKO_E2E_REAL_BINARY === "1";

function workbench(page: Page): Locator {
  return page.locator('section[aria-label="Coding Workbench"][data-state]');
}

// #3561 made the run's Changes view a collapsed disclosure. It has no accessible name; its summary
// reads the changed-file count once the run's changes are read, "Changes" while they are
// unavailable. Its content is only reachable once the operator expands it.
async function openRunChanges(page: Page): Promise<Locator> {
  const changes = workbench(page)
    .getByRole("group")
    .filter({ has: page.locator("summary", { hasText: /^(?:Changes|\d+ changed files?)$/u }) });
  await expect(changes).toBeVisible({ timeout: 30_000 });
  if ((await changes.getAttribute("open")) === null) await changes.locator("summary").click();
  await expect(changes).toHaveAttribute("open", "");
  return changes;
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

// #2644 moved the product-wide autonomy modes into Settings -> Security. The control is
// server-confirmed, so this waits for the selection to settle rather than assuming it applied.
async function requestAutonomyMode(page: Page, label: RegExp): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("region", { name: /^Settings/u });
  await settings.getByRole("button", { name: "Security" }).click();
  await page.getByRole("radio", { name: label }).click();
  await expect(page.getByRole("radio", { name: label })).toBeChecked();
  await page.getByRole("button", { name: "Close Settings window" }).click();
}

async function expectEffectiveMode(page: Page, mode: string): Promise<void> {
  await workbench(page).getByRole("button", { name: "Open Coding Workbench information" }).click();
  await expect(workbench(page).locator("[data-mode]")).toHaveAttribute("data-mode", mode);
  await page.keyboard.press("Escape");
}

async function openWorkbench(page: Page, pairingFragment?: string): Promise<void> {
  await page.goto(pairingFragment === undefined ? "/" : `/${pairingFragment}`);
  if (pairingFragment !== undefined) {
    // Bearer hygiene: the pairing fragment must leave the address bar (and the history entry)
    // before the workbench is even opened.
    await expect.poll(() => page.url()).not.toContain("keiko-app-session");
  }
  await page.getByRole("button", { name: "Coding Workbench", exact: true }).click();
  await expect(workbench(page)).toBeVisible();
}

// The registered fixture is the sole repository and is selected by the product automatically.
// Choose its existing worktree location control: that UI selection provisions, reconciles the
// verified head, and activates the managed checkout without an out-of-band reconciliation call.
// The fixture intentionally wires managed worktrees rather than local checkout provisioning.
async function bindFixtureWorkspace(page: Page): Promise<void> {
  const controls = workbench(page);
  await expect(controls.getByRole("combobox", { name: "Choose coding repository" })).toContainText(
    "Authority Fixture Repository",
  );
  await expect(controls.getByRole("combobox", { name: "Choose coding branch" })).toContainText(
    "main",
  );
  await controls.getByRole("combobox", { name: "Work in" }).click();
  const activation = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/task-workspaces/active" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("listbox", { name: "Work in" })
    .getByRole("option", { name: "New local worktree", exact: true })
    .click();
  expect((await activation).ok()).toBe(true);
  await expect(controls.getByRole("combobox", { name: "Work in" })).toContainText(
    "New local worktree",
  );
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
  await expect(questions.getByRole("heading", { name: "Runtime needs your input" })).toBeHidden({
    timeout: 30_000,
  });
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

async function openRealBinaryManualEditor(page: Page): Promise<void> {
  if (!realBinaryJourney) return;
  const targets = findManagedTargetFiles(managedRoot, 4);
  expect(targets).toHaveLength(1);
  const root = realpathSync(worktreeRootForTarget(targets[0] ?? ""));
  await page.getByRole("button", { name: "Editor" }).click();
  const workspace = await openEditorWorkspace(page);
  const editorWindow = page.locator('section[data-window-id="editor"]');
  // Raise through the shared helper, which uses the product's own pointer path. A bare focus() no
  // longer raises a window: WindowFrame only treats keyboard navigation as a raise signal, so a
  // still-loading window cannot grab focus and jump over the one the user moved to.
  await activateWindow(editorWindow);
  // The caret is aria-hidden since #2605 (role="tree" may own only treeitem/group), so it is
  // addressed by selector rather than by role. Expansion is also reachable via Arrow Right.
  await workspace.locator('button.tr-caret-btn[aria-label="Expand folder: src"]').click();
  await openTreeFile(workspace, AUTHORITY_TARGET_RELATIVE_PATH);
  // The ordinary Editor owns manual buffers only. Its readiness comes from the loaded
  // document, independently of the Workbench's governed changeset bridge.
  await expect(
    workspace.getByRole("textbox", {
      name: `Editor: ${AUTHORITY_TARGET_RELATIVE_PATH} in ${root}`,
      exact: true,
    }),
  ).toBeAttached();
  await expect(workspace.locator(".monaco-editor").first()).toBeVisible();
  await expect(workspace.locator(".monaco-editor .view-lines").first()).toContainText(
    AUTHORITY_EDITED_CONTENT.trimEnd(),
  );
  await expect(workspace.locator('[data-field="save"]').first()).toHaveText("Saved");
  await assertInheritedWorkspaceTrust(page);
  await activateWindow(page.locator('section[data-window-id="coding"]'));
}

// M11 (#2612/#2686) rebuilt workspace trust around user-facing projects: registering the folder
// the human chose IS the explicit local-human trust act (`handleCreateProject` grants script
// trust), provisioning derives that trust onto the managed worktree, managed worktrees are
// deliberately absent from the trust panel, and the editor palette's `Trust Workspace Scripts`
// command is unavailable for the active root. The journey therefore registers the fixture
// repository as a project BEFORE the run provisions its worktree — the exact call the folder
// picker performs — and later asserts the inherited trust where the old palette step used to be.
// Both engines need this: the vetted verification runs over trusted workspace scripts in the
// scripted journey exactly as in the real-binary one.
async function registerTrustedRepositoryProject(page: Page): Promise<void> {
  const created = await page.request.post("/api/projects", {
    headers: { "x-keiko-csrf": "1" },
    data: {
      path: repositoryRoot,
      name: "Authority Fixture Repository",
      selectionIntent: "explicit-folder-selection",
    },
  });
  expect(created.status()).toBe(201);
  const body = (await created.json()) as { readonly warning?: unknown };
  // A registration that leaves the project restricted would silently break the derived worktree
  // trust the rest of the journey depends on — surface it here, not as a 240s editor timeout.
  expect(body.warning).toBeUndefined();
}

async function assertInheritedWorkspaceTrust(page: Page): Promise<void> {
  // Provisioning derived the repository project's trust onto the managed worktree, so the editor
  // must open trusted: no restricted-mode banner. The verification activity that follows is the
  // deep proof — the typecheck script only runs over trusted workspace scripts.
  await expect(page.getByTestId("workspace-trust-banner-editor")).toHaveCount(0);
}

// #3897: the pinned runtime edits natively. The run's accepted supervised authority permits this
// routine contained edit, so the runtime's own `edit` tool applies it to the managed worktree
// without a per-action approval and no review surface is ever raised for it. The applied file in
// the managed worktree shows the write; the run's own allowed native `edit` decision binds it to
// this run and to Keiko's native policy. No Workbench changeset bridge is involved.
async function proveRealBinaryEditApplied(page: Page, runId: string): Promise<void> {
  if (!realBinaryJourney) return;
  await expect
    .poll(() => findManagedTargetFiles(managedRoot, 4).map((file) => readFileSync(file, "utf8")))
    .toEqual([AUTHORITY_EDITED_CONTENT]);
  await expect.poll(() => allowedNativeDecisionCount(runId, "edit")).toBeGreaterThan(0);
  await expect(
    workbench(page).getByRole("region", { name: "Review the proposed file change" }),
  ).toHaveCount(0);
}

// The runtime asks Keiko's native policy before each of its own tool calls, and every decision is
// persisted on the Activity Log under the run's id (`coding-runtime.native-policy.decided`, the
// record the real-binary runner's native governance proof reads). The real-binary runner points
// KEIKO_STATE_DIR at the journey's Activity Log, so its absence there is a broken lane, not a skip.
function allowedNativeDecisionCount(runId: string, permission: string): number {
  const keikoStateDir = process.env.KEIKO_STATE_DIR;
  if (keikoStateDir === undefined || keikoStateDir.length === 0) {
    throw new Error("The real-binary journey requires KEIKO_STATE_DIR for its Activity Log.");
  }
  return readActivityLogText(activityLogDirectory(keikoStateDir))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (record) =>
        record.op === "coding-runtime.native-policy.decided" &&
        record.correlationId === runId &&
        record.permission === permission &&
        record.effect === "allow" &&
        record.outcome === "allowed",
    ).length;
}

// #3901 (parity T10): the native journey verifies through the runtime's own `shell`, running the
// fixture's project check. Keiko's governed verifier needs a container backend and fails closed
// without one; the native check reaches the same verification owner, so the run's verification
// summary is the same card either way.
async function proveVerificationActivity(timeline: Locator): Promise<void> {
  if (realBinaryJourney) {
    const verification = toolActivity(timeline, "shell");
    await expect(verification).toHaveCount(1, { timeout: 90_000 });
    await expandCompletedActivity(timeline);
    await verification.locator("summary").click();
    await expect(verification.getByText("shell", { exact: true })).toBeVisible();
  }
  await expect(timeline.getByText("Verification summarized", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
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
  const changes = await openRunChanges(page);
  const fileButton = changes.getByRole("button", {
    name: new RegExp(AUTHORITY_TARGET_RELATIVE_PATH, "u"),
  });
  await expect(fileButton).toBeVisible({ timeout: 30_000 });
  const diffPane = changes.getByRole("region", { name: "Run-scoped file diff" });
  await expect(diffPane).toContainText(AUTHORITY_EDITED_CONTENT.trim());
  await expect(changes.getByText(/^As of [0-9a-f]{7,40}$/u)).toBeVisible();
  await proveUnpairedClientReadsNoManagedDiff(stranger, new URL(page.url()).origin, target);
  await proveChangesRefreshPreservesFocusAndContent(page, fileButton, diffPane);
}

// #2641 focus-survival extension: with a file row focused, any later change signal must NOT
// unmount the file list or the diff pane. Pinning this in the browser catches a regression to
// the pre-fix "reset to loading on refresh" behaviour that would blank the pane and drop focus.
// The hook-level regression test in `useCodingWorkbenchChanges.test.tsx` covers the exact
// stale-while-revalidate contract; this end-to-end assertion is a lightweight guard that the
// contract survives all the way through the real render tree in a real browser session.
async function proveChangesRefreshPreservesFocusAndContent(
  _page: Page,
  fileButton: Locator,
  diffPane: Locator,
): Promise<void> {
  await fileButton.focus();
  await expect(fileButton).toBeFocused();
  // Poll continuously for a bounded window so any late-arriving change signal from the
  // stopping/stopped transitions is observed. Both assertions must remain true for the whole
  // window — a regression to the pre-fix "reset to loading on refresh" would flip focus off
  // the button and blank the diff pane the moment the refresh landed.
  await expect
    .poll(
      async () =>
        (await fileButton.evaluate((element) => element === document.activeElement)) &&
        (await diffPane.evaluate(
          (element, needle) => element.textContent.includes(needle),
          AUTHORITY_EDITED_CONTENT.trim(),
        )),
      { intervals: [50, 100, 100, 100, 200], timeout: 800 },
    )
    .toBe(true);
}

// #2478: revoking the app session (sign-out through the paired cookie jar) must surface as the
// honest re-pair state on the questions surface, never a silent empty list. Since #2802 (#2869) the
// state-changing run routes are bound to the app session too, so the unpaired browser's Pause is
// refused and the run keeps running. Re-pairing through the launcher restores the run controls.
async function proveRevocationSurfacesRepairState(page: Page, runId: string): Promise<void> {
  const signedOut = await page.request.post("/api/coding-workbench/app-session/sign-out", {
    headers: { "x-keiko-csrf": "1" },
    data: {},
  });
  expect(signedOut.ok()).toBe(true);
  await page.getByRole("button", { name: "Pause run" }).click();
  await expect(runtimeQuestions(page)).toHaveAttribute("data-question-state", "unpaired", {
    timeout: 15_000,
  });
  await expect(
    runtimeQuestions(page).getByText("not paired for question content", { exact: false }),
  ).toBeVisible();
  const changes = await openRunChanges(page);
  await expect(changes.getByRole("alert")).toContainText("app session may need to be paired", {
    timeout: 15_000,
  });
  await expect(changes.getByRole("region", { name: "Run-scoped file diff" })).toHaveCount(0);
  await expect(changes).not.toContainText(AUTHORITY_EDITED_CONTENT.trim());
  await expect(workbench(page)).toHaveAttribute("data-state", "running");
  expect(await runState(page, runId)).toBe("running");

  await repairAppSession(page);
  await expect(workbench(page)).toHaveAttribute("data-state", "running");
  await page.getByRole("button", { name: "Pause run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "paused");
  await page.getByRole("button", { name: "Resume run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "running");
}

// A fresh launcher attestation pairs the reloaded page again; the restored workspace keeps the
// Workbench window, so it is opened only when the reload did not bring it back.
async function repairAppSession(page: Page): Promise<void> {
  await page.goto(`/${launcherPairingFragment()}`);
  await expect.poll(() => page.url()).not.toContain("keiko-app-session");
  const launcher = page.getByRole("button", { name: "Coding Workbench", exact: true });
  await expect(launcher).toBeVisible();
  if ((await launcher.getAttribute("aria-pressed")) !== "true") await launcher.click();
  await expect(workbench(page)).toBeVisible();
}

async function runState(page: Page, runId: string): Promise<string | undefined> {
  const snapshot = await page.request.get(`/api/coding-workbench/runtime/runs/${runId}`);
  expect(snapshot.ok()).toBe(true);
  return ((await snapshot.json()) as { readonly state?: string }).state;
}

async function proveLiveActivityTimeline(
  page: Page,
  request: APIRequestContext,
  timeline: Locator,
  runId: string,
): Promise<void> {
  await awaitRequiredQuestion(page);
  await workbench(page).getByRole("button", { name: "Run details" }).click();
  await expandCompletedActivity(timeline);
  if (realBinaryJourney) {
    await proveRepositorySearchConsumption(timeline);
    await proveSkillDiscoveryConsumption(timeline);
  }
  await expect(timeline.getByRole("region", { name: "Runtime questions" })).toBeVisible();
  await expect(timeline.getByText(FUNCTIONAL_PLAN_STEP_READ, { exact: true })).toBeVisible();
  if (!realBinaryJourney) await proveScriptedWorkspaceRead(timeline);
  await proveUnpairedClientReadsNoQuestionText(request, new URL(page.url()).origin, runId);
  await answerVisibleQuestion(page);
  await proveRealBinaryEditApplied(page, runId);
  await openRealBinaryManualEditor(page);
  await proveVerificationActivity(timeline);
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
  if (!realBinaryJourney) await proveRunChangesView(page, request, edited[0] ?? "");
}

// The scripted (mapped) engine reads through Keiko's own workspace tool; the real binary reads
// through its own `read`, which `proveRepositorySearchConsumption` already asserts.
async function proveScriptedWorkspaceRead(timeline: Locator): Promise<void> {
  await expect(toolActivity(timeline, "keiko_workspace_read")).toHaveCount(1);
}

function toolActivity(timeline: Locator, tool: string): Locator {
  return timeline
    .locator('[data-tool-state="succeeded"]')
    .filter({ has: timeline.page().getByText(tool, { exact: true }) });
}

async function expandCompletedActivity(timeline: Locator): Promise<void> {
  const summaries = timeline.locator(
    '[data-timeline-kind="group"] > details:not([open]) > summary',
  );
  for (const summary of await summaries.all()) await summary.click();
}

async function proveRepositorySearchConsumption(timeline: Locator): Promise<void> {
  const path = join(stateDir, "h1-result-consumption.json");
  await expect.poll(() => existsSync(path)).toBe(true);
  const proof: unknown = JSON.parse(readFileSync(path, "utf8"));
  expect(proof).toMatchObject({
    schemaVersion: 1,
    toolCallId: "h1-real-binary-search",
    hitCount: 1,
    pathDigest: createHash("sha256").update(AUTHORITY_TARGET_RELATIVE_PATH).digest("hex"),
    snippetDigest: createHash("sha256").update(AUTHORITY_ORIGINAL_CONTENT.trim()).digest("hex"),
    startLine: 1,
    endLine: 1,
    readTargetDerivedFromResult: true,
  });
  for (const tool of ["grep", "read"]) {
    const succeeded = toolActivity(timeline, tool);
    await expect(succeeded).toHaveCount(1);
    await expect(succeeded).toBeVisible();
    await succeeded.locator("summary").click();
    await expect(succeeded.getByText(tool, { exact: true })).toBeVisible();
  }
}

// #3417, #3897: the real binary listed the repository skill Keiko admitted (#3903) in its own prompt
// and invoked the one that listing named with its own `skill` tool, so the skill id it passed came
// from the runtime's listing and not from a fixture. The timeline carries the completed call.
async function proveSkillDiscoveryConsumption(timeline: Locator): Promise<void> {
  const path = join(stateDir, "skill-discovery-consumption.json");
  await expect.poll(() => existsSync(path)).toBe(true);
  const proof: unknown = JSON.parse(readFileSync(path, "utf8"));
  expect(proof).toMatchObject({
    schemaVersion: 1,
    toolCallId: "skill-real-binary-discovery",
    skillIdDigest: createHash("sha256").update(FUNCTIONAL_REPOSITORY_SKILL_NAME).digest("hex"),
    invokedSkillDerivedFromResult: true,
  });
  expect((proof as { readonly listedCount: number }).listedCount).toBeGreaterThanOrEqual(1);
  // Match the exact tool identifier inside its user-expandable card.
  const succeeded = toolActivity(timeline, "skill");
  await expect(succeeded).toHaveCount(1);
  await succeeded.locator("summary").click();
  await expect(succeeded.getByText("skill", { exact: true })).toBeVisible();
}

async function settleRealBinaryRun(page: Page, runId: string): Promise<void> {
  // Causal-terminal contract: once the applied changeset releases the pending-mutation hold, the
  // child's own `stop` completion settles the run succeeded — no operator stop is involved. The
  // settled outcome must land in the durable per-run snapshot the runs route serves.
  await expect
    .poll(
      async () => {
        const snapshot = await page.request.get(`/api/coding-workbench/runtime/runs/${runId}`);
        if (!snapshot.ok()) return "unavailable";
        return ((await snapshot.json()) as { readonly state?: string }).state ?? "unknown";
      },
      { timeout: 120_000 },
    )
    .toBe("succeeded");
  const codingWindow = page.locator('section[data-window-id="coding"]');
  await codingWindow
    .getByRole("group", { name: "Coding Workbench window controls" })
    .getByRole("button", { name: "Close Coding Workbench window" })
    .click();
  await expect(codingWindow).toHaveCount(0);
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
        selectableAgents: ["build"],
      }),
    }),
  );
  await openWorkbench(page);

  // #2476 AC4 — the setup surface stays reachable and honestly explains why start is unavailable
  // instead of disappearing behind the unconfirmed runtime.
  await expect(page.getByRole("region", { name: "Code setup" })).toBeVisible();
  await expect(page.getByTestId("coding-workbench-setup-runtime-note")).toBeVisible();
  // #2644 put the task composer behind the binding step, so an unconfirmed runtime cannot be
  // started at all here — a stronger guarantee than the disabled control this used to assert.
  await expect(page.getByLabel("Task instructions")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start coding run" })).toHaveCount(0);
});

// #2386 moved the default off full access; #2644 made the mode product-wide, so the default now
// comes from the autonomy policy and lands one step NARROWER still — the Workbench reports the
// server-confirmed mode instead of owning the selector. Never full access on a fresh install.
// This journey then proves a SUPERVISED run (see the header contract): under supervised-coding
// the envelope allows workspace-contained edits and vetted verification without per-action
// approval. Under the governed-assist default those admissions are ask-first, so the child's
// edit and verification tool calls would be silently denied at the tool-facade authority —
// exactly the post-#2644 stall this step repairs. The human raising the mode IS the product
// flow; the widening-rejection step below still proves a LIVE run cannot be widened further.
async function proveDefaultModeThenRaiseToSupervised(page: Page): Promise<void> {
  await expectEffectiveMode(page, "governed-assist");
  await requestAutonomyMode(page, /Supervised workspace/u);
  await expectEffectiveMode(page, "supervised-coding");
}

test("#2386 authority: question, sticky pause, widening rejection, follow-up, settle", async ({
  page,
  request,
}) => {
  // #2478: the boot URL carries the launcher-minted pairing attestation; question text is served
  // only to this paired window from here on.
  await registerTrustedRepositoryProject(page);
  await openWorkbench(page, launcherPairingFragment());
  await bindFixtureWorkspace(page);

  await proveDefaultModeThenRaiseToSupervised(page);
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
  if (realBinaryJourney) {
    await settleRealBinaryRun(page, runId);
    return;
  }

  // Pause is sticky: the run must stay paused across runtime activity until an explicit Resume.
  await page.getByRole("button", { name: "Pause run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "paused");

  // Widening past the server-confirmed effective mode while the run is live must not take effect;
  // the paused run keeps its authority. The selector now lives in Settings (#2644), so the proof is
  // that requesting Full access there leaves the live run's confirmed mode untouched — the
  // supervised mode this journey raised to before starting.
  await requestAutonomyMode(page, /Full access/u);
  await expectEffectiveMode(page, "supervised-coding");
  await expect(workbench(page)).toHaveAttribute("data-state", "paused");

  // A follow-up drafted while paused is admitted as a new task turn. Since #3452 (F51) it is the
  // operator's own "continue with this": the run resumes through the one resume path and the turn is
  // dispatched against the resumed revision, at the authority the run already holds. It runs BEFORE
  // the narrowing request below: since #2644 the mode is product-wide, so a narrowed policy would
  // legitimately hold a NEW task turn for approval instead of admitting it.
  const taskSubmitted = timeline.getByText("Task submitted", { exact: true });
  const submittedBefore = await taskSubmitted.count();
  await page.getByLabel("Task instructions").fill("Follow up: tighten the constant name");
  await page.getByRole("button", { name: "Send follow-up" }).click();
  await expect(taskSubmitted).toHaveCount(submittedBefore + 1, { timeout: 90_000 });
  await expect(workbench(page)).toHaveAttribute("data-state", "running");
  await expectEffectiveMode(page, "supervised-coding");

  // Narrowing the product-wide policy while the run is live leaves its confirmed mode untouched,
  // exactly like the widening attempt above.
  await requestAutonomyMode(page, /Ask for approval/u);
  await expectEffectiveMode(page, "supervised-coding");

  // #2478: revocation flips the questions surface to the honest re-pair state; once re-paired, the
  // proof pauses the run and returns it to running through an explicit Resume.
  await proveRevocationSurfacesRepairState(page, runId);

  // Settle through Stop: the orchestrator releases the active slot and the durable per-run
  // snapshot records the terminal cancelled state, which the Workbench keeps showing until the
  // operator starts a new task (#3394).
  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "cancelled");
  const settled = await page.request.get(`/api/coding-workbench/runtime/runs/${runId}`);
  expect(settled.ok()).toBe(true);
  expect(((await settled.json()) as { readonly state?: string }).state).toBe("cancelled");
});
