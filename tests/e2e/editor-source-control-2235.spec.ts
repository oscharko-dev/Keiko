import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitEditorDiffResponse } from "@oscharko-dev/keiko-contracts";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import {
  EDITOR_SELECTORS,
  cleanupEditorWorkspaces,
  collectPageErrors,
  createGitEditorWorkspace,
  openEditorWorkspace,
  seedEditorWindow,
  typeIntoActiveEditor,
  type GitEditorWorkspace,
} from "./support/editorWorkspace.js";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };

interface AgentSession {
  readonly sessionId?: unknown;
  readonly workspaceRoot?: unknown;
  readonly activeFile?: unknown;
}

interface CodingContextWireResponse {
  readonly pack?: {
    readonly entries?: readonly { readonly sourceKind?: unknown; readonly id?: unknown }[];
    readonly omissions?: readonly { readonly sourceKind?: unknown; readonly reason?: unknown }[];
  };
}

test.afterEach(() => {
  cleanupEditorWorkspaces();
});

async function openFixtureEditor(
  page: Page,
  fixture: GitEditorWorkspace,
  active: string,
): Promise<Locator> {
  await seedEditorWindow(page, {
    root: fixture.root,
    active,
    openFiles: [active],
    windowId: `editor-source-control-2235-${active.replaceAll("/", "-")}`,
    resetWorkspace: true,
    maximized: true,
  });
  await page.goto("/");
  const workspace = await openEditorWorkspace(page);
  await expect(workspace.locator(EDITOR_SELECTORS.monaco).first()).toBeVisible();
  return workspace;
}

async function runEditorCommand(page: Page, workspace: Locator, label: string): Promise<void> {
  await workspace.getByRole("textbox", { name: /^Editor:/u }).focus();
  await page.keyboard.press("F1");
  const palette = page.locator(".quick-input-widget");
  await expect(palette).toBeVisible();
  await palette.locator("input").fill(`>${label}`);
  await expect(
    palette.locator(".quick-input-list").getByText(label, { exact: true }).first(),
  ).toBeVisible();
  await page.keyboard.press("Enter");
}

async function placeCursorAtLine(page: Page, workspace: Locator, line: number): Promise<void> {
  const input = workspace.getByRole("textbox", { name: /^Editor:/u });
  await input.focus();
  await page.keyboard.press("Control+Home");
  for (let current = 1; current < line; current += 1) await page.keyboard.press("ArrowDown");
  await expect(workspace.locator('[data-field="cursor"]')).toContainText(`Ln ${String(line)}`);
}

async function currentSessionId(
  request: APIRequestContext,
  fixture: GitEditorWorkspace,
): Promise<string | null> {
  const response = await request.get("/api/editor/agent/sessions");
  if (!response.ok()) return null;
  const body = (await response.json()) as { readonly sessions?: readonly AgentSession[] };
  const session = body.sessions?.find(
    (candidate) =>
      candidate.workspaceRoot === fixture.root && candidate.activeFile === fixture.conflictPath,
  );
  return typeof session?.sessionId === "string" ? session.sessionId : null;
}

async function seedFilesAndEditorWindows(page: Page, fixture: GitEditorWorkspace): Promise<void> {
  await page.addInitScript(
    ({ root, file }) => {
      window.localStorage.setItem("keiko.theme", "dark");
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "source-control-files-2235",
            type: "files",
            x: 10,
            y: 10,
            w: 440,
            h: 650,
            z: 10,
            cfg: { root },
            max: false,
          },
          {
            id: "source-control-editor-2235",
            type: "editor",
            x: 465,
            y: 10,
            w: 760,
            h: 650,
            z: 11,
            cfg: { root, file, openFiles: [file] },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { root: fixture.root, file: fixture.nestedChangedPath },
  );
}

async function readStructuredDiff(
  request: APIRequestContext,
  fixture: GitEditorWorkspace,
  scope: "staged" | "unstaged",
): Promise<GitEditorDiffResponse> {
  const query = new URLSearchParams({ root: fixture.root, path: fixture.stagedPath, scope });
  const response = await request.get(`/api/git/diff/structured?${query.toString()}`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as GitEditorDiffResponse;
}

test("staged and unstaged gutter channels open the bounded hunk peek", async ({
  page,
  request,
}) => {
  const fixture = createGitEditorWorkspace();
  const errors = collectPageErrors(page);
  const [staged, unstaged] = await Promise.all([
    readStructuredDiff(request, fixture, "staged"),
    readStructuredDiff(request, fixture, "unstaged"),
  ]);
  expect(
    staged.files.some((entry) =>
      entry.hunks.some((hunk) => hunk.lines.some((line) => line.text.includes('staged = "index"'))),
    ),
  ).toBe(true);
  expect(
    unstaged.files.some((entry) =>
      entry.hunks.some((hunk) =>
        hunk.lines.some((line) => line.text.includes('unstaged = "worktree"')),
      ),
    ),
  ).toBe(true);
  const workspace = await openFixtureEditor(page, fixture, fixture.stagedPath);

  await workspace.getByRole("button", { name: /Refresh (?:editor )?change indicators/u }).click();
  await expect(workspace.locator(".keiko-git-gutter-staged").first()).toBeVisible();
  await expect(workspace.locator(".keiko-git-gutter-unstaged").first()).toBeVisible();
  await placeCursorAtLine(page, workspace, 4);
  await runEditorCommand(page, workspace, "Open change hunk");

  const peek = workspace.getByRole("dialog", { name: /Change preview.*Unstaged change/u });
  await expect(peek).toBeVisible();
  await expect(peek).toContainText('unstaged = "worktree"');
  await expect(peek.getByRole("button", { name: "Close change preview" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  expect(errors).toEqual([]);
});

test("on-demand blame opens its commit in the internal Git history", async ({ page }) => {
  const fixture = createGitEditorWorkspace();
  const errors = collectPageErrors(page);
  const workspace = await openFixtureEditor(page, fixture, fixture.blamePath);

  const editorInput = workspace.getByRole("textbox", { name: /^Editor:/u });
  await editorInput.focus();
  await page.keyboard.press("ArrowRight");
  await expect(workspace.locator('[data-field="cursor"]')).toContainText("Ln 1");
  await runEditorCommand(page, workspace, "Toggle line blame");
  await expect(workspace.locator(".keiko-blame-gutter").first()).toBeVisible();
  await runEditorCommand(page, workspace, "Open line commit in Git");

  const git = page.locator('[aria-label="Git"]').last();
  await expect(git).toBeVisible();
  await expect(git.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  await expect(git.getByRole("option", { selected: true })).toContainText(
    "test: seed source-control fixture",
  );
  await expect(git.getByRole("region", { name: "Commit details" })).toContainText(
    fixture.baseCommit,
  );
  expect(errors).toEqual([]);
});

test("conflict actions are navigable, undoable, and remain buffer-only until save", async ({
  page,
}) => {
  const fixture = createGitEditorWorkspace();
  const errors = collectPageErrors(page);
  const workspace = await openFixtureEditor(page, fixture, fixture.conflictPath);
  const tab = workspace.getByRole("tab", { name: /merge conflicts/u });
  await expect(tab).toHaveAttribute("data-merge-conflicts", "2");
  await runEditorCommand(page, workspace, "Go to next merge conflict");
  await expect(workspace.locator('[data-field="cursor"]')).not.toContainText("Ln 1, Col 1");
  await runEditorCommand(page, workspace, "Go to previous merge conflict");
  await expect(workspace.locator('[data-field="cursor"]')).toContainText("Ln 1, Col 1");
  await runEditorCommand(page, workspace, "Accept incoming change");
  await expect(tab).toHaveAttribute("data-merge-conflicts", "1");
  expect(readFileSync(join(fixture.root, fixture.conflictPath), "utf8")).toBe(
    fixture.conflictDiskContent,
  );

  await workspace.locator(EDITOR_SELECTORS.monaco).first().click();
  await page.keyboard.press("Control+KeyZ");
  await expect(tab).toHaveAttribute("data-merge-conflicts", "2");
  await runEditorCommand(page, workspace, "Accept current change");
  await expect(tab).toHaveAttribute("data-merge-conflicts", "1");
  expect(readFileSync(join(fixture.root, fixture.conflictPath), "utf8")).toBe(
    fixture.conflictDiskContent,
  );

  await workspace.getByRole("button", { name: "Save", exact: true }).click();
  await expect(workspace.locator(EDITOR_SELECTORS.saveField)).toHaveText("Saved");
  await expect
    .poll(() => readFileSync(join(fixture.root, fixture.conflictPath), "utf8"))
    .not.toBe(fixture.conflictDiskContent);
  expect(readFileSync(join(fixture.root, fixture.conflictPath), "utf8")).toContain(
    'first = "ours"',
  );
  expect(errors).toEqual([]);
});

test("Files reflects conflict, folder, ignored, and post-save status", async ({ page }) => {
  const fixture = createGitEditorWorkspace();
  await seedFilesAndEditorWindows(page, fixture);
  const errors = collectPageErrors(page);
  let statusReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/git/status") statusReads += 1;
  });
  await page.goto("/");
  const files = page.getByRole("region", { name: /^Files/u });
  await expect(files).toBeVisible();
  const src = files.locator(`${EDITOR_SELECTORS.treeRow}[data-path="src"]`);
  await expect(src.getByLabel(/conflict/u)).toBeVisible();
  await files.getByRole("button", { name: "Expand folder: src" }).click();
  const merge = files.locator(`${EDITOR_SELECTORS.treeRow}[data-path="src/merge"]`);
  await expect(merge.getByLabel(/conflict/u)).toBeVisible();
  const nested = files.locator(`${EDITOR_SELECTORS.treeRow}[data-path="src/nested"]`);
  await expect(nested.getByLabel(/Git change/u)).toBeVisible();
  await files.getByRole("button", { name: "Expand folder: merge" }).click();
  await expect(files.getByLabel(`Git conflict: ${fixture.conflictPath}`)).toBeVisible();

  await files.getByRole("button", { name: "Expand folder: tmp" }).click();
  await expect(
    files.getByRole("treeitem", { name: /ignored\.log, Ignored by Git/u }),
  ).toBeVisible();
  const beforeSave = statusReads;
  const workspace = page.locator(EDITOR_SELECTORS.workspace).first();
  await typeIntoActiveEditor(
    page,
    workspace.locator(EDITOR_SELECTORS.pane).first(),
    "export const nested = 2235;\n",
  );
  await page.keyboard.press("Control+KeyS");
  await expect(workspace.locator(EDITOR_SELECTORS.saveField)).toHaveText("Saved");
  await expect.poll(() => statusReads).toBeGreaterThan(beforeSave);
  await expect(nested.getByLabel(/Git change/u)).toBeVisible();
  expect(errors).toEqual([]);
});

test("docked editor session assembles conflict-aware git context through the real BFF", async ({
  page,
  request,
}) => {
  const fixture = createGitEditorWorkspace();
  const errors = collectPageErrors(page);
  await openFixtureEditor(page, fixture, fixture.conflictPath);
  await expect.poll(async () => currentSessionId(request, fixture)).not.toBeNull();
  const sessionId = await currentSessionId(request, fixture);
  if (sessionId === null) throw new Error("The docked editor session did not register.");

  const response = await request.post("/api/editor/context", {
    headers: MUTATION_HEADERS,
    data: {
      schemaVersion: "1",
      purpose: "diagnostic",
      editorSessionId: sessionId,
      root: fixture.root,
      documentPath: fixture.conflictPath,
      queryText: "Explain the current merge conflict",
      changedFiles: [fixture.conflictPath],
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as CodingContextWireResponse;
  const gitEntries =
    body.pack?.entries?.filter((entry) => entry.sourceKind === "git-context") ?? [];
  expect(gitEntries.some((entry) => entry.id === "git-context-summary")).toBe(true);
  expect(body.pack?.omissions).not.toContainEqual({
    sourceKind: "git-context",
    reason: "unavailable",
  });
  expect(JSON.stringify(body)).not.toContain(fixture.root);
  expect(JSON.stringify(body)).not.toContain("<<<<<<<");
  expect(errors).toEqual([]);
});
