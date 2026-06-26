import { expect, test, type Page, type Route } from "@playwright/test";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Issue #475 (Epic #470) — browser evidence that governed commit creation cannot bypass preview
// or policy evaluation (AC5). This drives the REAL packaged CLI UI (page.goto("/")) and the REAL
// window registry: the governedGit window is seeded into the app's own keiko.workspace.v4
// persistence key, so the app renders GovernedGitFlowCard exactly as a launcher would. The two
// governed commit routes are intercepted with deterministic governed JSON (no real git repo) so the
// assertion is stable; the integration/contract suites already prove the routes enforce policy. The
// browser proof here is narrower and load-bearing: the UI commit path is wired through the governed
// execute RESPONSE and surfaces the block — there is no client-side "force commit" escape hatch.

const REPO = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO, "docs", "git-delivery", "evidence", "475");
const ARTIFACT_NAMES = ["manifest.json", "governed-commit-block.png"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

const PREVIEW_ROUTE = "**/api/git-delivery/commit/preview";
const EXECUTE_ROUTE = "**/api/git-delivery/commit/execute";

// The conventional-commit type prefix is the policy gate the message-policy block keys off.
const NON_CONVENTIONAL_MESSAGE = "tidy up some files and ship it";
const CONVENTIONAL_MESSAGE = "feat(git-delivery): governed commit evidence";

// Governed preview/execute responses for the NON-conventional message: preview reports the
// message-policy violation; execute returns a hard block. This is the exact contract shape the BFF
// emits (status:"blocked", blockReason:"message-policy", messageViolations:[...]).
const BLOCKED_PREVIEW_BODY = {
  schemaVersion: "1",
  summary: { stagedFileCount: 2, areaCount: 1, touchesTests: false },
  intent: { warnings: ["non-conventional-subject"], isWip: false },
  messageValidation: { ok: false, violations: ["missing-conventional-prefix"] },
  preflightFindingCodes: [],
  policyOutcome: "allowed",
} as const;

const BLOCKED_EXECUTE_BODY = {
  schemaVersion: "1",
  status: "blocked",
  actionKind: "commit",
  blockReason: "message-policy",
  messageViolations: ["missing-conventional-prefix"],
  policyOutcome: "allowed",
} as const;

// Governed responses for the CONVENTIONAL message: preview is clean, execute succeeds.
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

async function fulfilJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

// Track that the browser actually went through the governed routes — the no-bypass proof depends on
// the commit path hitting execute (not some local-only success state).
interface RouteLedger {
  previewBodies: PostedRequest[];
  executeBodies: PostedRequest[];
}

async function interceptGovernedCommitRoutes(page: Page, ledger: RouteLedger): Promise<void> {
  await page.route(PREVIEW_ROUTE, async (route) => {
    const posted = readPosted(route);
    ledger.previewBodies.push(posted);
    const draft = typeof posted.messageDraft === "string" ? posted.messageDraft : "";
    await fulfilJson(route, isConventional(draft) ? OK_PREVIEW_BODY : BLOCKED_PREVIEW_BODY);
  });
  await page.route(EXECUTE_ROUTE, async (route) => {
    const posted = readPosted(route);
    ledger.executeBodies.push(posted);
    const message = typeof posted.message === "string" ? posted.message : "";
    await fulfilJson(route, isConventional(message) ? OK_EXECUTE_BODY : BLOCKED_EXECUTE_BODY);
  });
}

// Seed the governedGit window through the app's REAL persistence key so the REAL registry renders
// GovernedGitFlowCard with a concrete project reference (cfg.projectPath). NOTE: the governedGit
// window persists as "evidence-reference", which sanitizes cfg strings through isSafeOpaqueReference
// — slash-bearing filesystem paths are stripped from localStorage. The projectId is treated as an
// opaque reference by the card and (here) by the intercepted routes, so we use a slash-free token
// that survives persistence and yields a non-empty projectId (leaving the empty state).
const PROJECT_REFERENCE = "issue-475-governed-project";

async function seedGovernedGitWindow(page: Page): Promise<void> {
  await page.addInitScript((projectRef) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-475-governed-git",
          type: "governedGit",
          x: 24,
          y: 24,
          w: 560,
          h: 680,
          z: 20,
          cfg: { projectPath: projectRef },
          // Maximized so the card's branch/staging/commit sections all sit within the tall viewport and
          // every control (Preview/Commit) is reachable without the fixed window clipping at the fold.
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
    throw new Error("Issue #475 git-delivery evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!ARTIFACT_NAMES.includes(name)) {
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

async function openGovernedWindow(page: Page, ledger: RouteLedger): Promise<void> {
  await interceptGovernedCommitRoutes(page, ledger);
  await seedGovernedGitWindow(page);
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
  // The window mounted from the real registry: its labelled heading is present, and the card left its
  // empty state (i.e. it received a non-empty projectId) only if the commit composer is present.
  await expect(page.getByRole("heading", { name: /Governed Git/u })).toBeVisible();
  await expect(page.getByTestId("ggit-empty")).toHaveCount(0);
  await expect(page.getByLabel("Commit message")).toBeVisible();
}

// The no-bypass proof: a NON-conventional message must surface the governed block both at preview
// time and — critically — when the Commit button (the only commit affordance) is pressed.
async function assertNonConventionalIsBlocked(page: Page, ledger: RouteLedger): Promise<void> {
  await page.getByLabel("Commit message").fill(NON_CONVENTIONAL_MESSAGE);

  const preview = page.getByRole("button", { name: "Preview" });
  await preview.scrollIntoViewIfNeeded();
  await preview.click();
  const violations = page.getByTestId("ggit-violations");
  await expect(violations).toBeVisible();
  await expect(violations).toContainText("Missing a conventional-commit type prefix");

  const commit = page.getByRole("button", { name: "Commit" });
  await commit.scrollIntoViewIfNeeded();
  await commit.click();
  const outcome = page.getByTestId("ggit-outcome");
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText("commit: Blocked");
  await expect(outcome).toContainText("reason: message-policy");
  await expect(outcome).toContainText("Missing a conventional-commit type prefix");

  expect(ledger.executeBodies.length).toBeGreaterThanOrEqual(1);
  expect(ledger.executeBodies[ledger.executeBodies.length - 1]?.message).toBe(
    NON_CONVENTIONAL_MESSAGE,
  );
}

// Positive control: a conventional message reaches succeeded through the SAME execute route — so the
// block above is the policy talking, not a blanket commit failure.
async function assertConventionalSucceeds(page: Page, ledger: RouteLedger): Promise<void> {
  await page.getByLabel("Commit message").fill(CONVENTIONAL_MESSAGE);
  const commit = page.getByRole("button", { name: "Commit" });
  await commit.scrollIntoViewIfNeeded();
  await commit.click();
  await expect(page.getByTestId("ggit-outcome")).toContainText("commit: Succeeded");
  expect(ledger.executeBodies[ledger.executeBodies.length - 1]?.message).toBe(CONVENTIONAL_MESSAGE);
}

function writeEvidenceManifest(ledger: RouteLedger): void {
  const manifest = {
    issue: "#475",
    epic: "#470",
    harness: "playwright.issue-475-git-delivery.config.ts",
    appPath: "packaged-cli-ui",
    route: "/",
    evidencePath: "docs/git-delivery/evidence/475",
    generatedAt: new Date().toISOString(),
    governedRoutes: ["/api/git-delivery/commit/preview", "/api/git-delivery/commit/execute"],
    windowRegistration: {
      kind: "governedGit",
      seededVia: "keiko.workspace.v4",
      renderedBy: "GovernedGitFlowCard",
    },
    assertions: {
      packagedUiLoaded: true,
      governedWindowMountedFromRegistry: true,
      nonConventionalPreviewSurfacesViolation: true,
      commitPathSurfacesGovernedBlock: true,
      blockReasonIsMessagePolicy: true,
      browserReachedGovernedExecuteRoute: true,
      conventionalCommitReachesSucceeded: true,
    },
    requestLedger: {
      previewRequests: ledger.previewBodies.length,
      executeRequests: ledger.executeBodies.length,
    },
    notes: [
      "Real packaged CLI UI; governedGit window rendered through the real WindowsRegistry.",
      "Commit routes intercepted with governed JSON for determinism; routing enforcement is proven by the integration/contract suites.",
      "The UI exposes no force-commit escape: the Commit button always routes through /commit/execute and renders its governed response verbatim.",
    ],
    artifacts: ARTIFACT_NAMES,
  };
  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("Issue #475 — browser commit path cannot bypass governed message policy", async ({ page }) => {
  ensureEvidenceDir();
  const ledger: RouteLedger = { previewBodies: [], executeBodies: [] };

  await openGovernedWindow(page, ledger);
  await assertNonConventionalIsBlocked(page, ledger);
  await page.locator("body").screenshot({ path: artifactPath("governed-commit-block.png") });
  await assertConventionalSucceeds(page, ledger);

  writeEvidenceManifest(ledger);
});
