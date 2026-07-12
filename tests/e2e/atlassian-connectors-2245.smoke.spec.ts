// Issue #2245 (Epic #2238) — focused connector-setup browser smoke. Drives the real UI route
// (/atlassian-connectors) end to end against a FIXTURE BFF implemented with page.route stubs (the
// broader cross-cutting connector e2e belongs to #2246). Journey: setup → verify → scope → sync →
// status → approval, tagged @smoke so the Studio browser quality gate exercises it. The token is
// typed into the create form and never asserted back out — the write-only contract is unit-covered.

import { expect, test, type Page, type Route } from "@playwright/test";

const DOCS = {
  schemaVersion: "1",
  authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
  provider: "confluence",
  displayName: "Docs",
  baseUrl: "https://x.atlassian.net",
  authScheme: "basic-api-token",
  createdAt: 1_700_000_000_000,
} as const;

const OPS = {
  ...DOCS,
  authRef: "atlassian-cred:BBBBBBBBBBBBBBBBBBBBBB",
  provider: "jira",
  displayName: "Ops",
} as const;

const PROGRESS = {
  enumeratedItems: 4,
  fetchedItems: 4,
  indexedItems: 4,
  skippedItems: 0,
  failedItems: 0,
} as const;

const CHANGE_SUMMARY = {
  schemaVersion: "1",
  outcome: "succeeded",
  counts: {
    addedItems: 3,
    changedItems: 1,
    removedItems: 0,
    unchangedItems: 0,
    failedItems: 0,
    deniedItems: 0,
  },
  fingerprintSetDigest: "abc",
  completedAt: 2,
} as const;

const COMMON = {
  schemaVersion: "1",
  jobId: "job-1",
  connectorId: "conn-1",
  provider: "confluence",
  queuedAt: 0,
  progress: PROGRESS,
} as const;

const RUNNING = { ...COMMON, status: "running", startedAt: 1 };
const SUCCEEDED = {
  ...COMMON,
  status: "succeeded",
  startedAt: 1,
  completedAt: 2,
  changeSummary: CHANGE_SUMMARY,
};

const APPROVAL = {
  schemaVersion: "1",
  approvalId: "ap-1",
  connectorId: "conn-1",
  provider: "jira",
  actionType: "create-issue",
  actionClass: "connector-write",
  requiredScope: "issue-tracker.write",
  risk: "high",
  reviewReason: "deterministic-risk-approval-required",
  targetRef: "PROJ-1",
  correlationId: "corr-1",
  requestedAt: 0,
  expiresAt: 10_000,
} as const;

interface Stub {
  readonly re: RegExp;
  readonly method?: string;
  readonly body: unknown;
}

const STUBS: readonly Stub[] = [
  { re: /\/credentials$/u, method: "GET", body: { credentials: [DOCS] } },
  { re: /\/credentials$/u, method: "POST", body: OPS },
  { re: /\/verify$/u, body: { authRef: OPS.authRef, status: "ok" } },
  { re: /\/sync-jobs$/u, method: "POST", body: { job: RUNNING } },
  { re: /\/sync-jobs\/[^/]+\/cancel$/u, body: { job: { ...SUCCEEDED, status: "cancelled" } } },
  { re: /\/sync-jobs\/[^/]+$/u, method: "GET", body: { job: SUCCEEDED } },
  { re: /\/activity$/u, body: { activity: [] } },
  { re: /\/action-approvals$/u, method: "GET", body: { approvals: [APPROVAL] } },
  {
    re: /\/approve$/u,
    body: { disposition: "review-required", result: { status: "succeeded", targetRef: "PROJ-1" } },
  },
  {
    re: /\/reject$/u,
    body: { approvalId: "ap-1", disposition: "review-required", outcome: "cancelled" },
  },
];

function resolveStub(path: string, method: string): unknown {
  const match = STUBS.find((stub) => stub.re.test(path) && (stub.method ?? method) === method);
  return match?.body;
}

async function installStubs(page: Page): Promise<void> {
  await page.route("**/api/atlassian-connectors/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = resolveStub(path, request.method());
    if (body === undefined) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

function collectPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return () => {
    expect(errors).toEqual([]);
  };
}

test.describe("Atlassian connectors @smoke", () => {
  test("setup → verify → scope → sync → status → approval", async ({ page }) => {
    const assertNoPageErrors = collectPageErrors(page);
    await installStubs(page);
    await page.goto("/atlassian-connectors");

    // The configured connector is listed.
    const docsCard = page.getByTestId("acx-connector").filter({ hasText: "Docs" });
    await expect(docsCard).toContainText("https://x.atlassian.net");

    // Setup: add a connector (write-only token typed here).
    await page.getByRole("button", { name: "Add connector" }).click();
    await page.getByLabel("Label").fill("Ops");
    await page.getByLabel("Base URL").fill("https://ops.atlassian.net");
    await page.getByLabel("Account email").fill("me@example.com");
    await page.getByLabel("API token").fill("smoke-token");
    await page.getByRole("button", { name: "Save connector" }).click();

    // Verify: the inline post-save verify step renders the closed status.
    const addVerify = page.getByTestId("acx-add-verify");
    await addVerify.getByRole("button", { name: "Verify connection" }).click();
    await expect(page.getByTestId("acx-verify-status")).toHaveAttribute("data-status", "ok");
    await addVerify.getByRole("button", { name: "Cancel" }).click();

    // Scope + sync on the Docs connector.
    await docsCard.getByRole("button", { name: "Manage" }).click();
    await docsCard.getByLabel("Confluence space keys").fill("ENG");
    await docsCard.getByRole("button", { name: "Add key" }).click();
    await docsCard.getByRole("button", { name: "Start sync" }).click();

    // Status: the run reaches the succeeded terminal state with a change summary (via polling).
    await expect(docsCard.getByTestId("acx-sync-badge")).toHaveText("Succeeded");
    await expect(docsCard.getByTestId("acx-sync-changes")).toBeVisible();

    // Approval: a pending write action is approved and shows the typed result.
    const approval = page.getByTestId("acx-approval");
    await expect(approval).toContainText("Create Jira issue");
    await approval.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("acx-approval-result")).toContainText("Result: PROJ-1");

    assertNoPageErrors();
  });
});
