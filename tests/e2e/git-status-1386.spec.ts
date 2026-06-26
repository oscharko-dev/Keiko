import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Keeps the status and diff fixtures adjacent so this browser smoke proves the same BFF contract.
// eslint-disable-next-line max-lines-per-function
async function routeGitBff(page: Page, roots: string[]): Promise<void> {
  await page.route("**/api/git/status**", async (route) => {
    const url = new URL(route.request().url());
    roots.push(url.searchParams.get("root") ?? "");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        root: url.searchParams.get("root") ?? "",
        repositoryRoot: url.searchParams.get("root") ?? "",
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
            path: "package.json",
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
      }),
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
