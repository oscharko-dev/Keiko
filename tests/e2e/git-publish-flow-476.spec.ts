import { expect, test, type Page, type Route } from "@playwright/test";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Issue #476 (Epic #470) — browser evidence that governed remote publish cannot bypass policy (AC1/AC2).
// Drives the REAL packaged CLI UI (page.goto("/")) and the REAL window registry: the governedGit window
// is seeded into the app's own keiko.workspace.v4 persistence key, so the app renders GovernedGitFlowCard
// (incl. the #476 Publish section) exactly as a launcher would. The two governed push routes are
// intercepted with deterministic governed JSON (no real remote) so the assertion is stable; the
// integration/contract/route suites already prove the routes enforce policy. The browser proof here is
// narrower and load-bearing: the UI publish path is wired through the governed execute RESPONSE and
// surfaces a protected-target BLOCK — there is no client-side "force publish" escape hatch.

const REPO = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO, "docs", "git-delivery", "evidence", "476");
const ARTIFACT_NAMES = ["manifest.json", "governed-publish-block.png"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

const PREVIEW_ROUTE = "**/api/git-delivery/push/preview";
const EXECUTE_ROUTE = "**/api/git-delivery/push/execute";

// A protected/shared remote target the default publish pack blocks; a user-namespace target it permits.
const PROTECTED_TARGET = "dev";
const SAFE_TARGET = "feat/x";

function isSafeTarget(target: string): boolean {
  return target.startsWith("feat/") || target.startsWith("fix/") || target.startsWith("chore/");
}

function previewBody(remoteBranchName: string): unknown {
  const safe = isSafeTarget(remoteBranchName);
  return {
    schemaVersion: "1",
    remoteAlias: "origin",
    remoteBranchName,
    sourceBranchName: "feat/x",
    riskClass: "publish",
    wouldCreateRemoteBranch: false,
    wouldTriggerChecks: true,
    forceBlocked: false,
    preflightBlockingCodes: [],
    preflightAdvisoryCodes: [],
    policyOutcome: safe ? "allowed" : "blocked",
    ...(safe ? {} : { policyBlockReason: "policy-pack-blocked" }),
  };
}

function executeBody(remoteBranchName: string): unknown {
  if (isSafeTarget(remoteBranchName)) {
    return {
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "push",
      policyOutcome: "allowed",
    };
  }
  return {
    schemaVersion: "1",
    status: "blocked",
    actionKind: "push",
    blockReason: "policy-pack-blocked",
    policyOutcome: "blocked",
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

async function fulfilJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

interface RouteLedger {
  previewBodies: PostedRequest[];
  executeBodies: PostedRequest[];
}

async function interceptGovernedPushRoutes(page: Page, ledger: RouteLedger): Promise<void> {
  await page.route(PREVIEW_ROUTE, async (route) => {
    const posted = readPosted(route);
    ledger.previewBodies.push(posted);
    const target = typeof posted.remoteBranchName === "string" ? posted.remoteBranchName : "";
    await fulfilJson(route, previewBody(target));
  });
  await page.route(EXECUTE_ROUTE, async (route) => {
    const posted = readPosted(route);
    ledger.executeBodies.push(posted);
    const target = typeof posted.remoteBranchName === "string" ? posted.remoteBranchName : "";
    await fulfilJson(route, executeBody(target));
  });
}

// Seed the governedGit window through the app's REAL persistence key so the REAL registry renders
// GovernedGitFlowCard with a concrete project reference. The projectId is an opaque, slash-free token
// that survives the evidence-reference sanitisation and yields a non-empty projectId (leaving the empty
// state). Mirrors the #475 evidence harness.
const PROJECT_REFERENCE = "issue-476-governed-project";

async function seedGovernedGitWindow(page: Page): Promise<void> {
  await page.addInitScript((projectRef) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-476-governed-git",
          type: "governedGit",
          x: 24,
          y: 24,
          w: 560,
          h: 760,
          z: 20,
          cfg: { projectPath: projectRef },
          max: true,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  }, PROJECT_REFERENCE);
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #476 git-publish evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!ARTIFACT_NAMES.includes(name)) {
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

async function openGovernedWindow(page: Page, ledger: RouteLedger): Promise<void> {
  await interceptGovernedPushRoutes(page, ledger);
  await seedGovernedGitWindow(page);
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Governed Git/u })).toBeVisible();
  await expect(page.getByTestId("ggit-empty")).toHaveCount(0);
  await expect(page.getByLabel("Publish")).toBeVisible();
}

async function fillPublishTarget(page: Page, remoteBranch: string): Promise<void> {
  await page.getByLabel("Source branch").fill("feat/x");
  await page.getByLabel("Remote branch").fill(remoteBranch);
}

// The no-bypass proof: pushing to a protected/shared target must surface the governed block both at
// preview time and — critically — when the Push button (the only publish affordance) is pressed.
async function assertProtectedTargetIsBlocked(page: Page, ledger: RouteLedger): Promise<void> {
  await fillPublishTarget(page, PROTECTED_TARGET);

  const preview = page.getByRole("button", { name: "Preview push" });
  await preview.scrollIntoViewIfNeeded();
  await preview.click();
  const pushPreview = page.getByTestId("ggit-push-policy");
  await expect(pushPreview).toBeVisible();
  await expect(pushPreview).toContainText("Policy: blocked");
  await expect(pushPreview).toContainText("policy-pack-blocked");

  const push = page.getByRole("button", { name: "Push", exact: true });
  await push.scrollIntoViewIfNeeded();
  await push.click();
  const outcome = page.getByTestId("ggit-outcome");
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText("push: Blocked");
  await expect(outcome).toContainText("reason: policy-pack-blocked");

  expect(ledger.executeBodies.length).toBeGreaterThanOrEqual(1);
  expect(ledger.executeBodies[ledger.executeBodies.length - 1]?.remoteBranchName).toBe(
    PROTECTED_TARGET,
  );
}

// Positive control: a user-namespace target reaches succeeded through the SAME execute route — so the
// block above is policy talking, not a blanket publish failure.
async function assertSafeTargetSucceeds(page: Page, ledger: RouteLedger): Promise<void> {
  await fillPublishTarget(page, SAFE_TARGET);
  const push = page.getByRole("button", { name: "Push", exact: true });
  await push.scrollIntoViewIfNeeded();
  await push.click();
  await expect(page.getByTestId("ggit-outcome")).toContainText("push: Succeeded");
  expect(ledger.executeBodies[ledger.executeBodies.length - 1]?.remoteBranchName).toBe(SAFE_TARGET);
}

function writeEvidenceManifest(ledger: RouteLedger): void {
  const manifest = {
    issue: "#476",
    epic: "#470",
    harness: "playwright.issue-476-git-publish.config.ts",
    appPath: "packaged-cli-ui",
    route: "/",
    evidencePath: "docs/git-delivery/evidence/476",
    generatedAt: new Date().toISOString(),
    governedRoutes: ["/api/git-delivery/push/preview", "/api/git-delivery/push/execute"],
    windowRegistration: {
      kind: "governedGit",
      seededVia: "keiko.workspace.v4",
      renderedBy: "GovernedGitFlowCard (Publish section)",
    },
    assertions: {
      packagedUiLoaded: true,
      governedWindowMountedFromRegistry: true,
      protectedTargetPreviewSurfacesPolicyBlock: true,
      publishPathSurfacesGovernedBlock: true,
      blockReasonIsPolicyPackBlocked: true,
      browserReachedGovernedPushExecuteRoute: true,
      safeNamespaceTargetReachesSucceeded: true,
    },
    requestLedger: {
      previewRequests: ledger.previewBodies.length,
      executeRequests: ledger.executeBodies.length,
    },
    notes: [
      "Real packaged CLI UI; governedGit window rendered through the real WindowsRegistry.",
      "Push routes intercepted with governed JSON for determinism; routing enforcement is proven by the integration/route/contract suites.",
      "The UI exposes no force-publish escape: the Push button always routes through /push/execute and renders its governed response verbatim.",
    ],
    artifacts: ARTIFACT_NAMES,
  };
  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("Issue #476 — browser publish path cannot bypass governed target policy", async ({ page }) => {
  ensureEvidenceDir();
  const ledger: RouteLedger = { previewBodies: [], executeBodies: [] };

  await openGovernedWindow(page, ledger);
  await assertProtectedTargetIsBlocked(page, ledger);
  await page.locator("body").screenshot({ path: artifactPath("governed-publish-block.png") });
  await assertSafeTargetSucceeds(page, ledger);

  writeEvidenceManifest(ledger);
});
