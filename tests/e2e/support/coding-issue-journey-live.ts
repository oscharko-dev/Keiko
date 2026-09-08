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
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type { GatewayReadinessReport } from "@oscharko-dev/keiko-contracts/bff-wire";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";
import { selectCodingIssueMode } from "./coding-issue-browser.js";
import {
  assertObservedRuntimeReady,
  LIFECYCLE_STATUS,
  observedDiagnosis,
  observedRun,
  type ObservedRun,
} from "./coding-issue-journey-live-observed.js";

const SURFACE = 'section[aria-label="Coding Workbench"][data-state]';
const AUTH_ENDPOINT = "/api/coding-workbench/github-authorization";
const GATEWAY_READINESS_ENDPOINT = "/api/gateway/readiness";
const GATEWAY_SETUP_ENDPOINT = "/api/gateway/setup";
const PROJECTS_ENDPOINT = "/api/projects";
const CSRF = { "X-Keiko-CSRF": "1" };

export function workbenchSurface(page: Page): Locator {
  return page.locator(SURFACE);
}

// #3394 — the always-mounted left rail (`LeftRail.tsx`, `aria-label={t("rail.primaryNavigation")}`
// = "Primary workspace navigation"). Scoping every rail lookup through this locator, rather than an
// unscoped `getByRole("button", { name: … })`, keeps "Editor" and "Settings" unambiguous once the
// Settings window is open: `settings.tabs.editor` renders its OWN "Editor" tab button inside the
// Settings region, and an unscoped query would match either one depending on DOM order.
function primaryRail(page: Page): Locator {
  return page.getByRole("navigation", { name: "Primary workspace navigation" });
}

// Every rail tool button reports its own open/closed state via `aria-pressed` (LeftRail.tsx), and
// `AppShell.tsx`'s `onTool` toggles that state on every click: clicking an already-open tool's rail
// button CLOSES it. Reading `aria-pressed` first makes opening a tool idempotent -- required here
// because "Editor" and "Settings" are opened from more than one call site in this module and a
// second blind click would toggle the window shut instead of reusing it.
async function ensureRailToolOpen(page: Page, label: string): Promise<void> {
  const button = primaryRail(page).getByRole("button", { name: label, exact: true });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
  }
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

// Opens (or reuses) the Settings tool window and switches it to the named tab
// (`settingsTabLabel` in SettingsPanel.tsx: "Models" / "Security" / …), mirroring the exact
// sequence `coding-issue-intake.spec.ts`'s `enableFullAccess` already drives against the real UI
// (rail "Settings" -> region named "Settings…" -> tab button).
async function openSettingsTab(page: Page, tabName: string): Promise<Locator> {
  await ensureRailToolOpen(page, "Settings");
  const settings = page.getByRole("region", { name: /^Settings/u });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: tabName, exact: true }).click();
  return settings;
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

/** The chat models the gateway is configured with, read from the Settings Models tab the operator
 * uses. `conv-elig-ok` is the PRODUCT's own conversation-eligibility badge, rendered exactly for
 * `kind === "chat"` (`isConversationEligibleModel`), so filtering on it uses the product's own
 * classification instead of a second copy of the rule. */
async function displayedChatModelIds(page: Page): Promise<readonly string[]> {
  const settings = await openSettingsTab(page, "Models");
  const rows = settings.locator(".ml-row").filter({ has: page.getByTestId("conv-elig-ok") });
  const names = await rows.locator(".ml-name").allTextContents();
  return names.map((name) => name.trim()).filter((name) => name.length > 0);
}

/**
 * The Code task's OWN verdict that the configured model can power a coding run.
 *
 * This is the only surface that answers the full rule: `isCodingWorkbenchModel` additionally
 * requires a fresh tool-calling proof, workflow eligibility and a coding use case, and the Models
 * tab displays none of those three. It is also the verdict the Start control actually gates on, so
 * asking the window is both the honest question and the decisive one -- rather than re-deriving the
 * predicate here from a route's fields, which is what this replaced.
 *
 * The window re-reads its model source on the gateway-config and model-readiness announcements
 * (`coding-workbench-runtime-effects.ts`, whose comment records the exact defect that behaviour
 * fixes), so a remedy applied in Settings reaches this without a reload -- but not instantly, hence
 * the bounded wait.
 */
async function usableModelSource(page: Page, timeoutMs = 30_000): Promise<boolean> {
  const status = workbenchSurface(page).locator(LIFECYCLE_STATUS);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (((await status.textContent()) ?? "").includes("Model source ready.")) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(1_000);
  }
}

// Real affordance: SettingsPanel.tsx's Models tab, `ModelCapabilityRow`'s "Run readiness check"
// button (`t("settings.models.runReadiness")`) -- it POSTs GATEWAY_READINESS_ENDPOINT with no
// `probes` filter, so the server runs its whole `DEFAULT_PROBES` set (chat, streaming, tool_calling,
// json_schema, embedding -- gateway-readiness.ts), not only `tool_calling` as the removed direct
// call requested. There is no narrower control a real user can reach: this is the finest-grained
// readiness action the product exposes, and `tool_calling` is always included in that default set,
// so the proof this function exists to capture is still produced.
async function refreshToolCallingProof(page: Page, modelId: string): Promise<void> {
  const settings = await openSettingsTab(page, "Models");
  const modelRow = settings
    .locator(".ml-row")
    .filter({ has: page.getByText(modelId, { exact: true }) });
  const readinessButton = modelRow.getByRole("button", {
    name: "Run readiness check",
    exact: true,
  });
  await expect(readinessButton).toBeEnabled({ timeout: 60_000 });
  const readiness = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(GATEWAY_READINESS_ENDPOINT),
  );
  await readinessButton.click();
  const response = await readiness;
  expect(
    response.ok(),
    `the guarded readiness call failed with HTTP ${String(response.status())}`,
  ).toBe(true);
  const report = (await response.json()) as GatewayReadinessReport;
  const proof = report.probes.find((probe) => probe.name === "tool_calling");
  expect(proof?.status, "the guarded readiness call must verify tool calling").toBe("passed");
  expect(report.verifiedCapabilities.toolCalling).toBe(true);
}

export interface LiveModelQualificationClient {
  /** The Code task's own verdict that the configured model can power a coding run. */
  readonly usableModelSource: () => Promise<boolean>;
  /** The chat models the Settings Models tab displays, by id. */
  readonly displayedChatModelIds: () => Promise<readonly string[]>;
  readonly refreshToolCalling: (modelId: string) => Promise<void>;
  readonly enableWorkflow: (modelId: string) => Promise<void>;
}

// #3390: keyed entirely on what the desktop DISPLAYS. The internal `workspaceId` is a React key
// and reaches no rendered element, and the task branch is already carried by the branch control's
// own accessible name ("Manage branch <name>"), so neither needs a hidden route read: the task
// workspace button, the repository control and the branch control name the same workspace between
// them, and all three are on screen.
export interface LiveWorkbenchIdentity {
  readonly taskControlName: string;
  readonly repositoryControlName: string;
  readonly branchControlName: string;
}

interface LiveWorkbenchReloadClient {
  readonly reload: () => Promise<void>;
  readonly waitForWorkbench: () => Promise<void>;
  readonly waitForWorkspaceIdentity: (identity: LiveWorkbenchIdentity) => Promise<void>;
}

/**
 * Brings the configured model to a state the Code task will start a run on, using only real
 * operator remedies and the product's own verdict.
 *
 * #3390: this used to read `/api/models` and re-derive `isCodingWorkbenchModel` from the returned
 * fields, deciding for itself which remedy was needed. It now asks the window -- the surface the
 * Start control actually gates on -- and applies the two remedies an operator has, in the order an
 * operator would: prove tool calling through the Models tab's readiness check, then mark the model
 * workflow-eligible through the gateway dialog. Neither is attempted while the source is already
 * usable, so an already-qualified profile still costs no paid probe.
 *
 * Returns whether anything was changed, which the caller uses to decide on a reconciling reload.
 */
export async function qualifyLiveModel(client: LiveModelQualificationClient): Promise<boolean> {
  if (await client.usableModelSource()) return false;
  const modelId = await theOneDisplayedChatModel(client);
  await client.refreshToolCalling(modelId);
  if (!(await client.usableModelSource())) {
    await client.enableWorkflow(modelId);
    expect(
      await client.usableModelSource(),
      "setup must publish the selected model as coding-workbench capable",
    ).toBe(true);
  }
  // A remedy must qualify the model it was applied to. The route-reading version pinned this by
  // comparing the model identity the gateway republished; the same guarantee now comes from the
  // Models tab still displaying that one model and no other.
  expect(
    await theOneDisplayedChatModel(client),
    "qualification must preserve the selected model identity",
  ).toBe(modelId);
  return true;
}

async function theOneDisplayedChatModel(client: LiveModelQualificationClient): Promise<string> {
  const ids = await client.displayedChatModelIds();
  expect(
    ids.length,
    "the configured Model Gateway must expose at least one chat model",
  ).toBeGreaterThan(0);
  expect(ids.length, "the live qualification config must identify one unambiguous chat model").toBe(
    1,
  );
  const id = ids[0];
  if (id === undefined) throw new Error("live qualification chat model was unavailable");
  return id;
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

// #3390: the active task workspace ROOT used to be read here from `/api/task-workspaces/active`.
// It is gone on purpose. The product deliberately does NOT display that path -- the workspace chip
// was explicitly stripped of the raw filesystem root, and `BoundRootTarget` is content-free by
// construction -- so scraping it back out of a route would have contradicted a deliberate product
// decision in order to assert something no operator can see. The description scope is now pinned by
// CONSISTENCY across the requests the card itself issues (coding-issue-journey-live-description.ts).

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

function taskWorkspaceControl(page: Page): Locator {
  return page.locator('button[aria-label^="Task workspaces: "]');
}

async function currentLiveWorkbenchIdentity(page: Page): Promise<LiveWorkbenchIdentity> {
  // ActiveWorkspaceContext publishes "Workspace ready" only after it has reconciled the server
  // instance and the rendered repository binding, so every control read below is taken after that
  // boundary and names the reconciled workspace rather than a pre-setup one.
  await waitForWorkbenchWorkspace(page);
  return {
    taskControlName: await controlName(taskWorkspaceControl(page), "task workspace"),
    repositoryControlName: await controlName(
      page.locator('button[aria-label^="Manage repository "]'),
      "repository",
    ),
    branchControlName: await controlName(
      page.locator('button[aria-label^="Manage branch "]'),
      "branch",
    ),
  };
}

async function waitForLiveWorkbenchIdentity(
  page: Page,
  identity: LiveWorkbenchIdentity,
): Promise<void> {
  await expect(page.getByRole("button", { name: identity.taskControlName })).toBeVisible({
    timeout: 60_000,
  });
  await waitForWorkbenchResources(page);
  await expect(page.getByRole("button", { name: identity.repositoryControlName })).toBeVisible();
  await expect(page.getByRole("button", { name: identity.branchControlName })).toBeVisible();
}

// Live-run blocker (B): the real gateway config may hold a chat model whose previously verified
// tool-calling proof has expired, or one that has not yet been marked workflow-eligible. Refreshing
// an expired proof must go through the production readiness route, which is protected by the same
// durable qualification-spend admission as every subsequent provider request. Filtering the stale
// model out before that call made a valid configured profile impossible to qualify.
// Real affordance: SettingsPanel.tsx's Models tab "Update credentials" button
// (`t("settings.models.updateCredentials")`, shown once a gateway is already configured) opens
// GatewaySetupDialog.tsx with `preserveExisting={gatewayConfigured}` (SettingsPanel.tsx's
// `ModelsTabContent`). That prop is exactly the removed direct call's `preserveExisting: true`:
// every OTHER field left blank is resolved server-side from the stored config
// (`submittedOrInheritedString` / the `deploymentNames` empty-list fallback in
// packages/keiko-server/src/gateway-setup.ts), so filling in only the "Coding-safe workflow models"
// field (`t("gatewaySetup.workflowEligibleModels")`) and submitting cannot clobber the live
// provider credentials this journey depends on. `workflowEligibleModelIdsConfigured` flips true on
// the field's own onChange, which alone satisfies `computeCanSubmit` when `preserveExisting` is
// true, so no other field needs to be touched for "Test & save" to become enabled.
async function enableCodingWorkflowEligibility(page: Page, modelId: string): Promise<void> {
  const settings = await openSettingsTab(page, "Models");
  await settings.getByRole("button", { name: "Update credentials", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Update Keiko credentials" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Coding-safe workflow models").fill(modelId);
  const setup = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(GATEWAY_SETUP_ENDPOINT),
  );
  const submit = dialog.getByRole("button", { name: "Test & save", exact: true });
  await expect(submit).toBeEnabled({ timeout: 10_000 });
  await submit.click();
  const setupResponse = await setup;
  expect(
    setupResponse.ok(),
    `the gateway setup call failed with HTTP ${String(setupResponse.status())}`,
  ).toBe(true);
}

export async function ensureWorkflowEligibleModel(page: Page): Promise<boolean> {
  const workspaceIdentity = await currentLiveWorkbenchIdentity(page);
  const changed = await qualifyLiveModel({
    usableModelSource: () => usableModelSource(page),
    displayedChatModelIds: () => displayedChatModelIds(page),
    refreshToolCalling: (modelId) => refreshToolCallingProof(page, modelId),
    enableWorkflow: (modelId) => enableCodingWorkflowEligibility(page, modelId),
  });
  await reconcileLiveWorkbenchAfterModelChange(changed, workspaceIdentity, {
    reload: () => page.reload().then(() => undefined),
    waitForWorkbench: () => expect(workbenchSurface(page)).toBeVisible(),
    waitForWorkspaceIdentity: (identity) => waitForLiveWorkbenchIdentity(page, identity),
  });
  return changed;
}

// The GitHub issue-reader grant, over the authorization route.
//
// #3390: the five qualification flows no longer use this. They grant through the Workbench's own
// control on the issue-access refusal (`previewIssueGrantingAccessIfRefused` above ->
// CodingWorkbenchIssueIntake.tsx's `GitHubIssueAccessGrant`), which is the real user journey and
// the reason that control now exists: the only affordance used to live in Settings, whose bound
// root at grant time is not the repository the operator just named in the Workbench.
//
// What remains here serves ONE caller: `coding-issue-journey-live-git-chat.ts`'s
// `connectControlledPullRequestToChat`, a scenario that never previews an issue and therefore never
// reaches that control. There the grant is a FIXTURE PRECONDITION, not a user step under
// qualification -- it exists so that scenario does not silently depend on an issue-to-PR flow
// having run first in the same process (review 3941793542). It is deliberately not a step of the
// five flows, and nothing in those flows calls it.
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

interface RepositoryProjectRegistration {
  readonly status: number;
  readonly warning?: unknown;
}

export interface LiveRepositoryProjectClient {
  readonly register: (repositoryRoot: string) => Promise<RepositoryProjectRegistration>;
}

export async function registerTrustedRepositoryProject(
  client: LiveRepositoryProjectClient,
  repositoryRoot: string,
): Promise<void> {
  const registered = await client.register(repositoryRoot);
  expect(
    registered.status,
    `the repository project registration failed with HTTP ${String(registered.status)}`,
  ).toBe(201);
  expect(
    registered.warning,
    "the registered repository must inherit package-script trust before worktree provisioning",
  ).toBeUndefined();
}

export interface LiveIssueWorkspacePreparation {
  readonly open: () => Promise<void>;
  readonly registerProject: () => Promise<void>;
  readonly bindIssue: () => Promise<void>;
}

// #3394/#3390 -- the GitHub access grant used to be a step of its own here, performed by PUTting
// the authorization route, because the only control for it lived in Settings bound to a root this
// window had not produced yet. The Workbench now offers the grant itself on the access refusal
// (CodingWorkbenchIssueIntake.tsx's `GitHubIssueAccessGrant`), so granting happens inside
// `bindIssue`, through the real control, exactly as a user reaches it.
//
// The server accepts a grant only for an already-registered repository
// (packages/keiko-server/src/coding-context/githubAuthorizationRoutes.ts's
// `registeredRepositoryRoot`, which checks `deps.store.listProjects()`), and nothing before this
// point registers `repositoryRoot` -- `coding-issue-journey-server.mts` starts with an empty
// project store, and `openLiveWorkbench` only seeds the window layout, never `/api/projects`. That
// ordering is now structural rather than sequenced: the grant control exists only inside a window
// bound to the registered repository path. registerProject also has to precede bindIssue for its
// own, separate reason (trust must be derived before the provisioner runs, see the comment at the
// call site below).
export async function prepareTrustedIssueWorkspace(
  steps: LiveIssueWorkspacePreparation,
): Promise<void> {
  await steps.open();
  await steps.registerProject();
  await steps.bindIssue();
}

// Real affordance: the project/repository open flow. EditorEmptyState.tsx ("Shown when the editor
// window is open without a bound project root (e.g. toggled from the left rail)") is the one
// `createProject` call site that renders its manual-path fallback UNCONDITIONALLY, alongside the
// native picker, rather than instead of it (compare RepositoryFolderSwitcher.tsx's `FolderPanel`,
// which renders the manual form ONLY when native dialogs are unsupported -- unusable here since
// `nativeFileDialogSupported` reports true on darwin/win32 regardless of automation). Toggling the
// left rail's "Editor" tool with no root bound (a fresh coding-only workspace has no "editor" window
// yet) mounts EditorEmptyState directly, with no dialog to drive first.
async function openEmptyEditorWindow(page: Page): Promise<Locator> {
  await ensureRailToolOpen(page, "Editor");
  const empty = page.getByTestId("editor-empty-state");
  await expect(empty).toBeVisible();
  return empty;
}

// The scratch Editor window served only to reach EditorEmptyState's real "open a project" control;
// closing it again keeps the workspace layout the rest of the journey expects (a single "coding"
// window) rather than leaving an unrelated bound Editor window mounted for the remaining steps.
// Safe to call right after `openEmptyEditorWindow`: the rail button's `aria-pressed` is still
// "true" (open), so this click toggles it closed rather than reopening it.
async function closeEditorWindow(page: Page): Promise<void> {
  await primaryRail(page).getByRole("button", { name: "Editor", exact: true }).click();
}

async function registerLiveRepositoryProject(page: Page, repositoryRoot: string): Promise<void> {
  await registerTrustedRepositoryProject(
    {
      register: async (path): Promise<RepositoryProjectRegistration> => {
        const empty = await openEmptyEditorWindow(page);
        await empty.getByLabel("Project folder path").fill(path);
        const created = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" && response.url().endsWith(PROJECTS_ENDPOINT),
        );
        await empty.getByRole("button", { name: "Open", exact: true }).click();
        const response = await created;
        await closeEditorWindow(page);
        if (response.status() !== 201) return { status: response.status() };
        const body = (await response.json()) as { readonly warning?: unknown };
        return { status: response.status(), warning: body.warning };
      },
    },
    repositoryRoot,
  );
}

// #3390: read from the window's own live status region rather than by calling the readiness route
// the UI already calls for itself. The authority must be selected FIRST: the product re-reads
// readiness for whichever authority is currently requested, so asking before the operator has
// chosen would answer for the wrong one.
export async function assertRuntimeReady(page: Page, mode: CodingWorkbenchMode): Promise<void> {
  await selectCodingIssueMode(page, mode);
  await assertObservedRuntimeReady(page);
}

async function previewAndAcceptIssue(page: Page, issueRef: string): Promise<void> {
  const issueField = page.getByLabel("Issue URL or #number");
  if (!(await issueField.isVisible())) {
    await page.getByRole("button", { name: "Start from a GitHub issue", exact: true }).click();
  }
  await expect(issueField).toBeVisible();
  await issueField.fill(issueRef);
  await previewIssueGrantingAccessIfRefused(page);
  await page.getByRole("button", { name: "Use this issue", exact: true }).click();
}

/**
 * Previews the entered issue, and -- when the repository has no GitHub issue-reader grant yet --
 * enables it through the Workbench's OWN control before previewing again. That refuse-grant-retry
 * sequence IS the real user journey (#3390): the preview is the moment the missing precondition
 * shows up, and `GitHubIssueAccessGrant` (CodingWorkbenchIssueIntake.tsx) offers it right there for
 * the exact repository path the intake is bound to. Before that control existed this lane PUT the
 * authorization route itself, because the only affordance lived in Settings, bound to a root no
 * task workspace had produced yet.
 *
 * Any refusal that is NOT the access one is surfaced as itself rather than retried: only the
 * access refusal has a remedy on this surface.
 */
async function previewIssueGrantingAccessIfRefused(page: Page): Promise<void> {
  const preview = page.getByRole("button", { name: "Preview issue", exact: true });
  const previewRegion = page.getByRole("region", { name: "Issue preview", exact: true });
  const alert = page.getByTestId("coding-workbench-issue-alert");
  const grant = page.getByRole("button", { name: "Enable GitHub issue access", exact: true });
  await preview.click();
  await expect(previewRegion.or(alert).first()).toBeVisible({ timeout: 60_000 });
  if (await alert.isVisible()) {
    await expect(alert).toHaveAttribute("data-failure", "auth-required");
    await grant.click();
    // The control withdraws itself only once the server has confirmed the grant, so its
    // disappearance is the confirmation -- never an optimistic local flag.
    await expect(grant).toBeHidden({ timeout: 60_000 });
    await preview.click();
  }
  await expect(previewRegion).toBeVisible({ timeout: 60_000 });
}

export async function previewAndBindIssue(page: Page, issueRef: string): Promise<void> {
  await previewAndAcceptIssue(page, issueRef);
  await page.getByRole("button", { name: "Bind workspace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Code setup", exact: true })).toHaveCount(0);
}

export async function reacceptBoundIssue(page: Page, issueRef: string): Promise<void> {
  const identity = await currentLiveWorkbenchIdentity(page);
  // The setup surface closes only after the existing bind/reconcile/activate sequence settles.
  // Provision reuses this repository/task pair; assert that reacceptance did not create a task.
  await previewAndBindIssue(page, issueRef);
  await waitForLiveWorkbenchIdentity(page, identity);
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
    "1) Use keiko_repository_search to locate the existing production implementation and tests, and use at least one returned hit to choose the files you read.",
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

/** Starts the run and returns its id, taken from the response the product itself received for the
 * operator's click. The run id is a correlation key -- it addresses the activity log and binds the
 * evidence receipt -- not a fact the interface owes the operator, and the Code task deliberately
 * keeps it out of the chrome. Reading it from the product's own traffic is therefore the honest
 * source; nothing here asks a route for it. */
export async function startCodingRun(
  page: Page,
  mode: CodingWorkbenchMode,
  issueRef: string,
): Promise<string> {
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
  const { runId } = (await response.json()) as { readonly runId?: string };
  if (runId === undefined || runId.length === 0) {
    throw new Error("the coding-run start did not return a run id");
  }
  return runId;
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

const DRAFT_WAIT_TERMINAL_STATES: ReadonlySet<string> = new Set([
  "taken-over",
  "failed",
  "cancelled",
  "recovery-required",
  "succeeded",
]);

const UNSUCCESSFUL_TERMINAL_STATES: ReadonlySet<string> = new Set([
  "taken-over",
  "failed",
  "cancelled",
  "recovery-required",
]);

// #3390: both guards now read what the Code task DISPLAYS, so a lane failure reads the way the
// operator's own screen would. `diagnose` supplies the window's live status sentence and any alert
// in place of the internal `failureCode`, which no window ever displayed -- a strictly more useful
// failure message, and one a support bundle can be matched against.
export async function readObservedRunWhileAwaitingDraft(
  read: () => Promise<ObservedRun>,
  diagnose: () => Promise<string>,
): Promise<ObservedRun> {
  const observed = await read();
  if (
    observed.delivery?.phase === "draft-created" ||
    !DRAFT_WAIT_TERMINAL_STATES.has(observed.state)
  ) {
    return observed;
  }
  throw new Error(
    `the coding run reached ${observed.state} before creating a draft pull request -- ${await diagnose()}`,
  );
}

// The run-identity guard this replaces compared a run id no window displays. Its invariant --
// never accept ANOTHER attempt's success as this one's -- is relocated onto the fact the interface
// does show: the delivery card must still name the pull request this flow delivered. A second run
// would have its own delivery, or none yet.
export async function readObservedRunWhileAwaitingSuccess(
  read: () => Promise<ObservedRun>,
  expectedPullRequestNumber: number,
  diagnose: () => Promise<string>,
): Promise<ObservedRun> {
  const observed = await read();
  if (observed.delivery?.pullRequest?.number !== expectedPullRequestNumber) {
    throw new Error(
      `the Code task stopped showing pull request #${String(expectedPullRequestNumber)} while awaiting terminal success`,
    );
  }
  if (!UNSUCCESSFUL_TERMINAL_STATES.has(observed.state)) return observed;
  throw new Error(`the coding run reached ${observed.state} -- ${await diagnose()}`);
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
  await prepareTrustedIssueWorkspace({
    open: () => openLiveWorkbench(page, input.repositoryRoot),
    // Project registration is the folder picker's explicit trust act. It must precede Bind so
    // the production provisioner derives that trust onto the managed worktree, and (#3394) so the
    // GitHub access grant the issue preview asks for inside Bind names a repository the server
    // already knows -- it accepts a grant for no other.
    registerProject: () => registerLiveRepositoryProject(page, input.repositoryRoot),
    bindIssue: () =>
      prepareBoundIssueForRun({
        previewAndBind: () => previewAndBindIssue(page, input.issueRef),
        qualifyModel: () => ensureWorkflowEligibleModel(page),
        previewAndAccept: () => reacceptBoundIssue(page, input.issueRef),
      }),
  });
  await assertRuntimeReady(page, input.mode);
  const runId = await startCodingRun(page, input.mode, input.issueRef);
  await expect(workbenchSurface(page)).toHaveAttribute("data-state", "running", {
    timeout: 60_000,
  });
  const observed = await waitWhileAnsweringApprovals(
    page,
    () =>
      readObservedRunWhileAwaitingDraft(
        () => observedRun(page),
        () => observedDiagnosis(page),
      ),
    (value) => value.delivery?.phase === "draft-created",
    {
      timeoutMs: 25 * 60_000,
      message: "expected a real draft pull request to be recorded within the live run",
    },
  );
  const delivery = observed.delivery;
  const pullRequest = delivery?.pullRequest;
  if (delivery === undefined || pullRequest === undefined) {
    throw new Error("the Code task did not display a delivered pull request after the live drive");
  }
  // The delivery card names the repository and both refs of the target it delivered against; the
  // pull request link and the observed-remote facts name the created pull request itself.
  return {
    runId,
    repository: delivery.repository,
    number: pullRequest.number,
    baseRef: delivery.baseRef,
    headRef: delivery.headRef,
    headSha: pullRequest.headSha,
  };
}
