// Issue #2385 — Code Task OpenCode tracer: the first full browser journey over the REAL coding
// runtime composition. The webServer entry (tests/e2e/servers/coding-runtime-2385-server.mts) boots
// the real buildUiHandlerDeps/createUiServer wiring with the scripted OpenCode harness injected at
// the production `codingRuntimeResolver` seam; the browser drives the real routes end to end:
//
//   pair the app session through the launcher (#2802) → bind the registered checkout by choosing a
//   new managed worktree, which reconciles the verified head the runtime authority requires → start
//   a run → observe live SSE timeline events from the scripted runtime → assert the contained edit
//   landed in the managed worktree and the vetted verification was summarized → settle the run
//   through Stop.
//
// The negative test proves the surface is live, not static: intercepting only the readiness route
// with a contract-valid `runtimeAvailable: false` body must flip the workbench to "Runtime not
// confirmed" and disable Start. If the runtime routes were removed or replaced with static data,
// the journey test fails (canStart never becomes true, no SSE events, no worktree edit).

import { expect, test, type Locator, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";

import {
  TRACER_APP_SESSION_LAUNCHER_SECRET,
  TRACER_EDITED_CONTENT,
  TRACER_TARGET_RELATIVE_PATH,
  tracerManagedWorkspaceRoot,
  tracerRepositoryRoot,
  tracerStateDir,
} from "./support/coding-runtime-2385-tracer.js";

const stateDir = tracerStateDir();
const repositoryRoot = tracerRepositoryRoot(stateDir);
const managedRoot = tracerManagedWorkspaceRoot(stateDir);

function workbench(page: Page): Locator {
  return page.locator('section[aria-label="Coding Workbench"][data-state]');
}

function launcherPairingFragment(): string {
  return encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: TRACER_APP_SESSION_LAUNCHER_SECRET,
      requestId: `req_tracer-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`,
      issuedAtMs: Date.now(),
    }),
  );
}

async function openWorkbench(page: Page, pairingFragment?: string): Promise<void> {
  await page.goto(pairingFragment === undefined ? "/" : `/${pairingFragment}`);
  if (pairingFragment !== undefined) {
    // Bearer hygiene: the pairing fragment leaves the address bar before the Workbench opens.
    await expect.poll(() => page.url()).not.toContain("keiko-app-session");
  }
  await page.getByRole("button", { name: "Coding Workbench", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Coding Workbench", exact: true })).toBeVisible();
}

const TRACER_PROJECT_NAME = "Tracer Fixture Repository";

// PR #3625: the setup card no longer has "Repository path"/"Target branch" text inputs -- the
// repository is chosen from Git's REGISTERED checkouts through a combobox. Register the fixture
// checkout first (mirrors the real "Add repository" dialog) so it appears in that catalog at all.
async function registerFixtureRepositoryProject(page: Page): Promise<void> {
  const response = await page.request.post("/api/projects", {
    headers: { "X-Keiko-CSRF": "1" },
    data: { path: repositoryRoot, name: TRACER_PROJECT_NAME },
  });
  expect(response.ok()).toBe(true);
}

// #3685: the registered fixture is the sole repository, so the product selects it and its branch
// automatically and the separate "Code setup" card no longer appears. Choosing the "Work in"
// location provisions the managed worktree, reconciles its verified head and activates it, the
// same UI-only path the #2386 authority journey drives.
async function bindFixtureWorkspace(page: Page): Promise<void> {
  const controls = workbench(page);
  await expect(controls.getByRole("combobox", { name: "Choose coding repository" })).toContainText(
    TRACER_PROJECT_NAME,
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
  const candidate = join(dir, TRACER_TARGET_RELATIVE_PATH);
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

// Runs FIRST: this readiness probe asserts the #2476 AC4 setup surface, which only renders while
// no workspace binding is active — the tracer journey below binds and activates the fixture
// workspace on the shared webServer, after which "Code setup" is legitimately replaced by the
// binding summary (the exact ordering break behind nightly run 29635737112).
test("#2385 tracer: the workbench readiness surface is live, not static", async ({ page }) => {
  await page.route("**/api/coding-workbench/runtime/readiness*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        requestedMode: "governed-assist",
        deploymentCeiling: "governed-assist",
        effectiveMode: "governed-assist",
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

test("#2385 tracer: bind, run, observe live SSE activity, and settle against the real runtime", async ({
  page,
}) => {
  // Registered before the Workbench reads Git's catalog: the client serves that catalog from a
  // short-lived cache that only its own registration flow invalidates (#3625 registration).
  await registerFixtureRepositoryProject(page);
  await openWorkbench(page, launcherPairingFragment());
  await bindFixtureWorkspace(page);

  // #2644 moved the autonomy selector into Settings -> Security; the Workbench reports the mode the
  // server confirmed rather than owning the control.
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("region", { name: /^Settings/u });
  await settings.getByRole("button", { name: "Security" }).click();
  await page.getByRole("radio", { name: /Full access/u }).click();
  await expect(page.getByRole("radio", { name: /Full access/u })).toBeChecked();
  await page.getByRole("button", { name: "Close Settings window" }).click();
  await page.getByLabel("Task instructions").fill("Rename the tracer constant under src/");
  const start = page.getByRole("button", { name: "Start coding run" });
  await expect(start).toBeEnabled();
  await start.click();

  await expect(workbench(page)).toHaveAttribute("data-state", "running");
  const runId = await currentRunId(page);
  const timeline = page.getByRole("list", { name: "Coding run event timeline" });
  // #3561: run lifecycle events are listed under the collapsed "Run details" disclosure.
  const runDetails = workbench(page).getByRole("button", { name: "Run details" });
  await runDetails.click();
  await expect(runDetails).toHaveAttribute("aria-expanded", "true");
  await expect(timeline.getByText("Runtime started", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await expect(timeline.getByText("Verification summarized", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  expect(await timeline.locator('li:not([aria-hidden="true"])').count()).toBeGreaterThanOrEqual(2);

  const edited = findManagedTargetFiles(managedRoot, 4);
  expect(edited).toHaveLength(1);
  expect(readFileSync(edited[0] ?? "", "utf8")).toBe(TRACER_EDITED_CONTENT);

  // Settle through Stop: the real orchestrator releases the active slot and the durable per-run
  // snapshot records the terminal cancelled state, which the Workbench keeps showing until the
  // operator starts a new task (#3394).
  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "cancelled");
  const settled = await page.request.get(`/api/coding-workbench/runtime/runs/${runId}`);
  expect(settled.ok()).toBe(true);
  expect(((await settled.json()) as { readonly state?: string }).state).toBe("cancelled");
});
