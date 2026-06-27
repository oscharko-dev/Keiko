import { expect, test, type Locator, type Page } from "@playwright/test";
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

// Issue #1575 (Epic #1571) — browser evidence that the Git "Changes" view correctly renders all six
// file states against a REAL local git fixture. The spec proves:
//   • Changed-file list (nav[aria-label="Changed files"]) shows one row per change, with the correct
//     badge (Conflict | Untracked | Partially staged | Staged) and checkbox aria-labels.
//   • Header reads "{N} changed · {M} staged" and "Stage all" / "Unstage all" are present.
//   • Clicking a path button loads the diff; the diff pane shows role=group[aria-label="Diff scope"]
//     with "Worktree" and "Staged" buttons.
//   • Diff pane empty state ("No diff content") when the selected change has no text diff.
//   • Binary file message ("Binary file — no text diff to display.") when the diff is binary.
//   • section[aria-label="Commit"] with "Summary" input, "Description" textarea, and "Commit" button.
//   • [data-testid="git-commit-preview"] appears after the debounced policy preview fires.
//
// The real git repo provides the fixture root. The read surface (/api/git/status + /api/git/diff) is
// intercepted with a deterministic fixture so the assertion is stable across CI environments and
// machines where the git binary path may differ. Only the staging mutation routes
// (/api/git-delivery/staging/*) are intercepted with lightweight governed JSON. The commit routes
// are NOT exercised (the commit button is disabled without staged files; this spec does not stage).

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "git-delivery", "evidence", "1575");
const ARTIFACT_NAMES = ["manifest.json", "git-changes-view.png"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

// ─── Real git fixture ─────────────────────────────────────────────────────────────────────────────

const tempRepos: string[] = [];

test.afterAll(() => {
  for (const root of tempRepos.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

// Build a hermetic git repository containing exactly the six change states the UI contract requires:
//
//   • MODIFIED   — "src/app.ts" tracked, committed, then edited in the worktree (worktreeStatus=M)
//   • ADDED      — "src/new-feature.ts" staged but never committed (indexStatus=A)
//   • DELETED    — "src/legacy.ts" committed then removed from the index (indexStatus=D)
//   • RENAMED    — "docs/README.md" committed then moved to "docs/OVERVIEW.md" in the index
//   • UNTRACKED  — "notes.txt" written but never added (untracked=true)
//   • CONFLICTED — "src/shared.ts" modified on two branches + merge-conflict left unresolved
//
// Returns the real filesystem path so the BFF's /api/git/status route could read it; the spec
// uses deterministic route interception, but the path is captured for the evidence manifest.
function buildGitFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-e2e-git-changes-1575-")));
  tempRepos.push(root);

  // Hermetic identity — only PATH is forwarded so no global git config bleeds in.
  git(["init", "-q"], root);
  git(["config", "user.email", "test@keiko.example"], root);
  git(["config", "user.name", "Keiko Test"], root);
  git(["config", "commit.gpgsign", "false"], root);

  // ── Base commit: seed the files that will later be modified, deleted, renamed, or conflicted ──
  writeFileSync(join(root, "src"), "", "utf8"); // temp: replaced by dir below
  rmSync(join(root, "src"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });

  writeFileSync(join(root, "src", "app.ts"), "export const version = 1;\n", "utf8");
  writeFileSync(join(root, "src", "legacy.ts"), "// legacy module\nexport {};\n", "utf8");
  writeFileSync(join(root, "src", "shared.ts"), "export const value = 0;\n", "utf8");
  writeFileSync(join(root, "docs", "README.md"), "# Project\n", "utf8");

  git(["add", "."], root);
  git(["commit", "-m", "chore: initial commit"], root);
  // Capture the default branch name now (git init may name it main or master). The reflog-relative
  // HEAD@{-1} form is unreliable in a freshly scripted repo, so resolve the name explicitly.
  const baseBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], root).trim();

  // ── MODIFIED: edit app.ts in the worktree without staging ──
  writeFileSync(join(root, "src", "app.ts"), "export const version = 2;\n", "utf8");

  // ── ADDED: stage a brand-new file (never committed) ──
  writeFileSync(
    join(root, "src", "new-feature.ts"),
    "export function newFeature(): void {}\n",
    "utf8",
  );
  git(["add", join("src", "new-feature.ts")], root);

  // ── DELETED: stage the removal of legacy.ts ──
  git(["rm", join("src", "legacy.ts")], root);

  // ── RENAMED: stage docs/README.md → docs/OVERVIEW.md ──
  git(["mv", join("docs", "README.md"), join("docs", "OVERVIEW.md")], root);

  // ── UNTRACKED: write a file without staging it ──
  writeFileSync(join(root, "notes.txt"), "work in progress\n", "utf8");

  // ── CONFLICTED: create a merge conflict in shared.ts ──
  // Branch "feature" modifies shared.ts to value = 1.
  git(["checkout", "-b", "feature"], root);
  writeFileSync(join(root, "src", "shared.ts"), "export const value = 1;\n", "utf8");
  git(["commit", "-am", "feat: set value to 1"], root);
  // Back on the default branch, modify shared.ts to value = 2.
  git(["checkout", baseBranch], root);
  writeFileSync(join(root, "src", "shared.ts"), "export const value = 2;\n", "utf8");
  git(["commit", "-am", "fix: set value to 2"], root);
  // Merge "feature" — conflicts on shared.ts, exits non-zero; ignore the error.
  try {
    git(["merge", "feature", "--no-ff", "--no-edit"], root);
  } catch {
    // Expected: conflicting merge leaves MERGE_HEAD in place.
  }

  return root;
}

// ─── Route interception ───────────────────────────────────────────────────────────────────────────

// The six change states as a deterministic /api/git/status fixture.  indexStatus / worktreeStatus
// follow git's XY short-format codes: index=X, worktree=Y (space = unchanged side).
const FIXTURE_REPO_PATH = "/tmp/keiko-e2e-git-changes-1575-fixture";
const STATUS_FIXTURE = {
  schemaVersion: "1",
  root: FIXTURE_REPO_PATH,
  repositoryRoot: FIXTURE_REPO_PATH,
  state: "available",
  available: true,
  branch: "main",
  detached: false,
  clean: false,
  stagedCount: 3, // new-feature.ts (A), legacy.ts (D), README→OVERVIEW.md (R) are staged
  unstagedCount: 1, // app.ts modified in worktree
  untrackedCount: 1, // notes.txt
  conflictedCount: 1,
  changes: [
    // MODIFIED — tracked file edited in worktree, not staged
    {
      path: "src/app.ts",
      indexStatus: " ",
      worktreeStatus: "M",
      staged: false,
      unstaged: true,
      untracked: false,
      conflicted: false,
    },
    // ADDED — new file staged (index=A, worktree=clean)
    {
      path: "src/new-feature.ts",
      indexStatus: "A",
      worktreeStatus: " ",
      staged: true,
      unstaged: false,
      untracked: false,
      conflicted: false,
    },
    // DELETED — staged removal (index=D, worktree=clean)
    {
      path: "src/legacy.ts",
      indexStatus: "D",
      worktreeStatus: " ",
      staged: true,
      unstaged: false,
      untracked: false,
      conflicted: false,
    },
    // RENAMED — staged rename (index=R)
    {
      path: "docs/OVERVIEW.md",
      oldPath: "docs/README.md",
      indexStatus: "R",
      worktreeStatus: " ",
      staged: true,
      unstaged: false,
      untracked: false,
      conflicted: false,
    },
    // UNTRACKED — file written but never added
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
      staged: false,
      unstaged: false,
      untracked: true,
      conflicted: false,
    },
    // CONFLICTED — unresolved merge conflict
    {
      path: "src/shared.ts",
      indexStatus: "U",
      worktreeStatus: "U",
      staged: false,
      unstaged: false,
      untracked: false,
      conflicted: true,
    },
  ],
  truncated: false,
  maxChanges: 500,
} as const;

// Minimal text diff for app.ts (modified file) — enough to render a diff hunk in the pane.
const APP_TS_DIFF =
  "diff --git a/src/app.ts b/src/app.ts\n" +
  "index abcdef1..1234567 100644\n" +
  "--- a/src/app.ts\n" +
  "+++ b/src/app.ts\n" +
  "@@ -1 +1 @@\n" +
  "-export const version = 1;\n" +
  "+export const version = 2;\n";

// Deterministic stage/unstage governed responses (success outcome — content-free).
const STAGE_SUCCESS_BODY = {
  schemaVersion: "1",
  status: "succeeded",
  actionKind: "stage",
  policyOutcome: "allowed",
} as const;

const UNSTAGE_SUCCESS_BODY = {
  schemaVersion: "1",
  status: "succeeded",
  actionKind: "unstage",
  policyOutcome: "allowed",
} as const;

// Commit preview response used to verify [data-testid="git-commit-preview"] appears.
const COMMIT_PREVIEW_BODY = {
  schemaVersion: "1",
  summary: { stagedFileCount: 3, areaCount: 2, touchesTests: false },
  intent: { warnings: [], isWip: false },
  messageValidation: { ok: true },
  preflightFindingCodes: [],
  policyOutcome: "allowed",
} as const;

function jsonBody(body: unknown): { status: number; contentType: string; body: string } {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

// Read surface: /api/git/status (all six file states) + /api/git/branches (toolbar) +
// /api/git/diff (a text hunk for app.ts; empty diff for other paths).
async function interceptReadRoutes(page: Page): Promise<void> {
  await page.route("**/api/git/status**", async (route) => {
    const rootParam = new URL(route.request().url()).searchParams.get("root") ?? "";
    await route.fulfill(
      jsonBody({ ...STATUS_FIXTURE, root: rootParam, repositoryRoot: rootParam }),
    );
  });
  await page.route("**/api/git/branches**", async (route) => {
    const rootParam = new URL(route.request().url()).searchParams.get("root") ?? "";
    await route.fulfill(
      jsonBody({
        schemaVersion: "1",
        root: rootParam,
        repositoryRoot: rootParam,
        state: "available",
        available: true,
        branches: [{ name: "main", headRefHash: "abc123", current: true }],
        truncated: false,
      }),
    );
  });
  await page.route("**/api/git/diff**", async (route) => {
    const url = new URL(route.request().url());
    const rootParam = url.searchParams.get("root") ?? "";
    const pathParam = url.searchParams.get("path") ?? "";
    const scope = url.searchParams.get("scope") ?? "worktree";
    await route.fulfill(
      jsonBody({
        schemaVersion: "1",
        root: rootParam,
        repositoryRoot: rootParam,
        state: "available",
        available: true,
        path: pathParam,
        scope,
        diff: pathParam === "src/app.ts" ? APP_TS_DIFF : "",
        truncated: false,
        maxBytes: 131072,
      }),
    );
  });
}

// /api/projects (the fixture repo) + governed staging/commit-preview routes (deterministic success).
async function interceptProjectAndMutationRoutes(page: Page, fixtureRoot: string): Promise<void> {
  await page.route("**/api/projects**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill(
      jsonBody({
        projects: [
          {
            path: fixtureRoot,
            name: "keiko-git-changes-1575",
            favorite: false,
            createdAt: Date.now(),
            lastOpenedAt: Date.now(),
            available: true,
          },
        ],
      }),
    );
  });
  await page.route("**/api/git-delivery/staging/stage**", async (route) => {
    await route.fulfill(jsonBody(STAGE_SUCCESS_BODY));
  });
  await page.route("**/api/git-delivery/staging/unstage**", async (route) => {
    await route.fulfill(jsonBody(UNSTAGE_SUCCESS_BODY));
  });
  await page.route("**/api/git-delivery/commit/preview**", async (route) => {
    await route.fulfill(jsonBody(COMMIT_PREVIEW_BODY));
  });
}

async function interceptGitRoutes(page: Page, fixtureRoot: string): Promise<void> {
  await interceptReadRoutes(page);
  await interceptProjectAndMutationRoutes(page, fixtureRoot);
}

// ─── Window seeding ───────────────────────────────────────────────────────────────────────────────

// The governedGit window is seeded via the app's REAL keiko.workspace.v4 persistence key so the
// REAL WindowsRegistry renders GitClientWindow with cfg.projectPath = fixtureRoot. The
// persistence strategy for governedGit is "fs-reference" (not "evidence-reference"), so
// slash-bearing absolute filesystem paths survive sanitizeCfgForPersistence unchanged.
async function seedGitClientWindow(page: Page, fixtureRoot: string): Promise<void> {
  await page.addInitScript((projectPath) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-1575-git-changes",
          type: "governedGit",
          x: 24,
          y: 24,
          w: 1200,
          h: 900,
          z: 20,
          cfg: { projectPath },
          // Maximized so the sidebar (file list + commit composer) and the diff pane are all
          // within the tall viewport; no scrolling required to reach any assertion target.
          max: true,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  }, fixtureRoot);
}

// ─── Evidence helpers ─────────────────────────────────────────────────────────────────────────────

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #1575 git-changes evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) {
    throw new Error("Unexpected Issue #1575 git-changes evidence artifact name");
  }
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Issue #1575 git-changes evidence artifact escaped its directory");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #1575 git-changes evidence artifact path is a symlink");
  }
  return resolved;
}

const MANIFEST_ROUTES = [
  "/api/git/status",
  "/api/git/branches",
  "/api/git/diff",
  "/api/projects",
  "/api/git-delivery/staging/stage",
  "/api/git-delivery/staging/unstage",
  "/api/git-delivery/commit/preview",
] as const;

const MANIFEST_FIXTURE_STATES = {
  modified: "src/app.ts — tracked, committed, then edited in worktree (worktreeStatus=M)",
  added: "src/new-feature.ts — new file staged but never committed (indexStatus=A)",
  deleted: "src/legacy.ts — committed then staged for removal (indexStatus=D)",
  renamed: "docs/README.md → docs/OVERVIEW.md — staged rename (indexStatus=R)",
  untracked: "notes.txt — written but never staged (untracked=true)",
  conflicted: "src/shared.ts — unresolved merge conflict between main and feature branches",
} as const;

const MANIFEST_NOTES = [
  "Real governedGit window rendered through the real WindowsRegistry + GitClientWindow.",
  "Read surface (status/diff) intercepted with deterministic fixture carrying all six states.",
  "Staging mutation routes intercepted for determinism; commit is not exercised (no staged files).",
  "The real git fixture is built in a temp dir (execFileSync git init/add/commit/mv/rm/merge).",
] as const;

function writeEvidenceManifest(fixtureRoot: string): void {
  const manifest = {
    issue: "#1575",
    epic: "#1571",
    harness: "playwright.issue-1575-git-changes.config.ts",
    appPath: "packaged-cli-ui",
    route: "/",
    evidencePath: "docs/git-delivery/evidence/1575",
    generatedAt: new Date().toISOString(),
    fixtureRoot,
    routesIntercepted: MANIFEST_ROUTES,
    windowRegistration: {
      kind: "gitClient",
      windowType: "governedGit",
      seededVia: "keiko.workspace.v4",
      renderedBy: "GitClientWindow",
      cfgPersistence: "fs-reference",
    },
    gitFixtureStates: MANIFEST_FIXTURE_STATES,
    notes: MANIFEST_NOTES,
    artifacts: ARTIFACT_NAMES,
  };
  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

// ─── Tests ────────────────────────────────────────────────────────────────────────────────────────

// Asserts the changed-file list renders all six states with the correct indicators + header.
async function assertChangedFileList(gitWindow: Locator): Promise<Locator> {
  const nav = gitWindow.locator('nav[aria-label="Changed files"]');
  await expect(nav).toBeVisible();
  await expect(nav.locator("li")).toHaveCount(6);

  // Header counter (6 changes, 3 staged) and the stage-all / unstage-all actions.
  await expect(gitWindow.getByText(/6 changed · 3 staged/u)).toBeVisible();
  await expect(gitWindow.getByRole("button", { name: "Stage all", exact: true })).toBeVisible();
  await expect(gitWindow.getByRole("button", { name: "Unstage all", exact: true })).toBeVisible();

  // MODIFIED (unstaged → "Stage") vs staged ADDED/DELETED/RENAMED (→ "Unstage").
  await expect(nav.locator('input[type="checkbox"][aria-label="Stage src/app.ts"]')).toBeVisible();
  await expect(
    nav.locator('input[type="checkbox"][aria-label="Unstage src/new-feature.ts"]'),
  ).toBeVisible();
  await expect(
    nav.locator('input[type="checkbox"][aria-label="Unstage src/legacy.ts"]'),
  ).toBeVisible();
  await expect(
    nav.locator('input[type="checkbox"][aria-label="Unstage docs/OVERVIEW.md"]'),
  ).toBeVisible();

  // Word indicators (never colour alone) for the staged / untracked / conflicted states.
  // Exact, case-sensitive match targets the visible badge text only — the rows also carry a
  // lowercase screen-reader status label (e.g. "untracked") that a loose match would collide with.
  await expect(nav.getByText("Staged", { exact: true }).first()).toBeVisible();
  await expect(nav.getByText("Untracked", { exact: true })).toBeVisible();
  await expect(nav.getByText("Conflict", { exact: true })).toBeVisible();
  return nav;
}

// Asserts the diff pane scope controls, a rendered hunk, the no-diff state, and the commit composer.
async function assertDiffAndCommitComposer(
  page: Page,
  gitWindow: Locator,
  nav: Locator,
): Promise<void> {
  // No scope group until a change is selected.
  await expect(gitWindow.getByRole("group", { name: "Diff scope" })).toHaveCount(0);

  // Select the MODIFIED file → scope toggle + a rendered hunk ("+export const version = 2;").
  await nav.getByRole("button").filter({ hasText: "src/app.ts" }).click();
  const scopeGroup = gitWindow.getByRole("group", { name: "Diff scope" });
  await expect(scopeGroup).toBeVisible();
  await expect(scopeGroup.getByRole("button", { name: "Worktree", exact: true })).toBeVisible();
  await expect(scopeGroup.getByRole("button", { name: "Staged", exact: true })).toBeVisible();
  await expect(gitWindow.getByText(/version = 2/u)).toBeVisible();

  // Select the RENAMED file (no text diff) → the no-diff empty state.
  await nav.getByRole("button").filter({ hasText: "docs/OVERVIEW.md" }).click();
  await expect(gitWindow.getByText("No diff content for this change.")).toBeVisible();

  // Commit composer: labelled Summary + Description, a Commit button, and a debounced policy preview.
  const commitSection = gitWindow.locator('section[aria-label="Commit"]');
  await expect(commitSection).toBeVisible();
  await expect(commitSection.getByLabel("Summary")).toBeVisible();
  await expect(commitSection.getByLabel("Description")).toBeVisible();
  await expect(commitSection.getByRole("button", { name: /Commit/u })).toBeVisible();
  await commitSection.getByLabel("Summary").fill("chore: verify git changes view for issue 1575");
  await expect(page.locator('[data-testid="git-commit-preview"]')).toBeVisible();
}

test("Issue #1575 — Git Changes view renders all six file states against a real git fixture", async ({
  page,
}) => {
  ensureEvidenceDir();
  const fixtureRoot = buildGitFixture();

  await interceptGitRoutes(page, fixtureRoot);
  await seedGitClientWindow(page, fixtureRoot);
  await page.goto("/");

  const gitWindow = page.locator('[data-window-id="issue-1575-git-changes"]');
  await expect(gitWindow).toBeVisible();

  const nav = await assertChangedFileList(gitWindow);
  await assertDiffAndCommitComposer(page, gitWindow, nav);

  await page.locator("body").screenshot({ path: artifactPath("git-changes-view.png") });
  writeEvidenceManifest(fixtureRoot);
});

// ─── Focused sub-assertions (mutation-robust, single act each) ────────────────────────────────────

test("Issue #1575 — Stage all button is enabled when unstaged changes are present", async ({
  page,
}) => {
  const fixtureRoot = buildGitFixture();
  await interceptGitRoutes(page, fixtureRoot);
  await seedGitClientWindow(page, fixtureRoot);
  await page.goto("/");

  const gitWindow = page.locator('[data-window-id="issue-1575-git-changes"]');
  await expect(gitWindow).toBeVisible();
  const stageAllBtn = gitWindow.getByRole("button", { name: "Stage all", exact: true });
  await expect(stageAllBtn).toBeVisible();
  // The fixture has 1 unstaged (app.ts) + 1 untracked (notes.txt) → Stage all must be enabled.
  await expect(stageAllBtn).toBeEnabled();
});

test("Issue #1575 — Unstage all button is enabled when staged changes are present", async ({
  page,
}) => {
  const fixtureRoot = buildGitFixture();
  await interceptGitRoutes(page, fixtureRoot);
  await seedGitClientWindow(page, fixtureRoot);
  await page.goto("/");

  const gitWindow = page.locator('[data-window-id="issue-1575-git-changes"]');
  await expect(gitWindow).toBeVisible();
  const unstageAllBtn = gitWindow.getByRole("button", { name: "Unstage all", exact: true });
  await expect(unstageAllBtn).toBeVisible();
  // The fixture has 3 staged files → Unstage all must be enabled.
  await expect(unstageAllBtn).toBeEnabled();
});

test("Issue #1575 — Untracked row checkbox aria-label uses 'Stage' not 'Unstage'", async ({
  page,
}) => {
  const fixtureRoot = buildGitFixture();
  await interceptGitRoutes(page, fixtureRoot);
  await seedGitClientWindow(page, fixtureRoot);
  await page.goto("/");

  const gitWindow = page.locator('[data-window-id="issue-1575-git-changes"]');
  await expect(gitWindow).toBeVisible();
  const nav = gitWindow.locator('nav[aria-label="Changed files"]');
  // Untracked files are unstaged; their checkbox must say "Stage <path>", not "Unstage <path>".
  await expect(nav.locator('input[aria-label="Stage notes.txt"]')).toBeVisible();
  await expect(nav.locator('input[aria-label="Unstage notes.txt"]')).toHaveCount(0);
});

test("Issue #1575 — Conflicted row checkbox aria-label uses 'Stage' not 'Unstage'", async ({
  page,
}) => {
  const fixtureRoot = buildGitFixture();
  await interceptGitRoutes(page, fixtureRoot);
  await seedGitClientWindow(page, fixtureRoot);
  await page.goto("/");

  const gitWindow = page.locator('[data-window-id="issue-1575-git-changes"]');
  await expect(gitWindow).toBeVisible();
  const nav = gitWindow.locator('nav[aria-label="Changed files"]');
  // Conflicted files show staged=false; their checkbox must say "Stage <path>".
  await expect(nav.locator('input[aria-label="Stage src/shared.ts"]')).toBeVisible();
  await expect(nav.locator('input[aria-label="Unstage src/shared.ts"]')).toHaveCount(0);
});

test("Issue #1575 — Switching diff scope from Worktree to Staged changes aria-pressed state", async ({
  page,
}) => {
  const fixtureRoot = buildGitFixture();
  await interceptGitRoutes(page, fixtureRoot);
  await seedGitClientWindow(page, fixtureRoot);
  await page.goto("/");

  const gitWindow = page.locator('[data-window-id="issue-1575-git-changes"]');
  await expect(gitWindow).toBeVisible();

  // Select the modified file so the diff pane activates.
  const nav = gitWindow.locator('nav[aria-label="Changed files"]');
  await nav.getByRole("button").filter({ hasText: "src/app.ts" }).click();

  const scopeGroup = gitWindow.getByRole("group", { name: "Diff scope" });
  const worktreeBtn = scopeGroup.getByRole("button", { name: "Worktree", exact: true });
  const stagedBtn = scopeGroup.getByRole("button", { name: "Staged", exact: true });

  // Default: Worktree is active (aria-pressed=true), Staged is inactive.
  await expect(worktreeBtn).toHaveAttribute("aria-pressed", "true");
  await expect(stagedBtn).toHaveAttribute("aria-pressed", "false");

  // Click Staged — the scope switches.
  await stagedBtn.click();
  await expect(stagedBtn).toHaveAttribute("aria-pressed", "true");
  await expect(worktreeBtn).toHaveAttribute("aria-pressed", "false");
});
