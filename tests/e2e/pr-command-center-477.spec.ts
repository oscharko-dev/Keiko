import { expect, test, type Page, type Route } from "@playwright/test";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Issue #477 (Epic #470) — browser evidence that the governed GitHub pull request command center
// cannot bypass policy (AC1/AC4/AC5). This drives the REAL packaged CLI UI (page.goto("/")) and the
// REAL window registry: the governedPullRequest window is seeded into the app's own keiko.workspace.v4
// persistence key, so the app renders GovernedPullRequestCard exactly as a launcher would. The two
// governed PR routes are intercepted with deterministic governed JSON (no real gh/GitHub) so the
// assertion is stable; the integration/contract suites already prove the routes enforce policy. The
// browser proof here is narrower and load-bearing: the UI PR path is wired through the governed execute
// RESPONSE and surfaces the block — there is no client-side "open anyway" escape hatch.

const REPO = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO, "docs", "git-delivery", "evidence", "477");
const ARTIFACT_NAMES = ["manifest.json", "governed-pr-block.png"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

const PREVIEW_ROUTE = "**/api/git-delivery/pr/preview";
const EXECUTE_ROUTE = "**/api/git-delivery/pr/execute";

// `dev` is a legitimate integration base in the default PR policy pack; `experimental-trunk` is not.
const SAFE_BASE = "dev";
const BLOCKED_BASE = "experimental-trunk";

interface PostedRequest {
  readonly baseBranchName?: unknown;
  readonly headBranchName?: unknown;
  readonly ownerAndRepo?: unknown;
  readonly kind?: unknown;
  readonly verifiedCommitSha?: unknown;
}

// #3394 review: the reviewed head SHA every preview reports back — the browser must capture it and
// resubmit it as `verifiedCommitSha` on the execute call, never independently re-derive it.
const HEAD_COMMIT_SHA = "a".repeat(40);

function readPosted(route: Route): PostedRequest {
  const raw = route.request().postData();
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as PostedRequest;
  } catch {
    return {};
  }
}

function previewBody(base: string): unknown {
  const blocked = base !== SAFE_BASE;
  return {
    schemaVersion: "1",
    actionKind: "pr-create",
    headBranchName: "claude/issue-477-github-pr-command-center",
    baseBranchName: base,
    headCommitSha: HEAD_COMMIT_SHA,
    riskClass: "protected-or-merge",
    riskSeverity: 3,
    isDraft: false,
    policyOutcome: blocked ? "blocked" : "allowed",
    ...(blocked ? { policyBlockReason: "policy-pack-blocked" } : {}),
    composedTitle: "feat(keiko-server): github pr command center",
    composedBody: "## Summary\nfeat: github pr command center",
    riskNarrative: "This change is classified protected-or-merge (severity 3).",
    recommendation: blocked ? "blocked" : "create-as-ready",
    readiness: { objectExists: false, reviewReady: false, blockerCodes: [] },
    suggestedLabels: ["enhancement"],
    suggestedIssueRefs: ["#477"],
    titleByteLength: 10,
    bodyByteLength: 20,
  };
}

function executeBody(base: string): unknown {
  if (base !== SAFE_BASE) {
    return {
      schemaVersion: "1",
      status: "blocked",
      actionKind: "pr-create",
      blockReason: "policy-pack-blocked",
      policyOutcome: "blocked",
    };
  }
  return {
    schemaVersion: "1",
    status: "succeeded",
    actionKind: "pr-create",
    policyOutcome: "constrained",
    createdPrExternalId: "1499",
  };
}

async function fulfilJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

interface RouteLedger {
  previewBodies: PostedRequest[];
  executeBodies: PostedRequest[];
}

// #3394 review: pre-existing gap, unrelated to this fix — confirmed still present at the freeze
// commit (epic #3384 correction 5 made GovernedPullRequestCard's `withMintedPrApproval` mint via
// POST /api/git-delivery/pr/approve unconditionally before every execute, but this fixture never
// mocked that route, so it fell through to the real running server and failed with an
// unknown-project error). Mocked here, alongside the fix under test, so this spec's own "safe base
// reaches succeeded" proof — and this fix's own capture-and-resend assertion on the execute body —
// are reachable at all.
const APPROVE_ROUTE = "**/api/git-delivery/pr/approve**";

function approveBody(): unknown {
  return {
    schemaVersion: "1",
    approval: {
      schemaVersion: "1",
      approvalId: "e2e-477-approval",
      approvalToken: "e2e-477-token",
    },
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

async function interceptGovernedPrRoutes(page: Page, ledger: RouteLedger): Promise<void> {
  await page.route(PREVIEW_ROUTE, async (route) => {
    const posted = readPosted(route);
    ledger.previewBodies.push(posted);
    const base = typeof posted.baseBranchName === "string" ? posted.baseBranchName : "";
    await fulfilJson(route, previewBody(base));
  });
  await page.route(APPROVE_ROUTE, async (route) => {
    await fulfilJson(route, approveBody());
  });
  await page.route(EXECUTE_ROUTE, async (route) => {
    const posted = readPosted(route);
    ledger.executeBodies.push(posted);
    const base = typeof posted.baseBranchName === "string" ? posted.baseBranchName : "";
    await fulfilJson(route, executeBody(base));
  });
}

// Seed the governedPullRequest window through the app's REAL persistence key so the REAL registry
// renders GovernedPullRequestCard with a concrete project reference. The projectId is an opaque,
// slash-free token that survives sanitisation and yields a non-empty projectId (leaving the empty
// state). Mirrors the #476 evidence harness.
const PROJECT_REFERENCE = "issue-477-governed-project";

async function seedGovernedPrWindow(page: Page): Promise<void> {
  await page.addInitScript((projectRef) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-477-governed-pr",
          type: "governedPullRequest",
          x: 24,
          y: 24,
          w: 600,
          h: 820,
          z: 20,
          cfg: {
            projectPath: projectRef,
            headBranchName: "claude/issue-477-github-pr-command-center",
          },
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
    throw new Error("Issue #477 pr-command-center evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!ARTIFACT_NAMES.includes(name)) {
    throw new Error("Unexpected Issue #477 pr-command-center evidence artifact");
  }
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Issue #477 pr-command-center evidence artifact escaped its directory");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #477 pr-command-center evidence artifact path is a symlink");
  }
  return resolved;
}

async function openGovernedPrWindow(page: Page, ledger: RouteLedger): Promise<void> {
  await interceptGovernedPrRoutes(page, ledger);
  await seedGovernedPrWindow(page);
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
  // #3394 review: pre-existing gap, unrelated to this fix — confirmed still present, unchanged, at
  // the freeze commit. The window's actual title heading is "Pull Request" (WindowsRegistry.ts); the
  // stale "Pull request command center" text this locator looked for never matched, so this browser
  // proof never reached its own governed-PR assertions.
  await expect(page.getByRole("heading", { name: "Pull Request", exact: true })).toBeVisible();
  await expect(page.getByTestId("gpr-empty")).toHaveCount(0);
}

async function fillTarget(page: Page, base: string): Promise<void> {
  // #3394 review: pre-existing gap, unrelated to this fix — confirmed still present at the freeze
  // commit. `getByLabel` substring-matches by default, and the later PR-description panel (#3399)
  // added its OWN field whose aria-label ("Description repository (owner/repo)") contains this same
  // text, so the unqualified locator became ambiguous once that panel started rendering alongside
  // this form. `exact: true` disambiguates to the create/update form's own field.
  await page.getByLabel("Repository (owner/repo)", { exact: true }).fill("oscharko-dev/Keiko");
  await page.getByLabel("Base branch").fill(base);
  await page.getByLabel("Pull request title").fill("feat: governed pr command center");
}

// The no-bypass proof: a base outside the integration allow-list must surface the governed block both at
// preview time and — critically — when the Open button (the only PR affordance) is pressed.
async function assertBlockedBaseIsBlocked(page: Page, ledger: RouteLedger): Promise<void> {
  await fillTarget(page, BLOCKED_BASE);

  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const readiness = page.getByTestId("gpr-readiness");
  await expect(readiness).toBeVisible();
  await expect(readiness).toContainText("Policy: blocked");
  await expect(readiness).toContainText("policy-pack-blocked");

  await page.getByTestId("gpr-submit").click();
  const outcome = page.getByTestId("gpr-outcome");
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText("pr-create: blocked");
  await expect(outcome).toContainText("reason: policy-pack-blocked");

  expect(ledger.executeBodies.length).toBeGreaterThanOrEqual(1);
  expect(ledger.executeBodies[ledger.executeBodies.length - 1]?.baseBranchName).toBe(BLOCKED_BASE);
}

// Positive control: an integration-base PR reaches succeeded through the SAME execute route — so the
// block above is policy talking, not a blanket PR failure.
async function assertSafeBaseSucceeds(page: Page, ledger: RouteLedger): Promise<void> {
  await page.getByLabel("Base branch").fill(SAFE_BASE);
  // #3394 review: re-preview the changed target before executing — the previous preview was for
  // BLOCKED_BASE, and the capture-and-resubmit contract only attaches `verifiedCommitSha` from a
  // preview that is still valid for the CURRENT target (GovernedPullRequestCard.tsx's
  // `usePrFormActionHandlers`), exactly as a real user reviewing before submitting would.
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByTestId("gpr-readiness")).toContainText("Policy: allowed");
  await page.getByTestId("gpr-submit").click();
  await expect(page.getByTestId("gpr-outcome")).toContainText("pr-create: succeeded");
  await expect(page.getByTestId("gpr-outcome")).toContainText("pr: #1499");
  const lastExecute = ledger.executeBodies[ledger.executeBodies.length - 1];
  expect(lastExecute?.baseBranchName).toBe(SAFE_BASE);
  // The reviewed head commit is captured from the preview response just evaluated and threaded
  // through to execute — never independently re-derived at click time.
  expect(lastExecute?.verifiedCommitSha).toBe(HEAD_COMMIT_SHA);
}

function writeEvidenceManifest(ledger: RouteLedger): void {
  const manifest = {
    issue: "#477",
    epic: "#470",
    harness: "tests/e2e/config/playwright.issue-477-pr-command-center.config.ts",
    appPath: "packaged-cli-ui",
    route: "/",
    evidencePath: "docs/git-delivery/evidence/477",
    generatedAt: new Date().toISOString(),
    governedRoutes: [
      "/api/git-delivery/pr/preview",
      "/api/git-delivery/pr/approve",
      "/api/git-delivery/pr/execute",
    ],
    windowRegistration: {
      kind: "governedPullRequest",
      seededVia: "keiko.workspace.v4",
      renderedBy: "GovernedPullRequestCard",
    },
    assertions: {
      packagedUiLoaded: true,
      governedWindowMountedFromRegistry: true,
      blockedBasePreviewSurfacesPolicyBlock: true,
      prPathSurfacesGovernedBlock: true,
      blockReasonIsPolicyPackBlocked: true,
      browserReachedGovernedPrExecuteRoute: true,
      integrationBaseReachesSucceeded: true,
      createdPrNumberSurfaced: true,
    },
    requestLedger: {
      previewRequests: ledger.previewBodies.length,
      executeRequests: ledger.executeBodies.length,
    },
    notes: [
      "Real packaged CLI UI; governedPullRequest window rendered through the real WindowsRegistry.",
      "PR routes intercepted with governed JSON for determinism; routing enforcement is proven by the integration/route/contract suites.",
      "The UI exposes no open-anyway escape: the Open button always routes through /pr/execute and renders its governed response verbatim.",
    ],
    artifacts: ARTIFACT_NAMES,
  };
  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("Issue #477 — browser PR path cannot bypass governed base policy", async ({ page }) => {
  ensureEvidenceDir();
  const ledger: RouteLedger = { previewBodies: [], executeBodies: [] };

  await openGovernedPrWindow(page, ledger);
  await assertBlockedBaseIsBlocked(page, ledger);
  await page.locator("body").screenshot({ path: artifactPath("governed-pr-block.png") });
  await assertSafeBaseSucceeds(page, ledger);

  writeEvidenceManifest(ledger);
});
