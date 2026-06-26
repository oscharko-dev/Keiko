import { expect, test, type Page } from "@playwright/test";
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

async function routeCommandBff(page: Page, runs: string[]): Promise<void> {
  // Deterministically serve the SSE channel so the EventSource connects to a controlled endpoint
  // (instead of the live BFF) and a synthetic run-completed frame is delivered to the events log.
  await page.route("**/api/commands/events**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body:
        "event: ready\ndata: {}\n\n" +
        'id: 1\nevent: command:run-completed\ndata: {"kind":"run-completed","runId":"run-e2e-1","payload":{"failureReason":"none","durationMs":42}}\n\n',
    });
  });

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
          },
        ],
      }),
    });
  });

  await page.route("**/api/commands/runs", async (route) => {
    const body = route.request().postData() ?? "";
    runs.push(body);
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
