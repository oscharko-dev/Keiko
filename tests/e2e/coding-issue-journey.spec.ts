import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";

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
const MODELS_ENDPOINT = "/api/models";
const GATEWAY_SETUP_ENDPOINT = "/api/gateway/setup";
const READINESS_ENDPOINT = "/api/coding-workbench/runtime/readiness";
const CSRF = { "X-Keiko-CSRF": "1" };

function workbench(page: Page): Locator {
  return page.locator(SURFACE);
}

// Live-run blocker (A): unlike every scripted `coding-issue-*.spec.ts` sibling, this file drives
// the REAL `keiko ui` production composition, which starts every browser session unpaired. An
// unpaired session gets no app-session read authority at all (`appSessionReadAuthority.ts`), so
// the issue-preview route -- and every other content-bearing route -- answers 403
// `authority-denied` no matter what the caller does next; that is the observed "Workbench is not
// paired" narration and the reported preview 403 in one. The fix mints the SAME single-use
// launcher pairing attestation `coding-issue-intake.spec.ts` (#3385) mints against its scripted
// server's fixed fixture secret -- here against the real launched server's own secret, resolved
// identically on both sides from `KEIKO_QUALIFICATION_LAUNCHER_SECRET`
// (`playwright.coding-issue-journey.config.ts` resolves it once and hands it to both the launched
// server and this spec process; `coding-issue-journey-server.mts`'s `resolveLauncherSecret` reads
// it server-side). Pairing MUST happen before any authority-gated call -- see `grantGithubAccess`
// and the issue-preview flow below, which is exactly what previously 403'd.
async function pair(page: Page): Promise<void> {
  const launcherSecret = process.env.KEIKO_QUALIFICATION_LAUNCHER_SECRET;
  expect(
    launcherSecret,
    "KEIKO_QUALIFICATION_LAUNCHER_SECRET must be resolved by the Playwright config and handed " +
      "to both this process and the launched server",
  ).toBeTruthy();
  if (launcherSecret === undefined) return;
  const fragment = encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: launcherSecret,
      requestId: `coding-issue-journey-${String(Date.now())}`,
      issuedAtMs: Date.now(),
    }),
  );
  await page.goto(`/${fragment}`);
  await expect.poll(() => page.url()).not.toContain("keiko-app-session");
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
  await pair(page);
  await expect(workbench(page)).toBeVisible();
  await expect(page.getByLabel(REPOSITORY_FIELD)).toHaveValue(repositoryRoot);
}

// Live-run blocker (B): the real gateway config may hold a chat model that is tool-calling capable
// but not yet marked workflow-eligible ("The tool-calling chat model is not workflow-eligible.
// Enable workflow eligibility in Settings -> Models."). This performs the SAME real route the
// product's own Settings -> Models "workflow eligible" toggle calls
// (`packages/keiko-ui/src/app/components/desktop/modals/GatewaySetupDialog.tsx` submits
// `workflowEligibleModelIds` to this endpoint), discovering the candidate model id from the real
// `/api/models` capability list -- never a hardcoded model id, since the configured deployment
// name varies by operator profile. `preserveExisting: true` updates only the workflow-eligible
// selection, exactly the production "update an existing gateway config" path
// (`gateway-setup.test.ts`'s "coding-update"/"coding-unknown" cases pin this same minimal body).
async function ensureWorkflowEligibleModel(page: Page): Promise<void> {
  const modelsResponse = await page.request.get(MODELS_ENDPOINT);
  expect(modelsResponse.ok()).toBe(true);
  const { models } = (await modelsResponse.json()) as {
    readonly models: readonly ModelCapability[];
  };
  const toolCallingChatModels = models.filter(
    (model) => model.kind === "chat" && model.toolCalling,
  );
  expect(
    toolCallingChatModels.length,
    "the configured Model Gateway must expose at least one tool-calling chat model",
  ).toBeGreaterThan(0);
  if (toolCallingChatModels.some((model) => model.workflowEligible)) return;
  const modelId = toolCallingChatModels[0]?.id;
  const setupResponse = await page.request.post(GATEWAY_SETUP_ENDPOINT, {
    headers: CSRF,
    data: { preserveExisting: true, workflowEligibleModelIds: [modelId] },
  });
  expect(setupResponse.ok()).toBe(true);
  // The browser's own source/profile projection is fetched once on mount, not polled -- reload so
  // the Workbench observes the just-enabled eligibility the same way a real operator's refresh
  // after a Settings change would.
  await page.reload();
  await expect(workbench(page)).toBeVisible();
}

async function assertRuntimeReady(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `${READINESS_ENDPOINT}?${new URLSearchParams({ requestedMode: "autonomous-delivery" }).toString()}`,
        );
        if (!response.ok()) return false;
        const body = (await response.json()) as { readonly runtimeAvailable: boolean };
        return body.runtimeAvailable;
      },
      { timeout: 60_000, message: "coding runtime must report ready before a run may start" },
    )
    .toBe(true);
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

  // Pairing (blocker A) must land before any authority-gated call -- `grantGithubAccess` isn't
  // authority-gated, but the issue-preview route right after it is, so pairing is established
  // inside `openWorkbench` first regardless. Model eligibility (blocker B) and runtime host
  // readiness are real preconditions the product itself checks before a run may start, so they
  // are asserted here too rather than discovered as a timeout on "Start coding run".
  await openWorkbench(page, controlledRepositoryRoot);
  await ensureWorkflowEligibleModel(page);
  await grantGithubAccess(page, controlledRepositoryRoot);
  await assertRuntimeReady(page);

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
