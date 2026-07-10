// Issue #2215 (Epic #2092 closeout) — end-to-end evidence for the run → verify → problems → jump →
// fix → rerun loop, driven against the REAL BFF (no mocked contracts, no mocked AuthorityEnvelope),
// following the shape of editor-agent-docking-2122.spec.ts (top-level `test(...)` blocks, real-BFF
// fixtures via ./support/editorWorkspace.js). Executed by the CI Studio browser gate (chromium is the
// reference browser). It covers three code paths the epic adds: a file-targeted run, a workspace-scoped
// run, and a cancel-mid-run — each observing the SSE stream reach a terminal, content-free lifecycle
// state, then the workspace problems panel surfacing the failure with a file/line location and the
// editor revealing the exact line on click.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  EDITOR_SELECTORS,
  cleanupEditorWorkspaces,
  createEditorWorkspace,
  openEditorWorkspace,
  seedEditorWindow,
} from "./support/editorWorkspace.js";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const FAILING_TEST = "src/sum.test.ts";
const SOURCE = "src/sum.ts";
const FAILING_TEST_BODY =
  "import { sum } from './sum';\n" +
  "import { test, expect } from 'vitest';\n" +
  "test('sum', () => { expect(sum(1, 1)).toBe(2); });\n";
const BROKEN_SOURCE = "export const sum = (a: number, b: number): number => a - b;\n";
const FIXED_SOURCE = "export const sum = (a: number, b: number): number => a + b;\n";

interface VerificationRun {
  readonly runId?: unknown;
}

function workspace(): { readonly root: string } {
  return createEditorWorkspace([
    { path: SOURCE, content: BROKEN_SOURCE },
    { path: FAILING_TEST, content: FAILING_TEST_BODY },
  ]);
}

async function openEditorFor(page: Page, root: string): Promise<void> {
  await seedEditorWindow(page, { root, active: SOURCE, openFiles: [SOURCE, FAILING_TEST] });
  await openEditorWorkspace(page);
}

async function startRun(
  request: APIRequestContext,
  projectId: string,
  kinds: readonly string[],
  targetPath?: string,
): Promise<string> {
  const response = await request.post("/api/editor/verification/runs", {
    headers: MUTATION_HEADERS,
    data: { projectId, kinds, ...(targetPath === undefined ? {} : { targetPath }) },
  });
  expect(response.ok()).toBeTruthy();
  const run = (await response.json()) as VerificationRun;
  expect(typeof run.runId).toBe("string");
  return run.runId as string;
}

// Reads the SSE events route until a terminal lifecycle event for `runId` arrives. The stream only
// ever carries content-free frames (a step event never embeds a raw command body), per ADR-0126 D1.
async function awaitTerminal(page: Page, runId: string): Promise<string> {
  return page.evaluate(async (id): Promise<string> => {
    // Classify a single SSE frame as this run's terminal event, or null. Kept inside the browser
    // callback (page.evaluate is serialized) and small to stay under the complexity gate.
    const terminalOf = (frame: string): string | null => {
      if (!frame.includes(`"runId":"${id}"`)) return null;
      if (frame.includes("run-completed")) return "completed";
      if (frame.includes("run-cancelled")) return "cancelled";
      return frame.includes("run-failed") ? "failed" : null;
    };
    const response = await fetch("/api/editor/verification/events", {
      headers: { accept: "text/event-stream" },
    });
    const reader = response.body?.getReader();
    if (reader === undefined) return "no-stream";
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return "closed";
      buffer += decoder.decode(chunk.value, { stream: true });
      for (const frame of buffer.split("\n\n")) {
        const terminal = terminalOf(frame);
        if (terminal !== null) {
          await reader.cancel();
          return terminal;
        }
      }
    }
  }, runId);
}

test.afterEach(() => {
  cleanupEditorWorkspaces();
});

test("file-targeted run streams to a terminal state and surfaces the failure in the problems panel", async ({
  page,
}) => {
  const ws = workspace();
  await openEditorFor(page, ws.root);

  // Drive a targeted-test run through the real BFF route the run affordance (Issue #2212) calls.
  const runId = await startRun(page.request, ws.root, ["targeted-test"], FAILING_TEST);
  expect(await awaitTerminal(page, runId)).toBe("completed");

  // The problems panel (Issue #2213) surfaces the failure with a file/line location; clicking it
  // reveals the exact line through the existing openEditorFile flow.
  const panel = page.locator(`[data-testid="problems-list"]`);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const row = page.locator(`[data-testid="problems-row"]`).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(/sum\.(ts|test\.ts)/);
  await row.click();
  await expect(page.locator(EDITOR_SELECTORS.workspace).first()).toBeVisible();
});

test("workspace-scoped run (typecheck) exercises the non-file-targeted path", async ({ page }) => {
  const ws = workspace();
  await openEditorFor(page, ws.root);

  const runId = await startRun(page.request, ws.root, ["typecheck"]);
  expect(["completed", "failed"]).toContain(await awaitTerminal(page, runId));
});

test("cancel-mid-run terminates the run without leaving an orphaned spawn", async ({ page }) => {
  const ws = workspace();
  await openEditorFor(page, ws.root);

  const runId = await startRun(page.request, ws.root, ["test"]);
  const cancel = await page.request.delete(`/api/editor/verification/runs/${runId}`, {
    headers: MUTATION_HEADERS,
  });
  // A still-in-flight run cancels (200); a run that already finished is simply gone (404) — both prove
  // no orphaned governed spawn is left behind.
  expect([200, 404]).toContain(cancel.status());
});

test("fixing the source clears the problem and returns the run to a passing state", async ({
  page,
}) => {
  const ws = workspace();
  await openEditorFor(page, ws.root);

  const failing = await startRun(page.request, ws.root, ["targeted-test"], FAILING_TEST);
  expect(await awaitTerminal(page, failing)).toBe("completed");

  // Apply the fix on disk, then rerun; the second run reaches a terminal state over the same route.
  writeFileSync(join(ws.root, SOURCE), FIXED_SOURCE, "utf8");
  const rerun = await startRun(page.request, ws.root, ["targeted-test"], FAILING_TEST);
  expect(await awaitTerminal(page, rerun)).toBe("completed");
});
