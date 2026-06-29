import { expect, test, type Page } from "@playwright/test";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const PROJECT_ROOT = process.cwd();
const LONG_FILE = "vitest.coverage.packages.config.ts";
const SHORT_FILE = "NOTICE";
const ACTIVE_FILE = LONG_FILE;

function collectPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return () => {
    expect(errors).toEqual([]);
  };
}

async function ensureProject(page: Page, projectPath: string): Promise<void> {
  const response = await page.request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: projectPath, name: "Editor tooltip fixture" },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function seedEditorWindow(page: Page, projectPath: string): Promise<void> {
  await page.addInitScript(
    ({ root, activeFile }) => {
      window.localStorage.setItem("keiko.theme", "dark");
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "editor-project-tree-tooltip",
            type: "editor",
            x: 32,
            y: 32,
            w: 900,
            h: 620,
            z: 10,
            cfg: {
              root,
              file: activeFile,
              openFiles: [activeFile],
              layout: {
                sidebarCollapsed: false,
                sidebarWidth: 175,
                tree: { type: "pane", paneId: "root" },
                panes: {
                  root: {
                    id: "root",
                    file: activeFile,
                    openFiles: [activeFile],
                  },
                },
              },
            },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { root: projectPath, activeFile: ACTIVE_FILE },
  );
}

test("editor project-tree filenames use delayed Keiko tooltip only when truncated", async ({
  page,
}) => {
  const assertNoPageErrors = collectPageErrors(page);
  const projectPath = PROJECT_ROOT;
  await ensureProject(page, projectPath);
  await seedEditorWindow(page, projectPath);

  await page.goto("/");
  const editorWindow = page
    .locator(".window[data-window-id]")
    .filter({ has: page.locator(".editor-workspace") })
    .first();
  await expect(editorWindow).toBeVisible();
  await expect(editorWindow.locator(".monaco-editor")).toBeVisible();

  const longRow = editorWindow.locator(`.ed-sidebar .tr-row[data-path="${LONG_FILE}"]`);
  const shortRow = editorWindow.locator(`.ed-sidebar .tr-row[data-path="${SHORT_FILE}"]`);
  await expect(longRow).toBeVisible();
  await expect(shortRow).toBeVisible();

  const longRowState = await longRow.evaluate((row) => {
    const name = row.querySelector<HTMLElement>(".tr-name");
    return {
      dataTip: row.getAttribute("data-tip"),
      title: row.getAttribute("title"),
      truncated: name !== null && name.scrollWidth > name.clientWidth + 1,
    };
  });
  expect(longRowState).toEqual({ dataTip: null, title: null, truncated: true });

  await shortRow.hover();
  await page.waitForTimeout(800);
  await expect(page.locator(".files-tree-tooltip")).toHaveCount(0);

  await longRow.hover();
  await page.waitForTimeout(500);
  await expect(page.locator(".files-tree-tooltip")).toHaveCount(0);
  await expect(page.locator(".files-tree-tooltip")).toHaveText(LONG_FILE, { timeout: 500 });

  await page.mouse.move(20, 20);
  await expect(page.locator(".files-tree-tooltip")).toHaveCount(0);
  assertNoPageErrors();
});
