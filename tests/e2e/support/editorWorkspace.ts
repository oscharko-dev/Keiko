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
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

export interface GitEditorWorkspace {
  readonly root: string;
  readonly baseCommit: string;
  readonly incomingCommit: string;
  readonly mainCommit: string;
  readonly stagedPath: string;
  readonly blamePath: string;
  readonly conflictPath: string;
  readonly nestedChangedPath: string;
  readonly ignoredPath: string;
  readonly conflictDiskContent: string;
}

interface SeedEditorWindowOptions {
  readonly root?: string;
  readonly openFiles?: readonly string[];
  readonly active?: string | null;
  readonly windowId?: string;
  readonly theme?: "dark" | "light";
  readonly resetWorkspace?: boolean;
  readonly maximized?: boolean;
}

const createdRoots: string[] = [];

/** mkdtemp a fresh project root, write every fixture file (creating parent dirs), and track it. */
export function createEditorWorkspace(files: readonly EditorWorkspaceFile[]): {
  readonly root: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-1377-editor-")));
  createdRoots.push(root);
  for (const file of files) {
    const absolute = join(root, file.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, "utf8");
  }
  return { root };
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

function writeWorkspaceFile(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

const GIT_EDITOR_PATHS = {
  stagedPath: "src/staged.ts",
  blamePath: "src/blame.ts",
  conflictPath: "src/merge/conflict.ts",
  nestedChangedPath: "src/nested/changed.ts",
  ignoredPath: "tmp/ignored.log",
} as const;

function stagedFixtureContent(
  staged: "base" | "index",
  unstaged: "base" | "index" | "worktree",
): string {
  return [
    "export const alpha = 1;",
    `export const staged = "${staged}";`,
    "export const middle = true;",
    `export const unstaged = "${unstaged}";`,
    "export const omega = 5;",
    "",
  ].join("\n");
}

function seedGitEditorFiles(root: string): void {
  writeWorkspaceFile(root, GIT_EDITOR_PATHS.stagedPath, stagedFixtureContent("base", "base"));
  writeWorkspaceFile(root, GIT_EDITOR_PATHS.blamePath, 'export const blamed = "baseline";\n');
  writeWorkspaceFile(
    root,
    GIT_EDITOR_PATHS.conflictPath,
    [
      'export const first = "base";',
      ...Array.from(
        { length: 10 },
        (_, index) =>
          `export const spacer${String(index + 1).padStart(2, "0")} = ${String(index + 1)};`,
      ),
      'export const second = "base";',
      "",
    ].join("\n"),
  );
  writeWorkspaceFile(root, GIT_EDITOR_PATHS.nestedChangedPath, 'export const nested = "base";\n');
  writeWorkspaceFile(root, ".gitignore", "tmp/ignored.log\n");
}

function initializeFixtureRepository(root: string): string {
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.email", "keiko-e2e@example.invalid"]);
  runGit(root, ["config", "user.name", "Keiko E2E"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  runGit(root, ["config", "core.hooksPath", ".git/disabled-hooks"]);
  runGit(root, ["add", "--", "."]);
  runGit(root, ["commit", "-q", "-m", "test: seed source-control fixture"]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

function conflictSide(root: string, side: "ours" | "theirs"): string {
  return (
    runGit(root, ["show", `main:${GIT_EDITOR_PATHS.conflictPath}`])
      .replace('first = "base"', `first = "${side}"`)
      .replace('second = "base"', `second = "${side}"`) + "\n"
  );
}

function createFixtureConflict(root: string): {
  readonly incomingCommit: string;
  readonly mainCommit: string;
  readonly conflictDiskContent: string;
} {
  runGit(root, ["switch", "-q", "-c", "incoming"]);
  writeWorkspaceFile(root, GIT_EDITOR_PATHS.conflictPath, conflictSide(root, "theirs"));
  runGit(root, ["add", "--", GIT_EDITOR_PATHS.conflictPath]);
  runGit(root, ["commit", "-q", "-m", "test: create incoming conflict side"]);
  const incomingCommit = runGit(root, ["rev-parse", "HEAD"]);
  runGit(root, ["switch", "-q", "main"]);
  writeWorkspaceFile(root, GIT_EDITOR_PATHS.conflictPath, conflictSide(root, "ours"));
  runGit(root, ["add", "--", GIT_EDITOR_PATHS.conflictPath]);
  runGit(root, ["commit", "-q", "-m", "test: create current conflict side"]);
  const mainCommit = runGit(root, ["rev-parse", "HEAD"]);
  const merge = spawnSync("git", ["merge", "--no-edit", "incoming"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (merge.status !== 1) {
    throw new Error(`Expected the hermetic merge to conflict, got ${String(merge.status)}.`);
  }
  return {
    incomingCommit,
    mainCommit,
    conflictDiskContent: readFileSync(join(root, GIT_EDITOR_PATHS.conflictPath), "utf8"),
  };
}

function createFixtureWorktreeStates(root: string): void {
  writeWorkspaceFile(root, GIT_EDITOR_PATHS.stagedPath, stagedFixtureContent("index", "index"));
  runGit(root, ["add", "--", GIT_EDITOR_PATHS.stagedPath]);
  writeWorkspaceFile(root, GIT_EDITOR_PATHS.stagedPath, stagedFixtureContent("index", "worktree"));
  writeWorkspaceFile(
    root,
    GIT_EDITOR_PATHS.nestedChangedPath,
    'export const nested = "worktree";\n',
  );
  writeWorkspaceFile(root, GIT_EDITOR_PATHS.ignoredPath, "ignored fixture\n");
}

/**
 * Build the hermetic source-control workspace for Epic #2093's real-BFF closeout. The fixture has
 * no remote, uses repository-local identity/signing configuration, and deliberately retains one
 * unmerged index entry alongside staged, unstaged, nested, and ignored worktree states.
 */
export function createGitEditorWorkspace(): GitEditorWorkspace {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-2235-git-editor-")));
  createdRoots.push(root);
  seedGitEditorFiles(root);
  const baseCommit = initializeFixtureRepository(root);
  const conflict = createFixtureConflict(root);
  createFixtureWorktreeStates(root);
  return {
    root,
    baseCommit,
    ...conflict,
    ...GIT_EDITOR_PATHS,
  };
}

/** Remove every workspace created during the run. Call from `test.afterAll`. */
export function cleanupEditorWorkspaces(): void {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Generate `count` synthetic TypeScript source files under `root/dir`, each padded with comment bytes
 * to (approximately) `bytesPerFile`, so a test can build a workspace whose total read bytes exceed
 * `LanguageServiceLimits.maxWorkspaceReadBytes` (packages/keiko-contracts/src/language-service.ts)
 * without hand-authoring adversarial TypeScript content inline. Every generated file stays valid,
 * analyzable TypeScript (a header comment, a padding comment, and one real export), so it is a
 * legitimate program root file the TS compiler must actually read — not dead weight it would skip.
 */
export function writePaddedFixtureFiles(
  root: string,
  dir: string,
  count: number,
  bytesPerFile: number,
): void {
  const absoluteDir = join(root, dir);
  mkdirSync(absoluteDir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const header = `// Padded near-cap fixture file ${String(index)} (generated; see writePaddedFixtureFiles).\n`;
    const footer = `export const nearCapFixtureValue${String(index)} = ${String(index)};\n`;
    const paddingLength = Math.max(0, bytesPerFile - header.length - footer.length);
    const padding = paddingLength > 0 ? `// ${"x".repeat(paddingLength)}\n` : "";
    writeFileSync(
      join(absoluteDir, `padded-${String(index)}.ts`),
      `${header}${padding}${footer}`,
      "utf8",
    );
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
  const windowId = opts.windowId ?? "issue-1377-editor";
  const cfg =
    opts.root === undefined
      ? {}
      : {
          root: opts.root,
          ...(opts.active === null || opts.active === undefined ? {} : { file: opts.active }),
          ...(opts.openFiles === undefined ? {} : { openFiles: [...opts.openFiles] }),
        };
  await page.addInitScript(
    ({ window: editorWindow, lsKey, resetKey, resetWorkspace }) => {
      if (resetWorkspace && window.sessionStorage.getItem(resetKey) !== "1") {
        window.localStorage.removeItem(lsKey);
        window.sessionStorage.setItem(resetKey, "1");
      }
      window.localStorage.setItem("keiko.theme", editorWindow.theme);
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      if (window.localStorage.getItem(lsKey) === null) {
        window.localStorage.setItem(lsKey, JSON.stringify([editorWindow.entry]));
      }
      window.localStorage.removeItem("keiko.conns.v1");
    },
    {
      lsKey: WORKSPACE_LS_KEY,
      resetKey: `${WORKSPACE_LS_KEY}:seed-reset:${windowId}`,
      resetWorkspace: opts.resetWorkspace ?? false,
      window: {
        theme: opts.theme ?? "dark",
        entry: {
          id: windowId,
          type: "editor",
          x: 24,
          y: 24,
          w: 1100,
          h: 760,
          z: 10,
          cfg,
          max: opts.maximized ?? false,
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
    ({ dbName, storeName }): Promise<string[]> => {
      // Wires the getAllKeys() request's outcome handlers. Declared here — a sibling of the
      // Promise executor below, not nested inside its open-success handler — so the handlers it
      // assigns stay within the nesting depth limit (S2004); it is called with just the values it
      // needs. It must stay inside this callback: page.evaluate serializes only this function's
      // own source into the browser context, so it cannot call a helper declared at module scope.
      function attachKeysRequestHandlers(
        db: IDBDatabase,
        keysRequest: IDBRequest<IDBValidKey[]>,
        resolvePromise: (keys: string[]) => void,
      ): void {
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
      }

      return new Promise<string[]>((resolvePromise: (keys: string[]) => void): void => {
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
          attachKeysRequestHandlers(db, keysRequest, resolvePromise);
        };
      });
    },
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
