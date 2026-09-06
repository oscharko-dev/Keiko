import { expect, test, type Locator } from "@playwright/test";
import {
  advanceGitChangeChatFixtureHead,
  authorizeGitHubForFixture,
  buildGitChangeChatFixture,
  createChatForFixture,
  fetchGitChangeScopes,
  interceptGovernedPrDescriptionLifecycle,
  interceptProjectList,
  readGitChangeChatProviderState,
  removeGitChangeChatFixture,
  seedGovernedPrDescriptionWindow,
  seedWorkspace,
  type GitChangeChatFixture,
} from "./support/git-change-chat-3400.js";
import {
  capturePrDescriptionModes,
  capturePrDescriptionState,
  measureRenderedTextContrast,
  writePrDescriptionJourneyEvidence,
} from "./support/pr-description-visual-evidence.js";
import {
  interceptWorkbenchDescriptionRace,
  seedWorkbenchDescriptionWindow,
} from "./support/workbench-description-3401.js";

const CHAT_VISUAL_SOURCES = [
  "tests/e2e/git-change-chat-3400.spec.ts",
  "tests/e2e/config/playwright.git-change-chat-3400.config.ts",
  "tests/e2e/support/git-change-chat-3400.ts",
  "tests/e2e/support/pr-description-visual-evidence.ts",
  "packages/keiko-ui/src/app/components/desktop/GitChangeScopePill.tsx",
  "packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx",
  "packages/keiko-ui/src/lib/api.ts",
  "packages/keiko-ui/src/lib/coding-workbench-lazy-fetchers.ts",
] as const;

const PR_CARD_VISUAL_SOURCES = [
  "tests/e2e/git-change-chat-3400.spec.ts",
  "tests/e2e/config/playwright.git-change-chat-3400.config.ts",
  "tests/e2e/support/git-change-chat-3400.ts",
  "tests/e2e/support/pr-description-visual-evidence.ts",
  "packages/keiko-ui/src/app/components/desktop/widgets/cards/GovernedPullRequestCard.tsx",
  "packages/keiko-ui/src/app/components/desktop/widgets/index.tsx",
  "packages/keiko-ui/src/lib/api.ts",
  "packages/keiko-ui/src/lib/coding-workbench-lazy-fetchers.ts",
] as const;

const WORKBENCH_VISUAL_SOURCES = [
  "tests/e2e/git-change-chat-3400.spec.ts",
  "tests/e2e/config/playwright.git-change-chat-3400.config.ts",
  "tests/e2e/support/pr-description-visual-evidence.ts",
  "tests/e2e/support/workbench-description-3401.ts",
  "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchDraftDelivery.tsx",
  "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.module.css",
  "packages/keiko-ui/src/lib/coding-workbench-runtime-api.ts",
] as const;

async function activateWithKeyboard(control: Locator): Promise<void> {
  await control.focus();
  await expect(control).toBeFocused();
  await control.press("Enter");
}

async function sendConnectedRefinement(
  chatWindow: Locator,
  request: string,
  expected: string,
): Promise<void> {
  const composer = chatWindow.getByRole("textbox", { name: "Chat message" });
  await composer.fill(request);
  await activateWithKeyboard(chatWindow.getByRole("button", { name: "Send message" }));
  await expect(chatWindow.getByText(expected, { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });
}

// Issue #3400 (epic #3384) — "Connect a Git change to Chat for iterative pull request
// description refinement". Frozen Decision 5: the Git window only CONNECTS a comparison to a
// Chat; refinement happens afterward in normal Chat, never in a Git-side composer.
//
// This journey proves, against a real git repository and the real running server:
//   1. The Git window's toolbar carries a "Connect to Chat" action reaching an existing Chat.
//   2. Connecting resolves the real base/head comparison (main...feature/x) server-side and
//      returns only a server-issued scope — never a raw path or diff.
//   3. That scope renders as a GitChangeScopePill in the target Chat's header, showing the
//      comparison label, file count, and "Current" status.
//
// See tests/e2e/support/git-change-chat-3400.ts for the fixture/seeding recipe: only
// `/api/projects` is faked (the Git window's own picker/availability gate); the git-change
// connect route, the chat creation, and the pill's data all come from the real server.

const fixtures: GitChangeChatFixture[] = [];

test.afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    removeGitChangeChatFixture(fixture.root);
  }
});

test.use({ viewport: { width: 1600, height: 900 } });

test("connects the Git window's current branch to a Chat and shows the scope pill", async ({
  page,
  request,
}) => {
  const fixture = buildGitChangeChatFixture();
  fixtures.push(fixture);
  const chat = await createChatForFixture(request, fixture.root);
  await interceptProjectList(page, fixture.root);
  await seedWorkspace(page, fixture.root, chat);

  await page.goto("/");

  // Mirrors git-changes-view-1575.spec.ts: locate the seeded window by its stable
  // data-window-id rather than guessing WindowFrame's title/subtitle composition.
  const gitWindow = page.locator('[data-window-id="issue-3400-git-window"]');
  await expect(gitWindow).toBeVisible();
  await expect(gitWindow.getByRole("button", { name: "Connect to Chat" })).toBeVisible();

  await gitWindow.getByRole("button", { name: "Connect to Chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Git change to chat" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Head branch")).toHaveValue(fixture.headRef);

  await dialog.getByRole("combobox", { name: "Base branch" }).click();
  await page.getByRole("option", { name: fixture.baseRef }).click();
  await dialog.getByRole("combobox", { name: "Chat" }).click();
  await page.getByRole("option", { name: chat.title }).click();
  await dialog.getByRole("button", { name: "Connect" }).click();

  await expect(dialog).toBeHidden();

  const chatWindow = page.locator('[data-window-id="issue-3400-chat-window"]');
  await expect(chatWindow).toBeVisible();
  const label = `${fixture.baseRef}...${fixture.headRef}`;
  await expect(chatWindow.getByText(label)).toBeVisible();
  await expect(chatWindow.getByText("Current", { exact: true })).toBeVisible();
  // Exactly one file is changed by the fixture — the singular count message, not "1 files changed".
  await expect(chatWindow.getByText("1 file changed")).toBeVisible();
  await expect(
    chatWindow.getByRole("button", { name: `Disconnect ${label} from chat` }),
  ).toBeVisible();

  // Refreshing an unchanged comparison stays "Current" (no head movement to detect).
  await chatWindow.getByRole("button", { name: `Refresh ${label}` }).click();
  await expect(chatWindow.getByText("Current", { exact: true })).toBeVisible();

  // T25 — a real accepted Chat turn mints its description authority at turn admission and reaches
  // the bounded Model Gateway. A comparison-only scope has no remote PR application target, but it
  // still renders the generated generic description and keeps the server-issued pill current.
  const composer = chatWindow.getByRole("textbox", { name: "Chat message" });
  await composer.click();
  await composer.fill("First connected refinement");
  await activateWithKeyboard(chatWindow.getByRole("button", { name: "Send message" }));
  await expect(
    chatWindow.getByText("First connected refinement is retained", { exact: false }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(chatWindow.getByText(label)).toBeVisible();
  await expect(chatWindow.getByText("Current", { exact: true })).toBeVisible();
  await expect(chatWindow.getByText("1 file changed")).toBeVisible();

  // T25 — move the fixture's head and refresh again: this must surface the production
  // stale-detection path (gitChangeRoutes.ts's `persistStaleScope`, real server tests in
  // gitChangeRoutes.test.ts), not only the unchanged-comparison case proven above.
  advanceGitChangeChatFixtureHead(fixture);
  await chatWindow.getByRole("button", { name: `Refresh ${label}` }).click();
  await expect(chatWindow.getByText("Stale", { exact: true })).toBeVisible();
  await expect(chatWindow.getByText(label)).toBeVisible();

  // T25 — actually click Disconnect (not just assert visibility) and prove the PATCH landed on
  // the real server by re-fetching the chat through the real GET /api/chats route, rather than
  // only trusting the client's own repainted UI state.
  await chatWindow.getByRole("button", { name: `Disconnect ${label} from chat` }).click();
  await expect(chatWindow.getByText(label)).toBeHidden();
  await expect
    .poll(async () => await fetchGitChangeScopes(request, fixture.root, chat.id))
    .toBeUndefined();
});

// #3400 F5 production route proof. Only the external provider boundary is hermetic: PR discovery,
// two normal Chat turns, proposal retention, review, approval, body-only application and disconnect
// all cross the mounted server handlers. The extra GitHub remote makes the old browser-selected
// owner/repository bug observable; the real routes accept only the server-resolved origin target.
test("reviews, approves and applies the held description through the connected pull request", async ({
  page,
  request,
}) => {
  const fixture = buildGitChangeChatFixture();
  fixtures.push(fixture);
  const chat = await createChatForFixture(request, fixture.root);
  await authorizeGitHubForFixture(request, fixture.root);
  await interceptProjectList(page, fixture.root);
  await seedWorkspace(page, fixture.root, chat);
  const lifecycleRequests: Record<string, unknown>[] = [];
  page.on("request", (networkRequest) => {
    if (/\/api\/git-change\/(?:review|approve|apply)-description$/u.test(networkRequest.url())) {
      lifecycleRequests.push(networkRequest.postDataJSON() as Record<string, unknown>);
    }
  });

  await page.goto("/");

  const gitWindow = page.locator('[data-window-id="issue-3400-git-window"]');
  await expect(gitWindow).toBeVisible();
  await gitWindow.getByRole("button", { name: "Connect to Chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Git change to chat" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Open pull request for this branch" }).click();
  await dialog.getByRole("combobox", { name: "Chat" }).click();
  await page.getByRole("option", { name: chat.title }).click();
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toBeHidden();

  const chatWindow = page.locator('[data-window-id="issue-3400-chat-window"]');
  await expect(chatWindow).toBeVisible();
  await expect(chatWindow.getByText("PR #42")).toBeVisible();

  await sendConnectedRefinement(
    chatWindow,
    "First connected refinement",
    "First connected refinement is retained",
  );
  await sendConnectedRefinement(
    chatWindow,
    "Second connected refinement",
    "Second connected refinement is visible",
  );

  const connectedScopes = await fetchGitChangeScopes(request, fixture.root, chat.id);
  const scope = connectedScopes?.find((candidate) => candidate.pullRequestNumber === 42);
  const proposalId = scope?.descriptionProposalId;
  if (scope === undefined || proposalId === undefined) {
    throw new Error("second connected Chat turn did not retain a PR-description proposal");
  }

  await chatWindow.getByTestId("git-change-description-preview").click();
  const previewBody = chatWindow.getByTestId("git-change-description-preview-body");
  await expect(previewBody).toHaveValue(/Second connected refinement is visible/u);
  const finalBody = await previewBody.inputValue();
  expect(finalBody).toContain("Human context before the managed region.");
  expect(finalBody).toContain("Human footer after the managed region.");
  await expect(chatWindow.getByTestId("git-change-description-state")).toHaveText(
    "Blocked (approval-required)",
  );

  await capturePrDescriptionModes({
    issue: 3400,
    page,
    windowId: "issue-3400-chat-window",
    surface: '[data-testid="git-change-description-preview-body"]',
    state: "held-preview",
    sources: CHAT_VISUAL_SOURCES,
    keyboardTarget: '[data-testid="git-change-description-approve"]',
  });

  const approve = chatWindow.getByTestId("git-change-description-approve");
  await approve.click();
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  const approvalRequest = {
    schemaVersion: "1",
    chatId: chat.id,
    relationshipId: scope.relationshipId,
    proposalId,
  };
  // A repeated approval reaches the SAME mounted route and binding. The store coalesces it into
  // one live authorization, so only the first later apply can consume it.
  const duplicateApproval = await request.post("/api/git-change/approve-description", {
    headers: { "X-Keiko-CSRF": "1" },
    data: approvalRequest,
  });
  expect(duplicateApproval.status(), await duplicateApproval.text()).toBe(200);
  await chatWindow.getByTestId("git-change-description-apply").click();
  await expect(chatWindow.getByTestId("git-change-description-state")).toHaveText(
    "Current (applied)",
  );
  await expect(chatWindow.getByText("Current", { exact: true })).toBeVisible();
  await expect(chatWindow.getByText("Blocked", { exact: true })).toHaveCount(0);
  const appliedStatusContrastRatio = await measureRenderedTextContrast(
    page,
    '[data-window-id="issue-3400-chat-window"] .scope-pill-status',
  );
  expect(appliedStatusContrastRatio).toBeGreaterThanOrEqual(4.5);
  const appliedCapture = await capturePrDescriptionState(
    page,
    3400,
    "issue-3400-chat-window",
    "09-applied",
  );

  // One-use: the approved proposal was consumed by the apply above, so a second Apply click must
  // not reach the route again (the button becomes aria-disabled once applied).
  await expect(chatWindow.getByTestId("git-change-description-apply")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  const replayedApply = await request.post("/api/git-change/apply-description", {
    headers: { "X-Keiko-CSRF": "1" },
    data: approvalRequest,
  });
  expect(replayedApply.status()).toBe(409);
  const provider = readGitChangeChatProviderState();
  expect(provider).toMatchObject({ body: finalBody, updates: 1 });
  expect(lifecycleRequests).toHaveLength(3);
  for (const body of lifecycleRequests) {
    expect(body).toEqual(approvalRequest);
    expect(body).not.toHaveProperty("ownerAndRepo");
  }

  await chatWindow.getByRole("button", { name: "Disconnect PR #42 from chat" }).click();
  await expect
    .poll(async () => await fetchGitChangeScopes(request, fixture.root, chat.id))
    .toBeUndefined();
  writePrDescriptionJourneyEvidence({
    issue: 3400,
    cases: [
      "two normal Chat turns refine one connected pull request",
      "server-held proposal reviewed before approval",
      "exact final body displayed",
      "fork and upstream remote ordering cannot author the target",
      "repeated approval still permits only one apply",
      "disconnect persists through the mounted PATCH route",
    ],
    observations: {
      connectedChatTurns: 2,
      reviewRequests: 1,
      browserApprovalRequests: 1,
      directDuplicateApprovals: 1,
      applyRequests: 1,
      rejectedApplyReplays: 1,
      providerUpdates: provider.updates,
      serverResolvedOrigin: true,
      exactFinalBodyDisplayed: true,
      appliedControlDisabled: true,
      appliedStatusContrastRatio,
      disconnectPersisted: true,
      appliedCapture,
    },
    sources: CHAT_VISUAL_SOURCES,
  });
});

test("qualifies the governed PR Description panel through preview, approval and apply", async ({
  page,
}) => {
  const lifecycle = await interceptGovernedPrDescriptionLifecycle(page);
  await seedGovernedPrDescriptionWindow(page);
  await page.goto("/");

  const prWindow = page.locator('[data-window-id="issue-3389-governed-pr-window"]');
  const description = prWindow.getByTestId("gpr-description");
  await expect(description).toBeVisible();
  await description
    .getByLabel("Description repository (owner/repo)")
    .fill("keiko-e2e/git-change-chat-3400");
  await description.getByLabel("Description pull request number").fill("42");
  await activateWithKeyboard(description.getByTestId("gpr-description-preview-button"));
  await expect(description.getByTestId("gpr-description-preview")).toHaveText(lifecycle.finalBody, {
    useInnerText: false,
  });
  await expect(description).toContainText("Human context before the managed region.");
  await expect(description).toContainText("Generated by Keiko from bounded fixture evidence.");
  await expect(description).toContainText("Human footer after the managed region.");

  await capturePrDescriptionModes({
    issue: 3389,
    page,
    windowId: "issue-3389-governed-pr-window",
    surface: '[data-testid="gpr-description"]',
    state: "preview-loaded",
    sources: PR_CARD_VISUAL_SOURCES,
    keyboardTarget: '[data-testid="gpr-description-approve-button"]',
  });
  await activateWithKeyboard(description.getByTestId("gpr-description-approve-button"));
  await expect(description.getByTestId("gpr-description-apply-button")).toBeEnabled();
  await activateWithKeyboard(description.getByTestId("gpr-description-apply-button"));
  await expect(description.getByTestId("gpr-description-state")).toHaveAttribute(
    "data-state",
    "current",
  );
  const appliedCapture = await capturePrDescriptionState(
    page,
    3389,
    "issue-3389-governed-pr-window",
    "09-applied",
  );
  expect(lifecycle.calls).toEqual({ review: 1, approve: 1, apply: 1 });
  writePrDescriptionJourneyEvidence({
    issue: 3389,
    cases: [
      "preview displays exact server final body",
      "managed and human regions remain visible",
      "approval precedes one apply",
    ],
    observations: {
      ...lifecycle.calls,
      exactFinalBodyDisplayed: true,
      humanRegionsDisplayed: true,
      appliedCapture,
    },
    sources: PR_CARD_VISUAL_SOURCES,
  });
});

test("keeps the current generic Workbench draft visible when an older response lands late", async ({
  page,
}) => {
  const fixture = buildGitChangeChatFixture();
  fixtures.push(fixture);
  const race = await interceptWorkbenchDescriptionRace(page);
  await seedWorkbenchDescriptionWindow(page, fixture.root);
  await page.goto("/");

  const workbench = page.locator('[data-window-id="issue-3401-workbench-window"]');
  const description = workbench.getByRole("region", { name: "Pull request description draft" });
  await expect(description).toBeVisible();
  await activateWithKeyboard(description.getByRole("button", { name: "Review exact draft" }));
  await race.oldRequestStarted;
  race.advanceToNewHead();
  await expect(description).toContainText(race.newHeadSha);
  await activateWithKeyboard(description.getByRole("button", { name: "Review exact draft" }));
  const draft = description.getByTestId("cwb-description-draft");
  await expect(draft).toHaveValue(race.currentMarkdown);
  race.releaseOldResponse();
  await expect.poll(() => race.calls).toMatchObject({ oldDraft: 1, newDraft: 1 });
  await expect(draft).toHaveValue(race.currentMarkdown);
  await expect(draft).not.toHaveValue(race.oldMarkdown);

  await capturePrDescriptionModes({
    issue: 3401,
    page,
    windowId: "issue-3401-workbench-window",
    surface: 'section[aria-label="Pull request description draft"]',
    state: "generic-held-draft-after-response-race",
    sources: WORKBENCH_VISUAL_SOURCES,
    keyboardTarget: '[data-testid="cwb-description-review"]',
  });
  const currentCapture = await capturePrDescriptionState(
    page,
    3401,
    "issue-3401-workbench-window",
    "09-response-race-current",
  );
  writePrDescriptionJourneyEvidence({
    issue: 3401,
    cases: [
      "generic no-PR artifact remains reviewable",
      "exact server-held final markdown is displayed",
      "late older response cannot replace the current proposal",
    ],
    observations: {
      ...race.calls,
      hasPullRequestTarget: false,
      exactCurrentMarkdownDisplayed: true,
      olderResponseDiscarded: true,
      currentCapture,
    },
    sources: WORKBENCH_VISUAL_SOURCES,
  });
});
