import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expectViewportModal } from "./support/modal.js";

// Issue #1578 capstone evidence for Epic #1571. This spec verifies the completed Git client through
// the real packaged app path with local fixtures and deterministic route stubs only. The child issue
// e2es hold detailed per-state evidence; this capstone proves the integrated window path and captures
// final desktop + constrained screenshots without local paths, remote URLs, credentials, or provider IO.

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "git-delivery", "evidence", "1578");
const EVIDENCE_PROJECT_PATH = "keiko-git-client-closeout-1578";
const ARTIFACT_NAMES = [
  "manifest.json",
  "git-client-closeout-desktop.png",
  "git-client-closeout-constrained.png",
] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

const ROUTES = [
  "/api/projects",
  "/api/workspaces",
  "/api/git/status",
  "/api/git/branches",
  "/api/git/summary",
  "/api/git/history",
  "/api/git/remotes",
  "/api/git/diff",
  "/api/files/content",
  "/api/git-delivery/staging/stage",
  "/api/git-delivery/commit/preview",
  "/api/git-delivery/commit/execute",
  "/api/git-delivery/local-branch/create",
  "/api/git-delivery/local-branch/switch",
  "/api/git-delivery/pull/preview",
  "/api/git-delivery/pull/execute",
  "/api/git-delivery/pr/preview",
  "/api/git-delivery/merge/preview",
] as const;

const CHILD_EVIDENCE = [
  "docs/git-delivery/evidence/1575/manifest.json",
  "docs/git-delivery/evidence/1575/git-changes-view.png",
  "docs/git-delivery/evidence/1576/manifest.json",
  "docs/git-delivery/evidence/1576/git-branch-history-sync.png",
  "docs/git-delivery/evidence/1577/manifest.json",
  "docs/git-delivery/evidence/1577/git-pr-merge-agent-ops.png",
] as const;

interface GitFixture {
  readonly worktreeRoot: string;
  readonly remoteRoot: string;
  readonly baseSha: string;
  readonly featureSha: string;
}

interface RouteLedger {
  readonly stageCalls: unknown[];
  readonly commitPreviews: unknown[];
  readonly commitExecutes: unknown[];
  readonly branchCreates: unknown[];
  readonly branchSwitches: unknown[];
  readonly syncPreviews: unknown[];
  readonly syncExecutes: unknown[];
  readonly prPreviews: unknown[];
  readonly mergePreviews: unknown[];
}

const tempRoots: string[] = [];

test.afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-06-28T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-06-28T10:00:00Z",
    },
  });
}

function buildLocalBareFixture(): GitFixture {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-e2e-git-closeout-1578-")));
  tempRoots.push(fixtureRoot);
  const remoteRoot = join(fixtureRoot, "remote.git");
  const worktreeRoot = join(fixtureRoot, "worktree");

  git(["init", "--bare", "-q", remoteRoot], fixtureRoot);
  git(["init", "-q", worktreeRoot], fixtureRoot);
  git(["config", "user.email", "test@keiko.example"], worktreeRoot);
  git(["config", "user.name", "Keiko Test"], worktreeRoot);
  git(["config", "commit.gpgsign", "false"], worktreeRoot);
  git(["checkout", "-b", "main"], worktreeRoot);
  writeFileSync(join(worktreeRoot, "README.md"), "# Keiko Git client closeout\n", "utf8");
  git(["add", "README.md"], worktreeRoot);
  git(["commit", "-m", "chore: seed git client closeout"], worktreeRoot);
  const baseSha = git(["rev-parse", "HEAD"], worktreeRoot).trim();
  git(["remote", "add", "origin", remoteRoot], worktreeRoot);
  git(["push", "-u", "origin", "main"], worktreeRoot);
  git(["checkout", "-b", "feature/closeout"], worktreeRoot);
  writeFileSync(join(worktreeRoot, "src.ts"), "export const closeout = true;\n", "utf8");
  git(["add", "src.ts"], worktreeRoot);
  git(["commit", "-m", "feat: closeout evidence"], worktreeRoot);
  const featureSha = git(["rev-parse", "HEAD"], worktreeRoot).trim();
  return { worktreeRoot, remoteRoot, baseSha, featureSha };
}

function json(route: Route, body: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function parsePost(route: Route): unknown {
  const raw = route.request().postData();
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function projectBody(): Record<string, unknown> {
  return {
    path: EVIDENCE_PROJECT_PATH,
    name: "keiko-git-client-closeout-1578",
    favorite: false,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
    available: true,
    workspaceAvailable: true,
  };
}

function statusBody(): unknown {
  return {
    schemaVersion: "1",
    root: EVIDENCE_PROJECT_PATH,
    repositoryRoot: EVIDENCE_PROJECT_PATH,
    state: "available",
    available: true,
    branch: "main",
    detached: false,
    clean: false,
    stagedCount: 1,
    unstagedCount: 1,
    untrackedCount: 1,
    conflictedCount: 0,
    changes: [
      {
        path: "src/app.ts",
        indexStatus: " ",
        worktreeStatus: "M",
        staged: false,
        unstaged: true,
        untracked: false,
        conflicted: false,
      },
      {
        path: "src/new-feature.ts",
        indexStatus: "A",
        worktreeStatus: " ",
        staged: true,
        unstaged: false,
        untracked: false,
        conflicted: false,
      },
      {
        path: "notes.txt",
        indexStatus: "?",
        worktreeStatus: "?",
        staged: false,
        unstaged: false,
        untracked: true,
        conflicted: false,
      },
    ],
    truncated: false,
    maxChanges: 500,
  };
}

function branchBody(fixture: GitFixture): unknown {
  return {
    schemaVersion: "1",
    root: EVIDENCE_PROJECT_PATH,
    repositoryRoot: EVIDENCE_PROJECT_PATH,
    state: "available",
    available: true,
    branches: [
      { name: "main", headRefHash: fixture.baseSha, current: true },
      { name: "feature/closeout", headRefHash: fixture.featureSha, current: false },
    ],
    truncated: false,
  };
}

function summaryBody(): unknown {
  return {
    schemaVersion: "1",
    root: EVIDENCE_PROJECT_PATH,
    repositoryRoot: EVIDENCE_PROJECT_PATH,
    state: "available",
    available: true,
    branch: "main",
    detached: false,
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    ahead: 0,
    behind: 1,
    stagedCount: 1,
    unstagedCount: 1,
    untrackedCount: 1,
    conflictedCount: 0,
    clean: false,
    remotes: [{ name: "origin" }],
    truncated: false,
  };
}

function historyBody(fixture: GitFixture): unknown {
  return {
    schemaVersion: "1",
    root: EVIDENCE_PROJECT_PATH,
    repositoryRoot: EVIDENCE_PROJECT_PATH,
    state: "available",
    available: true,
    entries: [
      {
        sha: fixture.featureSha,
        shortSha: fixture.featureSha.slice(0, 7),
        subject: "feat: closeout evidence",
        author: "Keiko Test",
        date: "2026-06-28T10:00:00Z",
        refs: ["feature/closeout"],
        parentCount: 1,
        changedFileCount: 1,
      },
      {
        sha: fixture.baseSha,
        shortSha: fixture.baseSha.slice(0, 7),
        subject: "chore: seed git client closeout",
        author: "Keiko Test",
        date: "2026-06-28T09:59:00Z",
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

function remotesBody(): unknown {
  return {
    schemaVersion: "1",
    root: EVIDENCE_PROJECT_PATH,
    repositoryRoot: EVIDENCE_PROJECT_PATH,
    state: "available",
    available: true,
    remotes: [{ name: "origin", fetchUrl: "git@github.com:oscharko-dev/Keiko.git" }],
    truncated: false,
  };
}

function diffBody(route: Route): unknown {
  const url = new URL(route.request().url());
  const pathParam = url.searchParams.get("path") ?? "src/app.ts";
  const files =
    pathParam === "src/app.ts"
      ? [
          {
            path: pathParam,
            layer: "worktree",
            status: "modified",
            binary: false,
            hunks: [
              {
                header: "@@ -1 +1 @@",
                oldStart: 1,
                oldCount: 1,
                newStart: 1,
                newCount: 1,
                lines: [
                  { kind: "del", oldLine: 1, newLine: null, text: "export const version = 1;" },
                  { kind: "add", oldLine: null, newLine: 1, text: "export const version = 2;" },
                ],
                truncated: false,
              },
            ],
            addedLines: 1,
            removedLines: 1,
            truncated: false,
          },
        ]
      : [];
  return {
    schemaVersion: "1",
    scope: url.searchParams.get("scope") ?? "unstaged",
    files,
    truncated: false,
    totalFiles: files.length,
    totalBytes: 128,
    maxBytes: 524288,
    maxFiles: 400,
  };
}

function filesContentBody(route: Route): unknown {
  const url = new URL(route.request().url());
  const root = url.searchParams.get("root") ?? EVIDENCE_PROJECT_PATH;
  const path = url.searchParams.get("path") ?? "src/app.ts";
  return {
    root,
    path,
    name: path.split("/").at(-1) ?? path,
    sizeBytes: 24,
    modifiedAt: 1,
    extension: "ts",
    mime: "text/plain",
    symlink: false,
    content: "export const version = 2;\n",
    maxBytes: 1_000_000,
    session: {
      schemaVersion: "1",
      version: { sizeBytes: 24, modifiedAt: 1, contentHash: "a".repeat(64) },
    },
  };
}

function commitPreviewBody(): unknown {
  return {
    schemaVersion: "1",
    summary: { stagedFileCount: 1, areaCount: 1, touchesTests: true },
    intent: { warnings: [], isWip: false },
    messageValidation: { ok: true },
    preflightFindingCodes: [],
    policyOutcome: "allowed",
  };
}

function pullPreviewBody(): unknown {
  return {
    schemaVersion: "1",
    operation: "pull",
    available: true,
    state: "available",
    branch: "main",
    detached: false,
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    remote: "origin",
    ahead: 0,
    behind: 1,
    hasRemote: true,
    hasUpstream: true,
    dirty: false,
    executable: true,
  };
}

function prPreviewBody(): unknown {
  return {
    schemaVersion: "1",
    actionKind: "pr-create",
    headBranchName: "main",
    baseBranchName: "main",
    riskClass: "protected-or-merge",
    riskSeverity: 3,
    isDraft: false,
    policyOutcome: "blocked",
    policyBlockReason: "policy-pack-blocked",
    composedTitle: "test(git-ui): add Git client closeout verification",
    composedBody: "Issue #1578 closeout browser evidence body.",
    riskNarrative: "Pull Request requires review before merge.",
    recommendation: "blocked",
    readiness: { objectExists: false, reviewReady: false, blockerCodes: ["policy-pack-blocked"] },
    suggestedLabels: ["git-ui"],
    suggestedIssueRefs: ["#1578"],
    titleByteLength: 54,
    bodyByteLength: 44,
  };
}

function mergePreviewBody(): unknown {
  return {
    schemaVersion: "1",
    actionKind: "merge",
    baseBranchName: "main",
    headBranchName: "feature/closeout",
    prExternalId: "1578",
    riskClass: "protected-or-merge",
    riskSeverity: 4,
    requestedStrategy: "squash",
    requestedStrategyEligible: true,
    eligibleStrategies: ["squash", "provider-default"],
    selectedDefaultStrategy: "squash",
    recommendation: "blocked",
    policyOutcome: "approval-gated",
    requiresApproval: true,
    readiness: {
      mergeable: false,
      blockers: [
        {
          code: "required-checks-pending",
          severity: "blocking",
          remediation: "wait-for-checks",
          actionHint: "refresh-merge-readiness",
        },
      ],
    },
  };
}

async function installReadRoutes(page: Page, fixture: GitFixture): Promise<void> {
  let repositoryAdded = false;
  await page.route("**/api/projects**", (route) => {
    const project = projectBody();
    const method = route.request().method();
    if (method === "PATCH" || method === "POST") {
      repositoryAdded = true;
      return json(route, { project });
    }
    return json(route, { projects: repositoryAdded ? [project] : [] });
  });
  await page.route("**/api/git/status**", (route) => json(route, statusBody()));
  await page.route("**/api/git/branches**", (route) => json(route, branchBody(fixture)));
  await page.route("**/api/git/summary**", (route) => json(route, summaryBody()));
  await page.route("**/api/git/history**", (route) => json(route, historyBody(fixture)));
  await page.route("**/api/git/remotes**", (route) => json(route, remotesBody()));
  await page.route("**/api/git/diff**", (route) => json(route, diffBody(route)));
  await page.route("**/api/files/content**", (route) => json(route, filesContentBody(route)));
  await page.route("**/api/workspaces", (route) => json(route, { manifests: [] }));
}

async function installLocalWriteRoutes(page: Page, ledger: RouteLedger): Promise<void> {
  await page.route("**/api/git-delivery/staging/stage", (route) => {
    ledger.stageCalls.push(parsePost(route));
    return json(route, {
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "stage",
      policyOutcome: "allowed",
    });
  });
  await page.route("**/api/git-delivery/commit/preview", (route) => {
    ledger.commitPreviews.push(parsePost(route));
    return json(route, commitPreviewBody());
  });
  await page.route("**/api/git-delivery/commit/execute", (route) => {
    ledger.commitExecutes.push(parsePost(route));
    return json(route, {
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "commit",
      policyOutcome: "allowed",
    });
  });
  await page.route("**/api/git-delivery/local-branch/create", (route) => {
    ledger.branchCreates.push(parsePost(route));
    return json(route, { schemaVersion: "1", status: "succeeded", actionKind: "branch-create" });
  });
  await page.route("**/api/git-delivery/local-branch/switch", (route) => {
    ledger.branchSwitches.push(parsePost(route));
    return json(route, { schemaVersion: "1", status: "succeeded", actionKind: "branch-switch" });
  });
}

async function installRemoteWriteRoutes(page: Page, ledger: RouteLedger): Promise<void> {
  await page.route("**/api/git-delivery/pull/preview", (route) => {
    ledger.syncPreviews.push(parsePost(route));
    return json(route, pullPreviewBody());
  });
  await page.route("**/api/git-delivery/pull/execute", (route) => {
    ledger.syncExecutes.push(parsePost(route));
    return json(route, {
      schemaVersion: "1",
      operation: "pull",
      status: "succeeded",
      available: true,
      branch: "main",
      upstream: { ref: "origin/main", remote: "origin", branch: "main" },
      remote: "origin",
      ahead: 0,
      behind: 0,
      truncated: false,
    });
  });
  await page.route("**/api/git-delivery/pr/preview", (route) => {
    ledger.prPreviews.push(parsePost(route));
    return json(route, prPreviewBody());
  });
  await page.route("**/api/git-delivery/merge/preview", (route) => {
    ledger.mergePreviews.push(parsePost(route));
    return json(route, mergePreviewBody());
  });
}

async function installRoutes(page: Page, fixture: GitFixture, ledger: RouteLedger): Promise<void> {
  await installReadRoutes(page, fixture);
  await installLocalWriteRoutes(page, ledger);
  await installRemoteWriteRoutes(page, ledger);
}

async function seedGitClientWindow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-1578-git-client-closeout",
          type: "governedGit",
          x: 24,
          y: 24,
          w: 1200,
          h: 900,
          z: 20,
          cfg: { projectPath: "" },
          max: true,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  });
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #1578 evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) {
    throw new Error("Unexpected Issue #1578 evidence artifact");
  }
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Issue #1578 evidence artifact escaped its directory");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #1578 evidence artifact path is a symlink");
  }
  return resolved;
}

function writeManifest(ledger: RouteLedger): void {
  const manifest = {
    issue: "#1578",
    epic: "#1571",
    harness: "tests/e2e/config/playwright.issue-1578-git-client-closeout.config.ts",
    appPath: "packaged-cli-ui",
    route: "/",
    evidencePath: "docs/git-delivery/evidence/1578",
    fixture: {
      kind: "local-bare-repository",
      worktree: "temporary-local-worktree",
      remote: "temporary-local-bare-remote",
      browserProjectPath: EVIDENCE_PROJECT_PATH,
    },
    routesIntercepted: ROUTES,
    childEvidence: CHILD_EVIDENCE,
    statesVerified: [
      "repository selection and add-repository clone/open dialog",
      "changed files, staging, diff pane, commit preview, and commit execute",
      "branch search, branch switch, and new branch creation",
      "history list and selected commit details",
      "sync pull preview and execute",
      "Pull Request and Merge panel entry, preview, blocked/readiness outcomes",
      "desktop and constrained viewport screenshots",
      "path-free and credential-free browser evidence",
    ],
    assertions: {
      stageCalls: ledger.stageCalls.length,
      commitPreviews: ledger.commitPreviews.length,
      commitExecutes: ledger.commitExecutes.length,
      branchCreates: ledger.branchCreates.length,
      branchSwitches: ledger.branchSwitches.length,
      syncPreviews: ledger.syncPreviews.length,
      syncExecutes: ledger.syncExecutes.length,
      prPreviews: ledger.prPreviews.length,
      mergePreviews: ledger.mergePreviews.length,
      localPathsRendered: false,
      remoteUrlsRendered: false,
      externalCredentialsUsed: false,
      forbiddenVisibleGovernanceLanguage: false,
    },
    artifacts: ARTIFACT_NAMES,
  };
  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function emptyLedger(): RouteLedger {
  return {
    stageCalls: [],
    commitPreviews: [],
    commitExecutes: [],
    branchCreates: [],
    branchSwitches: [],
    syncPreviews: [],
    syncExecutes: [],
    prPreviews: [],
    mergePreviews: [],
  };
}

async function assertNoPrivateEvidence(page: Page, fixture: GitFixture): Promise<void> {
  const body = page.locator("body");
  await expect(body).not.toContainText(fixture.worktreeRoot);
  await expect(body).not.toContainText(fixture.remoteRoot);
  await expect(body).not.toContainText("git@github.com:oscharko-dev/Keiko.git");
  await expect(body).not.toContainText("Governed Git");
  await expect(body).not.toContainText("Governance");
  await expect(body).not.toContainText("Delivery path");
}

async function openGitWindow(page: Page, fixture: GitFixture): Promise<Locator> {
  const gitWindow = page.locator('[data-window-id="issue-1578-git-client-closeout"]');
  await expect(gitWindow).toBeVisible();
  await assertNoPrivateEvidence(page, fixture);
  return gitWindow;
}

async function verifyAddRepositoryDialog(page: Page, gitWindow: Locator): Promise<void> {
  const connectButton = gitWindow.getByRole("button", { name: "Connect repository" });
  await expect(connectButton).toBeVisible();
  await connectButton.click();
  const addDialog = page.getByRole("dialog", { name: "Add repository" });
  await expectViewportModal(page, addDialog);
  const addMode = addDialog.getByRole("group", { name: "Add mode" });
  await expect(addMode.getByRole("button", { name: "Clone repository" })).toBeVisible();
  await addMode.getByRole("button", { name: "Open local repository" }).click();
  await expect(addDialog.getByLabel("Local repository path")).toBeVisible();
  await addDialog.getByLabel("Local repository path").fill(EVIDENCE_PROJECT_PATH);
  await addDialog.getByRole("button", { name: "Open repository" }).click();
  await expect(gitWindow.getByRole("button", { name: "Branch: main" })).toBeVisible();
}

async function verifyChangesAndCommit(
  page: Page,
  gitWindow: Locator,
  ledger: RouteLedger,
): Promise<void> {
  const changedFiles = gitWindow.locator('nav[aria-label="Changed files"]');
  await expect(changedFiles).toBeVisible();
  await changedFiles.locator('input[aria-label="Stage src/app.ts"]').click();
  await expect
    .poll(() => ledger.stageCalls.length, { message: "stage route called" })
    .toBeGreaterThan(0);
  const changedFile = changedFiles.getByRole("button", { name: /^src\/app\.ts,/u });
  await expect(changedFile).toBeVisible();
  await changedFile.click();
  await expect(gitWindow.getByRole("group", { name: "Diff scope" })).toBeVisible();
  await expect(gitWindow.getByText(/version = 2/u)).toBeVisible();
  const revealedEditor = page.locator('[data-window-id^="editor-"]');
  await expect(revealedEditor).toBeVisible();
  await revealedEditor.getByRole("button", { name: /^Close .+ window$/u }).click();
  await expect(revealedEditor).toHaveCount(0);

  const commitSection = gitWindow.locator('section[aria-label="Commit"]');
  await commitSection.getByLabel("Summary").fill("test(git-ui): verify closeout evidence");
  await expect(page.locator('[data-testid="git-commit-preview"]')).toBeVisible();
  await commitSection.getByRole("button", { name: /Commit/u }).click();
  await expect
    .poll(() => ledger.commitExecutes.length, { message: "commit execute route called" })
    .toBeGreaterThan(0);
}

async function verifyBranchAndHistory(
  page: Page,
  gitWindow: Locator,
  fixture: GitFixture,
  ledger: RouteLedger,
): Promise<void> {
  await gitWindow.getByRole("button", { name: "Branch: main" }).click();
  await gitWindow.getByRole("searchbox", { name: "Search branches" }).fill("feature");
  await gitWindow.getByRole("menuitemradio", { name: /feature\/closeout/u }).click();
  const branchSwitchDialog = page.getByRole("dialog", { name: "Confirm branch switch" });
  await expectViewportModal(page, branchSwitchDialog);
  await branchSwitchDialog.getByRole("button", { name: "Switch branch" }).click();
  await expect
    .poll(() => ledger.branchSwitches.length, { message: "branch switch route called" })
    .toBeGreaterThan(0);
  await gitWindow.getByRole("button", { name: "New branch" }).click();
  const branchDialog = page.getByRole("dialog", { name: "New branch" });
  await branchDialog.getByLabel("Branch name").fill("feature/closeout-docs");
  await branchDialog.getByRole("button", { name: "Create branch" }).click();
  await expect
    .poll(() => ledger.branchCreates.length, { message: "branch create route called" })
    .toBeGreaterThan(0);
  await expect
    .poll(() => ledger.branchSwitches.length, { message: "created branch switch route called" })
    .toBeGreaterThan(1);
  await expect(branchDialog.locator('[data-testid="git-branch-outcome"]')).toHaveCount(0);
  await expect(branchDialog).not.toBeVisible();
  await expect(gitWindow.getByRole("button", { name: "New branch" })).toBeFocused();

  await gitWindow.getByRole("tab", { name: "History" }).click();
  await expect(gitWindow.getByRole("list", { name: "Commit history" })).toBeVisible();
  await gitWindow.getByRole("button", { name: /feat: closeout evidence/u }).click();
  await expect(gitWindow.getByRole("region", { name: "Commit details" })).toContainText(
    fixture.featureSha,
  );
}

async function verifySyncPull(page: Page, gitWindow: Locator, ledger: RouteLedger): Promise<void> {
  await gitWindow.getByRole("button", { name: "Run sync: Pull" }).click();
  const pullDialog = page.getByRole("dialog", { name: "Confirm pull" });
  await expectViewportModal(page, pullDialog);
  await pullDialog.getByRole("button", { name: "Pull changes" }).click();
  await expect
    .poll(() => ledger.syncExecutes.length, { message: "pull execute route called" })
    .toBeGreaterThan(0);
}

async function verifyPrAndMerge(
  page: Page,
  gitWindow: Locator,
  fixture: GitFixture,
  ledger: RouteLedger,
): Promise<void> {
  await gitWindow.getByRole("tab", { name: "Changes" }).click();
  const createPullRequest = gitWindow.getByRole("button", { name: "Create Pull Request" });
  await expect(createPullRequest).toBeVisible();
  await createPullRequest.click();
  const prPanel = page.getByRole("region", { name: "Pull Request", exact: true });
  await expect(prPanel.getByLabel("Repository (owner/repo)")).toHaveValue("oscharko-dev/Keiko");
  await prPanel.getByRole("button", { name: "Preview" }).click();
  await expect
    .poll(() => ledger.prPreviews.length, { message: "PR preview route called" })
    .toBeGreaterThan(0);
  await expect(prPanel.locator('[data-field="policy"]')).toContainText("policy-pack-blocked");
  await page.getByRole("button", { name: "Back to diff" }).click();

  await gitWindow.getByRole("button", { name: /Merge/u }).click();
  const mergePanel = page.getByRole("region", { name: "Merge", exact: true });
  await mergePanel.getByLabel("Pull Request number").fill("1578");
  await mergePanel.getByRole("button", { name: "Preview" }).click();
  await expect
    .poll(() => ledger.mergePreviews.length, { message: "merge preview route called" })
    .toBeGreaterThan(0);
  await expect(mergePanel.getByText("required-checks-pending")).toBeVisible();
  await assertNoPrivateEvidence(page, fixture);
}

async function captureCloseoutEvidence(
  page: Page,
  gitWindow: Locator,
  fixture: GitFixture,
  ledger: RouteLedger,
): Promise<void> {
  const editorWindows = page.locator('[data-window-id^="editor-"]');
  if ((await editorWindows.count()) > 0) {
    await editorWindows
      .first()
      .getByRole("button", { name: /^Close .+ window$/u })
      .click();
  }
  await expect(editorWindows).toHaveCount(0);
  await expect(gitWindow.getByRole("combobox", { name: "Repository" })).toBeVisible();
  await expect(gitWindow.getByRole("region", { name: "Merge", exact: true })).toBeVisible();
  await page.screenshot({ path: artifactPath("git-client-closeout-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 900, height: 760 });
  await expect(gitWindow).toBeVisible();
  await assertNoPrivateEvidence(page, fixture);
  await page.screenshot({
    path: artifactPath("git-client-closeout-constrained.png"),
    fullPage: true,
  });

  writeManifest(ledger);
  const manifestText = readFileSync(artifactPath("manifest.json"), "utf8");
  expect(manifestText).not.toContain(fixture.worktreeRoot);
  expect(manifestText).not.toContain(fixture.remoteRoot);
}

test("Issue #1578 - Git client closeout evidence covers integrated workflows", async ({ page }) => {
  ensureEvidenceDir();
  const fixture = buildLocalBareFixture();
  const ledger = emptyLedger();
  await installRoutes(page, fixture, ledger);
  await seedGitClientWindow(page);
  await page.goto("/");

  const gitWindow = await openGitWindow(page, fixture);
  await verifyAddRepositoryDialog(page, gitWindow);
  await verifyChangesAndCommit(page, gitWindow, ledger);
  await verifyBranchAndHistory(page, gitWindow, fixture, ledger);
  await verifySyncPull(page, gitWindow, ledger);
  await verifyPrAndMerge(page, gitWindow, fixture, ledger);
  await captureCloseoutEvidence(page, gitWindow, fixture, ledger);
});
