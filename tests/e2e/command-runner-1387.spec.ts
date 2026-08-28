import { expect, test, type Page } from "@playwright/test";
import type { CommandTaskTrustState } from "@oscharko-dev/keiko-contracts/runtime/command-runner";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue #1387 — browser smoke for the controlled command runner UI. Drives the real Studio shell in
// Chromium; the /api/commands/* BFF is mocked at the network boundary (same approach as
// git-status-1386.spec.ts) so the test is deterministic and never spawns a real child process.

const TAG = "@command-runner-1387";
const tempProjects: string[] = [];

test.afterAll(() => {
  for (const root of tempProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-cmd-"));
  tempProjects.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "vitest", build: "tsc" } }),
    "utf8",
  );
  return root;
}

async function seedCommandsWindow(page: Page, projectPath: string): Promise<void> {
  await page.addInitScript((root) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-1387-commands",
          type: "commands",
          x: 64,
          y: 56,
          w: 620,
          h: 480,
          z: 10,
          cfg: { projectPath: root },
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  }, projectPath);
}

// The catalog is the surface that carries the server's trust decision (`trustState`), and the Run
// control is gated on it alone. A fixture that omits the field cannot describe either outcome, so
// the state under test is a parameter here rather than a constant: "trusted" drives the run
// journey, "approval-required" drives the refusal below.
async function routeCommandCatalog(page: Page, trustState: CommandTaskTrustState): Promise<void> {
  await page.route("**/api/commands/catalog**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        projectId: new URL(route.request().url()).searchParams.get("projectId") ?? "",
        tasks: [
          {
            id: "npm-script:test",
            kind: "test",
            label: "npm run test",
            executable: "npm",
            args: ["run", "test"],
            source: "package-json-script",
            trustState,
            trustReason: "repository-authored-script",
          },
        ],
      }),
    });
  });
}

interface Deferred {
  readonly promise: Promise<string>;
  resolve: (value: string) => void;
}

// Both signals carry the same fact — the requestId this run was minted with — so one string-valued
// deferred serves for the handoff in each direction.
function deferred(): Deferred {
  let resolve: (value: string) => void = () => undefined;
  const promise = new Promise<string>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// KEIKO-0204 scoped the visible "Recent events" log to the widget's OWN in-flight request, so a
// synthetic frame is only logged while `pendingRequestIdRef` still holds the requestId the browser
// minted for this run — that is, strictly before the run POST resolves. The two handlers below
// therefore hand off rather than race: the run POST publishes the requestId and then waits for the
// event frame to be served; the event stream waits for that requestId and serves the frame with it.
// No sleeps and no assumed ordering — each side awaits the fact it needs.
async function routeCommandBff(page: Page, runs: string[]): Promise<void> {
  const requestIdKnown = deferred();
  const eventServed = deferred();

  await page.route("**/api/commands/events**", async (route) => {
    const requestId = await requestIdKnown.promise;
    const completed = JSON.stringify({
      kind: "run-completed",
      runId: "run-e2e-1",
      // isOwnEvent reads the id from the PAYLOAD, which is where the BFF puts it.
      payload: { requestId, failureReason: "none", durationMs: 42 },
    });
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `event: ready\ndata: {}\n\nid: 1\nevent: command:run-completed\ndata: ${completed}\n\n`,
    });
    eventServed.resolve(requestId);
  });

  await page.route("**/api/commands/runs", async (route) => {
    const body = route.request().postData() ?? "";
    runs.push(body);
    const posted = JSON.parse(body) as { readonly requestId?: unknown };
    if (typeof posted.requestId === "string") {
      requestIdKnown.resolve(posted.requestId);
      await eventServed.promise;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        runId: "run-e2e-1",
        taskId: "npm-script:test",
        kind: "test",
        exitCode: 0,
        durationMs: 42,
        truncated: false,
        timedOut: false,
        failureReason: "none",
        stdout: "Test Files  1 passed (1)",
        stderr: "",
      }),
    });
  });
}

test(`Tasks window discovers a task and runs it ${TAG}`, async ({ page }) => {
  const root = createProject();
  const runBodies: string[] = [];
  await seedCommandsWindow(page, root);
  await routeCommandBff(page, runBodies);
  await routeCommandCatalog(page, "trusted");

  await page.goto("/");
  const tasksWindow = page.getByRole("region", { name: /^Tasks/u });
  await expect(tasksWindow).toBeVisible();

  // The discovered task is selectable and the Run control becomes enabled once the catalog loads.
  const runButton = tasksWindow.getByRole("button", { name: /run task/i });
  await expect(runButton).toHaveAttribute("aria-disabled", "false");

  await runButton.click();

  // The structured result surfaces in the real browser: exit code, failure reason, and stdout.
  await expect(tasksWindow.getByText("exit 0", { exact: true })).toBeVisible();
  await expect(tasksWindow.getByText(/Test Files {2}1 passed/u)).toBeVisible();
  await expect(tasksWindow.getByText(/run finished: exit 0/i)).toBeVisible();

  // The live SSE event channel delivers run lifecycle events into the bounded events log.
  await expect(tasksWindow.getByRole("log")).toContainText(/completed/);

  // The run request named the discovered task id — never free-form argv.
  await expect
    .poll(() => runBodies.some((b) => b.includes('"taskId":"npm-script:test"')), {
      message: "run posted with the discovered task id",
    })
    .toBe(true);
});

// The negative control for the same surface. Trust is a SERVER decision the catalog reports, and
// the browser is not allowed to run around it: an approval-required task must leave the Run control
// disabled and say why, with no request reaching /api/commands/runs. Without this case the run
// journey above passes just as well over a widget that ignored `trustState` entirely.
test(`Tasks window refuses an approval-required task ${TAG}`, async ({ page }) => {
  const root = createProject();
  const runBodies: string[] = [];
  await seedCommandsWindow(page, root);
  await routeCommandBff(page, runBodies);
  await routeCommandCatalog(page, "approval-required");

  await page.goto("/");
  const tasksWindow = page.getByRole("region", { name: /^Tasks/u });
  await expect(tasksWindow).toBeVisible();

  const runButton = tasksWindow.getByRole("button", { name: /run task/i });
  await expect(runButton).toBeDisabled();
  await expect(
    tasksWindow.getByText(
      "Server-side workspace trust is required before this repository-authored script can run.",
    ),
  ).toBeVisible();

  // The affordance is the whole gate: a disabled <button> dispatches no click, so no run can start
  // and the events log stays empty. Asserting the ledger after the widget has settled is what makes
  // that a real negative rather than a race against a request that was never going to be made.
  await expect(tasksWindow.getByRole("log")).not.toContainText(/completed/);
  expect(runBodies).toEqual([]);
});
