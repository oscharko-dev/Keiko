import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupEditorWorkspaces,
  collectPageErrors,
  EDITOR_SELECTORS,
  firstPane,
  openEditorWorkspace,
  paneCount,
  typeIntoActiveEditor,
} from "./support/editorWorkspace.js";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const EVIDENCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "release",
  "2090-workspace-search-evidence.json",
);

const tempProjects: string[] = [];

interface WorkspaceSearchResponse {
  readonly results: readonly {
    readonly path: string;
    readonly lineRange: { readonly startLine: number; readonly endLine: number };
  }[];
  readonly truncated: boolean;
  readonly filesScanned: number;
  readonly elapsedMs: number;
}

function resolveCommit(): string {
  const fromEnv = process.env.GITHUB_SHA ?? process.env.KEIKO_PERF_COMMIT;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return Math.round(sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))] ?? 0);
}

function createWorkspace(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `keiko-2090-${name}-`));
  tempProjects.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "search-target.ts"),
    `export function searchTarget(): string {
  return "workspaceSearchNeedle";
}
`,
    "utf8",
  );
  writeFileSync(
    join(root, "src", "replace-target.ts"),
    `export const replaceTarget = "replaceNeedle";
`,
    "utf8",
  );
  writeFileSync(
    join(root, "src", "closed-replace.ts"),
    `export const closedReplaceTarget = "replaceNeedle";
`,
    "utf8",
  );
  writeFileSync(
    join(root, "src", "quick.ts"),
    `export const quickAccessValue = "quickAccessNeedle";
`,
    "utf8",
  );
  for (let index = 0; index < 40; index += 1) {
    writeFileSync(
      join(root, "src", `bulk-${String(index).padStart(2, "0")}.ts`),
      `export const bulk${String(index)} = "boundedNeedle";
`,
      "utf8",
    );
  }
  return root;
}

async function ensureProject(request: APIRequestContext, root: string): Promise<void> {
  const response = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name: "Keiko 2090 E2E" },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function workspaceSearch(
  request: APIRequestContext,
  root: string,
  query: string,
  maxResults: number,
): Promise<WorkspaceSearchResponse> {
  const response = await request.post("/api/editor/workspace-search", {
    headers: MUTATION_HEADERS,
    data: {
      root,
      query,
      mode: "literal",
      caseSensitive: false,
      includeGlobs: [],
      excludeGlobs: [],
      maxResults,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as WorkspaceSearchResponse;
}

async function seedWindows(page: Page, windows: readonly Record<string, unknown>[]): Promise<void> {
  await page.addInitScript((entries) => {
    window.localStorage.setItem("keiko.theme", "dark");
    window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
    window.localStorage.setItem("keiko.workspace.v4", JSON.stringify(entries));
    window.localStorage.removeItem("keiko.conns.v1");
  }, windows);
}

function shortcutModifier(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control";
}

async function waitForShell(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Open quick access" })).toBeVisible();
  await expect(page.getByRole("main", { name: "Workspace surface" })).toBeVisible();
}

async function openSearchPanel(page: Page): Promise<Locator> {
  await waitForShell(page);
  await page.keyboard.press(`${shortcutModifier()}+Shift+KeyF`);
  const searchbox = page.getByRole("searchbox", { name: "Search files and symbols" });
  await expect(searchbox).toBeEnabled();
  return searchbox;
}

async function openQuickAccess(page: Page): Promise<Locator> {
  await waitForShell(page);
  await page.keyboard.press(`${shortcutModifier()}+KeyP`);
  const quickInput = page.getByRole("combobox", {
    name: /workspace file or symbol query/i,
  });
  await expect(quickInput).toBeVisible();
  return quickInput;
}

// Monaco tags its two side-by-side panes `.original-in-monaco-diff-editor` / `-modified-`, so the
// before/after text can be asserted directly instead of depending on which file is selected first.
async function expectReplacePreviewDiff(diffEditor: Locator): Promise<void> {
  const page = diffEditor.page();
  await expect(diffEditor).toBeVisible();
  await expect(page.getByTestId("keiko-diff-file")).toHaveCount(2);
  await page.getByTestId("keiko-diff-file").filter({ hasText: "replace-target.ts" }).click();
  await expect(
    diffEditor.locator(".original-in-monaco-diff-editor .view-line", { hasText: "replaceNeedle" }),
  ).toBeVisible();
  await expect(
    diffEditor.locator(".modified-in-monaco-diff-editor .view-line", { hasText: "replaceDone" }),
  ).toBeVisible();
}

test.afterAll(() => {
  cleanupEditorWorkspaces();
  while (tempProjects.length > 0) {
    const root = tempProjects.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

test("workspace search route records bounded latency and result evidence @release-evidence", async ({
  request,
}) => {
  const root = createWorkspace("perf");
  await ensureProject(request, root);
  const runs = Number.parseInt(process.env.KEIKO_PERF_RUNS ?? "3", 10);
  const samples: number[] = [];
  const resultCounts: number[] = [];
  for (let index = 0; index < Math.max(1, runs); index += 1) {
    const started = performance.now();
    const body = await workspaceSearch(request, root, "boundedNeedle", 12);
    samples.push(Math.round(performance.now() - started));
    resultCounts.push(body.results.length);
    expect(body.results.length).toBeLessThanOrEqual(12);
    expect(body.truncated).toBe(true);
  }
  const evidence = {
    schemaVersion: 1,
    issue: 2090,
    commit: resolveCommit(),
    measuredAtIso: new Date().toISOString(),
    workspaceSearch: {
      runs: samples.length,
      budgetP50Ms: 200,
      budgetP95Ms: 500,
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
      maxResultsRequested: 12,
      maxObservedResultCount: Math.max(...resultCounts),
      resultBoundHeld: resultCounts.every((count) => count <= 12),
    },
  };
  expect(evidence.workspaceSearch.p50Ms).toBeLessThanOrEqual(evidence.workspaceSearch.budgetP50Ms);
  expect(evidence.workspaceSearch.p95Ms).toBeLessThanOrEqual(evidence.workspaceSearch.budgetP95Ms);
  expect(evidence.workspaceSearch.resultBoundHeld).toBe(true);
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
});

test("workspace search panel opens a result at its reported start line", async ({
  page,
  request,
}) => {
  const root = createWorkspace("search-ui");
  await ensureProject(request, root);
  const searchResponse = await workspaceSearch(request, root, "workspaceSearchNeedle", 5);
  const reportedRange = searchResponse.results.find(
    (result) => result.path === "src/search-target.ts",
  )?.lineRange;
  expect(reportedRange).toBeDefined();
  if (reportedRange === undefined) return;
  const pageErrors = collectPageErrors(page);
  await seedWindows(page, []);
  await page.goto("/");
  const searchbox = await openSearchPanel(page);
  await searchbox.fill("workspaceSearchNeedle");
  await expect(page.getByRole("group", { name: "src/search-target.ts" })).toBeVisible();
  const option = page.getByRole("option").filter({ hasText: "workspaceSearchNeedle" }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.locator(EDITOR_SELECTORS.workspace).first()).toBeVisible();
  await expect(page.getByRole("tab", { name: /search-target\.ts/ })).toBeVisible();
  const cursorField = firstPane(page.locator(EDITOR_SELECTORS.workspace).first()).locator(
    `${EDITOR_SELECTORS.statusBar} [data-field="cursor"]`,
  );
  await expect(cursorField).toHaveAttribute("aria-label", /^Line \d+, column \d+$/u);
  const label = await cursorField.getAttribute("aria-label");
  const line = Number(/^Line (\d+), column \d+$/u.exec(label ?? "")?.[1] ?? "0");
  expect(line).toBe(reportedRange.startLine);
  expect(pageErrors).toEqual([]);
});

test("replace preview applies closed files and dirty open buffers only after confirmation", async ({
  page,
  request,
}) => {
  const root = createWorkspace("replace-ui");
  await ensureProject(request, root);
  const pageErrors = collectPageErrors(page);
  await seedWindows(page, [
    {
      id: "editor-2090",
      type: "editor",
      x: 24,
      y: 24,
      w: 760,
      h: 620,
      z: 10,
      cfg: { root, file: "src/replace-target.ts", openFiles: ["src/replace-target.ts"] },
      max: false,
    },
  ]);
  await page.goto("/");
  const workspace = await openEditorWorkspace(page);
  await typeIntoActiveEditor(
    page,
    firstPane(workspace),
    `export const replaceTarget = "replaceNeedle";
export const unsavedOnly = true;
`,
  );
  const searchbox = await openSearchPanel(page);
  await searchbox.fill("replaceNeedle");
  await page.getByLabel("Replacement").fill("replaceDone");
  await page.getByRole("button", { name: "Preview replace" }).click();
  await expect(page.getByText("2 replacements across 2 files.")).toBeVisible();
  expect(readFileSync(join(root, "src", "replace-target.ts"), "utf8")).toContain("replaceNeedle");
  expect(readFileSync(join(root, "src", "closed-replace.ts"), "utf8")).toContain("replaceNeedle");
  await expectReplacePreviewDiff(page.getByTestId("keiko-diff-editor"));
  await page.getByRole("button", { name: "Apply reviewed replace" }).click();
  await expect(page.getByText("2 files applied.")).toBeVisible();
  await expect(
    workspace.locator(".monaco-editor .view-line").filter({ hasText: "replaceDone" }),
  ).toBeVisible();
  expect(readFileSync(join(root, "src", "replace-target.ts"), "utf8")).toContain("replaceNeedle");
  expect(readFileSync(join(root, "src", "closed-replace.ts"), "utf8")).toContain("replaceDone");
  expect(pageErrors).toEqual([]);
});

test("workspace symbols and quick access route through the unified reveal-at-line flow", async ({
  page,
  request,
}) => {
  const root = createWorkspace("quick-access");
  await ensureProject(request, root);
  const pageErrors = collectPageErrors(page);
  await seedWindows(page, []);
  await page.goto("/");
  const quickInput = await openQuickAccess(page);
  await quickInput.fill("quick.ts");
  await expect(page.getByRole("option").filter({ hasText: "src/quick.ts" }).first()).toBeVisible();
  await quickInput.fill(">theme");
  await expect(
    page.getByRole("option").filter({ hasText: "Toggle light / dark theme" }).first(),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Command query" }).fill("");
  const fileInput = page.getByRole("combobox", {
    name: /workspace file or symbol query/i,
  });
  await expect(fileInput).toBeVisible();
  await fileInput.fill("searchTarget");
  await page.getByRole("option").filter({ hasText: "searchTarget" }).first().click();
  await expect(page.getByRole("tab", { name: /search-target\.ts/ })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("editor-scoped commands run through the unified quick-access palette's command mode", async ({
  page,
  request,
}) => {
  const root = createWorkspace("quick-access-editor");
  await ensureProject(request, root);
  const pageErrors = collectPageErrors(page);
  await seedWindows(page, [
    {
      id: "editor-2090-commands",
      type: "editor",
      x: 24,
      y: 24,
      w: 760,
      h: 620,
      z: 10,
      // Splitting moves the active file into a new pane, so at least two open tabs are required —
      // a single-tab pane has nothing left to leave behind and the split is a documented no-op
      // (`splitPane` in `editor-layout.ts`).
      cfg: {
        root,
        file: "src/search-target.ts",
        openFiles: ["src/search-target.ts", "src/quick.ts"],
      },
      max: false,
    },
  ]);
  await page.goto("/");
  const workspace = await openEditorWorkspace(page);
  expect(await paneCount(workspace)).toBe(1);
  const quickInput = await openQuickAccess(page);
  await quickInput.fill(">");
  await expect(
    page.getByRole("option").filter({ hasText: "Toggle light / dark theme" }).first(),
  ).toBeVisible();
  const splitOption = page.getByRole("option").filter({ hasText: "Split Editor Right" }).first();
  await expect(splitOption).toBeVisible();
  await splitOption.click();
  await expect(workspace.locator(EDITOR_SELECTORS.pane)).toHaveCount(2);
  expect(pageErrors).toEqual([]);
});
