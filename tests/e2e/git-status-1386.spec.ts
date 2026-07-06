import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAG = "@git-status-1386";
const tempProjects: string[] = [];

test.afterAll(() => {
  for (const root of tempProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-git-"));
  tempProjects.push(root);
  writeFileSync(join(root, "package.json"), '{"name":"old"}\n', "utf8");
  return root;
}

function createNestedProject(): { readonly parent: string; readonly nested: string } {
  const parent = mkdtempSync(join(tmpdir(), "keiko-e2e-git-parent-"));
  const nested = join(parent, "SpringAI Showcase");
  tempProjects.push(parent);
  mkdirSync(nested);
  writeFileSync(join(nested, "pom.xml"), "<project />\n", "utf8");
  return { parent, nested };
}

async function seedFilesWindow(page: Page, root: string): Promise<void> {
  await page.addInitScript((projectRoot) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-1386-files",
          type: "files",
          x: 64,
          y: 56,
          w: 640,
          h: 680,
          z: 10,
          cfg: { root: projectRoot },
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  }, root);
}

function changedGitStatus(root: string, path: string): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "1",
    root,
    repositoryRoot: root,
    state: "available",
    available: true,
    branch: "main",
    detached: false,
    clean: false,
    stagedCount: 0,
    unstagedCount: 1,
    untrackedCount: 0,
    conflictedCount: 0,
    changes: [
      {
        path,
        indexStatus: " ",
        worktreeStatus: "M",
        staged: false,
        unstaged: true,
        untracked: false,
        conflicted: false,
      },
    ],
    truncated: false,
    maxChanges: 500,
  };
}

function unavailableGitStatus(root: string): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "1",
    root,
    state: "unavailable",
    available: false,
    reason: "not-a-repository",
    detached: false,
    clean: true,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    changes: [],
    truncated: false,
    maxChanges: 500,
  };
}

// Keeps the status and diff fixtures adjacent so this browser smoke proves the same BFF contract.
async function routeGitBff(page: Page, roots: string[]): Promise<void> {
  await page.route("**/api/git/status**", async (route) => {
    const url = new URL(route.request().url());
    const root = url.searchParams.get("root") ?? "";
    roots.push(root);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(changedGitStatus(root, "package.json")),
    });
  });

  await page.route("**/api/git/diff**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        root: url.searchParams.get("root") ?? "",
        repositoryRoot: url.searchParams.get("root") ?? "",
        state: "available",
        available: true,
        path: url.searchParams.get("path") ?? "",
        scope: "all",
        diff: 'diff --git a/package.json b/package.json\n-{"name":"old"}\n+{"name":"new"}\n',
        truncated: false,
        maxBytes: 131072,
      }),
    });
  });
}

// Same mocked BFF contract as routeGitBff, but parent folders are not repositories and the nested
// project is. This covers the Files window state transition behind issue #1963's Windows screenshot.
async function routeNestedGitBff(
  page: Page,
  nestedRoot: string,
  statusRoots: string[],
  diffRequests: { readonly root: string; readonly path: string }[],
): Promise<void> {
  await page.route("**/api/git/status**", async (route) => {
    const url = new URL(route.request().url());
    const root = url.searchParams.get("root") ?? "";
    statusRoots.push(root);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        root === nestedRoot ? changedGitStatus(root, "pom.xml") : unavailableGitStatus(root),
      ),
    });
  });

  await page.route("**/api/git/diff**", async (route) => {
    const url = new URL(route.request().url());
    const root = url.searchParams.get("root") ?? "";
    const path = url.searchParams.get("path") ?? "";
    diffRequests.push({ root, path });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        root,
        repositoryRoot: root,
        state: "available",
        available: true,
        path,
        scope: "all",
        diff: "diff --git a/pom.xml b/pom.xml\n-old\n+new\n",
        truncated: false,
        maxBytes: 131072,
      }),
    });
  });
}

test(`Files window shows Git status and opens diff ${TAG}`, async ({ page }) => {
  const root = createProject();
  const statusRoots: string[] = [];
  await seedFilesWindow(page, root);
  await routeGitBff(page, statusRoots);

  await page.goto("/");
  const filesWindow = page.getByRole("region", { name: /^Files/u });
  await expect(filesWindow).toBeVisible();
  await expect(filesWindow.getByText(/Git main 1 changed file/u)).toBeVisible();
  await expect(filesWindow.getByRole("treeitem", { name: /package\.json M/u })).toBeVisible();

  await filesWindow.getByRole("button", { name: "View Git diff for package.json" }).click();
  await expect(filesWindow.getByRole("region", { name: "Git diff: package.json" })).toContainText(
    '{"name":"new"}',
  );
  await expect
    .poll(() => statusRoots.includes(root), { message: "status fetched with selected root" })
    .toBe(true);
});

test(`Files window recognizes Git after entering a nested project ${TAG}`, async ({ page }) => {
  const { parent, nested } = createNestedProject();
  const statusRoots: string[] = [];
  const diffRequests: { readonly root: string; readonly path: string }[] = [];
  await seedFilesWindow(page, parent);
  await routeNestedGitBff(page, nested, statusRoots, diffRequests);

  await page.goto("/");
  const filesWindow = page.getByRole("region", { name: /^Files/u });
  await expect(filesWindow).toBeVisible();
  await filesWindow.getByRole("treeitem", { name: "SpringAI Showcase" }).click();

  await expect(filesWindow.getByText(/Git main 1 changed file/u)).toBeVisible();
  await expect(filesWindow.getByRole("treeitem", { name: /pom\.xml M/u })).toBeVisible();

  await filesWindow
    .getByRole("button", { name: "View Git diff for SpringAI Showcase/pom.xml" })
    .click();
  await expect(
    filesWindow.getByRole("region", { name: "Git diff: SpringAI Showcase/pom.xml" }),
  ).toContainText("+new");
  await expect
    .poll(() => statusRoots.includes(nested), { message: "status fetched with nested root" })
    .toBe(true);
  await expect
    .poll(
      () => diffRequests.some((request) => request.root === nested && request.path === "pom.xml"),
      { message: "diff fetched with nested root-relative path" },
    )
    .toBe(true);
});
