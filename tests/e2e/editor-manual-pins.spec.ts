/** Normal Editor keeps manual editing and split panes without agent control or subscriptions. */
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { editorModifier } from "./support/editor-chord.js";
import {
  EDITOR_SELECTORS,
  cleanupEditorWorkspaces,
  collectPageErrors,
  createEditorWorkspace,
  openEditorWorkspace,
  seedEditorWindow,
  splitActivePane,
} from "./support/editorWorkspace.js";

const RELATIVE_PATH = "src/manual.ts";
const INITIAL_CONTENT = "export const value = 1;\n";
const EDITED_CONTENT = "export const value = 2;\n";

test.use({ viewport: { width: 1600, height: 1000 } });
test.afterAll(() => {
  cleanupEditorWorkspaces();
});

function collectAgentControlRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/^\/api\/editor\/agent\/(?:events|actions|audit)$/u.test(pathname)) paths.push(pathname);
  });
  return paths;
}

async function openManualEditor(
  page: Page,
  request: APIRequestContext,
  split = false,
): Promise<Locator> {
  const files = [{ path: RELATIVE_PATH, content: INITIAL_CONTENT }];
  if (split) files.push({ path: "src/second.ts", content: "export const second = 1;\n" });
  const { root } = createEditorWorkspace(files);
  const response = await request.post("/api/projects", {
    headers: { "X-Keiko-CSRF": "1" },
    data: { path: root, selectionIntent: "explicit-folder-selection" },
  });
  expect(response.ok()).toBe(true);
  await seedEditorWindow(page, {
    root,
    active: RELATIVE_PATH,
    openFiles: files.map((file) => file.path),
    windowId: "editor-manual-pins",
    resetWorkspace: true,
  });
  await page.goto("/");
  return openEditorWorkspace(page);
}

async function readEditorBuffer(workspace: Locator): Promise<string> {
  const viewLines = workspace.locator(".monaco-editor .view-lines").first();
  await expect(viewLines).toBeVisible();
  return viewLines.evaluate((container) =>
    Array.from(container.querySelectorAll<HTMLElement>(".view-line"))
      .sort(
        (left, right) => Number.parseInt(left.style.top, 10) - Number.parseInt(right.style.top, 10),
      )
      .map((line) => line.textContent.replaceAll(" ", " "))
      .join("\n")
      .replace(/\n+$/u, ""),
  );
}

test("normal Editor keeps manual undo and redo without an agent channel", async ({
  page,
  request,
}) => {
  const agentRequests = collectAgentControlRequests(page);
  const pageErrors = collectPageErrors(page);
  const workspace = await openManualEditor(page, request);
  await expect.poll(() => readEditorBuffer(workspace)).toBe(INITIAL_CONTENT.trimEnd());
  const modifier = await editorModifier(page);
  const input = workspace.locator(".monaco-editor .native-edit-context").first();
  await input.focus();
  await page.keyboard.press(`${modifier}+Home`);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.type("2");
  await expect.poll(() => readEditorBuffer(workspace)).toBe(EDITED_CONTENT.trimEnd());
  await page.keyboard.press(`${modifier}+KeyZ`);
  await expect.poll(() => readEditorBuffer(workspace)).toBe(INITIAL_CONTENT.trimEnd());
  await page.keyboard.press(`${modifier}+Shift+KeyZ`);
  await expect.poll(() => readEditorBuffer(workspace)).toBe(EDITED_CONTENT.trimEnd());
  expect(agentRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("normal Editor keeps both split panes manual through focus changes", async ({
  page,
  request,
}) => {
  const agentRequests = collectAgentControlRequests(page);
  const pageErrors = collectPageErrors(page);
  const workspace = await openManualEditor(page, request, true);
  await splitActivePane(workspace, RELATIVE_PATH, "right");
  const panes = workspace.locator(EDITOR_SELECTORS.pane);
  await expect(panes).toHaveCount(2);
  for (const pane of await panes.all()) {
    await pane.locator(EDITOR_SELECTORS.monaco).first().click();
    await expect(pane.locator(EDITOR_SELECTORS.monaco).first()).toBeVisible();
  }
  await expect(workspace.getByText("Recent agent actions", { exact: true })).toHaveCount(0);
  expect(agentRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
