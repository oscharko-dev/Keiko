// Issue #2385 — Code Task OpenCode tracer: the first full browser journey over the REAL coding
// runtime composition. The webServer entry (tests/e2e/servers/coding-runtime-2385-server.mts) boots
// the real buildUiHandlerDeps/createUiServer wiring with the scripted OpenCode harness injected at
// the production `codingRuntimeResolver` seam; the browser drives the real routes end to end:
//
//   bind an existing local git checkout through the new "Code setup" section → reconcile the fresh
//   binding through the #447 reconciliation route (stamps the verified head the runtime authority
//   requires) → start a run → observe live SSE timeline events from the scripted runtime → assert
//   the contained edit landed in the managed worktree and the vetted verification was summarized →
//   settle the run through Stop.
//
// The negative test proves the surface is live, not static: intercepting only the readiness route
// with a contract-valid `runtimeAvailable: false` body must flip the workbench to "Runtime not
// confirmed" and disable Start. If the runtime routes were removed or replaced with static data,
// the journey test fails (canStart never becomes true, no SSE events, no worktree edit).

import { expect, test, type Locator, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
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

async function openWorkbench(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Coding Workbench" }).click();
  await expect(page.getByRole("heading", { name: "Coding Workbench" })).toBeVisible();
}

// Drives the #2385/#2476 "Code setup" section end to end through UI interactions only: binding the
// fixture checkout now provisions, runs the #447 reconciliation pass that stamps the verified head the
// runtime launch authority requires, and only then activates — no out-of-band `page.request`
// reconciliation call (#2476 AC1). The section yields to the task-start flow once the verified binding
// lands, which is the signal the whole sequence succeeded.
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

test("#2385 tracer: bind, run, observe live SSE activity, and settle against the real runtime", async ({
  page,
}) => {
  await openWorkbench(page);
  await bindFixtureWorkspace(page);

  await page.getByRole("radio", { name: /Full access/u }).check();
  await page.getByLabel("Task instructions").fill("Rename the tracer constant under src/");
  const start = page.getByRole("button", { name: "Start coding run" });
  await expect(start).toBeEnabled();
  await start.click();

  await expect(workbench(page)).toHaveAttribute("data-state", "running");
  const runId = await currentRunId(page);
  const timeline = page.getByRole("list", { name: "Coding run event timeline" });
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

  // Settle through Stop: the real orchestrator releases the active slot (workbench returns to
  // idle) and the durable per-run snapshot records the terminal cancelled state.
  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "idle");
  const settled = await page.request.get(`/api/coding-workbench/runtime/runs/${runId}`);
  expect(settled.ok()).toBe(true);
  expect(((await settled.json()) as { readonly state?: string }).state).toBe("cancelled");
});
