import { expect, test, type Locator, type Page } from "@playwright/test";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import { validateWorkspaceManifest } from "@oscharko-dev/keiko-contracts/runtime/workspace-manifest";

import {
  cleanupEditorWorkspaces,
  createEditorWorkspace,
  EDITOR_SELECTORS,
  firstPane,
  revokeEditorWorkspaceTrust,
} from "./support/editorWorkspace.js";
import { replaceEditorBuffer } from "./support/editor-chord.js";
import { editorM11PairingFragment } from "./support/editor-m11-app-session.js";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const WORKSPACE_KEY = "keiko.workspace.v4";

async function registerProject(page: Page, root: string, name: string): Promise<void> {
  const response = await page.request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function seedFilesWindow(page: Page, root: string): Promise<void> {
  await page.addInitScript(
    ({ key, projectRoot }) => {
      window.localStorage.setItem("keiko.theme", "dark");
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      const seededKey = `${key}.issue-2525-seeded`;
      if (window.sessionStorage.getItem(seededKey) === "1") return;
      window.localStorage.setItem(
        key,
        JSON.stringify([
          {
            id: "issue-2525-files",
            type: "files",
            x: 20,
            y: 20,
            w: 430,
            h: 690,
            z: 10,
            cfg: { root: projectRoot },
            max: false,
          },
          {
            id: "issue-2525-trust",
            type: "workspaceTrust",
            x: 990,
            y: 20,
            w: 400,
            h: 690,
            z: 11,
            cfg: {},
            max: false,
          },
        ]),
      );
      window.sessionStorage.setItem(seededKey, "1");
    },
    { key: WORKSPACE_KEY, projectRoot: root },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestFromList(value: unknown, root: string): WorkspaceManifest {
  if (!isRecord(value)) {
    throw new Error("workspace manifest list unavailable");
  }
  const manifests = value.manifests;
  if (!Array.isArray(manifests)) throw new Error("workspace manifest list invalid");
  for (const candidate of manifests as readonly unknown[]) {
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

async function openFileFromRoot(page: Page, group: Locator, path: string): Promise<void> {
  await group.locator(`[role="treeitem"].tr-file[data-path=${JSON.stringify(path)}]`).click();
  await group.getByRole("button", { name: "Open in editor" }).click();
  await expect(page.locator(`${EDITOR_SELECTORS.workspace}:visible`)).toHaveCount(1);
}

async function verifyResponsiveExplorer(page: Page): Promise<void> {
  const explorer = page.locator("[data-multi-root-explorer]");
  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const width = await explorer.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
  const violations = seriousOrCritical(await runAxe(page, "[data-multi-root-explorer]"));
  expect(violations, formatViolations(violations)).toEqual([]);
}

async function storedWorkspace(page: Page): Promise<string> {
  return page.evaluate((key) => window.localStorage.getItem(key) ?? "", WORKSPACE_KEY);
}

async function revokeRootTrust(page: Page, root: Locator, projectName: string): Promise<void> {
  const revokeButton = page.getByRole("button", { name: "Revoke", exact: true });
  const trustCard = page
    .getByTestId("workspace-trust-panel")
    .getByTestId("workspace-trust-root")
    .filter({ hasText: projectName, has: revokeButton });
  await expect(trustCard).toBeVisible();
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "DELETE" &&
      candidate.url().endsWith("/api/editor/verification/trust"),
  );
  await trustCard.getByRole("button", { name: "Revoke" }).evaluate((button: HTMLElement) => {
    button.click();
  });
  await page
    .getByRole("alertdialog", { name: "Revoke trust for this workspace?" })
    .getByRole("button", { name: "Revoke trust" })
    .evaluate((button: HTMLElement) => {
      button.click();
    });
  expect((await response).status()).toBe(200);
  await expect(root.getByLabel("Restricted Mode")).toBeVisible();
  await page
    .getByRole("button", { name: "Close Workspace Trust window" })
    .evaluate((button: HTMLElement) => {
      button.click();
    });
}

function createMultiRootFixtures(): readonly [
  ReturnType<typeof createEditorWorkspace>,
  ReturnType<typeof createEditorWorkspace>,
] {
  return [
    createEditorWorkspace([
      { path: "a.txt", content: "root A\n" },
      { path: "package.json", content: '{"name":"multi-root-a","private":true}\n' },
    ]),
    createEditorWorkspace([
      { path: "b.txt", content: "root B\n" },
      { path: "package.json", content: '{"name":"multi-root-b","private":true}\n' },
    ]),
  ];
}

async function pairAppSession(page: Page): Promise<void> {
  await page.goto(`/${editorM11PairingFragment("2525")}`);
  await expect.poll(() => page.url()).not.toContain("keiko-app-session");
}

test.afterEach(() => {
  cleanupEditorWorkspaces();
});

test("two roots retain independent editor and trust state through focused-root changes", async ({
  page,
  browserName,
}) => {
  // KNOWN CROSS-ENGINE GAP — Gecko only, tracked, NOT a silent exclusion.
  // This journey replaces the whole editor buffer (`replaceEditorBuffer`) before asserting. Monaco
  // 0.56 uses the EditContext API where it exists and falls back to `textarea.inputarea` where it
  // does not; Firefox has no EditContext. On that fallback surface neither Ctrl+A nor Cmd+A reaches
  // Monaco's keybinding service, so the replacement paste leaves stale model content behind.
  // Verified on this host, not assumed: running this very spec with --project=firefox fails inside
  // the shared helper because no hot-exit write ever carries the requested exact full buffer — the
  // helper catches the corruption where it happens instead of accepting a visible first-line anchor
  // while stale content survives. Same gap as release-smoke.spec.ts.
  //
  // This config inherits BOTH projects from the shared base config, but its npm script pins
  // --project=chromium, so this guard changes no CI lane today; it exists so a future firefox run
  // fails as a documented skip rather than as a confusing corruption error.
  test.skip(
    browserName === "firefox",
    "Monaco select-all does not reach the EditContext fallback surface on Gecko; the buffer-replacement gesture is unproven there",
  );

  const [a, b] = createMultiRootFixtures();
  await pairAppSession(page);
  await registerProject(page, a.root, "Multi-root A");
  await registerProject(page, b.root, "Multi-root B");
  await addSecondRoot(page, a.root, b.root);
  await revokeEditorWorkspaceTrust(page.request, a.root);
  await revokeEditorWorkspaceTrust(page.request, b.root);
  await seedFilesWindow(page, a.root);
  await page.goto("/");

  const rootA = page.getByRole("treeitem", { name: "Multi-root A" });
  const rootB = page.getByRole("treeitem", { name: "Multi-root B" });
  await expect(rootA).toBeVisible();
  await expect(rootB).toBeVisible();
  await openFileFromRoot(page, rootA, "a.txt");
  const grantResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      candidate.url().endsWith("/api/editor/verification/trust"),
  );
  await page
    .getByRole("alertdialog", { name: "Trust this workspace?" })
    .getByRole("button", { name: "Trust workspace" })
    .click();
  expect((await grantResponse).status()).toBe(200);
  await expect(rootA.getByLabel("Trusted workspace")).toBeVisible();

  const editor = page.locator(`${EDITOR_SELECTORS.workspace}:visible`);
  await replaceEditorBuffer(page, firstPane(editor), "dirty root A\n", a.root);
  await expect(editor.locator(`${EDITOR_SELECTORS.tab}[data-dirty='true']`)).toHaveCount(1);
  await expect.poll(() => storedWorkspace(page)).toContain("rootSessionsJson");
  await expect.poll(() => storedWorkspace(page)).toContain("a.txt");

  await page.getByRole("tab", { name: /Multi-root B/u }).click();
  const trustPrompt = page.getByRole("alertdialog", { name: "Trust this workspace?" });
  await expect(trustPrompt).toBeVisible();
  await trustPrompt.getByRole("button", { name: "Stay restricted" }).click();
  await editor.locator('[role="treeitem"].tr-file[data-path="b.txt"]').click();
  await expect(rootB).toHaveAttribute("aria-selected", "true");
  await expect(editor).toContainText("b.txt");
  await expect.poll(() => storedWorkspace(page)).toContain("b.txt");
  await page.getByRole("tab", { name: /Multi-root A/u }).click();
  await expect(editor.locator(`${EDITOR_SELECTORS.tab}[data-dirty='true']`)).toHaveCount(1);
  await expect(editor).toContainText("a.txt");

  await expect(rootA.getByLabel("Trusted workspace")).toBeVisible();
  await expect(rootB.getByLabel("Restricted Mode")).toBeVisible();
  await revokeRootTrust(page, rootA, "Multi-root A");
  await verifyResponsiveExplorer(page);
});
