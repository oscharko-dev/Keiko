import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  A11Y_CONTRAST_MODES,
  A11Y_SURFACES,
  A11Y_THEMES,
  type A11yContrastMode,
  type A11yTheme,
} from "./support/a11y-surfaces.js";
import { type AxeViolation, formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";
import { openEditorWorkspace, seedEditorWindow } from "./support/editorWorkspace.js";

// Documented baseline of pre-existing real-browser serious/critical violations that this gate does
// NOT own the fix for. Each entry must carry a reason and an owner. The gate fails on ANY
// serious/critical violation NOT on this list, so new regressions are still caught. Keep this list
// SHORT and shrinking — it is a to-fix ledger, not a mute button.
//
// Currently EMPTY, and both prior residuals were fixed at the source rather than aged here:
//   - RB-14, .win-zpct color-contrast — the zoom-percentage badge rendered --text-tertiary under
//     the zoom cluster's opacity:0.72, measuring 3.45:1 in a real browser. Fixed in the SHA-pinned
//     globals.css via the --win-zoom-pct token (dark 6.15:1 / light 4.97:1).
//   - aria-required-children on .ed-tablist — the editor tab strip owned a close `button` per tab
//     and the overflow `details`, neither of which a role="tablist" may own. Fixed by the WAI-ARIA
//     APG closable-tab shape (#2802): the close affordance is a non-focusable descendant of its
//     role="tab" element with Delete/Backspace on the tab, and the tablist role sits on a row that
//     holds nothing but tabs. Pinned in jsdom by EditorRuntimeWidget.a11y.test.tsx, which reproduces
//     both owned-child cases, so a regression fails before this lane ever runs.
const KNOWN_A11Y_ISSUES: readonly {
  readonly id: string;
  readonly selector: string;
  readonly reason: string;
  readonly owner: string;
}[] = [];

// Returns serious/critical violations after removing nodes explained by KNOWN_A11Y_ISSUES. A
// violation survives only if it has at least one node whose target is NOT covered by an allowlist
// entry for the same rule — so a color-contrast regression on a DIFFERENT element still fails.
function unexplainedViolations(violations: readonly AxeViolation[]): readonly AxeViolation[] {
  const survivors: AxeViolation[] = [];
  for (const violation of seriousOrCritical(violations)) {
    const unexplainedNodes = violation.nodes.filter(
      (node) =>
        !KNOWN_A11Y_ISSUES.some(
          (known) =>
            known.id === violation.id &&
            node.target.some((selector) => selector.includes(known.selector)),
        ),
    );
    if (unexplainedNodes.length > 0) {
      survivors.push({ ...violation, nodes: unexplainedNodes });
    }
  }
  return survivors;
}

// GEN-TEST-E2E-004 — the browser a11y estate was one coordinator-only axe suite (update-ui-1696,
// wired into no CI job) plus jsdom component axe. The W10 High-severity regressions (composer
// combobox semantics, roving tabindex, focus traps) are the kind that jsdom cannot see and only a
// real browser reveals.
//
// 0.3.0 release audit — that first version scanned TWO surfaces (the shell and a seeded chat window)
// in the default DARK theme with NO dialog open, which left the light theme, the in-app
// high-contrast step, forced colours, every modal, and every bound work surface without any
// real-browser contrast proof at all. The matrix now derives from the coverage contract in
// support/a11y-surfaces.ts: every surface a local human operates, in both themes, plus one OPEN
// destructive confirm — the one place the danger palette is actually rendered — and a contrast sweep
// over the launcher. Still a smoke lane: one page load per case, no evidence artifacts, no retries.

const CHAT_MODEL_ID = "e2e-chat-model";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const WORKSPACE_KEY = "keiko.workspace.v4";
const CHAT_WINDOW_ID = "e2e-a11y-chat-window";
const FILES_WINDOW_ID = "e2e-a11y-files-window";
const GIT_WINDOW_ID = "e2e-a11y-git-window";
const EDITOR_WINDOW_ID = "e2e-a11y-editor-window";
const tempRoots: string[] = [];

// Give the seeded floating windows room to render fully inside the viewport for the axe scan.
test.use({ viewport: { width: 1280, height: 960 } });

interface ChatResponse {
  readonly chat: { readonly id: string; readonly title: string };
}

/** A surface opener leaves the page on the surface and returns the selector axe should scan. */
type SurfaceOpener = (page: Page, request: APIRequestContext, theme: A11yTheme) => Promise<string>;

function createProjectFixture(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `keiko-e2e-a11y-${prefix}-`)));
  tempRoots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# a11y smoke fixture\n", "utf8");
  writeFileSync(join(root, "src", "app.ts"), "export const fixtureValue = 1;\n", "utf8");
  return root;
}

/** A hermetic repo with one worktree modification, so the Git window renders its changed-file list. */
function createGitFixture(): string {
  const root = createProjectFixture("git");
  const git = (args: readonly string[]): void => {
    execFileSync("git", [...args], {
      cwd: root,
      env: { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" },
    });
  };
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "a11y@keiko.invalid"]);
  git(["config", "user.name", "Keiko A11y Smoke"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "."]);
  git(["commit", "-m", "chore: a11y smoke baseline"]);
  writeFileSync(join(root, "src", "app.ts"), "export const fixtureValue = 2;\n", "utf8");
  return root;
}

async function registerProject(request: APIRequestContext, root: string): Promise<void> {
  const response = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name: "Keiko a11y E2E" },
  });
  if (!response.ok()) throw new Error(`Project setup failed (${String(response.status())})`);
}

/**
 * Pin locale and theme through the app's OWN persistence keys, so the scan measures the real
 * themed render rather than an attribute poked onto <html> after hydration.
 */
async function seedShell(page: Page, theme: A11yTheme): Promise<void> {
  await page.addInitScript((value) => {
    window.localStorage.setItem("keiko.locale", "en");
    window.localStorage.setItem("keiko.theme", value);
  }, theme);
}

async function seedWindow(page: Page, entry: Record<string, unknown>): Promise<void> {
  await page.addInitScript(
    ({ key, win }) => {
      window.localStorage.setItem(key, JSON.stringify([win]));
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { key: WORKSPACE_KEY, win: entry },
  );
}

function windowEntry(
  id: string,
  type: string,
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  return { id, type, x: 40, y: 48, w: 1180, h: 840, z: 10, cfg, max: false };
}

async function createChat(request: APIRequestContext): Promise<ChatResponse["chat"]> {
  const root = createProjectFixture("chat");
  await registerProject(request, root);
  const create = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: { projectPath: root, title: "E2E a11y chat", selectedModel: CHAT_MODEL_ID },
  });
  expect(create.status()).toBe(201);
  return ((await create.json()) as ChatResponse).chat;
}

async function shellReady(page: Page, theme: A11yTheme): Promise<void> {
  await seedShell(page, theme);
  await page.goto("/");
  // The launcher/taskbar shell header is always present; wait for it before scanning.
  await expect(page.locator("header.header")).toBeVisible();
}

const openLauncher: SurfaceOpener = async (page, _request, theme) => {
  await shellReady(page, theme);
  return "body";
};

const openChatWindow: SurfaceOpener = async (page, request, theme) => {
  const chat = await createChat(request);
  await seedShell(page, theme);
  await seedWindow(
    page,
    windowEntry(CHAT_WINDOW_ID, "chat", { chatId: chat.id, title: chat.title }),
  );
  await page.goto("/");
  const chatWindow = page.getByRole("region", { name: `Chat — ${chat.title}` });
  await expect(chatWindow).toBeVisible();
  await expect(chatWindow.getByRole("textbox", { name: "Chat message" })).toBeVisible();
  await chatWindow.locator(".chatw-empty").evaluate(async (element) => {
    await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
  });
  return `.window[data-window-id="${CHAT_WINDOW_ID}"]`;
};

const openCommandPalette: SurfaceOpener = async (page, _request, theme) => {
  await shellReady(page, theme);
  // The product's own shortcut for `quick-access.commands` (CtrlOrMeta+Shift+P) — no test-only hook.
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Quick access" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox")).toBeFocused();
  // Scan a populated list, not the empty state: the command rows are what carries the palette's
  // label/shortcut/group contrast.
  await expect(palette.getByRole("option").first()).toBeVisible();
  return ".cmdk";
};

const openCodingWorkbench: SurfaceOpener = async (page, _request, theme) => {
  await seedShell(page, theme);
  // Reuses the shared live-runtime fixture, so this scans a workbench BOUND to a governed session
  // (mode bar, source status, run controls) rather than an unbound placeholder.
  const fixture = await installLiveCodingWorkbenchRuntime(page);
  await fixture.open();
  await expect(fixture.workbench).toBeVisible();
  await expect(fixture.workbench.locator("[data-mode]")).toBeVisible();
  return 'section[aria-label="Coding Workbench"][data-state]';
};

const openEditorWindow: SurfaceOpener = async (page, request, theme) => {
  const root = createProjectFixture("editor");
  await registerProject(request, root);
  await seedShell(page, theme);
  await seedEditorWindow(page, {
    root,
    active: "src/app.ts",
    openFiles: ["src/app.ts"],
    windowId: EDITOR_WINDOW_ID,
    theme,
  });
  await page.goto("/");
  const workspace = await openEditorWorkspace(page);
  await expect(workspace.locator(".monaco-editor").first()).toBeVisible();
  return `.window[data-window-id="${EDITOR_WINDOW_ID}"]`;
};

const openGitWindow: SurfaceOpener = async (page, request, theme) => {
  const root = createGitFixture();
  await registerProject(request, root);
  await seedShell(page, theme);
  await seedWindow(page, windowEntry(GIT_WINDOW_ID, "governedGit", { projectPath: root }));
  await page.goto("/");
  const gitWindow = page.locator(`[data-window-id="${GIT_WINDOW_ID}"]`);
  await expect(gitWindow).toBeVisible();
  await expect(gitWindow.locator('nav[aria-label="Changed files"]')).toBeVisible();
  return `.window[data-window-id="${GIT_WINDOW_ID}"]`;
};

const openDeleteConfirm: SurfaceOpener = async (page, request, theme) => {
  const root = createProjectFixture("delete");
  await registerProject(request, root);
  await seedShell(page, theme);
  await seedWindow(page, windowEntry(FILES_WINDOW_ID, "files", { root }));
  await page.goto("/");
  const row = page.locator('[role="treeitem"].tr-row[data-path="README.md"]');
  await expect(row).toBeVisible();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.locator('.ed-dirty-dialog[role="dialog"][aria-modal="true"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();
  return ".ed-dirty-dialog";
};

const OPENERS: Readonly<Record<string, SurfaceOpener>> = {
  launcher: openLauncher,
  "chat-window": openChatWindow,
  "command-palette": openCommandPalette,
  "coding-workbench": openCodingWorkbench,
  editor: openEditorWindow,
  "git-window": openGitWindow,
  "delete-confirm": openDeleteConfirm,
};

/**
 * `baseline` asserts no contrast preference; `high-contrast` drives BOTH `prefers-contrast: more`
 * and the in-app `[data-hc="more"]` token step (globals.css keys on them independently, so a scan
 * of only one proves only half the hook); `forced-colors` drives `forced-colors: active`, which this
 * Playwright/chromium project supports — see the note on A11Y_CONTRAST_MODES for what a scan in
 * that mode does and does not prove.
 */
async function applyContrastMode(page: Page, mode: A11yContrastMode): Promise<void> {
  await page.emulateMedia({
    contrast: mode === "high-contrast" ? "more" : "no-preference",
    forcedColors: mode === "forced-colors" ? "active" : "none",
  });
  await page.evaluate((highContrast) => {
    if (highContrast) document.documentElement.dataset.hc = "more";
    else document.documentElement.removeAttribute("data-hc");
  }, mode === "high-contrast");
}

async function expectNoViolations(page: Page, selector: string, context: string): Promise<void> {
  const violations = unexplainedViolations(await runAxe(page, selector));
  expect(violations.length, `${context}\n${formatViolations(violations)}`).toBe(0);
}

test.afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const surface of A11Y_SURFACES) {
  const open = OPENERS[surface.id];
  // Collection-time completeness check: a surface added to the coverage contract without an opener
  // would otherwise silently contribute zero tests, which is exactly the "reads as coverage" failure
  // this matrix exists to prevent.
  if (open === undefined) throw new Error(`a11y smoke: no opener for surface "${surface.id}"`);
  for (const theme of A11Y_THEMES) {
    test(`${surface.label} has no serious/critical axe violations — ${theme} theme @smoke`, async ({
      page,
      request,
    }) => {
      const selector = await open(page, request, theme);
      await expectNoViolations(page, selector, `${surface.label} (${theme})`);
    });
  }
}

for (const theme of A11Y_THEMES) {
  test(`desktop shell holds up across contrast modes — ${theme} theme @smoke`, async ({ page }) => {
    await shellReady(page, theme);
    for (const mode of A11Y_CONTRAST_MODES) {
      await applyContrastMode(page, mode);
      await expectNoViolations(page, "body", `launcher shell (${theme}, ${mode})`);
    }
  });
}
