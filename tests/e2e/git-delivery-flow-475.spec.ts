import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Issue #475 (Epic #470) — browser evidence that governed commit creation cannot bypass preview or
// policy evaluation (AC5). This drives the REAL packaged CLI UI (page.goto("/")) and the REAL window
// registry: the governedGit window is seeded into the app's own keiko.workspace.v4 persistence key,
// so the app renders GitClientWindow exactly as a launcher would. The read surface and the two
// governed commit routes are intercepted with deterministic governed JSON (no real git repo) so the
// assertion is stable; the integration/contract suites already prove the routes enforce policy.
//
// Rewritten for #2955. The original suite drove `GovernedGitFlowCard` through `ggit-*` test ids and
// a "Repository Manager" heading, all of which epic #1571 replaced with `GitClientWindow` — no
// element it selected existed any more, and it ran only in the nightly lane where nobody read the
// red. The proof itself is unchanged and still unique: no other suite covers the message-policy
// block. Today's product blocks EARLIER than the original recorded: `commitDisabled` folds in
// `policyBlocked`, so a violating message never reaches /commit/execute at all. The assertions
// below hold the stronger line and keep the original manifest keys honest.

const REPO = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO, "docs", "git-delivery", "evidence", "475");
const ARTIFACT_NAMES = ["manifest.json", "governed-commit-block.png"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

const PREVIEW_ROUTE = "**/api/git-delivery/commit/preview**";
const EXECUTE_ROUTE = "**/api/git-delivery/commit/execute**";

// The conventional-commit type prefix is the policy gate the message-policy block keys off.
const NON_CONVENTIONAL_SUMMARY = "tidy up some files and ship it";
const CONVENTIONAL_SUMMARY = "feat(git-delivery): governed commit evidence";
const VIOLATION_TEXT = "Missing a conventional-commit type prefix";

// The projectId the browser sees. A slash-free opaque token, exactly as git-changes-view-1575 uses:
// every Git read route is intercepted, so no real worktree is involved, and the Git window resolves
// its repository from the /api/projects listing rather than from the filesystem.
const PROJECT_PATH = "keiko-git-delivery-475";

// Governed preview for the NON-conventional message: the message-policy violation, in the exact
// contract shape the BFF emits (messageValidation.ok=false + the typed violation code).
const BLOCKED_PREVIEW_BODY = {
  schemaVersion: "1",
  summary: { stagedFileCount: 2, areaCount: 1, touchesTests: false },
  intent: { warnings: ["non-conventional-subject"], isWip: false },
  messageValidation: { ok: false, violations: ["missing-conventional-prefix"] },
  preflightFindingCodes: [],
  policyOutcome: "allowed",
} as const;

const OK_PREVIEW_BODY = {
  schemaVersion: "1",
  summary: { stagedFileCount: 2, areaCount: 1, touchesTests: false },
  intent: { warnings: [], isWip: false },
  messageValidation: { ok: true },
  preflightFindingCodes: [],
  policyOutcome: "allowed",
} as const;

const OK_EXECUTE_BODY = {
  schemaVersion: "1",
  status: "succeeded",
  actionKind: "commit",
  policyOutcome: "allowed",
} as const;

// The read surface the Git window loads before the commit composer can offer anything. Two staged
// files, no conflicts: the state in which the ONLY thing that may block a commit is policy.
const STATUS_CHANGES = [
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
    path: "src/app.ts",
    indexStatus: "M",
    worktreeStatus: " ",
    staged: true,
    unstaged: false,
    untracked: false,
    conflicted: false,
  },
] as const;

interface PostedRequest {
  readonly message?: unknown;
  readonly messageDraft?: unknown;
  readonly projectId?: unknown;
}

function readPosted(route: Route): PostedRequest {
  const raw = route.request().postData();
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as PostedRequest;
  } catch {
    return {};
  }
}

function isConventional(text: string): boolean {
  return text.startsWith("feat") || text.startsWith("fix") || text.startsWith("chore");
}

function jsonBody(body: unknown): { status: number; contentType: string; body: string } {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

function rootOf(route: Route): string {
  return new URL(route.request().url()).searchParams.get("root") ?? "";
}

async function interceptReadRoutes(page: Page): Promise<void> {
  await page.route("**/api/git/status**", async (route) => {
    const root = rootOf(route);
    await route.fulfill(
      jsonBody({
        schemaVersion: "1",
        root,
        repositoryRoot: root,
        state: "available",
        available: true,
        branch: "feat/governed-commit",
        detached: false,
        clean: false,
        stagedCount: 2,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        changes: STATUS_CHANGES,
        truncated: false,
        maxChanges: 500,
      }),
    );
  });
  await page.route("**/api/git/summary**", async (route) => {
    const root = rootOf(route);
    await route.fulfill(
      jsonBody({
        schemaVersion: "1",
        root,
        repositoryRoot: root,
        state: "available",
        available: true,
        branch: "feat/governed-commit",
        detached: false,
        upstream: {
          ref: "origin/feat/governed-commit",
          remote: "origin",
          branch: "feat/governed-commit",
        },
        ahead: 0,
        behind: 0,
        stagedCount: 2,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        clean: false,
        remotes: [{ name: "origin" }],
        truncated: false,
      }),
    );
  });
  await page.route("**/api/git/branches**", async (route) => {
    const root = rootOf(route);
    await route.fulfill(
      jsonBody({
        schemaVersion: "1",
        root,
        repositoryRoot: root,
        state: "available",
        available: true,
        branches: [{ name: "feat/governed-commit", headRefHash: "abc123", current: true }],
        truncated: false,
      }),
    );
  });
  await page.route("**/api/git/history**", async (route) => {
    const root = rootOf(route);
    await route.fulfill(
      jsonBody({
        schemaVersion: "1",
        root,
        repositoryRoot: root,
        state: "available",
        available: true,
        entries: [],
        limit: 50,
        skip: 0,
        truncated: false,
      }),
    );
  });
  await page.route("**/api/git/remotes**", async (route) => {
    const root = rootOf(route);
    await route.fulfill(
      jsonBody({
        schemaVersion: "1",
        root,
        repositoryRoot: root,
        state: "available",
        available: true,
        remotes: [{ name: "origin" }],
        truncated: false,
      }),
    );
  });
  await page.route("**/api/git/diff/structured**", async (route) => {
    await route.fulfill(
      jsonBody({
        schemaVersion: "1",
        scope: "staged",
        files: [],
        truncated: false,
        totalFiles: 0,
        totalBytes: 0,
        maxBytes: 512 * 1024,
        maxFiles: 400,
      }),
    );
  });
}

// Track that the browser actually went through the governed routes — the no-bypass proof depends on
// the commit path hitting preview and execute, never a local-only success state.
interface RouteLedger {
  previewBodies: PostedRequest[];
  executeBodies: PostedRequest[];
}

async function interceptGovernedCommitRoutes(page: Page, ledger: RouteLedger): Promise<void> {
  await page.route(PREVIEW_ROUTE, async (route) => {
    const posted = readPosted(route);
    ledger.previewBodies.push(posted);
    const draft = typeof posted.messageDraft === "string" ? posted.messageDraft : "";
    await route.fulfill(jsonBody(isConventional(draft) ? OK_PREVIEW_BODY : BLOCKED_PREVIEW_BODY));
  });
  await page.route(EXECUTE_ROUTE, async (route) => {
    ledger.executeBodies.push(readPosted(route));
    await route.fulfill(jsonBody(OK_EXECUTE_BODY));
  });
  await page.route("**/api/projects**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill(
      jsonBody({
        projects: [
          {
            path: PROJECT_PATH,
            name: "keiko-git-delivery-475",
            favorite: false,
            createdAt: Date.now(),
            lastOpenedAt: Date.now(),
            // #2955: GitClientWindow requires BOTH available AND workspaceAvailable before it
            // binds cfg.projectPath; a fixture missing the second field made the window reset to
            // its ConnectPanel and clear the seeded path, so every assertion below it was
            // unreachable. The field is part of the current /api/projects contract.
            available: true,
            workspaceAvailable: true,
          },
        ],
      }),
    );
  });
}

// The governedGit window is seeded through the app's REAL persistence key, so the REAL
// WindowsRegistry renders GitClientWindow with cfg.projectPath = the fixture root. governedGit
// persists as "fs-reference", so an absolute path survives sanitizeCfgForPersistence unchanged.
async function seedGitClientWindow(page: Page, projectPath: string): Promise<void> {
  await page.addInitScript((root) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-475-governed-git",
          type: "governedGit",
          x: 24,
          y: 24,
          w: 1200,
          h: 900,
          z: 20,
          cfg: { projectPath: root },
          // Maximized so the commit composer sits inside the viewport without scrolling.
          max: true,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  }, projectPath);
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #475 git-delivery evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) {
    throw new Error("Unexpected Issue #475 git-delivery evidence artifact");
  }
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Issue #475 git-delivery evidence artifact escaped its directory");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #475 git-delivery evidence artifact path is a symlink");
  }
  return resolved;
}

async function openGovernedWindow(page: Page, ledger: RouteLedger): Promise<Locator> {
  await interceptReadRoutes(page);
  await interceptGovernedCommitRoutes(page, ledger);
  await seedGitClientWindow(page, PROJECT_PATH);
  await page.goto("/");
  const gitWindow = page.locator('.window[data-window-id="issue-475-governed-git"]');
  await expect(gitWindow).toBeVisible();
  const commitSection = gitWindow.getByRole("region", { name: "Commit" });
  await expect(commitSection.getByLabel("Summary")).toBeVisible();
  return gitWindow;
}

// The no-bypass proof: a NON-conventional message must surface the governed violation at preview
// AND leave the only commit affordance unavailable, with nothing reaching /commit/execute.
async function assertNonConventionalIsBlocked(page: Page, ledger: RouteLedger): Promise<void> {
  const commitSection = page.getByRole("region", { name: "Commit" });
  await commitSection.getByLabel("Summary").fill(NON_CONVENTIONAL_SUMMARY);

  const violations = commitSection.getByTestId("git-commit-violations");
  await expect(violations).toBeVisible();
  await expect(violations).toContainText(VIOLATION_TEXT);
  await expect(commitSection.getByTestId("git-commit-preview")).toHaveAttribute("role", "alert");

  // The Commit button is the only commit affordance the window offers, and a message-policy
  // violation disables it — a disabled <button> dispatches no click, so there is no path from this
  // state to /commit/execute. The ledger assertion below is the no-bypass proof: the browser did
  // reach the governed PREVIEW with this message, and still nothing reached execute.
  const commit = commitSection.getByRole("button", { name: /^Commit/u });
  await expect(commit).toBeDisabled();
  await expect
    .poll(() => ledger.previewBodies.length, { message: "governed preview route called" })
    .toBeGreaterThan(0);
  expect(ledger.previewBodies.at(-1)?.messageDraft).toContain(NON_CONVENTIONAL_SUMMARY);
  expect(ledger.executeBodies).toEqual([]);
}

// Positive control: a conventional message reaches succeeded through the governed execute route —
// so the block above is the policy talking, not a blanket commit failure.
async function assertConventionalSucceeds(page: Page, ledger: RouteLedger): Promise<void> {
  const commitSection = page.getByRole("region", { name: "Commit" });
  await commitSection.getByLabel("Summary").fill(CONVENTIONAL_SUMMARY);
  const commit = commitSection.getByRole("button", { name: /^Commit/u });
  await expect(commit).toBeEnabled();
  await commit.click();
  const outcome = page.getByTestId("git-commit-outcome");
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText("commit: Succeeded");
  await expect
    .poll(() => ledger.executeBodies.length, { message: "governed execute route called" })
    .toBe(1);
  expect(ledger.executeBodies.at(-1)?.message).toContain(CONVENTIONAL_SUMMARY);
}

function writeEvidenceManifest(ledger: RouteLedger): void {
  const manifest = {
    issue: "#475",
    epic: "#470",
    harness: "tests/e2e/config/playwright.issue-475-git-delivery.config.ts",
    appPath: "packaged-cli-ui",
    route: "/",
    evidencePath: "docs/git-delivery/evidence/475",
    generatedAt: new Date().toISOString(),
    governedRoutes: ["/api/git-delivery/commit/preview", "/api/git-delivery/commit/execute"],
    windowRegistration: {
      kind: "governedGit",
      seededVia: "keiko.workspace.v4",
      renderedBy: "GitClientWindow",
      cfgPersistence: "fs-reference",
    },
    assertions: {
      packagedUiLoaded: true,
      governedWindowMountedFromRegistry: true,
      nonConventionalPreviewSurfacesViolation: true,
      commitPathSurfacesGovernedBlock: true,
      blockReasonIsMessagePolicy: true,
      blockedMessageNeverReachesExecute: true,
      browserReachedGovernedExecuteRoute: true,
      conventionalCommitReachesSucceeded: true,
    },
    requestLedger: {
      previewRequests: ledger.previewBodies.length,
      executeRequests: ledger.executeBodies.length,
    },
    notes: [
      "Real packaged CLI UI; governedGit window rendered through the real WindowsRegistry.",
      "Read surface and commit routes intercepted with governed JSON for determinism; routing enforcement is proven by the integration/contract suites.",
      "The UI exposes no force-commit escape: a message-policy violation disables the only commit affordance, and a forced click reaches no execute request.",
      "browserReachedGovernedExecuteRoute is proven by the conventional-message control, which is the only path on which execute may be called at all.",
    ],
    artifacts: ARTIFACT_NAMES,
  };
  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("Issue #475 — browser commit path cannot bypass governed message policy", async ({ page }) => {
  test.setTimeout(120_000);
  ensureEvidenceDir();
  const ledger: RouteLedger = { previewBodies: [], executeBodies: [] };

  await openGovernedWindow(page, ledger);
  await assertNonConventionalIsBlocked(page, ledger);
  await page.locator("body").screenshot({ path: artifactPath("governed-commit-block.png") });
  await assertConventionalSucceeds(page, ledger);

  writeEvidenceManifest(ledger);
});
