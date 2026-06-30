/**
 * Issue #1375 — Editor tabs, split panes, and resize regression hardening.
 *
 * Browser-level Playwright tests that drive the REAL packaged app
 * (`node dist/cli/index.js ui`). The webServer is defined in
 * tests/e2e/config/playwright.issue-1375-editor-layout.config.ts.
 *
 * These cover the acceptance criteria that the issue asks to prove in a browser:
 *   - Two-pane split creation, orientation switching, and keyboard resize (AC5).
 *   - Keyboard tab reorder within a pane and cross-pane move (AC1/AC3 fallback).
 *   - Tab order persists across a reload (AC1).
 *
 * The interactions use the keyboard and button affordances, which are the
 * deterministic, accessible equivalents of the pointer drag/drop covered by the
 * jsdom unit tests; HTML5 drag-and-drop is intentionally not simulated here.
 *
 * If the packaged app is not available (dist/ absent), Playwright's webServer
 * step builds it; the tests are not faked — they exercise the real product path.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPEN_FILES = ["src/App.tsx", "src/utils.ts", "README.md"] as const;
const ACTIVE_FILE = "src/App.tsx";
const tempProjects: string[] = [];

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-1375-layout-"));
  tempProjects.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "App.tsx"), "export const App = () => null;\n", "utf8");
  writeFileSync(join(root, "src", "utils.ts"), "export const noop = () => undefined;\n", "utf8");
  writeFileSync(join(root, "README.md"), "# Fixture\n", "utf8");
  return root;
}

async function seedEditorWindow(page: Page, root: string): Promise<void> {
  // addInitScript runs on every navigation, including reload. Seed the workspace only when it is
  // absent so a reload reads the layout the app persisted, not the original fixture (AC1 relies on
  // this to prove persistence rather than re-seeding).
  await page.addInitScript(
    ({ projectRoot, files, active }) => {
      window.localStorage.setItem("keiko.theme", "dark");
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      if (window.localStorage.getItem("keiko.workspace.v4") === null) {
        window.localStorage.setItem(
          "keiko.workspace.v4",
          JSON.stringify([
            {
              id: "issue-1375-editor-layout",
              type: "editor",
              x: 24,
              y: 24,
              w: 1100,
              h: 760,
              z: 10,
              cfg: { root: projectRoot, file: active, openFiles: files },
              max: false,
            },
          ]),
        );
      }
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { projectRoot: root, files: [...OPEN_FILES], active: ACTIVE_FILE },
  );
}

async function openEditor(page: Page): Promise<Locator> {
  const workspace = page.locator(".editor-workspace").first();
  await expect(workspace.locator(".ed-tablist").first()).toBeVisible();
  return workspace;
}

async function tabLabels(pane: Locator): Promise<readonly string[]> {
  await expect(pane.locator(".ed-tab-label").first()).toBeVisible();
  return pane.locator(".ed-tab-label").allInnerTexts();
}

async function tabCenter(pane: Locator, file: string): Promise<{
  readonly x: number;
  readonly y: number;
  readonly right: number;
}> {
  const tab = pane.locator(`.ed-tab-hit[data-tip="${file}"]`);
  await expect(tab).toBeVisible();
  const box = await tab.boundingBox();
  if (box === null) throw new Error(`tab ${file} must have a browser box`);
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    right: box.x + box.width,
  };
}

async function insertionHighlightStyles(workspace: Locator): Promise<
  readonly {
    readonly file: string | null;
    readonly active: boolean;
    readonly transition: string;
    readonly borderTop: string;
    readonly background: string;
    readonly boxShadow: string;
  }[]
> {
  return workspace
    .locator(
      [
        '.ed-tab[data-tab-insert-before="true"]',
        '.ed-tab:has(+ .ed-tab[data-tab-insert-before="true"])',
        '.ed-tab[data-tab-insert-after="true"]',
        '.ed-tab[data-tab-insert-after="true"] + .ed-tab',
      ].join(", "),
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const element = node as HTMLElement;
        const style = window.getComputedStyle(element);
        return {
          file: element.dataset.tabFile ?? null,
          active: element.classList.contains("active"),
          transition: style.transition,
          borderTop: style.borderTopColor,
          background: style.backgroundColor,
          boxShadow: style.boxShadow,
        };
      }),
    );
}

async function persistedFirstPaneTabOrder(page: Page): Promise<readonly string[] | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("keiko.workspace.v4");
    if (raw === null) return null;
    const wins = JSON.parse(raw) as readonly { type?: string; cfg?: { layoutJson?: string } }[];
    const layoutJson = wins.find((w) => w.type === "editor")?.cfg?.layoutJson;
    if (layoutJson === undefined) return null;
    const layout = JSON.parse(layoutJson) as { panes?: Record<string, { tabOrder?: string[] }> };
    const firstPane = Object.values(layout.panes ?? {})[0];
    return firstPane?.tabOrder ?? null;
  });
}

test.afterAll(() => {
  for (const root of tempProjects) rmSync(root, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await seedEditorWindow(page, createWorkspace());
  await page.goto("/");
});

test("splits a pane and resizes the two-pane split from the keyboard (AC5)", async ({ page }) => {
  const workspace = await openEditor(page);
  expect(await workspace.locator(".ed-pane").count()).toBe(1);

  await workspace
    .getByRole("button", { name: `Split ${ACTIVE_FILE} right` })
    .first()
    .click();
  await expect(workspace.locator(".ed-pane")).toHaveCount(2);

  const separator = workspace.getByRole("separator", { name: "Resize editor split" });
  await expect(separator).toHaveAttribute("aria-orientation", "vertical");
  await expect(separator).toHaveAttribute("aria-valuenow", "50");

  await separator.focus();
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "52");

  // The alternate split button switches orientation without creating orphan panes.
  await workspace
    .getByRole("button", { name: `Split ${ACTIVE_FILE} down` })
    .first()
    .click();
  await expect(workspace.locator(".ed-pane")).toHaveCount(2);
  await expect(workspace.getByRole("separator", { name: "Resize editor split" })).toHaveCount(1);
  await expect(separator).toHaveAttribute("aria-orientation", "horizontal");
  await expect(separator).toHaveAttribute("aria-valuenow", "50");
});

test("reorders and moves tabs through the keyboard fallback (AC1/AC3)", async ({ page }) => {
  const workspace = await openEditor(page);
  const firstPane = workspace.locator(".ed-pane").first();
  expect(await tabLabels(firstPane)).toEqual([...OPEN_FILES]);

  // Alt+ArrowRight reorders the active tab one slot to the right within its pane.
  await firstPane.locator(`.ed-tab-hit[data-tip="${ACTIVE_FILE}"]`).press("Alt+ArrowRight");
  expect(await tabLabels(firstPane)).toEqual(["src/utils.ts", ACTIVE_FILE, "README.md"]);

  // Alt+Shift+ArrowLeft moves a tab from the adjacent pane into the first pane.
  await workspace
    .getByRole("button", { name: `Split ${ACTIVE_FILE} right` })
    .first()
    .click();
  await expect(workspace.locator(".ed-pane")).toHaveCount(2);

  const leftPane = workspace.locator(".ed-pane").first();
  const rightPane = workspace.locator(".ed-pane").nth(1);
  await rightPane.locator(`.ed-tab-hit[data-tip="src/utils.ts"]`).press("Alt+Shift+ArrowLeft");

  await expect(leftPane.locator(`.ed-tab-hit[data-tip="src/utils.ts"]`)).toBeVisible();
  await expect(workspace.locator(".ed-pane")).toHaveCount(2);
});

test("keeps pointer-drag tab insertion feedback and next-click focus consistent", async ({
  page,
}) => {
  const workspace = await openEditor(page);
  const pane = workspace.locator(".ed-pane").first();
  expect(await tabLabels(pane)).toEqual([...OPEN_FILES]);

  const source = await tabCenter(pane, "README.md");
  const activeTarget = await tabCenter(pane, ACTIVE_FILE);

  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x + 18, source.y, { steps: 3 });
  await page.mouse.move(activeTarget.right - 4, activeTarget.y, { steps: 6 });

  await expect
    .poll(async () => insertionHighlightStyles(workspace))
    .toHaveLength(2);
  const highlighted = await insertionHighlightStyles(workspace);

  expect(new Set(highlighted.map((entry) => entry.transition))).toEqual(new Set(["none"]));
  expect(new Set(highlighted.map((entry) => entry.borderTop)).size).toBe(1);
  expect(new Set(highlighted.map((entry) => entry.background)).size).toBe(1);
  expect(new Set(highlighted.map((entry) => entry.boxShadow)).size).toBe(1);

  await page.mouse.up();
  await pane.locator(`.ed-tab-hit[data-tip="src/utils.ts"]`).click();
  await expect(pane.locator(`.ed-tab-hit[data-tip="src/utils.ts"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("persists tab order across a reload (AC1)", async ({ page }) => {
  const workspace = await openEditor(page);
  const pane = workspace.locator(".ed-pane").first();

  // Reorder App.tsx to the end of the strip.
  await pane.locator(`.ed-tab-hit[data-tip="${ACTIVE_FILE}"]`).press("Alt+ArrowRight");
  await pane.locator(`.ed-tab-hit[data-tip="${ACTIVE_FILE}"]`).press("Alt+ArrowRight");
  const reordered = ["src/utils.ts", "README.md", ACTIVE_FILE];
  expect(await tabLabels(pane)).toEqual(reordered);

  // The layout-persistence effect runs after paint; wait until the reordered order is in
  // localStorage so the reload reads persisted state rather than racing the write.
  await expect.poll(() => persistedFirstPaneTabOrder(page)).toEqual(reordered);
  await page.reload();
  const restored = await openEditor(page);
  expect(await tabLabels(restored.locator(".ed-pane").first())).toEqual(reordered);
});
