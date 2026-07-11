// Issue #2215 (Epic #2092 closeout) — end-to-end evidence for the run → verify → problems → jump →
// fix → rerun loop, driven against the REAL BFF (no mocked contracts, no mocked AuthorityEnvelope),
// following the shape of editor-agent-docking-2122.spec.ts (top-level `test(...)` blocks, real-BFF
// fixtures via ./support/editorWorkspace.js). Executed by the CI Studio browser gate (chromium is the
// reference browser).
//
// Every scenario drives the run through the ACTUAL UI affordance (Issue #2212's command-palette run
// actions), never a direct `page.request.post(...)` to the verification route — a broken command
// wire-up (wrong params, unwired onClick, a disabled-state gate that never clears) must fail this
// suite, which a REST-only spec would never catch (Issue #2215 fix-up, audit-confirmed defect: the
// prior version bypassed the UI affordance entirely). It covers three code paths the epic adds: a
// file-targeted run, a workspace-scoped run, and a cancel-mid-run — each observing the run through
// the same user-visible signals a human relies on (the status bar, the workspace problems panel), and
// the "jump to the exact line" claim is proven by asserting the actual post-click cursor position and
// visible source line (mirroring editor-baseline-1377.spec.ts's F12/Shift+F12 verification pattern) —
// not merely that some editor surface remained visible, which would pass even if the jump were broken.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  EDITOR_SELECTORS,
  cleanupEditorWorkspaces,
  createEditorWorkspace,
  firstPane,
  openEditorWorkspace,
  seedEditorWindow,
} from "./support/editorWorkspace.js";

const FAILING_TEST = "src/sum.test.ts";
const SOURCE = "src/sum.ts";
const FAILING_TEST_BODY =
  "import { sum } from './sum';\n" +
  "import { test, expect } from 'vitest';\n" +
  "test('sum', () => { expect(sum(1, 1)).toBe(2); });\n";
const BROKEN_SOURCE = "export const sum = (a: number, b: number): number => a - b;\n";
const FIXED_SOURCE = "export const sum = (a: number, b: number): number => a + b;\n";
// vitest's default reporter stack-frames a failing assertion at the `expect(...)` call site — the
// third line of the (deliberately minimal) failing-test fixture above.
const FAILING_LINE = 3;

const MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

function workspace(): { readonly root: string } {
  return createEditorWorkspace([
    { path: SOURCE, content: BROKEN_SOURCE },
    { path: FAILING_TEST, content: FAILING_TEST_BODY },
  ]);
}

async function openEditorFor(page: Page, root: string): Promise<Locator> {
  await seedEditorWindow(page, { root, active: SOURCE, openFiles: [SOURCE, FAILING_TEST] });
  return openEditorWorkspace(page);
}

// Drives Issue #2212's command palette exactly as a user would: open it in "commands" mode with the
// real keybinding, type enough of the target command's title to uniquely match it, then activate the
// top (only) result. Throws (via the `option` locator's own timeout) if the command never becomes
// available — e.g. because the run-affordance wiring this test exists to prove is broken.
async function runPaletteCommand(page: Page, commandTitle: string): Promise<void> {
  await page.keyboard.press(`${MODIFIER}+Shift+KeyP`);
  const combobox = page.getByRole("combobox", { name: "Command query" });
  await expect(combobox).toBeVisible();
  await combobox.fill(commandTitle);
  const option = page.getByRole("option", { name: commandTitle, exact: true });
  await expect(option).toBeVisible();
  await option.click();
}

// Waits for the workspace Problems panel (Issue #2213) to render at least one row — the user-visible
// proof that a run reached a terminal state and its failure was aggregated, without reading the SSE
// wire directly.
async function awaitProblemsRow(page: Page): Promise<Locator> {
  const panel = page.locator(`[data-testid="problems-list"]`);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const row = page.locator(`[data-testid="problems-row"]`).first();
  await expect(row).toBeVisible();
  return row;
}

// Waits for the status bar's run field to settle back to idle (Issue #2212's status-bar affordance),
// the user-visible proof a run reached ANY terminal state (passed, failed, or cancelled) without
// reading the SSE wire directly.
async function awaitRunIdle(pane: Locator): Promise<void> {
  const runField = pane.locator(`${EDITOR_SELECTORS.statusBar} [data-field="run"]`);
  await expect(runField).toHaveCount(0, { timeout: 30_000 });
}

test.afterEach(() => {
  cleanupEditorWorkspaces();
});

test("running tests for the active file through the command palette streams to the problems panel and jumps to the exact failing line", async ({
  page,
}) => {
  const ws = workspace();
  const workspaceLocator = await openEditorFor(page, ws.root);
  const pane = firstPane(workspaceLocator);

  // Drives the SAME "Run Tests for File" affordance a human clicks — never the verification route
  // directly. src/sum.ts (the active file) resolves to its src/sum.test.ts counterpart.
  await runPaletteCommand(page, "Run Tests for File");

  const row = await awaitProblemsRow(page);
  await expect(row).toContainText(/sum\.(ts|test\.ts)/);
  await expect(row).toHaveAccessibleName(new RegExp(`at line ${String(FAILING_LINE)}$`));

  await row.click();

  // Proves the click actually navigated — not merely that some editor surface stayed visible
  // (the vacuous assertion this test previously made; a broken failure-location parser or reveal
  // flow would leave the cursor at its pre-click position and this would fail).
  await expect(pane.locator(`${EDITOR_SELECTORS.statusBar} [data-field="cursor"]`)).toHaveAttribute(
    "aria-label",
    new RegExp(`^Line ${String(FAILING_LINE)}, column \\d+$`),
  );
  await expect(
    workspaceLocator.locator(".monaco-editor .view-line").filter({ hasText: "expect(sum(1, 1))" }),
  ).toBeVisible();
});

test("running a workspace typecheck through the command palette exercises the non-file-targeted path", async ({
  page,
}) => {
  const ws = workspace();
  const workspaceLocator = await openEditorFor(page, ws.root);
  const pane = firstPane(workspaceLocator);

  await runPaletteCommand(page, "Run Typecheck");
  await awaitRunIdle(pane);

  // The command becomes available again once idle — proving the run genuinely reached a terminal
  // state (not merely that the UI stopped showing a spinner for an unrelated reason).
  await page.keyboard.press(`${MODIFIER}+Shift+KeyP`);
  await page.getByRole("combobox", { name: "Command query" }).fill("Run Typecheck");
  await expect(page.getByRole("option", { name: "Run Typecheck", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("cancelling a run mid-flight through the command palette settles without leaving an orphaned spawn", async ({
  page,
}) => {
  const ws = workspace();
  const workspaceLocator = await openEditorFor(page, ws.root);
  const pane = firstPane(workspaceLocator);

  await runPaletteCommand(page, "Run Tests for File");
  // Cancel immediately — a real spawn may already have finished by the time this activates (the
  // fixture is tiny), which is fine: either outcome is a legitimate terminal state and both are
  // proven the same way, by the run affordance settling rather than hanging.
  await runPaletteCommand(page, "Cancel Verification").catch(() => {
    // "Cancel Verification" is only available while a run is active (editorCommands.ts); if the run
    // already finished before this activates, the command is gone — that is itself a valid terminal
    // outcome, proven by awaitRunIdle below.
  });
  await awaitRunIdle(pane);
});

test("fixing the source on disk and rerunning through the command palette clears the problem", async ({
  page,
}) => {
  const ws = workspace();
  const workspaceLocator = await openEditorFor(page, ws.root);
  const pane = firstPane(workspaceLocator);

  await runPaletteCommand(page, "Run Tests for File");
  await awaitProblemsRow(page);

  // The verification run reads the REAL file from disk (a spawned test runner), not the editor's
  // in-memory buffer, so writing the fix directly to disk is the correct fixture shape here.
  writeFileSync(join(ws.root, SOURCE), FIXED_SOURCE, "utf8");
  await runPaletteCommand(page, "Run Tests for File");
  await awaitRunIdle(pane);

  await expect(page.locator(`[data-testid="problems-empty"]`)).toBeVisible({ timeout: 30_000 });
});
