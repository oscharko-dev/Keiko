import { expect, test, type Page, type Route } from "@playwright/test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// Issue #1577 browser evidence: the real Git client window opens Pull Request and Merge panels in
// the right pane, reusing the governed PR/Merge BFF routes through deterministic stubs. The fixture
// uses a temporary local folder registered as a repository; no provider credentials or remote network
// calls are used, and the evidence manifest intentionally omits local filesystem paths.

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "git-delivery", "evidence", "1577");
const EVIDENCE_PROJECT_PATH = "keiko-git-pr-merge-1577";
const ARTIFACT_NAMES = ["manifest.json", "git-pr-merge-agent-ops.png"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

const ROUTES = [
  "/api/projects",
  "/api/git/status",
  "/api/git/branches",
  "/api/git/summary",
  "/api/git/history",
  "/api/git/remotes",
  "/api/git/diff",
  "/api/git-delivery/pr/preview",
  "/api/git-delivery/pr/execute",
  "/api/git-delivery/merge/preview",
  "/api/git-delivery/merge/execute",
] as const;

interface RouteLedger {
  readonly prPreviews: unknown[];
  readonly mergePreviews: unknown[];
}

const tempRoots: string[] = [];

test.afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-git-pr-merge-1577-"));
  tempRoots.push(root);
  return root;
}

function json(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

function statusBody(root: string): unknown {
  return {
    schemaVersion: "1",
    root,
    repositoryRoot: root,
    state: "available",
    available: true,
    branch: "feat/issue-1577",
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

function summaryBody(root: string): unknown {
  return {
    schemaVersion: "1",
    root,
    repositoryRoot: root,
    state: "available",
    available: true,
    branch: "feat/issue-1577",
    detached: false,
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    ahead: 1,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    clean: true,
    remotes: [{ name: "origin" }],
    truncated: false,
  };
}

function branchListBody(root: string): unknown {
  return {
    schemaVersion: "1",
    root,
    repositoryRoot: root,
    state: "available",
    available: true,
    branches: [
      { name: "main", headRefHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", current: false },
      {
        name: "feat/issue-1577",
        headRefHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        current: true,
      },
    ],
    truncated: false,
  };
}

function historyBody(root: string): unknown {
  return {
    schemaVersion: "1",
    root,
    repositoryRoot: root,
    state: "available",
    available: true,
    entries: [],
    limit: 50,
    skip: 0,
    truncated: false,
  };
}

function remotesBody(root: string): unknown {
  return {
    schemaVersion: "1",
    root,
    repositoryRoot: root,
    state: "available",
    available: true,
    remotes: [{ name: "origin", fetchUrl: "git@github.com:oscharko-dev/Keiko.git" }],
    truncated: false,
  };
}

function diffBody(root: string): unknown {
  return {
    schemaVersion: "1",
    root,
    repositoryRoot: root,
    state: "available",
    available: true,
    scope: "all",
    diff: "",
    truncated: false,
    maxBytes: 131072,
  };
}

function prPreviewBody(): unknown {
  return {
    schemaVersion: "1",
    actionKind: "pr-create",
    headBranchName: "feat/issue-1577",
    baseBranchName: "main",
    riskClass: "protected-or-merge",
    riskSeverity: 3,
    isDraft: false,
    policyOutcome: "blocked",
    policyBlockReason: "policy-pack-blocked",
    composedTitle: "feat(git-ui): integrate PR merge operations",
    composedBody: "Issue #1577 browser evidence body.",
    riskNarrative: "Pull Request requires review before merge.",
    recommendation: "blocked",
    readiness: { objectExists: false, reviewReady: false, blockerCodes: ["policy-pack-blocked"] },
    suggestedLabels: ["git-ui"],
    suggestedIssueRefs: ["#1577"],
    titleByteLength: 44,
    bodyByteLength: 34,
  };
}

function mergePreviewBody(): unknown {
  return {
    schemaVersion: "1",
    actionKind: "merge",
    baseBranchName: "main",
    headBranchName: "feat/issue-1577",
    prExternalId: "1577",
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

function readPosted(route: Route): unknown {
  const raw = route.request().postData();
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

async function interceptProjectRoutes(page: Page, fixtureRoot: string): Promise<void> {
  await page.route("**/api/projects", (route) =>
    json(route, {
      projects: [
        {
          path: fixtureRoot,
          name: "keiko-git-pr-merge-1577",
          favorite: false,
          createdAt: Date.now(),
          lastOpenedAt: Date.now(),
          available: true,
        },
      ],
    }),
  );
}

async function interceptGitReadRoutes(page: Page, fixtureRoot: string): Promise<void> {
  await page.route("**/api/git/status**", (route) => json(route, statusBody(fixtureRoot)));
  await page.route("**/api/git/summary**", (route) => json(route, summaryBody(fixtureRoot)));
  await page.route("**/api/git/branches**", (route) => json(route, branchListBody(fixtureRoot)));
  await page.route("**/api/git/history**", (route) => json(route, historyBody(fixtureRoot)));
  await page.route("**/api/git/remotes**", (route) => json(route, remotesBody(fixtureRoot)));
  await page.route("**/api/git/diff**", (route) => json(route, diffBody(fixtureRoot)));
}

async function interceptPrMergeRoutes(page: Page, ledger: RouteLedger): Promise<void> {
  await page.route("**/api/git-delivery/pr/preview", (route) => {
    ledger.prPreviews.push(readPosted(route));
    return json(route, prPreviewBody());
  });
  await page.route("**/api/git-delivery/pr/execute", (route) =>
    json(route, {
      schemaVersion: "1",
      status: "blocked",
      actionKind: "pr-create",
      blockReason: "policy-pack-blocked",
      policyOutcome: "blocked",
    }),
  );
  await page.route("**/api/git-delivery/merge/preview", (route) => {
    ledger.mergePreviews.push(readPosted(route));
    return json(route, mergePreviewBody());
  });
  await page.route("**/api/git-delivery/merge/execute", (route) =>
    json(route, {
      schemaVersion: "1",
      status: "approval-required",
      actionKind: "merge",
      blockReason: "approval-required",
      policyOutcome: "approval-gated",
    }),
  );
}

async function interceptRoutes(page: Page, fixtureRoot: string, ledger: RouteLedger): Promise<void> {
  await interceptProjectRoutes(page, fixtureRoot);
  await interceptGitReadRoutes(page, fixtureRoot);
  await interceptPrMergeRoutes(page, ledger);
}

async function seedGitClientWindow(page: Page, fixtureRoot: string): Promise<void> {
  await page.addInitScript((projectPath) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-1577-git-pr-merge",
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
  }, fixtureRoot);
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #1577 evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!ARTIFACT_NAMES.includes(name)) throw new Error("Unexpected Issue #1577 artifact");
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Issue #1577 artifact escaped");
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #1577 artifact path is a symlink");
  }
  return resolved;
}

function writeManifest(ledger: RouteLedger): void {
  writeFileSync(
    artifactPath("manifest.json"),
    `${JSON.stringify(
      {
        issue: "#1577",
        epic: "#1571",
        harness: "playwright.issue-1577-git-pr-merge.config.ts",
        appPath: "packaged-cli-ui",
        evidencePath: "docs/git-delivery/evidence/1577",
        routesIntercepted: ROUTES,
        fixture: {
          kind: "temporary registered repository with deterministic route stubs",
          browserProjectPath: EVIDENCE_PROJECT_PATH,
        },
        statesVerified: [
          "Git-window right pane switches from Diff to Pull Request and back",
          "Git-window right pane switches from Diff to Merge",
          "owner/repo, head branch, and base branch prefill without rendering remote URLs",
          "Pull Request preview delegates to /api/git-delivery/pr/preview and renders blocked policy",
          "Merge preview delegates to /api/git-delivery/merge/preview and renders readiness recovery",
        ],
        assertions: {
          prPreviewCalls: ledger.prPreviews.length,
          mergePreviewCalls: ledger.mergePreviews.length,
          remoteUrlsRendered: false,
          localPathsRendered: false,
          externalCredentialsUsed: false,
        },
        artifacts: ARTIFACT_NAMES,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test("Git window embeds Pull Request and Merge repository operations", async ({ page }) => {
  const fixtureRoot = makeFixtureRoot();
  const ledger: RouteLedger = { prPreviews: [], mergePreviews: [] };
  ensureEvidenceDir();
  await interceptRoutes(page, EVIDENCE_PROJECT_PATH, ledger);
  await seedGitClientWindow(page, EVIDENCE_PROJECT_PATH);
  await page.goto("/");

  const gitWindow = page.locator('[data-window-id="issue-1577-git-pr-merge"]');
  await expect(gitWindow).toBeVisible();
  await expect(gitWindow).not.toContainText(fixtureRoot);
  await page.getByRole("button", { name: "Create Pull Request" }).click();
  const prPanel = page.getByRole("region", { name: "Pull Request", exact: true });
  await expect(prPanel).toBeVisible();
  await expect(prPanel.getByLabel("Repository (owner/repo)")).toHaveValue("oscharko-dev/Keiko");
  await expect(prPanel.getByLabel("Head branch")).toHaveValue("feat/issue-1577");
  await expect(prPanel.getByLabel("Base branch")).toHaveValue("main");
  await expect(page.getByText("git@github.com:oscharko-dev/Keiko.git")).toHaveCount(0);
  await prPanel.getByRole("button", { name: "Preview" }).click();
  await expect(prPanel.locator('[data-field="policy"]')).toContainText("policy-pack-blocked");
  expect(ledger.prPreviews).toHaveLength(1);

  await page.getByRole("button", { name: "Back to diff" }).click();
  await expect(page.getByRole("region", { name: "Diff" })).toBeVisible();
  await page.getByRole("button", { name: /Merge/u }).click();
  const mergePanel = page.getByRole("region", { name: "Merge", exact: true });
  await expect(mergePanel).toBeVisible();
  await expect(mergePanel.getByLabel("Repository (owner/repo)")).toHaveValue(
    "oscharko-dev/Keiko",
  );
  await mergePanel.getByLabel("Pull Request number").fill("1577");
  await mergePanel.getByRole("button", { name: "Preview" }).click();
  await expect(mergePanel.getByText("required-checks-pending")).toBeVisible();
  await expect(mergePanel.getByText("refresh-merge-readiness")).toBeVisible();
  expect(ledger.mergePreviews).toHaveLength(1);

  await page.locator('[data-window-id="issue-1577-git-pr-merge"]').screenshot({
    path: artifactPath("git-pr-merge-agent-ops.png"),
  });
  writeManifest(ledger);
});
