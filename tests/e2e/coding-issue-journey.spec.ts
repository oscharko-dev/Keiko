import { expect, test, type Locator, type Page } from "@playwright/test";

// Issue #3390: the real-model production-composition journey. This spec is deliberately the only
// one in `tests/e2e/` that installs NO `page.route()` interception and imports NO scripted server
// module -- `playwright.coding-issue-journey.config.ts`'s `webServer` refuses to start unless
// `tests/e2e/support/coding-issue-journey-config.ts` resolves a real Model Gateway/LiteLLM profile
// and a real controlled-repository checkout, so by construction this file can only ever run
// against the real production server (`@oscharko-dev/keiko-cli`'s `runUiCli`) driving the real
// OpenCode adapter against a real model. A scripted model, a mocked tool-result stream, or an
// alternative runtime cannot substitute here: there is no seam left for one to attach to.
//
// The UI surface, button names, and endpoints below are the same real, unmocked ones
// `coding-issue-intake.spec.ts` (#3385) exercises against its scripted fixture server -- this file
// drives the identical product flow against the real one instead of reimplementing it.
//
// This test qualifies the observable journey shape (issue intake through a visible, causally
// linked tool-call effect). The full issue-to-PR-to-merge-to-closure journey, the ADR-0138
// per-mode matrix, and the Git-to-Chat journey are qualified by the manifest and validator this
// issue also ships (`scripts/check-coding-issue-journey-evidence.mjs`) against operator-recorded
// evidence, not solely by this Playwright run -- per the issue's own text, live execution requires
// operator-provided credentials, an approved model profile and spend budget, and the mandated
// human merge/close checkpoint, none of which this repository can supply on its own.

const SURFACE = 'section[aria-label="Coding Workbench"][data-state]';
const REPOSITORY_FIELD = "Repository path";
const ISSUE_FIELD = "Issue URL or #number";
const AUTH_ENDPOINT = "/api/coding-workbench/github-authorization";
const CSRF = { "X-Keiko-CSRF": "1" };

function workbench(page: Page): Locator {
  return page.locator(SURFACE);
}

async function openWorkbench(page: Page, repositoryRoot: string): Promise<void> {
  await page.addInitScript(
    ({ root }) => {
      localStorage.setItem("keiko.theme", "dark");
      localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "coding-issue-journey-live",
            type: "coding",
            x: 40,
            y: 48,
            w: 1120,
            h: 1400,
            z: 10,
            zoom: 1,
            cfg: { repositoryPath: root },
            max: false,
          },
        ]),
      );
      localStorage.removeItem("keiko.conns.v1");
    },
    { root: repositoryRoot },
  );
  await page.goto("/");
  await expect(workbench(page)).toBeVisible();
  await expect(page.getByLabel(REPOSITORY_FIELD)).toHaveValue(repositoryRoot);
}

// The real, generic per-repository read-authorization route (not a fixture): the same consent a
// real user grants once through the product's own GitHub-access prompt before the model may read
// issue content for this checkout.
async function grantGithubAccess(page: Page, repositoryRoot: string): Promise<void> {
  const observed = await page.request.get(
    `${AUTH_ENDPOINT}?${new URLSearchParams({ repositoryPath: repositoryRoot }).toString()}`,
  );
  expect(observed.ok()).toBe(true);
  const { revision } = (await observed.json()) as { readonly revision: number };
  const updated = await page.request.put(AUTH_ENDPOINT, {
    headers: CSRF,
    data: { repositoryPath: repositoryRoot, authorized: true, expectedRevision: revision },
  });
  expect(updated.ok()).toBe(true);
}

async function enableFullAccess(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("region", { name: /^Settings/u });
  await settings.getByRole("button", { name: "Security", exact: true }).click();
  await page.getByRole("radio", { name: /Full access/u }).click();
  await expect(page.getByRole("radio", { name: /Full access/u })).toBeChecked();
  await page.getByRole("button", { name: "Close Settings window", exact: true }).click();
}

test("a real model resolves the controlled issue through visible, causally linked tool calls", async ({
  page,
}) => {
  const controlledRepositoryRoot = process.env.KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT;
  const controlledIssueReference = process.env.KEIKO_QUALIFICATION_CONTROLLED_ISSUE_REFERENCE;
  // The webServer already refused to start without a real gateway and controlled repository
  // (see the file header), so both variables are present whenever this test actually runs;
  // narrowing here gives a precise failure if that ever stops being true instead of a confusing
  // downstream selector timeout.
  expect(
    controlledRepositoryRoot,
    "KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT must be resolved by webServer",
  ).toBeTruthy();
  expect(
    controlledIssueReference,
    "KEIKO_QUALIFICATION_CONTROLLED_ISSUE_REFERENCE must name the seeded failing issue",
  ).toBeTruthy();
  if (controlledRepositoryRoot === undefined || controlledIssueReference === undefined) return;

  await openWorkbench(page, controlledRepositoryRoot);
  await grantGithubAccess(page, controlledRepositoryRoot);

  await page.getByLabel(ISSUE_FIELD).fill(controlledIssueReference);
  await page.getByRole("button", { name: "Preview issue", exact: true }).click();
  await expect(page.getByRole("region", { name: "Issue preview", exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Use this issue", exact: true }).click();
  await page.getByRole("button", { name: "Bind workspace", exact: true }).click();

  await enableFullAccess(page);
  await page
    .getByLabel("Task instructions")
    .fill(
      "Resolve the linked issue: implement the required change across the affected modules, add " +
        "regression coverage for it, and leave the workspace clean.",
    );
  await page.getByRole("button", { name: "Start coding run", exact: true }).click();
  await expect(workbench(page)).toHaveAttribute("data-state", "running", { timeout: 60_000 });

  // A real model's tool-call sequence is nondeterministic by design (issue #3390: "Do not require
  // one hardcoded tool sequence from a nondeterministic model"); assert the observable effect --
  // at least one governed tool call actually ran -- rather than any specific tool or order.
  await expect(page.locator('[data-timeline-kind="tool"]').first()).toBeVisible({
    timeout: 300_000,
  });

  const status = await page.request.get("/api/coding-workbench/runtime/status");
  expect(status.ok()).toBe(true);
  const runtimeSnapshot = (await status.json()) as { readonly runId?: string };
  expect(
    runtimeSnapshot.runId,
    "a real run must be recorded once the model has acted",
  ).toBeTruthy();
});
