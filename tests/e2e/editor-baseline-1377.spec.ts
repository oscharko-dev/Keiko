/**
 * Issue #1377 — editor browser regression / accessibility baseline gate.
 *
 * The reusable QUALITY BACKBONE for the editor roadmap (Epic #1491). This consolidated matrix
 * drives the REAL packaged app (`node dist/cli/index.js ui`, webServer in
 * tests/e2e/config/playwright.issue-1377-editor-baseline.config.ts) through every load-bearing editor behavior —
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const HELPER_FILE = "src/helper.ts";
const UTIL_FILE = "src/utils.ts";
const README_FILE = "README.md";
const TSCONFIG_FILE = "tsconfig.json";
const OPEN_FILES = [APP_FILE, UTIL_FILE, README_FILE] as const;
const MISSING_FILE = "src/does-not-exist.ts";

const WORKSPACE_FILES = [
  {
    path: TSCONFIG_FILE,
    content: JSON.stringify({
      compilerOptions: {
        strict: true,
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
      },
      include: ["src/**/*"],
    }),
  },
  {
    path: APP_FILE,
    content: `import { callTarget, sharedValue } from "./helper.js";
import { utilityLabel } from "./utils.js";

export const appValue = sharedValue;

export function readSharedValue(): number {
  return sharedValue + 1;
}

export function needsQuickFix(): number {
  return missingHelperValue;
}

export const signatureProbe = callTarget;

export class AppController {
  render(): string {
    return utilityLabel("ok");
  }
}
`,
  },
  {
    path: HELPER_FILE,
    // Cross-file navigation fixture: `sharedValue` is declared below the fold (line 5, not line 1) so
    // go-to-definition (F12) must actually reveal/scroll to the real target line rather than merely
    // switching tabs onto an already-visible line 1 (audit defect #3).
    content: `// Cross-file navigation fixture module for the editor baseline gate (#1377).
// sharedValue is declared below the fold on purpose; see scenarioGoToDefinition.
export const leadingHelperConstant = 0;

export const sharedValue = 41;
export const missingHelperValue = 1;

export function callTarget(value: string): string {
  return value;
}
`,
  },
  {
    path: UTIL_FILE,
    content: `export function utilityLabel(value: string): string {
  return value;
}
`,
  },
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
  options: {
    readonly active?: string | null;
    readonly openFiles?: readonly string[];
  } = {},
): Promise<Locator> {
  const { root } = createEditorWorkspace(WORKSPACE_FILES);
  await seedEditorWindow(page, {
    root,
    openFiles: options.openFiles ?? OPEN_FILES,
    active: options.active === undefined ? APP_FILE : options.active,
    resetWorkspace: true,
  });
  await page.goto("/");
  return openEditorWorkspace(page);
}

async function openNavigationEditor(
  page: Page,
  options: { readonly openFiles?: readonly string[]; readonly active?: string } = {},
): Promise<{ readonly root: string; readonly workspace: Locator }> {
  const { root } = createEditorWorkspace(WORKSPACE_FILES);
  await seedEditorWindow(page, {
    root,
    openFiles: options.openFiles ?? [APP_FILE],
    active: options.active ?? APP_FILE,
    resetWorkspace: true,
  });
  await page.goto("/");
  return { root, workspace: await openEditorWorkspace(page) };
}

async function lineText(line: Locator): Promise<string> {
  return line.innerText();
}

interface MonacoClickPoint {
  readonly x: number;
  readonly y: number;
}

function occurrenceOffset(text: string, needle: string, occurrence: number): number {
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = text.indexOf(needle, from);
    if (found < 0) throw new Error(`needle not found in Monaco line: ${needle}`);
    if (index === occurrence) return found;
    from = found + needle.length;
  }
  return -1;
}

async function monacoClickPoint(line: Locator, textOffset: number): Promise<MonacoClickPoint> {
  return line.evaluate((element, offset) => {
    const host = element.getBoundingClientRect();
    const text = element.textContent;
    const bounded = Math.max(0, Math.min(offset, text.length));
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = bounded;
    let node = walker.nextNode();
    while (node !== null) {
      const value = node.textContent ?? "";
      if (remaining <= value.length) {
        const range = document.createRange();
        const local = Math.min(remaining, Math.max(0, value.length - 1));
        range.setStart(node, local);
        range.setEnd(node, Math.min(value.length, local + 1));
        const rect = range.getBoundingClientRect();
        const atEnd = remaining >= value.length;
        return {
          x: rect.left - host.left + (atEnd ? rect.width + 1 : rect.width / 2),
          y: rect.top - host.top + rect.height / 2,
        };
      }
      remaining -= value.length;
      node = walker.nextNode();
    }
    return { x: 2, y: host.height / 2 };
  }, textOffset);
}

async function placeCursorOnSymbol(
  workspace: Locator,
  lineNeedle: string,
  symbol: string,
  occurrence = 0,
): Promise<void> {
  const line = workspace
    .locator(".monaco-editor .view-lines .view-line")
    .filter({ hasText: lineNeedle })
    .first();
  await expect(line).toBeVisible();
  const text = await lineText(line);
  const offset = occurrenceOffset(text, symbol, occurrence);
  await line.click({
    position: await monacoClickPoint(line, offset + Math.floor(symbol.length / 2)),
  });
}

async function moveCursorFromLineStart(page: Page, line: Locator, offset: number): Promise<void> {
  const startPoint = await line.evaluate((element) => ({
    x: 2,
    y: element.getBoundingClientRect().height / 2,
  }));
  await line.click({ position: startPoint });
  await page.keyboard.press("Home");
  for (let index = 0; index < offset; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
}

async function placeCursorOnSymbolWithKeyboard(
  page: Page,
  pane: Locator,
  lineNeedle: string,
  symbol: string,
  lineNumber: number,
  options: { readonly exactColumn?: boolean } = {},
): Promise<void> {
  const line = pane
    .locator(".monaco-editor .view-lines .view-line")
    .filter({ hasText: lineNeedle })
    .first();
  await expect(line).toBeVisible();
  const offset = occurrenceOffset(await lineText(line), symbol, 0) + Math.floor(symbol.length / 2);
  await moveCursorFromLineStart(page, line, offset);
  const expectedLabel =
    options.exactColumn === false
      ? new RegExp(`^Line ${String(lineNumber)}, column \\d+$`, "u")
      : `Line ${String(lineNumber)}, column ${String(offset + 1)}`;
  await expect(pane.locator(`${EDITOR_SELECTORS.statusBar} [data-field="cursor"]`)).toHaveAttribute(
    "aria-label",
    expectedLabel,
  );
}

async function placeCursorAfterSymbolWithKeyboard(
  page: Page,
  pane: Locator,
  lineNeedle: string,
  symbol: string,
  lineNumber: number,
): Promise<void> {
  const line = pane
    .locator(".monaco-editor .view-lines .view-line")
    .filter({ hasText: lineNeedle })
    .first();
  await expect(line).toBeVisible();
  const offset = occurrenceOffset(await lineText(line), symbol, 0) + symbol.length;
  await moveCursorFromLineStart(page, line, offset);
  await expect(pane.locator(`${EDITOR_SELECTORS.statusBar} [data-field="cursor"]`)).toHaveAttribute(
    "aria-label",
    `Line ${String(lineNumber)}, column ${String(offset + 1)}`,
  );
}

async function triggerRename(page: Page, pane: Locator, nextName: string): Promise<void> {
  page.once("dialog", (dialog) => {
    void dialog.accept(nextName);
  });
  await placeCursorOnSymbolWithKeyboard(
    page,
    pane,
    "export const sharedValue = 41;",
    "sharedValue",
    5,
  );
  const prepare = languageResponse(page, "renamePrepare");
  const apply = languageResponse(page, "renameApply");
  await page.keyboard.press("F2");
  await prepare;
  await apply;
}

function readWorkspaceFile(root: string, file: string): string {
  return readFileSync(join(root, file), "utf8");
}

function languageResponse(page: Page, operation: string): Promise<unknown> {
  return page
    .waitForResponse((response) => {
      if (!response.url().includes("/api/editor/language")) return false;
      const raw = response.request().postData();
      if (raw === null) return false;
      try {
        return (JSON.parse(raw) as { readonly operation?: unknown }).operation === operation;
      } catch {
        return false;
      }
    })
    .then((response) => response.json() as Promise<unknown>);
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

  await tabHit(firstPane(workspace), UTIL_FILE).click();
  await splitActivePane(workspace, UTIL_FILE, "down");
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
  await seedEditorWindow(page, { windowId: "issue-1377-empty", resetWorkspace: true });
  await page.goto("/");

  const projectPrompt = page.getByRole("note").filter({ hasText: "Open a project" });
  await expect(projectPrompt).toBeVisible();
  await expect(projectPrompt).toContainText(/choose a project folder to start editing/i);
  await expect(page.locator(EDITOR_SELECTORS.monaco)).toHaveCount(0);
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
    resetWorkspace: true,
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
  const appPane = workspace.locator(EDITOR_SELECTORS.pane).nth(1);
  await expect(tabHit(appPane, APP_FILE)).toHaveAttribute("aria-selected", "true");
  await typeIntoActiveEditor(page, appPane, "export const a11y = true;\n");
  await closeButton(appPane, APP_FILE).click();
  const dialog = workspace.locator(EDITOR_SELECTORS.dirtyDialog);
  await expect(dialog).toBeVisible();
  // The modal labels itself via its heading, takes focus on open, and Escape dismisses it.
  await expect(dialog).toHaveAttribute("aria-labelledby", EDITOR_SELECTORS.dirtyDialogTitleId);
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
}

async function scenarioOutlineBreadcrumbNavigation(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  const workspace = await openSeededEditor(page);
  const outline = workspace.getByRole("region", { name: "Workspace outline" });
  const breadcrumbs = workspace.getByRole("navigation", { name: "Editor breadcrumbs" });

  await expect(outline).toBeVisible();
  await expect(outline.getByRole("treeitem", { name: /AppController class/i })).toBeVisible({
    timeout: 15_000,
  });
  await outline.getByRole("treeitem", { name: /render method/i }).click();
  await expect(breadcrumbs.getByRole("button", { name: "render" })).toBeVisible();
  await breadcrumbs.getByRole("button", { name: "render" }).click();
  await expect(
    workspace.locator(".monaco-editor .view-line").filter({ hasText: "render()" }),
  ).toBeVisible();
  await attachShot(page, testInfo, "outline-breadcrumb-navigation.png");
  expect(errors).toEqual([]);
}

async function scenarioGoToDefinition(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  const { workspace } = await openNavigationEditor(page);
  const pane = firstPane(workspace);

  await placeCursorOnSymbolWithKeyboard(page, pane, "return sharedValue + 1;", "sharedValue", 7, {
    exactColumn: false,
  });
  const response = languageResponse(page, "definition");
  await page.keyboard.press("F12");
  await response;

  await expect(tabHit(pane, HELPER_FILE)).toHaveAttribute("aria-selected", "true");
  // sharedValue is declared on line 5 of the (deliberately multi-line) helper fixture, below the
  // fold. Asserting the status-bar cursor position — not just tab selection and text visibility,
  // which would pass even if F12 merely switched tabs without navigating — proves F12 actually
  // revealed and moved the cursor to the real cross-file definition line (audit defect #3).
  await expect(pane.locator(`${EDITOR_SELECTORS.statusBar} [data-field="cursor"]`)).toHaveAttribute(
    "aria-label",
    /^Line 5, column \d+$/u,
  );
  await expect(
    workspace.locator(".monaco-editor .view-line").filter({ hasText: "export const sharedValue" }),
  ).toBeVisible();
  await attachShot(page, testInfo, "definition-cross-file.png");
  expect(errors).toEqual([]);
}

async function scenarioFindReferences(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  const { workspace } = await openNavigationEditor(page, {
    active: APP_FILE,
    openFiles: [APP_FILE, HELPER_FILE],
  });

  await splitActivePane(workspace, APP_FILE, "right");
  const helperPane = firstPane(workspace);
  const appPane = workspace.locator(EDITOR_SELECTORS.pane).nth(1);
  await expect(workspace.locator(EDITOR_SELECTORS.pane)).toHaveCount(2);
  await expect(tabHit(helperPane, HELPER_FILE)).toHaveAttribute("aria-selected", "true");
  await expect(tabHit(appPane, APP_FILE)).toHaveAttribute("aria-selected", "true");
  await expect(
    appPane.locator(".monaco-editor .view-line").filter({ hasText: "readSharedValue" }),
  ).toBeVisible();
  await placeCursorOnSymbolWithKeyboard(
    page,
    helperPane,
    "export const sharedValue = 41;",
    "sharedValue",
    5,
  );
  const response = languageResponse(page, "references");
  await page.keyboard.press("Shift+F12");
  const body = (await response) as {
    readonly result?: { readonly locations?: readonly { readonly path: string }[] };
  };
  const paths = body.result?.locations?.map((location) => location.path) ?? [];

  expect(paths).toEqual(expect.arrayContaining([APP_FILE, HELPER_FILE]));
  await expect(
    page.locator(".references-zone-widget, .reference-zone-widget, .peekview-widget").first(),
  ).toBeVisible();
  await attachShot(page, testInfo, "references-cross-file.png");
  expect(errors).toEqual([]);
}

async function scenarioRenameAccept(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  const { root, workspace } = await openNavigationEditor(page, {
    active: HELPER_FILE,
    openFiles: [APP_FILE, HELPER_FILE],
  });
  const pane = firstPane(workspace);
  const beforeApp = readWorkspaceFile(root, APP_FILE);
  const beforeHelper = readWorkspaceFile(root, HELPER_FILE);

  await triggerRename(page, pane, "renamedSharedValue");
  await expect(page.getByTestId("keiko-diff-editor")).toBeVisible();
  await expect(page.getByTestId("keiko-diff-file")).toHaveCount(2);
  await page.getByTestId("keiko-diff-apply").click();

  await expect(page.getByTestId("keiko-diff-editor")).toHaveCount(0);
  await expect(tabFor(pane, APP_FILE)).toHaveAttribute("data-dirty", "true");
  await expect(tabFor(pane, HELPER_FILE)).toHaveAttribute("data-dirty", "true");
  expect(readWorkspaceFile(root, APP_FILE)).toBe(beforeApp);
  expect(readWorkspaceFile(root, HELPER_FILE)).toBe(beforeHelper);
  await attachShot(page, testInfo, "rename-accept-dirty-no-disk-write.png");
  expect(errors).toEqual([]);
}

async function scenarioRenameReject(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  const { root, workspace } = await openNavigationEditor(page, {
    active: HELPER_FILE,
    openFiles: [APP_FILE, HELPER_FILE],
  });
  const pane = firstPane(workspace);
  const beforeApp = readWorkspaceFile(root, APP_FILE);
  const beforeHelper = readWorkspaceFile(root, HELPER_FILE);

  await triggerRename(page, pane, "rejectedSharedValue");
  await expect(page.getByTestId("keiko-diff-editor")).toBeVisible();
  await page.getByTestId("keiko-diff-reject").click();

  await expect(page.getByTestId("keiko-diff-editor")).toHaveCount(0);
  await expect(tabFor(pane, APP_FILE)).toHaveAttribute("data-dirty", "false");
  await expect(tabFor(pane, HELPER_FILE)).toHaveAttribute("data-dirty", "false");
  expect(readWorkspaceFile(root, APP_FILE)).toBe(beforeApp);
  expect(readWorkspaceFile(root, HELPER_FILE)).toBe(beforeHelper);
  await attachShot(page, testInfo, "rename-reject-no-buffer-mutation.png");
  expect(errors).toEqual([]);
}

async function scenarioQuickFix(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  const { workspace } = await openNavigationEditor(page);
  await expect(workspace.getByLabel(/error diagnostic .*missingHelperValue/iu)).toBeVisible();

  const response = languageResponse(page, "codeActions");
  await placeCursorOnSymbol(workspace, "return missingHelperValue;", "missingHelperValue");
  await page.keyboard.press("Control+Period");
  const body = (await response) as {
    readonly result?: { readonly actions?: readonly { readonly title: string }[] };
  };
  expect(body.result?.actions?.length ?? 0).toBeGreaterThan(0);
  const action = page.locator(".action-widget .monaco-list-row").filter({
    hasText: /update import from "\.\/helper\.js"/iu,
  });
  await expect(action.first()).toBeVisible();
  await page.keyboard.press("Control+Period");

  await expect(workspace.getByLabel(/error diagnostic .*missingHelperValue/iu)).toHaveCount(0);
  await attachShot(page, testInfo, "quick-fix-resolved.png");
  expect(errors).toEqual([]);
}

async function scenarioSignatureHelp(page: Page, testInfo: TestInfo): Promise<void> {
  const errors = collectPageErrors(page);
  const { workspace } = await openNavigationEditor(page);
  const response = languageResponse(page, "signatureHelp");

  const pane = firstPane(workspace);
  await placeCursorAfterSymbolWithKeyboard(
    page,
    pane,
    "signatureProbe = callTarget;",
    "callTarget",
    14,
  );
  await page.keyboard.insertText("(");
  await page.keyboard.press("Control+Shift+Space");
  await response;

  const hints = page.locator(".parameter-hints-widget").first();
  await expect(hints).toBeVisible();
  await expect(hints).toContainText("callTarget");
  await attachShot(page, testInfo, "signature-help.png");
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
  test("k. navigates symbols through the outline and breadcrumbs", ({ page }, testInfo) =>
    scenarioOutlineBreadcrumbNavigation(page, testInfo));
  test("l. jumps from a symbol reference to a cross-file definition with F12", ({
    page,
  }, testInfo) => scenarioGoToDefinition(page, testInfo));
  test("m. lists cross-file references with Shift+F12", ({ page }, testInfo) =>
    scenarioFindReferences(page, testInfo));
  test("n. opens rename review and accepts without writing to disk", ({ page }, testInfo) =>
    scenarioRenameAccept(page, testInfo));
  test("o. rejects rename review without mutating buffers", ({ page }, testInfo) =>
    scenarioRenameReject(page, testInfo));
  test("p. applies a quick fix and resolves the diagnostic", ({ page }, testInfo) =>
    scenarioQuickFix(page, testInfo));
  test("q. shows signature help while typing a call", ({ page }, testInfo) =>
    scenarioSignatureHelp(page, testInfo));
});
