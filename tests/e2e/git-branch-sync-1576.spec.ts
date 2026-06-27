import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// Issue #1576 (Epic #1571) browser evidence for the Git client branch, history, and sync
// workflows. The spec seeds the real governedGit window and builds a local bare remote plus working
// repository fixture. Routes are intercepted with deterministic local JSON so fetch/pull/push-state
// UI evidence never needs external credentials or provider access.

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "git-delivery", "evidence", "1576");
const ARTIFACT_NAMES = ["manifest.json", "git-branch-history-sync.png"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

const MANIFEST_ROUTES = [
  "/api/projects",
  "/api/git/branches",
  "/api/git/status",
  "/api/git/summary",
  "/api/git/history",
  "/api/git/remotes",
  "/api/git-delivery/local-branch/create",
  "/api/git-delivery/local-branch/switch",
  "/api/git-delivery/fetch/preview",
  "/api/git-delivery/fetch/execute",
  "/api/git-delivery/pull/preview",
  "/api/git-delivery/pull/execute",
  "/api/git-delivery/push/preview",
  "/api/git-delivery/push/execute",
] as const;

const MANIFEST_STATES = [
  "branch list and searchable branch switch",
  "new branch from selected real branch data with hidden hash",
  "history list and selected commit metadata",
  "behind -> pull",
  "ahead -> push",
  "no upstream -> publish upstream",
  "diverged -> fetch with merge guidance",
  "detached and conflicted blocked sync states",
] as const;

const MANIFEST_NOTES = [
  "The fixture uses git init --bare plus a local worktree remote; no external network or credentials.",
  "Read and mutation routes are intercepted for deterministic browser assertions.",
  "Branch create uses headRefHash internally; the UI assertions verify hashes are not rendered.",
] as const;

type SummaryMode = "behind" | "ahead" | "publish" | "diverged" | "detached" | "conflicted";

interface GitFixture {
  readonly worktreeRoot: string;
  readonly remoteRoot: string;
  readonly baseSha: string;
  readonly aheadSha: string;
}

interface RouteCalls {
  readonly branchCreates: unknown[];
  readonly branchSwitches: unknown[];
  readonly syncPreviews: unknown[];
  readonly syncExecutes: unknown[];
  readonly pushPreviews: unknown[];
  readonly pushExecutes: unknown[];
}

const tempRoots: string[] = [];

test.afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function buildGitFixture(): GitFixture {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-e2e-git-branch-sync-1576-")));
  tempRoots.push(fixtureRoot);
  const remoteRoot = join(fixtureRoot, "remote.git");
  const worktreeRoot = join(fixtureRoot, "worktree");

  git(["init", "--bare", "-q", remoteRoot], fixtureRoot);
  git(["init", "-q", worktreeRoot], fixtureRoot);
  git(["config", "user.email", "test@keiko.example"], worktreeRoot);
  git(["config", "user.name", "Keiko Test"], worktreeRoot);
  git(["config", "commit.gpgsign", "false"], worktreeRoot);
  git(["checkout", "-b", "main"], worktreeRoot);
  writeFileSync(join(worktreeRoot, "README.md"), "# Keiko fixture\n", "utf8");
  git(["add", "README.md"], worktreeRoot);
  git(["commit", "-m", "chore: seed branch sync fixture"], worktreeRoot);
  const baseSha = git(["rev-parse", "HEAD"], worktreeRoot).trim();
  git(["remote", "add", "origin", remoteRoot], worktreeRoot);
  git(["push", "-u", "origin", "main"], worktreeRoot);

  git(["checkout", "-b", "feature/local"], worktreeRoot);
  writeFileSync(join(worktreeRoot, "feature.txt"), "local branch evidence\n", "utf8");
  git(["add", "feature.txt"], worktreeRoot);
  git(["commit", "-m", "feat: local branch evidence"], worktreeRoot);
  const aheadSha = git(["rev-parse", "HEAD"], worktreeRoot).trim();

  return { worktreeRoot, remoteRoot, baseSha, aheadSha };
}

function jsonBody(body: unknown): { status: number; contentType: string; body: string } {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

function projectBody(fixture: GitFixture): unknown {
  return {
    projects: [
      {
        path: fixture.worktreeRoot,
        name: "keiko-git-branch-sync-1576",
        favorite: false,
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
        available: true,
      },
    ],
  };
}

function branchBody(fixture: GitFixture): unknown {
  return {
    schemaVersion: "1",
    root: fixture.worktreeRoot,
    repositoryRoot: fixture.worktreeRoot,
    state: "available",
    available: true,
    branches: [
      { name: "main", headRefHash: fixture.baseSha, current: true },
      { name: "feature/local", headRefHash: fixture.aheadSha, current: false },
    ],
    truncated: false,
  };
}

function baseStatusBody(fixture: GitFixture): Record<string, unknown> {
  return {
    schemaVersion: "1",
    root: fixture.worktreeRoot,
    repositoryRoot: fixture.worktreeRoot,
    state: "available",
    available: true,
    branch: "main",
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

function detachedStatusBody(fixture: GitFixture): unknown {
  return {
    ...baseStatusBody(fixture),
    branch: undefined,
    detached: true,
  };
}

function conflictedStatusBody(fixture: GitFixture): unknown {
  return {
    ...baseStatusBody(fixture),
    clean: false,
    conflictedCount: 1,
    changes: [
      {
        path: "src/conflict.ts",
        indexStatus: "U",
        worktreeStatus: "U",
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: true,
      },
    ],
  };
}

function statusBody(fixture: GitFixture, mode: SummaryMode): unknown {
  if (mode === "detached") return detachedStatusBody(fixture);
  if (mode === "conflicted") return conflictedStatusBody(fixture);
  return {
    ...baseStatusBody(fixture),
    branch: mode === "publish" ? "feature/local" : "main",
  };
}

function summaryBody(fixture: GitFixture, mode: SummaryMode): unknown {
  const base = {
    schemaVersion: "1",
    root: fixture.worktreeRoot,
    state: "available",
    available: true,
    branch: mode === "publish" ? "feature/local" : "main",
    detached: false,
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    clean: true,
    remotes: [{ name: "origin" }],
    truncated: false,
  };
  switch (mode) {
    case "behind":
      return { ...base, behind: 2 };
    case "ahead":
      return { ...base, ahead: 2 };
    case "publish":
      return { ...base, upstream: undefined, ahead: 1 };
    case "diverged":
      return { ...base, ahead: 2, behind: 3 };
    case "detached":
      return { ...base, branch: undefined, detached: true, upstream: undefined };
    case "conflicted":
      return { ...base, clean: false, conflictedCount: 1 };
  }
}

function historyBody(fixture: GitFixture): unknown {
  return {
    schemaVersion: "1",
    root: fixture.worktreeRoot,
    state: "available",
    available: true,
    entries: [
      {
        sha: fixture.aheadSha,
        shortSha: fixture.aheadSha.slice(0, 7),
        subject: "feat: local branch evidence",
        author: "Keiko Test",
        date: "2026-06-27T12:00:00Z",
        refs: ["feature/local"],
        parentCount: 1,
        changedFileCount: 1,
      },
      {
        sha: fixture.baseSha,
        shortSha: fixture.baseSha.slice(0, 7),
        subject: "chore: seed branch sync fixture",
        author: "Keiko Test",
        date: "2026-06-27T11:00:00Z",
        refs: ["main", "origin/main"],
        parentCount: 0,
        changedFileCount: 1,
      },
    ],
    limit: 50,
    skip: 0,
    truncated: false,
  };
}

function syncPreviewBody(operation: "fetch" | "pull", fixture: GitFixture, mode: SummaryMode): unknown {
  const summary = summaryBody(fixture, mode) as {
    readonly branch?: string;
    readonly detached: boolean;
    readonly upstream?: unknown;
    readonly ahead: number;
    readonly behind: number;
  };
  return {
    schemaVersion: "1",
    operation,
    available: true,
    state: "available",
    branch: summary.branch,
    detached: summary.detached,
    upstream: summary.upstream,
    remote: "origin",
    ahead: summary.ahead,
    behind: summary.behind,
    hasRemote: true,
    hasUpstream: summary.upstream !== undefined,
    dirty: false,
    executable: true,
  };
}

function syncExecuteBody(operation: "fetch" | "pull"): unknown {
  return {
    schemaVersion: "1",
    operation,
    status: "succeeded",
    available: true,
    branch: "main",
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    remote: "origin",
    ahead: 0,
    behind: 0,
    truncated: false,
  };
}

function pushPreviewBody(): unknown {
  return {
    schemaVersion: "1",
    remoteAlias: "origin",
    remoteBranchName: "main",
    sourceBranchName: "main",
    riskClass: "normal",
    wouldCreateRemoteBranch: false,
    wouldTriggerChecks: true,
    forceBlocked: false,
    preflightBlockingCodes: [],
    preflightAdvisoryCodes: [],
    policyOutcome: "allowed",
  };
}

function remotesBody(fixture: GitFixture): unknown {
  return {
    schemaVersion: "1",
    root: fixture.worktreeRoot,
    state: "available",
    available: true,
    remotes: [{ name: "origin" }],
    truncated: false,
  };
}

function emptyDiffBody(fixture: GitFixture): unknown {
  return {
    schemaVersion: "1",
    root: fixture.worktreeRoot,
    state: "available",
    available: true,
    scope: "worktree",
    diff: "",
    truncated: false,
    maxBytes: 131072,
  };
}

function parsePostBody(route: Route): unknown {
  const raw = route.request().postData();
  return raw === null ? null : JSON.parse(raw);
}

async function installReadRoutes(
  page: Page,
  fixture: GitFixture,
  modeRef: { value: SummaryMode },
): Promise<void> {
  await page.route("**/api/projects**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill(jsonBody(projectBody(fixture)));
  });
  await page.route("**/api/git/branches**", async (route) => {
    await route.fulfill(jsonBody(branchBody(fixture)));
  });
  await page.route("**/api/git/status**", async (route) => {
    await route.fulfill(jsonBody(statusBody(fixture, modeRef.value)));
  });
  await page.route("**/api/git/summary**", async (route) => {
    await route.fulfill(jsonBody(summaryBody(fixture, modeRef.value)));
  });
  await page.route("**/api/git/history**", async (route) => {
    await route.fulfill(jsonBody(historyBody(fixture)));
  });
  await page.route("**/api/git/remotes**", async (route) => {
    await route.fulfill(jsonBody(remotesBody(fixture)));
  });
  await page.route("**/api/git/diff**", async (route) => {
    await route.fulfill(jsonBody(emptyDiffBody(fixture)));
  });
}

async function installMutationRoutes(
  page: Page,
  fixture: GitFixture,
  modeRef: { value: SummaryMode },
  calls: RouteCalls,
): Promise<void> {
  await page.route("**/api/git-delivery/local-branch/create", async (route) => {
    calls.branchCreates.push(parsePostBody(route));
    await route.fulfill(
      jsonBody({ schemaVersion: "1", status: "succeeded", actionKind: "branch-create" }),
    );
  });
  await page.route("**/api/git-delivery/local-branch/switch", async (route) => {
    calls.branchSwitches.push(parsePostBody(route));
    await route.fulfill(
      jsonBody({ schemaVersion: "1", status: "succeeded", actionKind: "branch-switch" }),
    );
  });
  await page.route("**/api/git-delivery/fetch/preview", async (route) => {
    calls.syncPreviews.push(parsePostBody(route));
    await route.fulfill(jsonBody(syncPreviewBody("fetch", fixture, modeRef.value)));
  });
  await page.route("**/api/git-delivery/pull/preview", async (route) => {
    calls.syncPreviews.push(parsePostBody(route));
    await route.fulfill(jsonBody(syncPreviewBody("pull", fixture, modeRef.value)));
  });
  await page.route("**/api/git-delivery/fetch/execute", async (route) => {
    calls.syncExecutes.push(parsePostBody(route));
    await route.fulfill(jsonBody(syncExecuteBody("fetch")));
  });
  await page.route("**/api/git-delivery/pull/execute", async (route) => {
    calls.syncExecutes.push(parsePostBody(route));
    await route.fulfill(jsonBody(syncExecuteBody("pull")));
  });
  await page.route("**/api/git-delivery/push/preview", async (route) => {
    calls.pushPreviews.push(parsePostBody(route));
    await route.fulfill(jsonBody(pushPreviewBody()));
  });
  await page.route("**/api/git-delivery/push/execute", async (route) => {
    calls.pushExecutes.push(parsePostBody(route));
    await route.fulfill(jsonBody({ schemaVersion: "1", status: "succeeded", actionKind: "push" }));
  });
}

async function installRoutes(
  page: Page,
  fixture: GitFixture,
  modeRef: { value: SummaryMode },
  calls: RouteCalls,
): Promise<void> {
  await installReadRoutes(page, fixture, modeRef);
  await installMutationRoutes(page, fixture, modeRef, calls);
}

async function seedGitClientWindow(page: Page, fixture: GitFixture): Promise<void> {
  await page.addInitScript((projectPath) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-1576-branch-sync",
          type: "governedGit",
          x: 24,
          y: 24,
          w: 1200,
          h: 900,
          z: 20,
          cfg: { projectPath },
          max: true,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  }, fixture.worktreeRoot);
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #1576 git-branch-sync evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) {
    throw new Error("Unexpected Issue #1576 git-branch-sync artifact name");
  }
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Issue #1576 git-branch-sync artifact escaped its directory");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #1576 git-branch-sync artifact path is a symlink");
  }
  return resolved;
}

function writeEvidenceManifest(fixture: GitFixture): void {
  const manifest = {
    issue: "#1576",
    epic: "#1571",
    harness: "playwright.issue-1576-git-branch-sync.config.ts",
    appPath: "packaged-cli-ui",
    route: "/",
    evidencePath: "docs/git-delivery/evidence/1576",
    generatedAt: new Date().toISOString(),
    fixtureRoot: fixture.worktreeRoot,
    localBareRemoteRoot: fixture.remoteRoot,
    routesIntercepted: MANIFEST_ROUTES,
    windowRegistration: {
      windowType: "governedGit",
      seededVia: "keiko.workspace.v4",
      renderedBy: "GitClientWindow",
      cfgPersistence: "fs-reference",
    },
    statesCovered: MANIFEST_STATES,
    notes: MANIFEST_NOTES,
    artifacts: ARTIFACT_NAMES,
  };
  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function openGitWindow(page: Page, mode: SummaryMode): Promise<{
  readonly fixture: GitFixture;
  readonly gitWindow: Locator;
  readonly modeRef: { value: SummaryMode };
  readonly calls: RouteCalls;
}> {
  const fixture = buildGitFixture();
  const modeRef = { value: mode };
  const calls: RouteCalls = {
    branchCreates: [],
    branchSwitches: [],
    syncPreviews: [],
    syncExecutes: [],
    pushPreviews: [],
    pushExecutes: [],
  };
  await installRoutes(page, fixture, modeRef, calls);
  await seedGitClientWindow(page, fixture);
  await page.goto("/");
  const gitWindow = page.locator('[data-window-id="issue-1576-branch-sync"]');
  await expect(gitWindow).toBeVisible();
  return { fixture, gitWindow, modeRef, calls };
}

test("Issue #1576 - branch selector, new branch, history, and pull evidence", async ({ page }) => {
  ensureEvidenceDir();
  const { fixture, gitWindow, calls } = await openGitWindow(page, "behind");

  await gitWindow.getByRole("combobox", { name: "Branch" }).click();
  await gitWindow.getByRole("searchbox", { name: "Search branches" }).fill("feature");
  await expect(gitWindow.getByRole("option", { name: /feature\/local/u })).toBeVisible();
  await expect(gitWindow).not.toContainText(fixture.aheadSha);
  await gitWindow.getByRole("option", { name: /feature\/local/u }).click();
  await expect
    .poll(() => calls.branchSwitches.length, { message: "branch switch route called" })
    .toBeGreaterThan(0);

  await gitWindow.getByRole("button", { name: "New branch" }).click();
  const dialog = page.getByRole("dialog", { name: "New branch" });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText(fixture.baseSha);
  await dialog.getByLabel("Branch name").fill("feature/e2e-new");
  await dialog.getByRole("button", { name: "Create branch" }).click();
  await expect
    .poll(() => calls.branchCreates.length, { message: "branch create route called" })
    .toBeGreaterThan(0);
  expect(calls.branchCreates.at(-1)).toMatchObject({
    projectId: fixture.worktreeRoot,
    branchName: "feature/e2e-new",
    baseBranchName: "main",
    startPointRefHash: fixture.baseSha,
  });

  await gitWindow.getByRole("tab", { name: "History" }).click();
  await expect(gitWindow.getByRole("listbox", { name: "Commit history" })).toBeVisible();
  await expect(gitWindow.getByRole("option", { name: /feat: local branch evidence/u })).toBeVisible();
  await expect(gitWindow.getByRole("region", { name: "Commit details" })).toContainText(
    fixture.aheadSha,
  );

  await gitWindow.getByRole("button", { name: "Run sync: Pull" }).click();
  await expect
    .poll(() => calls.syncPreviews.length, { message: "pull preview route called" })
    .toBeGreaterThan(0);
  await expect
    .poll(() => calls.syncExecutes.length, { message: "pull execute route called" })
    .toBeGreaterThan(0);
  expect(calls.syncPreviews.at(-1)).toMatchObject({
    schemaVersion: "1",
    projectId: fixture.worktreeRoot,
    remote: "origin",
  });

  await page.locator("body").screenshot({ path: artifactPath("git-branch-history-sync.png") });
  writeEvidenceManifest(fixture);
});

test("Issue #1576 - ahead-only state pushes without force", async ({ page }) => {
  const { fixture, gitWindow, calls } = await openGitWindow(page, "ahead");

  await gitWindow.getByRole("button", { name: "Run sync: Push" }).click();

  await expect
    .poll(() => calls.pushPreviews.length, { message: "push preview route called" })
    .toBeGreaterThan(0);
  await expect
    .poll(() => calls.pushExecutes.length, { message: "push execute route called" })
    .toBeGreaterThan(0);
  expect(calls.pushPreviews.at(-1)).toMatchObject({
    schemaVersion: "1",
    projectId: fixture.worktreeRoot,
    remoteAlias: "origin",
    remoteBranchName: "main",
    sourceBranchName: "main",
    forcePush: false,
    setUpstreamTracking: false,
  });
});

test("Issue #1576 - no-upstream state publishes and sets upstream tracking", async ({ page }) => {
  const { fixture, gitWindow, calls } = await openGitWindow(page, "publish");

  await gitWindow.getByRole("button", { name: "Run sync: Publish upstream" }).click();

  await expect
    .poll(() => calls.pushPreviews.length, { message: "publish preview route called" })
    .toBeGreaterThan(0);
  expect(calls.pushPreviews.at(-1)).toMatchObject({
    schemaVersion: "1",
    projectId: fixture.worktreeRoot,
    remoteAlias: "origin",
    remoteBranchName: "feature/local",
    sourceBranchName: "feature/local",
    forcePush: false,
    setUpstreamTracking: true,
  });
});

test("Issue #1576 - diverged state fetches and shows merge guidance", async ({ page }) => {
  const { gitWindow } = await openGitWindow(page, "diverged");

  await expect(gitWindow.getByRole("button", { name: "Run sync: Fetch" })).toBeVisible();
  await expect(gitWindow.getByText(/Diverged: 2 ahead, 3 behind/u)).toBeVisible();
  await expect(gitWindow.getByText(/Use the Merge entry point/u)).toBeVisible();
});

test("Issue #1576 - detached and conflicted states block sync safely", async ({ page }) => {
  const opened = await openGitWindow(page, "detached");
  await expect(opened.gitWindow.getByRole("alert")).toContainText("Detached HEAD");
  await expect(opened.gitWindow.getByRole("button", { name: "Run sync: Detached HEAD" })).toBeDisabled();

  opened.modeRef.value = "conflicted";
  await page.reload();
  await expect(opened.gitWindow.getByRole("alert")).toContainText("Resolve conflicted files");
  await expect(
    opened.gitWindow.getByRole("button", { name: "Run sync: Resolve conflicts" }),
  ).toBeDisabled();
});
