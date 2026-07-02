/**
 * Issue #1377 — reusable editor browser-regression helper library.
 *
 * Consolidates the workspace-seeding, layout-driving, and evidence-collection logic that the
 * per-issue editor specs (#1295, #1375) each re-implemented, so future editor child issues can plug
 * a new scenario into the shared baseline matrix instead of copying boilerplate. The helpers
 * deliberately expose deterministic, accessibility-anchored affordances (roles, ARIA attributes,
 * keyboard fallbacks) and never any timing hack — every wait is web-first or an explicit poll.
 *
 * All selectors live in {@link EDITOR_SELECTORS}; they are the stable DOM contract verified against
 * EditorWidget.tsx / EditorRuntimeWidget.tsx / EditorStatusBar.tsx in keiko-ui and the
 * keiko-editor-hot-exit IndexedDB store in editorHotExitStore.ts.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The stable, accessibility-anchored DOM contract the editor renders (verified in source). */
export const EDITOR_SELECTORS = {
  workspace: ".editor-workspace",
  sidebar: "aside.ed-sidebar[aria-label='Editor files']",
  sidebarRestore: ".ed-sidebar-restore[aria-label='Show project tree']",
  treeRow: "button.tr-row",
  tablist: ".ed-tablist[role='tablist'][aria-label='Open documents']",
  // The outer tab element carries the `active`/`data-dirty` state; `role='tab'` and the
  // `data-tip`/`aria-selected` affordances live on the inner `.ed-tab-hit` button it wraps.
  tab: ".ed-tab",
  tabHit: ".ed-tab-hit",
  tabLabel: ".ed-tab-label",
  tabClose: ".ed-tab-close",
  pane: "section.ed-pane",
  splitSeparatorName: "Resize editor split",
  dirtyDialog: ".ed-dirty-dialog[role='dialog'][aria-modal='true']",
  dirtyDialogTitleId: "editor-dirty-close-title",
  recovery: ".ed-recovery[role='status']",
  empty: ".ed-empty[role='note']",
  host: ".ed-host[role='tabpanel']",
  monaco: ".monaco-editor",
  statusBar: "[data-testid='editor-status-bar']",
  saveField: "[data-field='save']",
  loadError: "[role='alert']",
} as const;

/** The IndexedDB database/store the hot-exit snapshots are persisted into (editorHotExitStore.ts). */
const HOT_EXIT_DB = "keiko-editor-hot-exit";
const HOT_EXIT_STORE = "snapshots";

const WORKSPACE_LS_KEY = "keiko.workspace.v4";

interface EditorWorkspaceFile {
  readonly path: string;
  readonly content: string;
}

interface SeedEditorWindowOptions {
  readonly root?: string;
  readonly openFiles?: readonly string[];
  readonly active?: string | null;
  readonly windowId?: string;
  readonly theme?: "dark" | "light";
}

const createdRoots: string[] = [];

/** mkdtemp a fresh project root, write every fixture file (creating parent dirs), and track it. */
export function createEditorWorkspace(files: readonly EditorWorkspaceFile[]): {
  readonly root: string;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-1377-editor-"));
  createdRoots.push(root);
  for (const file of files) {
    const absolute = join(root, file.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, "utf8");
  }
  return { root };
}

/** Remove every workspace created during the run. Call from `test.afterAll`. */
export function cleanupEditorWorkspaces(): void {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Seed the persisted editor window via `addInitScript` (runs on every navigation, including reload).
 * The workspace entry is written only when absent so a reload reads the layout the app persisted —
 * the precondition that lets persistence and recovery scenarios prove real round-trips rather than
 * re-seeding. Passing no `root` seeds an editor window with no file/root for the empty-state path.
 */
export async function seedEditorWindow(
  page: Page,
  opts: SeedEditorWindowOptions = {},
): Promise<void> {
  const cfg =
    opts.root === undefined
      ? {}
      : {
          root: opts.root,
          ...(opts.active === null || opts.active === undefined ? {} : { file: opts.active }),
          ...(opts.openFiles === undefined ? {} : { openFiles: [...opts.openFiles] }),
        };
  await page.addInitScript(
    ({ window: editorWindow, lsKey }) => {
      window.localStorage.setItem("keiko.theme", editorWindow.theme);
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      if (window.localStorage.getItem(lsKey) === null) {
        window.localStorage.setItem(lsKey, JSON.stringify([editorWindow.entry]));
      }
      window.localStorage.removeItem("keiko.conns.v1");
    },
    {
      lsKey: WORKSPACE_LS_KEY,
      window: {
        theme: opts.theme ?? "dark",
        entry: {
          id: opts.windowId ?? "issue-1377-editor",
          type: "editor",
          x: 24,
          y: 24,
          w: 1100,
          h: 760,
          z: 10,
          cfg,
          max: false,
        },
      },
    },
  );
}

/** Wait for the workspace and its tablist, then return the workspace locator. */
export async function openEditorWorkspace(page: Page): Promise<Locator> {
  const workspace = page.locator(EDITOR_SELECTORS.workspace).first();
  await expect(workspace.locator(EDITOR_SELECTORS.tablist).first()).toBeVisible();
  return workspace;
}

export function firstPane(workspace: Locator): Locator {
  return workspace.locator(EDITOR_SELECTORS.pane).first();
}

export function paneCount(workspace: Locator): Promise<number> {
  return workspace.locator(EDITOR_SELECTORS.pane).count();
}

/** The ordered tab labels of a pane (each label is the file's root-relative path). */
export async function tabLabels(pane: Locator): Promise<readonly string[]> {
  await expect(pane.locator(EDITOR_SELECTORS.tabLabel).first()).toBeVisible();
  return pane.locator(EDITOR_SELECTORS.tabLabel).allInnerTexts();
}

/** The accessible name (path) of the pane's selected tab, asserting exactly one is selected. */
export async function activeTabName(pane: Locator): Promise<string> {
  const selected = pane.locator(`${EDITOR_SELECTORS.tabHit}[aria-selected='true']`);
  await expect(selected).toHaveCount(1);
  return (await selected.locator(EDITOR_SELECTORS.tabLabel).innerText()).trim();
}

/** Click the toolbar "Split <file> right|down" button for the pane's active file. */
export async function splitActivePane(
  workspace: Locator,
  file: string,
  dir: "right" | "down",
): Promise<void> {
  await workspace
    .getByRole("button", { name: `Split ${file} ${dir}` })
    .first()
    .click();
}

/** Move the pane's active tab one slot left/right within its pane via the Alt+Arrow keyboard fallback. */
export async function reorderActiveTab(
  pane: Locator,
  file: string,
  dir: "left" | "right",
): Promise<void> {
  const key = dir === "left" ? "Alt+ArrowLeft" : "Alt+ArrowRight";
  await pane.locator(`${EDITOR_SELECTORS.tabHit}[data-tip="${file}"]`).press(key);
}

/** Move the pane's active tab into the adjacent pane via the Alt+Shift+ArrowRight keyboard fallback. */
export async function moveActiveTabToAdjacentPane(pane: Locator, file: string): Promise<void> {
  await pane
    .locator(`${EDITOR_SELECTORS.tabHit}[data-tip="${file}"]`)
    .press("Alt+Shift+ArrowRight");
}

/** Open a file from the project tree by clicking its row (the deterministic data-path affordance). */
export async function openTreeFile(workspace: Locator, relPath: string): Promise<void> {
  const row = workspace.locator(`${EDITOR_SELECTORS.treeRow}[data-path="${relPath}"]`);
  await expect(row).toBeVisible();
  await row.click();
}

interface PersistedEditorWindow {
  readonly cfg?: {
    readonly root?: string;
    readonly file?: string;
    readonly openFiles?: readonly string[];
    readonly layoutJson?: string;
  };
}

/** Read the persisted editor window entry from keiko.workspace.v4 (or null if absent). */
export async function readPersistedEditorWindow(page: Page): Promise<PersistedEditorWindow | null> {
  return page.evaluate((lsKey) => {
    const raw = window.localStorage.getItem(lsKey);
    if (raw === null) return null;
    const wins = JSON.parse(raw) as readonly ({ type?: string } & PersistedEditorWindow)[];
    return wins.find((win) => win.type === "editor") ?? null;
  }, WORKSPACE_LS_KEY);
}

/** Read the persisted first-pane tab order from the editor window's serialized layout (or null). */
export async function persistedFirstPaneTabOrder(page: Page): Promise<readonly string[] | null> {
  const win = await readPersistedEditorWindow(page);
  const layoutJson = win?.cfg?.layoutJson;
  if (layoutJson === undefined) return null;
  const layout = JSON.parse(layoutJson) as { panes?: Record<string, { tabOrder?: string[] }> };
  const firstPane = Object.values(layout.panes ?? {})[0];
  return firstPane?.tabOrder ?? null;
}

/** Read every key from the keiko-editor-hot-exit snapshot store (for deterministic polling). */
export async function readHotExitSnapshotKeys(page: Page): Promise<readonly string[]> {
  return page.evaluate(
    ({ dbName, storeName }): Promise<string[]> =>
      new Promise<string[]>((resolvePromise: (keys: string[]) => void): void => {
        if (typeof indexedDB === "undefined") {
          resolvePromise([]);
          return;
        }
        const open = indexedDB.open(dbName);
        open.onerror = (): void => {
          resolvePromise([]);
        };
        open.onsuccess = (): void => {
          const db = open.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.close();
            resolvePromise([]);
            return;
          }
          const tx = db.transaction(storeName, "readonly");
          const keysRequest = tx.objectStore(storeName).getAllKeys();
          keysRequest.onerror = (): void => {
            db.close();
            resolvePromise([]);
          };
          keysRequest.onsuccess = (): void => {
            db.close();
            // Hot-exit keys are v2 SHA-256 locator hashes; raw roots/paths never enter IndexedDB.
            const keys: string[] = keysRequest.result.map((entry: IDBValidKey) =>
              typeof entry === "string" ? entry : JSON.stringify(entry),
            );
            resolvePromise(keys);
          };
        };
      }),
    { dbName: HOT_EXIT_DB, storeName: HOT_EXIT_STORE },
  );
}

/**
 * Type into the focused Monaco editor of a pane to make its buffer dirty. Selects all then inserts,
 * so the resulting buffer deterministically differs from the on-disk fixture regardless of content.
 */
export async function typeIntoActiveEditor(page: Page, pane: Locator, text: string): Promise<void> {
  const editor = pane.locator(EDITOR_SELECTORS.monaco).first();
  await expect(editor).toBeVisible();
  await editor.click();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+KeyA`);
  await page.keyboard.insertText(text);
}

/** A benign Monaco cancellation that must not be treated as a leaked page error (ported from #1295). */
export function isBenignMonacoCancellation(message: string): boolean {
  if (message === "Canceled: Canceled" || message === "Canceled") return true;
  return /\b(monaco|inline[-\s]?completion|suggest|editor)\b/iu.test(message);
}

function isExpectedTaskWorkspaceProbeDenial(message: string): boolean {
  return message.includes("status of 403") && message.includes("/api/task-workspaces?root=");
}

/**
 * Start collecting page/console errors, filtering benign Monaco cancellations and Vite notices.
 * Returns a live array; assert it is empty at the end of the scenario.
 */
export function collectPageErrors(page: Page): readonly string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    if (isBenignMonacoCancellation(error.message)) return;
    errors.push(error.message.slice(0, 160));
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    const source = location.url.length > 0 ? ` @ ${location.url}` : "";
    const text = `${message.text()}${source}`.slice(0, 240);
    if (
      /^\[vite\]/iu.test(text) ||
      isBenignMonacoCancellation(text) ||
      isExpectedTaskWorkspaceProbeDenial(text)
    ) {
      return;
    }
    errors.push(text);
  });
  return errors;
}
