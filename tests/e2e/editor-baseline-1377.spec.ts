/**
 * Issue #1377 — editor browser regression / accessibility baseline gate.
 *
 * The reusable QUALITY BACKBONE for the editor roadmap (Epic #1491). This consolidated matrix
 * drives the REAL packaged app (`node dist/cli/index.js ui`, webServer in
 * playwright.issue-1377-editor-baseline.config.ts) through every load-bearing editor behavior —
 * tree-open, tabs, persistence, split/resize, dirty buffers, the dirty-close guard, hot-exit
 * recovery, the empty state, and the load-failure state — asserting only DETERMINISTIC signals
 * (roles, ARIA attributes, persisted state, IndexedDB keys). There are no arbitrary sleeps (AC3):
 * every wait is a web-first assertion or an `expect.poll`.
 *
 * Functional regressions only. Performance and bundle budgets are owned by the dedicated
 * editor-performance.spec.ts harness and the check:editor-bundle-size CI gate; see
 * docs/keiko-editor/1377-editor-browser-regression-gate.md.
 *
 * Each scenario lives in its own top-level function so the describe block stays a thin registration
 * list (and each function stays small and independently readable). The describe title carries the
 * stable `@editor-baseline` tag so the whole file can be selected or excluded as one unit.
 */
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  EDITOR_SELECTORS,
  activeTabName,
  cleanupEditorWorkspaces,
  collectPageErrors,
  createEditorWorkspace,
  firstPane,
  openEditorWorkspace,
  openTreeFile,
  paneCount,
  persistedFirstPaneTabOrder,
  readHotExitSnapshotKeys,
  reorderActiveTab,
  seedEditorWindow,
  splitActivePane,
  tabLabels,
  typeIntoActiveEditor,
} from "./support/editorWorkspace.js";

const APP_FILE = "src/App.tsx";
const UTIL_FILE = "src/utils.ts";
const README_FILE = "README.md";
const OPEN_FILES = [APP_FILE, UTIL_FILE, README_FILE] as const;
const MISSING_FILE = "src/does-not-exist.ts";

const WORKSPACE_FILES = [
  { path: APP_FILE, content: "export const App = () => null;\n" },
  { path: UTIL_FILE, content: "export const noop = () => undefined;\n" },
  { path: README_FILE, content: "# Fixture\n" },
] as const;

function tabHit(pane: Locator, file: string): Locator {
  return pane.locator(`${EDITOR_SELECTORS.tabHit}[data-tip="${file}"]`);
}

function tabFor(pane: Locator, file: string): Locator {
  // The dirty/active state lives on the outer `.ed-tab` span that wraps the file's `.ed-tab-hit`.
  return pane.locator(
    `${EDITOR_SELECTORS.tab}:has(${EDITOR_SELECTORS.tabHit}[data-tip="${file}"])`,
  );
}

function closeButton(pane: Locator, file: string): Locator {
  return pane.locator(`${EDITOR_SELECTORS.tabClose}[aria-label="Close ${file}"]`);
}

async function attachShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

async function openSeededEditor(
  page: Page,
  options: { readonly active?: string | null } = {},
): Promise<Locator> {
  const { root } = createEditorWorkspace(WORKSPACE_FILES);
  await seedEditorWindow(page, {
    root,
    openFiles: OPEN_FILES,
    active: options.active === undefined ? APP_FILE : options.active,
  });
  await page.goto("/");
  return openEditorWorkspace(page);
}

async function scenarioTreeOpen(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  const workspace = await openSeededEditor(page, { active: APP_FILE });
  const pane = firstPane(workspace);

  await openTreeFile(workspace, README_FILE);

  await expect(tabHit(pane, README_FILE)).toHaveAttribute("aria-selected", "true");
  expect(await activeTabName(pane)).toBe(README_FILE);
  await expect(pane.locator(EDITOR_SELECTORS.monaco)).toBeVisible();
  await attachShot(page, testInfo, "tree-open.png");
  expect(errors).toEqual([]);
}

async function scenarioTabSwitchAndClose(page: Page): Promise<void> {
  const errors = collectPageErrors(page);
  const workspace = await openSeededEditor(page);
  const pane = firstPane(workspace);
  expect(await tabLabels(pane)).toEqual([...OPEN_FILES]);

  const appTab = tabHit(pane, APP_FILE);
  const utilTab = tabHit(pane, UTIL_FILE);
  await expect(appTab).toHaveAttribute("aria-selected", "true");

  await utilTab.click();
  await expect(utilTab).toHaveAttribute("aria-selected", "true");
  await expect(appTab).toHaveAttribute("aria-selected", "false");

  await closeButton(pane, README_FILE).click();
  await expect(tabHit(pane, README_FILE)).toHaveCount(0);
  expect(await tabLabels(pane)).toEqual([APP_FILE, UTIL_FILE]);
  expect(errors).toEqual([]);
}

async function scenarioTabPersistence(page: Page): Promise<void> {
  const errors = collectPageErrors(page);
  const workspace = await openSeededEditor(page);
  const pane = firstPane(workspace);
  expect(await tabLabels(pane)).toEqual([...OPEN_FILES]);

  await reorderActiveTab(pane, APP_FILE, "right");
  await reorderActiveTab(pane, APP_FILE, "right");
  const reordered = [UTIL_FILE, README_FILE, APP_FILE];
  expect(await tabLabels(pane)).toEqual(reordered);

  await expect.poll(() => persistedFirstPaneTabOrder(page)).toEqual(reordered);
  await page.reload();
  const restored = await openEditorWorkspace(page);
  expect(await tabLabels(firstPane(restored))).toEqual(reordered);
  expect(errors).toEqual([]);
}

async function scenarioSplitAndResize(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  const workspace = await openSeededEditor(page);
  expect(await paneCount(workspace)).toBe(1);

  await splitActivePane(workspace, APP_FILE, "right");
  await expect(workspace.locator(EDITOR_SELECTORS.pane)).toHaveCount(2);

  const separator = workspace.getByRole("separator", { name: EDITOR_SELECTORS.splitSeparatorName });
  await expect(separator).toHaveAttribute("aria-orientation", "vertical");
  await expect(separator).toHaveAttribute("aria-valuenow", "50");

  await separator.focus();
  await separator.press("ArrowRight");
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "54");
  await attachShot(page, testInfo, "split.png");

  await splitActivePane(workspace, APP_FILE, "down");
  await expect(workspace.locator(EDITOR_SELECTORS.pane)).toHaveCount(3);
  await expect(
    workspace.getByRole("separator", { name: EDITOR_SELECTORS.splitSeparatorName }),
  ).toHaveCount(2);
  expect(errors).toEqual([]);
}

async function scenarioDirtyBuffer(page: Page): Promise<void> {
  const errors = collectPageErrors(page);
  const workspace = await openSeededEditor(page);
  const pane = firstPane(workspace);

  await typeIntoActiveEditor(page, pane, "export const dirty = true;\n");

  await expect(tabFor(pane, APP_FILE)).toHaveAttribute("data-dirty", "true");
  await expect(
    pane.locator(`${EDITOR_SELECTORS.statusBar} ${EDITOR_SELECTORS.saveField}`),
  ).toHaveText("Unsaved");
  expect(errors).toEqual([]);
}

async function scenarioDirtyCloseGuard(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  const workspace = await openSeededEditor(page);
  const pane = firstPane(workspace);

  await typeIntoActiveEditor(page, pane, "export const stillDirty = 1;\n");
  await expect(tabFor(pane, APP_FILE)).toHaveAttribute("data-dirty", "true");

  await closeButton(pane, APP_FILE).click();
  const dialog = workspace.locator(EDITOR_SELECTORS.dirtyDialog);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(`#${EDITOR_SELECTORS.dirtyDialogTitleId}`)).toHaveText(
    "Unsaved editor changes",
  );
  await attachShot(page, testInfo, "dirty-dialog.png");

  // Cancel keeps the tab open and the buffer dirty — no write to disk.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(tabHit(pane, APP_FILE)).toBeVisible();
  await expect(tabFor(pane, APP_FILE)).toHaveAttribute("data-dirty", "true");

  // Re-open the guard and dismiss it with Escape (the dialog's documented affordance).
  await closeButton(pane, APP_FILE).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(tabFor(pane, APP_FILE)).toHaveAttribute("data-dirty", "true");
  expect(errors).toEqual([]);
}

async function scenarioRecovery(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  const workspace = await openSeededEditor(page);
  const pane = firstPane(workspace);

  await typeIntoActiveEditor(page, pane, "export const recoverMe = 42;\n");
  await expect(tabFor(pane, APP_FILE)).toHaveAttribute("data-dirty", "true");

  // The snapshot write is an async effect; poll the IndexedDB store until it lands.
  await expect.poll(() => readHotExitSnapshotKeys(page)).not.toEqual([]);

  await page.reload();
  const reopened = await openEditorWorkspace(page);
  await expect(reopened.locator(EDITOR_SELECTORS.recovery)).toBeVisible();
  await attachShot(page, testInfo, "recovery.png");
  expect(errors).toEqual([]);
}

async function scenarioEmptyState(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  await seedEditorWindow(page, { windowId: "issue-1377-empty" });
  await page.goto("/");
  const host = page.locator(EDITOR_SELECTORS.host).first();

  const empty = host.locator(EDITOR_SELECTORS.empty);
  await expect(empty).toBeVisible();
  await expect(empty).toContainText(/choose a file from the project tree/i);
  await expect(host.locator(EDITOR_SELECTORS.monaco)).toHaveCount(0);
  await attachShot(page, testInfo, "empty.png");
  expect(errors).toEqual([]);
}

async function scenarioLoadFailure(page: Page, testInfo: TestInfo): Promise<void> {
  const { root } = createEditorWorkspace(WORKSPACE_FILES);
  await seedEditorWindow(page, {
    root,
    openFiles: [MISSING_FILE],
    active: MISSING_FILE,
    windowId: "issue-1377-error",
  });
  await page.goto("/");
  const workspace = await openEditorWorkspace(page);

  const alert = workspace.locator(`${EDITOR_SELECTORS.host} ${EDITOR_SELECTORS.loadError}`);
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(
    workspace.locator(`${EDITOR_SELECTORS.host} ${EDITOR_SELECTORS.monaco}`),
  ).toHaveCount(0);
  await attachShot(page, testInfo, "load-error.png");
}

async function scenarioAccessibility(page: Page): Promise<void> {
  const errors = collectPageErrors(page);
  const workspace = await openSeededEditor(page);
  const pane = firstPane(workspace);

  // Tablist/tab roles and accessible names are present and unique.
  await expect(workspace.locator(EDITOR_SELECTORS.tablist)).toHaveCount(1);
  await expect(pane.getByRole("tab", { name: APP_FILE })).toBeVisible();

  // Alt+ArrowRight reorders the active tab within the tablist via the keyboard; focus stays on a
  // tab so a keyboard user does not lose their place.
  const appTab = tabHit(pane, APP_FILE);
  await appTab.focus();
  await appTab.press("Alt+ArrowRight");
  const focusedTabTip = await page.evaluate(
    () => document.activeElement?.closest(".ed-tab-hit")?.getAttribute("data-tip") ?? null,
  );
  expect(focusedTabTip).not.toBeNull();

  // Tree keyboard navigation: a treeitem directory toggles aria-expanded.
  const srcRow = workspace.locator(`${EDITOR_SELECTORS.treeRow}[data-path="src"]`);
  await expect(srcRow).toHaveAttribute("role", "treeitem");
  await srcRow.focus();
  await srcRow.press("ArrowLeft");
  await expect(srcRow).toHaveAttribute("aria-expanded", "false");
  await srcRow.press("ArrowRight");
  await expect(srcRow).toHaveAttribute("aria-expanded", "true");

  // The split separator is a focusable role=separator with a live aria-valuenow.
  await splitActivePane(workspace, APP_FILE, "right");
  const separator = workspace.getByRole("separator", { name: EDITOR_SELECTORS.splitSeparatorName });
  await separator.focus();
  await expect(separator).toBeFocused();
  await expect(separator).toHaveAttribute("aria-valuenow", "50");

  // The dirty-close dialog contains focus and closes on Escape.
  await typeIntoActiveEditor(page, pane, "export const a11y = true;\n");
  await closeButton(pane, APP_FILE).click();
  const dialog = workspace.locator(EDITOR_SELECTORS.dirtyDialog);
  await expect(dialog).toBeVisible();
  // The modal labels itself via its heading, takes focus on open, and Escape dismisses it.
  await expect(dialog).toHaveAttribute("aria-labelledby", EDITOR_SELECTORS.dirtyDialogTitleId);
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
}

test.afterAll(() => {
  cleanupEditorWorkspaces();
});

test.describe("@editor-baseline editor browser regression and accessibility gate (#1377)", () => {
  test("a. opens a file from the project tree into an active editor", ({ page }, testInfo) =>
    scenarioTreeOpen(page, testInfo));
  test("b. switches between tabs and closes one deterministically", ({ page }) =>
    scenarioTabSwitchAndClose(page));
  test("c. persists keyboard tab reorder across a reload", ({ page }) =>
    scenarioTabPersistence(page));
  test("d. creates splits and resizes the separator deterministically", ({ page }, testInfo) =>
    scenarioSplitAndResize(page, testInfo));
  test("e. marks a typed buffer dirty in the tab and status bar", ({ page }) =>
    scenarioDirtyBuffer(page));
  test("f. blocks a dirty tab close behind the unsaved-changes dialog", ({ page }, testInfo) =>
    scenarioDirtyCloseGuard(page, testInfo));
  test("g. offers hot-exit recovery after a reload", ({ page }, testInfo) =>
    scenarioRecovery(page, testInfo));
  test("h. renders the empty state with no root or file", ({ page }, testInfo) =>
    scenarioEmptyState(page, testInfo));
  test("i. surfaces the load-failure state with a retry and no editor", ({ page }, testInfo) =>
    scenarioLoadFailure(page, testInfo));
  test("j. keeps tabs, panes, and the dialog keyboard-operable with stable roles", ({ page }) =>
    scenarioAccessibility(page));
});
