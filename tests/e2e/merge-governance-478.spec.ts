import { expect, test, type Page, type Route } from "@playwright/test";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Issue #478 (Epic #470) — browser evidence that the governed merge command center cannot bypass the
// readiness/approval gates (AC1/AC2/AC4/AC5). This drives the REAL packaged CLI UI (page.goto("/")) and
// the REAL window registry: the governedMerge window is seeded into the app's own keiko.workspace.v4
// persistence key, so the app renders GovernedMergeCard exactly as a launcher would. The two governed
// merge routes are intercepted with deterministic governed JSON (no real gh/GitHub) so the assertion is
// stable; the integration/contract suites already prove the routes enforce policy. The browser proof here
// is narrower and load-bearing: a not-mergeable PR leaves the merge button disabled (no client-side "merge
// anyway" escape), and a mergeable-but-high-risk PR can reach the governed execute route ONLY after the
// strategy is chosen from the preview's eligible set, the explicit high-risk confirmation is given, and the
// server-issued approval claim has been minted for exactly the command execute then repeats.

const REPO = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO, "docs", "git-delivery", "evidence", "478");
const ARTIFACT_NAMES = ["manifest.json", "governed-merge-block.png"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

const PREVIEW_ROUTE = "**/api/git-delivery/merge/preview";
const APPROVE_ROUTE = "**/api/git-delivery/merge/approve";
const EXECUTE_ROUTE = "**/api/git-delivery/merge/execute";

// PR 99 is a not-mergeable (conflicting) PR; PR 42 is mergeable but policy-gated as high risk.
const BLOCKED_PR = "99";
const MERGEABLE_PR = "42";

// The provider head the preview's readiness decision was made against. The card forwards it as
// `expectedHeadRefHash`, so the merge is pinned to that exact head (the provider `sha` guard).
const HEAD_REF_HASH = "0123456789abcdef0123456789abcdef01234567";

// The server-issued approval claim `/merge/approve` mints after the explicit high-risk confirmation.
const APPROVAL_CLAIM = {
  schemaVersion: "1",
  approvalId: "gda_issue478",
  approvalToken: "token-issue-478",
} as const;

interface PostedRequest {
  readonly prExternalId?: unknown;
  readonly baseBranchName?: unknown;
  readonly mergeStrategy?: unknown;
  readonly expectedHeadRefHash?: unknown;
  readonly approval?: unknown;
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

function previewBody(pr: string): unknown {
  const mergeable = pr === MERGEABLE_PR;
  return {
    schemaVersion: "1",
    actionKind: "merge",
    baseBranchName: "main",
    headBranchName: "claude/issue-478-merge-governance",
    prExternalId: pr,
    riskClass: "protected-or-merge",
    riskSeverity: 3,
    requestedStrategy: "squash",
    eligibleStrategies: ["squash", "provider-default"],
    selectedDefaultStrategy: "squash",
    requestedStrategyEligible: true,
    policyOutcome: "approval-gated",
    requiresApproval: true,
    headRefHash: HEAD_REF_HASH,
    readiness: {
      mergeable,
      blockers: mergeable
        ? []
        : [
            {
              code: "conflicts",
              severity: "blocking",
              remediation: "user-actionable",
              actionHint: "resolve-conflicts",
            },
          ],
    },
    recommendation: mergeable ? "needs-approval" : "blocked",
  };
}

function approveBody(): unknown {
  return { schemaVersion: "1", approval: APPROVAL_CLAIM, expiresAt: "2099-01-01T00:00:00.000Z" };
}

function executeBody(pr: string): unknown {
  if (pr !== MERGEABLE_PR) {
    return {
      schemaVersion: "1",
      status: "blocked",
      actionKind: "merge",
      policyOutcome: "approval-gated",
      blockReason: "protected-branch",
      mergeable: false,
      readinessBlockers: [
        {
          code: "conflicts",
          severity: "blocking",
          remediation: "user-actionable",
          actionHint: "resolve-conflicts",
        },
      ],
    };
  }
  return {
    schemaVersion: "1",
    status: "succeeded",
    actionKind: "merge",
    policyOutcome: "approval-gated",
    mergeable: true,
    merged: true,
    branchDeleted: false,
  };
}

async function fulfilJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

interface RouteLedger {
  previewBodies: PostedRequest[];
  approveBodies: PostedRequest[];
  executeBodies: PostedRequest[];
  // The order in which the approval mint and the execute call reached the governed routes.
  mutationOrder: ("approve" | "execute")[];
}

async function interceptGovernedMergeRoutes(page: Page, ledger: RouteLedger): Promise<void> {
  await page.route(PREVIEW_ROUTE, async (route) => {
    const posted = readPosted(route);
    ledger.previewBodies.push(posted);
    const pr = typeof posted.prExternalId === "string" ? posted.prExternalId : "";
    await fulfilJson(route, previewBody(pr));
  });
  await page.route(APPROVE_ROUTE, async (route) => {
    ledger.approveBodies.push(readPosted(route));
    ledger.mutationOrder.push("approve");
    await fulfilJson(route, approveBody());
  });
  await page.route(EXECUTE_ROUTE, async (route) => {
    const posted = readPosted(route);
    ledger.executeBodies.push(posted);
    ledger.mutationOrder.push("execute");
    const pr = typeof posted.prExternalId === "string" ? posted.prExternalId : "";
    await fulfilJson(route, executeBody(pr));
  });
}

// Seed the governedMerge window through the app's REAL persistence key so the REAL registry renders
// GovernedMergeCard with a concrete project reference. The projectId is an opaque, slash-free token that
// survives sanitisation and yields a non-empty projectId (leaving the empty state). Mirrors the #477
// evidence harness.
const PROJECT_REFERENCE = "issue-478-governed-project";

async function seedGovernedMergeWindow(page: Page): Promise<void> {
  await page.addInitScript((projectRef) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-478-governed-merge",
          type: "governedMerge",
          x: 24,
          y: 24,
          w: 600,
          h: 860,
          z: 20,
          cfg: {
            projectPath: projectRef,
            headBranchName: "claude/issue-478-merge-governance",
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
    throw new Error("Issue #478 merge-governance evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!ARTIFACT_NAMES.includes(name)) {
    throw new Error("Unexpected Issue #478 merge-governance evidence artifact");
  }
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Issue #478 merge-governance evidence artifact escaped its directory");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #478 merge-governance evidence artifact path is a symlink");
  }
  return resolved;
}

async function openGovernedMergeWindow(page: Page, ledger: RouteLedger): Promise<void> {
  await interceptGovernedMergeRoutes(page, ledger);
  await seedGovernedMergeWindow(page);
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
  // The window's title heading is "Merge" (GovernedMergeCard; WindowsRegistry `governedMerge`). The
  // "Merge command center" wording this locator used to look for was retired when the repository-centered
  // desktop workflow (#1652, d0e7df528) renamed the window; `exact` keeps the "Merge target" and
  // "Strategy" section headings from matching.
  await expect(page.getByRole("heading", { name: "Merge", exact: true })).toBeVisible();
  await expect(page.getByTestId("gm-empty")).toHaveCount(0);
}

async function fillTarget(page: Page, pr: string): Promise<void> {
  await page.getByLabel("Repository (owner/repo)").fill("oscharko-dev/Keiko");
  await page.getByLabel("Pull request number").fill(pr);
  await page.getByLabel("Base branch").fill("main");
}

// The no-bypass proof: a not-mergeable PR surfaces the governed readiness block AND keeps the Merge button
// disabled — there is no client-side path to the execute route.
async function assertNotMergeableIsBlocked(page: Page, ledger: RouteLedger): Promise<void> {
  await fillTarget(page, BLOCKED_PR);
  await page.getByRole("button", { name: "Preview", exact: true }).click();

  const readiness = page.getByTestId("gm-readiness");
  await expect(readiness).toBeVisible();
  await expect(readiness).toContainText("Mergeable: no");
  await expect(readiness).toContainText("blocker: conflicts");
  // AC3: the readiness block surfaces recovery guidance, not just the bare code.
  await expect(readiness).toContainText("resolve-conflicts");

  // The only merge affordance must be disabled — no approval mint or execute request is reachable.
  await expect(page.getByTestId("gm-submit")).toBeDisabled();
  expect(ledger.approveBodies).toHaveLength(0);
  expect(ledger.executeBodies).toHaveLength(0);
  expect(ledger.mutationOrder).toEqual([]);
}

// Positive control: a mergeable PR reaches succeeded through the governed execute route, but ONLY after the
// strategy is chosen from the preview's eligible set (AC2) and the explicit high-risk confirmation is given
// (AC1) — so the block above is policy/readiness talking, not a blanket merge failure. The approval-gated
// policy additionally requires the card to mint a claim via /merge/approve and attach it to the IDENTICAL
// command it then sends to /merge/execute (the server binds the claim to that exact typed command).
async function assertMergeableReachesGovernedExecute(
  page: Page,
  ledger: RouteLedger,
): Promise<void> {
  await page.getByLabel("Pull request number").fill(MERGEABLE_PR);
  await page.getByRole("button", { name: "Preview", exact: true }).click();

  // The strategy selector is populated from the preview's eligible strategies (AC2).
  const strategy = page.getByTestId("gm-strategy");
  await expect(strategy).toBeEnabled();
  await expect(strategy.locator("option")).toHaveCount(2);

  // High-risk confirmation gates the Merge button until explicitly checked (AC1).
  await expect(page.getByTestId("gm-submit")).toBeDisabled();
  await page.getByLabel("I confirm this high-risk merge").check();
  await expect(page.getByTestId("gm-submit")).toBeEnabled();
  // Confirming alone mints nothing and merges nothing: only the explicit Merge click reaches the routes.
  expect(ledger.approveBodies).toHaveLength(0);
  expect(ledger.executeBodies).toHaveLength(0);

  await page.getByTestId("gm-submit").click();
  const outcome = page.getByTestId("gm-outcome");
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText("merge: succeeded");
  await expect(outcome).toContainText("merged: yes");

  expect(ledger.approveBodies).toHaveLength(1);
  expect(ledger.executeBodies).toHaveLength(1);
  expect(ledger.mutationOrder).toEqual(["approve", "execute"]);
  const executed = ledger.executeBodies[0];
  expect(executed?.prExternalId).toBe(MERGEABLE_PR);
  expect(executed?.approval).toEqual(APPROVAL_CLAIM);
  // The merge is pinned to the exact head the readiness decision was made against.
  expect(executed?.expectedHeadRefHash).toBe(HEAD_REF_HASH);
  // Execute repeats the approved command byte for byte; the claim is the only addition.
  expect({ ...executed, approval: undefined }).toEqual(ledger.approveBodies[0]);
}

function writeEvidenceManifest(ledger: RouteLedger): void {
  const manifest = {
    issue: "#478",
    epic: "#470",
    harness: "tests/e2e/config/playwright.issue-478-merge-governance.config.ts",
    appPath: "packaged-cli-ui",
    route: "/",
    evidencePath: "docs/git-delivery/evidence/478",
    generatedAt: new Date().toISOString(),
    governedRoutes: [
      "/api/git-delivery/merge/preview",
      "/api/git-delivery/merge/approve",
      "/api/git-delivery/merge/execute",
    ],
    windowRegistration: {
      kind: "governedMerge",
      seededVia: "keiko.workspace.v4",
      renderedBy: "GovernedMergeCard",
    },
    assertions: {
      packagedUiLoaded: true,
      governedWindowMountedFromRegistry: true,
      notMergeablePrSurfacesReadinessBlock: true,
      mergeButtonDisabledWhenNotMergeable: true,
      noExecuteRequestReachableWhenBlocked: true,
      noApprovalMintedWhenBlocked: true,
      eligibleStrategiesPopulatedFromPreview: true,
      highRiskConfirmationGatesExecute: true,
      approvalMintedOnlyAfterExplicitMergeClick: true,
      executeCarriesMintedApprovalForApprovedCommand: true,
      executePinnedToPreviewedHead: true,
      browserReachedGovernedMergeExecuteRoute: true,
      mergeableReachesSucceeded: true,
    },
    requestLedger: {
      previewRequests: ledger.previewBodies.length,
      approveRequests: ledger.approveBodies.length,
      executeRequests: ledger.executeBodies.length,
    },
    notes: [
      "Real packaged CLI UI; governedMerge window rendered through the real WindowsRegistry.",
      "Merge routes intercepted with governed JSON for determinism; routing enforcement is proven by the integration/route/contract suites.",
      "The UI exposes no merge-anyway escape: the Merge button is disabled when not mergeable, and gated behind the eligible-strategy + high-risk confirmation otherwise; it mints the server-issued approval claim via /merge/approve, then always routes through /merge/execute with that claim and renders its governed response verbatim.",
    ],
    artifacts: ARTIFACT_NAMES,
  };
  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("Issue #478 — browser merge path cannot bypass governed readiness/approval gates", async ({
  page,
}) => {
  ensureEvidenceDir();
  const ledger: RouteLedger = {
    previewBodies: [],
    approveBodies: [],
    executeBodies: [],
    mutationOrder: [],
  };

  await openGovernedMergeWindow(page, ledger);
  await assertNotMergeableIsBlocked(page, ledger);
  await page.locator("body").screenshot({ path: artifactPath("governed-merge-block.png") });
  await assertMergeableReachesGovernedExecute(page, ledger);

  writeEvidenceManifest(ledger);
});
