import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import { validateWorkspaceManifest } from "@oscharko-dev/keiko-contracts/runtime/workspace-manifest";

import {
  cleanupEditorWorkspaces,
  createEditorWorkspace,
  revokeEditorWorkspaceTrust,
} from "./support/editorWorkspace.js";
import { editorM11PairingFragment } from "./support/editor-m11-app-session.js";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const WORKSPACE_KEY = "keiko.workspace.v4";

async function registerProject(page: Page, root: string, name: string): Promise<void> {
  const response = await page.request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestFromList(value: unknown, root: string): WorkspaceManifest {
  if (!isRecord(value) || !Array.isArray(value.manifests)) {
    throw new Error("workspace manifest list unavailable");
  }
  for (const candidate of value.manifests as readonly unknown[]) {
    if (!validateWorkspaceManifest(candidate).ok) continue;
    const manifest = candidate as WorkspaceManifest;
    if (manifest.roots.some((entry) => entry.canonicalRoot === root)) return manifest;
  }
  throw new Error("workspace manifest missing");
}

async function addSecondRoot(page: Page, actorRoot: string, projectPath: string): Promise<void> {
  const list = await page.request.get("/api/workspaces");
  expect(list.ok(), await list.text()).toBe(true);
  const manifest = manifestFromList(await list.json(), actorRoot);
  const actor = manifest.roots.find((root) => root.canonicalRoot === actorRoot);
  if (actor === undefined) throw new Error("workspace actor root unavailable");
  const response = await page.request.post(`/api/workspaces/${manifest.workspaceId}/roots`, {
    headers: MUTATION_HEADERS,
    data: {
      dispatch: {
        kind: "workspace-root-dispatch",
        schemaVersion: manifest.schemaVersion,
        workspaceId: manifest.workspaceId,
        manifestRef: manifest.manifestRef,
        manifestRevision: manifest.revision,
        manifestDigest: manifest.manifestDigest,
        rootRef: actor.rootRef,
        rootIdentityDigest: actor.identityDigest,
        operationClass: "mutating",
      },
      projectPath,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function seedIssueWindows(page: Page, root: string): Promise<void> {
  await page.addInitScript(
    ({ key, projectRoot }) => {
      window.localStorage.setItem("keiko.theme", "dark");
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      window.localStorage.setItem(
        key,
        JSON.stringify([
          {
            id: "issue-2526-editor",
            type: "editor",
            x: 620,
            y: 10,
            w: 960,
            h: 490,
            z: 14,
            cfg: { root: projectRoot },
            max: false,
          },
          {
            id: "issue-2526-commands",
            type: "commands",
            x: 1100,
            y: 510,
            w: 480,
            h: 460,
            z: 13,
            cfg: { projectPath: projectRoot },
            max: false,
          },
        ]),
      );
    },
    { key: WORKSPACE_KEY, projectRoot: root },
  );
}

async function stayRestricted(page: Page): Promise<void> {
  const prompt = page.getByRole("alertdialog", { name: "Trust this workspace?" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Stay restricted" }).click();
}

function requestTargetsRoot(requestUrl: string, route: string, root: string): boolean {
  const url = new URL(requestUrl);
  return url.pathname === route && url.searchParams.get("projectId") === root;
}

type EditorWorkspaceFixture = ReturnType<typeof createEditorWorkspace>;

interface IssueHarness {
  readonly rootA: EditorWorkspaceFixture;
  readonly rootB: EditorWorkspaceFixture;
}

function createIssueHarness(): IssueHarness {
  return {
    rootA: createEditorWorkspace([
      { path: "src/shared.ts", content: "export const needle = 'root A';\n" },
      { path: "package.json", content: '{"name":"root-a","private":true}\n' },
    ]),
    rootB: createEditorWorkspace([
      { path: "src/shared.ts", content: "export const needle = 'root B';\n" },
      { path: "package.json", content: '{"name":"root-b","private":true}\n' },
    ]),
  };
}

async function setupIssue(page: Page, harness: IssueHarness): Promise<void> {
  await page.goto(`/${editorM11PairingFragment("2526")}`);
  await expect.poll(() => page.url()).not.toContain("keiko-app-session");
  await registerProject(page, harness.rootA.root, "Root A");
  await registerProject(page, harness.rootB.root, "Root B");
  await addSecondRoot(page, harness.rootA.root, harness.rootB.root);
  await revokeEditorWorkspaceTrust(page.request, harness.rootA.root);
  await revokeEditorWorkspaceTrust(page.request, harness.rootB.root);
  await seedIssueWindows(page, harness.rootA.root);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await stayRestricted(page);
}

async function verifyDiscovery(
  page: Page,
  testInfo: TestInfo,
): Promise<{ readonly search: Locator; readonly editor: Locator }> {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+F" : "Control+Shift+F");
  const search = page.locator('[data-window-id="search"]');
  const searchStartedAt = Date.now();
  await search.getByRole("searchbox", { name: "Search files and symbols" }).fill("needle");
  await expect(search.getByRole("group", { name: "Root A: src/shared.ts" })).toBeVisible();
  await expect(search.getByRole("group", { name: "Root B: src/shared.ts" })).toBeVisible();
  await testInfo.attach("multi-root-search-latency", {
    body: Buffer.from(`${String(Date.now() - searchStartedAt)} ms\n`, "utf8"),
    contentType: "text/plain",
  });
  await page.getByRole("button", { name: "Open quick access" }).click();
  await page.getByRole("combobox", { name: /Workspace file or symbol query/u }).fill("shared");
  await expect(page.getByRole("option", { name: /Root A · src\/shared\.ts:1/u })).toBeVisible();
  await expect(page.getByRole("option", { name: /Root B · src\/shared\.ts:1/u })).toBeVisible();
  await page.keyboard.press("Escape");
  const editor = page.locator('[data-window-id="issue-2526-editor"]');
  await editor.getByRole("tab", { name: /Root A/u }).click();
  await expect(editor.getByRole("tab", { name: /Root A/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return { search, editor };
}

async function verifySequentialReplace(
  page: Page,
  search: Locator,
  harness: IssueHarness,
): Promise<void> {
  await search.getByLabel("Replacement").fill("thread");
  await search.getByRole("button", { name: "Preview replace" }).click();
  const applyA = search.getByRole("button", { name: "Apply reviewed replace in Root A" });
  const applyB = search.getByRole("button", { name: "Apply reviewed replace in Root B" });
  await expect(applyA).toBeVisible({ timeout: 45_000 });
  await expect(applyB).toBeVisible();
  const appliedA = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/editor/workspace-search/replace-apply"),
  );
  await applyA.click();
  expect((await appliedA).ok()).toBe(true);
  await expect(applyA).toBeDisabled();
  expect(readFileSync(join(harness.rootA.root, "src/shared.ts"), "utf8")).toContain("thread");
  expect(readFileSync(join(harness.rootB.root, "src/shared.ts"), "utf8")).toContain("needle");
  const appliedB = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/editor/workspace-search/replace-apply"),
  );
  await applyB.click();
  expect((await appliedB).ok()).toBe(true);
  await expect(applyB).toBeDisabled();
  expect(readFileSync(join(harness.rootB.root, "src/shared.ts"), "utf8")).toContain("thread");
}

async function verifyExplicitCommandRoot(
  page: Page,
  editor: Locator,
  rootB: string,
): Promise<void> {
  const commandRequest = page.waitForRequest((request) =>
    requestTargetsRoot(request.url(), "/api/commands/catalog", rootB),
  );
  await page
    .locator('[data-window-id="issue-2526-commands"]')
    .getByRole("combobox", { name: "Commands root" })
    .selectOption(rootB);
  await commandRequest;
  await expect(editor.getByRole("tab", { name: /Root A/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect
    .poll(() => page.evaluate((key) => window.localStorage.getItem(key) ?? "", WORKSPACE_KEY))
    .toContain(rootB);
}

test.afterEach(() => {
  cleanupEditorWorkspaces();
});

test("search, Quick Open, replace, and bound windows retain explicit root identity", async ({
  page,
}, testInfo) => {
  const harness = createIssueHarness();
  await setupIssue(page, harness);
  const { search, editor } = await verifyDiscovery(page, testInfo);
  await verifySequentialReplace(page, search, harness);
  await verifyExplicitCommandRoot(page, editor, harness.rootB.root);
});
