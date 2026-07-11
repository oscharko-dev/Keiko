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

import { readFileSync, symlinkSync } from "node:fs";
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
const PACKAGE_JSON = JSON.stringify(
  {
    name: "keiko-editor-verification-e2e",
    private: true,
    type: "module",
    scripts: {
      build: "node scripts/block-build.mjs",
      test: "vitest run",
      typecheck: "tsc --noEmit",
    },
    devDependencies: { typescript: "*", vitest: "*" },
  },
  null,
  2,
);
const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
      strict: true,
      target: "ES2022",
    },
    include: ["src/**/*.ts"],
  },
  null,
  2,
);
const BLOCKING_BUILD = "setInterval(() => undefined, 1_000);\n";
// vitest's default reporter stack-frames a failing assertion at the `expect(...)` call site — the
// third line of the (deliberately minimal) failing-test fixture above.
const FAILING_LINE = 3;

const MODIFIER = process.platform === "darwin" ? "Meta" : "Control";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };

function workspace(): { readonly root: string } {
  const fixture = createEditorWorkspace([
    { path: "package.json", content: `${PACKAGE_JSON}\n` },
    { path: "tsconfig.json", content: `${TSCONFIG}\n` },
    { path: "scripts/block-build.mjs", content: BLOCKING_BUILD },
    { path: SOURCE, content: BROKEN_SOURCE },
    { path: FAILING_TEST, content: FAILING_TEST_BODY },
  ]);
  // `npx vitest` resolves from the target workspace, not from Playwright's process PATH. Link the
  // repository's lockfile-pinned installation into the disposable fixture so the real sandboxed run
  // is deterministic and never attempts a registry download. The sandbox inherits the host
  // filesystem policy for verification and separately enforces network:none.
  symlinkSync(join(process.cwd(), "node_modules"), join(fixture.root, "node_modules"), "dir");
  return fixture;
}

async function openEditorFor(page: Page, root: string): Promise<Locator> {
  const project = await page.request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name: "Editor verification E2E" },
  });
  expect(project.ok(), await project.text()).toBe(true);
  await seedEditorWindow(page, { root, active: SOURCE, openFiles: [SOURCE, FAILING_TEST] });
  await page.goto("/");
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
  await combobox.fill(`>${commandTitle}`);
  const option = page.getByRole("option").filter({ hasText: commandTitle }).first();
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

async function openProblems(page: Page): Promise<void> {
  await runPaletteCommand(page, "Open Problems");
  // The filter exists in both empty and populated states, so it proves the project-bound panel
  // opened without presuming the result that each scenario asserts immediately afterwards.
  await expect(page.locator(`[data-testid="problems-filter-severity"]`)).toBeVisible();
}

async function trustWorkspaceScripts(page: Page): Promise<void> {
  const trustResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/editor/verification/trust"),
  );
  const catalogRefresh = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/api/editor/verification/catalog?projectId="),
  );
  await runPaletteCommand(page, "Trust Workspace Scripts");
  expect((await trustResponse).status()).toBe(200);
  expect((await catalogRefresh).status()).toBe(200);
}

async function awaitRunCompletion(pane: Locator): Promise<void> {
  const runField = pane.locator(`${EDITOR_SELECTORS.statusBar} [data-field="run"]`);
  // Terminal labels intentionally remain visible for four seconds so the result is perceivable.
  // Wait for one of the closed terminal states without requiring the transient "starting" label:
  // a healthy stream may advance to step-started before Playwright's first locator poll. The
  // terminal state still proves that the subscriber observed the complete run lifecycle.
  await expect(runField).toHaveText(/^Verification: (?:passed|failed|cancelled)$/u, {
    timeout: 30_000,
  });
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
  await awaitRunCompletion(pane);
  await openProblems(page);

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
    workspaceLocator.locator(`${EDITOR_SELECTORS.tabHit}[aria-selected="true"]`),
  ).toContainText(FAILING_TEST);
});

test("running a workspace typecheck through the command palette exercises the non-file-targeted path", async ({
  page,
}) => {
  const ws = workspace();
  const workspaceLocator = await openEditorFor(page, ws.root);
  const pane = firstPane(workspaceLocator);

  await trustWorkspaceScripts(page);
  await runPaletteCommand(page, "Run Typecheck");
  await awaitRunCompletion(pane);

  // The command becomes available again once idle — proving the run genuinely reached a terminal
  // state (not merely that the UI stopped showing a spinner for an unrelated reason).
  await page.keyboard.press(`${MODIFIER}+Shift+KeyP`);
  await page.getByRole("combobox", { name: "Command query" }).fill(">Run Typecheck");
  await expect(page.getByRole("option").filter({ hasText: "Run Typecheck" }).first()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("cancelling a run mid-flight through the command palette settles without leaving an orphaned spawn", async ({
  page,
}) => {
  const ws = workspace();
  const workspaceLocator = await openEditorFor(page, ws.root);
  const pane = firstPane(workspaceLocator);

  await trustWorkspaceScripts(page);
  const cancelledResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      /\/api\/editor\/verification\/runs\/[^/]+$/u.test(response.url()),
  );
  await runPaletteCommand(page, "Run Build");
  await expect(pane.locator(`${EDITOR_SELECTORS.statusBar} [data-field="run"]`)).toBeVisible();
  await runPaletteCommand(page, "Cancel Verification");
  expect((await cancelledResponse).status()).toBe(200);
  await expect(pane.locator(`${EDITOR_SELECTORS.statusBar} [data-field="run"]`)).toHaveText(
    "Verification: cancelled",
  );

  await page.keyboard.press(`${MODIFIER}+Shift+KeyP`);
  await page.getByRole("combobox", { name: "Command query" }).fill(">Run Build");
  await expect(page.getByRole("option").filter({ hasText: "Run Build" }).first()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("fixing and saving in Monaco before rerunning clears the problem", async ({ page }) => {
  const ws = workspace();
  const workspaceLocator = await openEditorFor(page, ws.root);
  const pane = firstPane(workspaceLocator);

  await runPaletteCommand(page, "Run Tests for File");
  await awaitRunCompletion(pane);
  await openProblems(page);
  await awaitProblemsRow(page);

  await page.getByRole("button", { name: "Close Problems window" }).click();
  await expect(page.locator(`[data-testid="problems-row"]`)).toHaveCount(0);

  const editorInput = pane.getByRole("textbox", { name: /^Editor:/u }).first();
  await editorInput.focus();
  // The fixture source is intentionally one line. Select that line through Monaco's keyboard
  // surface and replace it, preserving the existing trailing newline. This is a real editor edit;
  // the disk assertion below proves the Save affordance persisted it.
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.insertText(FIXED_SOURCE.trimEnd());
  await workspaceLocator.getByRole("button", { name: "Save", exact: true }).click();
  await expect(workspaceLocator.locator(EDITOR_SELECTORS.saveField)).toHaveText("Saved");
  await expect.poll(() => readFileSync(join(ws.root, SOURCE), "utf8")).toBe(FIXED_SOURCE);
  await runPaletteCommand(page, "Run Tests for File");
  await awaitRunCompletion(pane);

  await openProblems(page);
  await expect(page.locator(`[data-testid="problems-empty"]`)).toBeVisible({ timeout: 30_000 });
});
