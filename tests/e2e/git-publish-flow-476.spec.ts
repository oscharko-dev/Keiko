import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Issue #476 (Epic #470) — browser evidence that governed remote publish cannot bypass policy
// (AC1/AC2). Drives the REAL packaged CLI UI (page.goto("/")) and the REAL window registry: the
// governedGit window is seeded into the app's own keiko.workspace.v4 persistence key, so the app
// renders GitClientWindow exactly as a launcher would. The read surface and the two governed push
// routes are intercepted with deterministic governed JSON (no real remote) so the assertion is
// stable; the integration/contract/route suites already prove the routes enforce policy.
//
// Rewritten for #2955. The original suite drove `GovernedGitFlowCard`'s Publish section through
// `ggit-*` test ids and free-text "Source branch"/"Remote branch" fields, none of which survived
// epic #1571's GitClientWindow. Today the push target is DERIVED from repository state rather than
// typed, so the protected and safe cases are two repository summaries rather than two field values —
// and the product blocks EARLIER than the original recorded: a non-allowed push preview short-
// circuits before /push/execute is called at all. The assertions below hold that stronger line.

const REPO = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO, "docs", "git-delivery", "evidence", "476");
const ARTIFACT_NAMES = ["manifest.json", "governed-publish-block.png"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

const PREVIEW_ROUTE = "**/api/git-delivery/push/preview**";
const EXECUTE_ROUTE = "**/api/git-delivery/push/execute**";
const WINDOW_ID = "issue-476-governed-git";

// A protected/shared branch the default publish pack blocks by name; a user-namespace branch it
// permits. `isSafeTarget` mirrors the fixture's own split, not a product allow-list — the default
// pack carries no branch-pattern constraint, only the protected-name deny-list.
const PROTECTED_BRANCH = "dev";
const SAFE_BRANCH = "feat/x";

function isSafeTarget(target: string): boolean {
  return target.startsWith("feat/") || target.startsWith("fix/") || target.startsWith("chore/");
}

// The projectId the browser sees. A slash-free opaque token, exactly as git-changes-view-1575 uses:
// every Git read route is intercepted, so no real worktree is involved, and the Git window resolves
// its repository from the /api/projects listing rather than from the filesystem.
const PROJECT_PATH = "keiko-git-publish-476";

function previewBody(remoteBranchName: string): unknown {
  const safe = isSafeTarget(remoteBranchName);
  return {
    schemaVersion: "1",
    remoteAlias: "origin",
    remoteBranchName,
    sourceBranchName: remoteBranchName,
    riskClass: "publish",
    wouldCreateRemoteBranch: false,
    wouldTriggerChecks: true,
    forceBlocked: false,
    preflightBlockingCodes: [],
    preflightAdvisoryCodes: [],
    signatureRequirement: "not-required",
    policyOutcome: safe ? "allowed" : "blocked",
    // `protected-branch`, not the generic `policy-pack-blocked`: the default publish pack states
    // the protection directly (KEIKO_PROTECTED_REMOTE_BRANCHES) instead of deriving it from an
    // allow-list of branch prefixes, and pushRoutes.test.ts pins exactly this reason for `dev`.
    // A fixture carrying the other code would describe a policy model the product retired.
    ...(safe ? {} : { policyBlockReason: "protected-branch" }),
  };
}

interface PostedRequest {
  readonly remoteBranchName?: unknown;
  readonly sourceBranchName?: unknown;
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

function jsonBody(body: unknown): { status: number; contentType: string; body: string } {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

function rootOf(route: Route): string {
  return new URL(route.request().url()).searchParams.get("root") ?? "";
}

// The branch the intercepted read surface reports. Mutable so the same page can be reloaded onto the
// safe-namespace control without a second fixture: the push target is derived from this state.
const branchState = { current: PROTECTED_BRANCH };

// Module-level fixture state is safe only while something resets it. The single test below does,
// but a second test added later would silently inherit whatever the first left behind, so the
// reset lives here rather than in one test body.
test.beforeEach(() => {
  branchState.current = PROTECTED_BRANCH;
});

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
        branch: branchState.current,
        detached: false,
        clean: true,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        changes: [],
        truncated: false,
        maxChanges: 500,
      }),
    );
  });
  await page.route("**/api/git/summary**", async (route) => {
    const root = rootOf(route);
    const branch = branchState.current;
    await route.fulfill(
      jsonBody({
        schemaVersion: "1",
        root,
        repositoryRoot: root,
        state: "available",
        available: true,
        branch,
        detached: false,
        upstream: { ref: `origin/${branch}`, remote: "origin", branch },
        // Ahead of upstream: the derived sync action is Push, which is the publish path under test.
        ahead: 1,
        behind: 0,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        clean: true,
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
        branches: [{ name: branchState.current, headRefHash: "abc123", current: true }],
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
}

// Track that the browser actually went through the governed routes — the no-bypass proof depends on
// the publish path hitting preview, and on execute being reachable ONLY when policy allows.
interface RouteLedger {
  previewBodies: PostedRequest[];
  executeBodies: PostedRequest[];
}

async function interceptGovernedPushRoutes(page: Page, ledger: RouteLedger): Promise<void> {
  await page.route(PREVIEW_ROUTE, async (route) => {
    const posted = readPosted(route);
    ledger.previewBodies.push(posted);
    const target = typeof posted.remoteBranchName === "string" ? posted.remoteBranchName : "";
    await route.fulfill(jsonBody(previewBody(target)));
  });
  await page.route(EXECUTE_ROUTE, async (route) => {
    ledger.executeBodies.push(readPosted(route));
    await route.fulfill(
      jsonBody({
        schemaVersion: "1",
        status: "succeeded",
        actionKind: "push",
        policyOutcome: "allowed",
      }),
    );
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
            name: "keiko-git-publish-476",
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

// governedGit persists as "fs-reference", so an absolute path survives sanitizeCfgForPersistence.
async function seedGitClientWindow(page: Page, projectPath: string): Promise<void> {
  await page.addInitScript(
    ({ root, windowId }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: windowId,
            type: "governedGit",
            x: 24,
            y: 24,
            w: 1200,
            h: 900,
            z: 20,
            cfg: { projectPath: root },
            max: true,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { root: projectPath, windowId: WINDOW_ID },
  );
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #476 git-publish evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) {
    throw new Error("Unexpected Issue #476 git-publish evidence artifact");
  }
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Issue #476 git-publish evidence artifact escaped its directory");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #476 git-publish evidence artifact path is a symlink");
  }
  return resolved;
}

async function openGovernedWindow(page: Page, ledger: RouteLedger): Promise<Locator> {
  await interceptReadRoutes(page);
  await interceptGovernedPushRoutes(page, ledger);
  await seedGitClientWindow(page, PROJECT_PATH);
  await page.goto("/");
  const gitWindow = page.locator(`.window[data-window-id="${WINDOW_ID}"]`);
  await expect(gitWindow).toBeVisible();
  return gitWindow;
}

async function runPush(gitWindow: Locator): Promise<void> {
  const push = gitWindow.getByRole("button", { name: "Run sync: Push" });
  await expect(push).toBeEnabled();
  await push.click();
}

// The no-bypass proof: pushing to a protected/shared target must surface the governed block, and the
// browser must never reach /push/execute for it.
async function assertProtectedTargetIsBlocked(
  gitWindow: Locator,
  ledger: RouteLedger,
): Promise<void> {
  await runPush(gitWindow);
  await expect
    .poll(() => ledger.previewBodies.length, { message: "governed push preview called" })
    .toBeGreaterThan(0);
  expect(ledger.previewBodies.at(-1)?.remoteBranchName).toBe(PROTECTED_BRANCH);
  await expect(gitWindow.getByText("Blocked: protected-branch")).toBeVisible();
  expect(ledger.executeBodies).toEqual([]);
}

// Positive control: a user-namespace target reaches succeeded through the governed execute route —
// so the block above is policy talking, not a blanket publish failure.
async function assertSafeTargetSucceeds(page: Page, ledger: RouteLedger): Promise<void> {
  branchState.current = SAFE_BRANCH;
  await page.reload();
  const gitWindow = page.locator(`.window[data-window-id="${WINDOW_ID}"]`);
  await expect(gitWindow).toBeVisible();
  await runPush(gitWindow);
  await expect(gitWindow.getByText("Push: succeeded")).toBeVisible();
  await expect
    .poll(() => ledger.executeBodies.length, { message: "governed push execute called" })
    .toBe(1);
  expect(ledger.executeBodies.at(-1)?.remoteBranchName).toBe(SAFE_BRANCH);
}

function writeEvidenceManifest(ledger: RouteLedger): void {
  const manifest = {
    issue: "#476",
    epic: "#470",
    harness: "tests/e2e/config/playwright.issue-476-git-publish.config.ts",
    appPath: "packaged-cli-ui",
    route: "/",
    evidencePath: "docs/git-delivery/evidence/476",
    generatedAt: new Date().toISOString(),
    governedRoutes: ["/api/git-delivery/push/preview", "/api/git-delivery/push/execute"],
    windowRegistration: {
      kind: "governedGit",
      seededVia: "keiko.workspace.v4",
      renderedBy: "GitClientWindow (sync control)",
      cfgPersistence: "fs-reference",
    },
    assertions: {
      packagedUiLoaded: true,
      governedWindowMountedFromRegistry: true,
      protectedTargetPreviewSurfacesPolicyBlock: true,
      publishPathSurfacesGovernedBlock: true,
      blockReasonIsProtectedBranch: true,
      blockedTargetNeverReachesExecute: true,
      browserReachedGovernedPushExecuteRoute: true,
      safeNamespaceTargetReachesSucceeded: true,
    },
    requestLedger: {
      previewRequests: ledger.previewBodies.length,
      executeRequests: ledger.executeBodies.length,
    },
    notes: [
      "Real packaged CLI UI; governedGit window rendered through the real WindowsRegistry.",
      "Read surface and push routes intercepted with governed JSON for determinism; routing enforcement is proven by the integration/route/contract suites.",
      "The push target is derived from repository state, so the protected and safe cases are two intercepted summaries rather than two typed field values.",
      "The UI exposes no force-publish escape: a blocked push preview short-circuits before /push/execute, and the sync control offers no other publish affordance.",
      "browserReachedGovernedPushExecuteRoute is proven by the safe-namespace control, which is the only path on which execute may be called at all.",
    ],
    artifacts: ARTIFACT_NAMES,
  };
  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("Issue #476 — browser publish path cannot bypass governed target policy", async ({ page }) => {
  test.setTimeout(120_000);
  ensureEvidenceDir();
  const ledger: RouteLedger = { previewBodies: [], executeBodies: [] };

  const gitWindow = await openGovernedWindow(page, ledger);
  await assertProtectedTargetIsBlocked(gitWindow, ledger);
  await page.locator("body").screenshot({ path: artifactPath("governed-publish-block.png") });
  await assertSafeTargetSucceeds(page, ledger);

  writeEvidenceManifest(ledger);
});
