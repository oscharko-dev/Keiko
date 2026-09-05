import { expect, test } from "@playwright/test";
import {
  buildGitChangeChatFixture,
  createChatForFixture,
  interceptGovernedPrDescriptionLifecycle,
  interceptGitChangePullRequestConnect,
  interceptPrDescriptionLifecycle,
  interceptProjectList,
  removeGitChangeChatFixture,
  seedWorkspace,
  type GitChangeChatFixture,
} from "./support/git-change-chat-3400.js";
import {
  capturePrDescriptionModes,
  capturePrDescriptionState,
  writePrDescriptionJourneyEvidence,
} from "./support/pr-description-visual-evidence.js";

const CHAT_VISUAL_SOURCES = [
  "tests/e2e/git-change-chat-3400.spec.ts",
  "tests/e2e/support/git-change-chat-3400.ts",
  "tests/e2e/support/pr-description-visual-evidence.ts",
  "packages/keiko-ui/src/app/components/desktop/GitChangeScopePill.tsx",
  "packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx",
  "packages/keiko-ui/src/lib/api.ts",
  "packages/keiko-ui/src/lib/coding-workbench-lazy-fetchers.ts",
] as const;

const PR_CARD_VISUAL_SOURCES = [
  "tests/e2e/git-change-chat-3400.spec.ts",
  "tests/e2e/support/git-change-chat-3400.ts",
  "tests/e2e/support/pr-description-visual-evidence.ts",
  "packages/keiko-ui/src/app/components/desktop/widgets/cards/GovernedPullRequestCard.tsx",
  "packages/keiko-ui/src/app/components/desktop/widgets/cards/git-client/GitClientWindow.tsx",
  "packages/keiko-ui/src/lib/api.ts",
  "packages/keiko-ui/src/lib/coding-workbench-lazy-fetchers.ts",
] as const;

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
  await expect(chatWindow.getByText("Current")).toBeVisible();
  // Exactly one file is changed by the fixture — the singular count message, not "1 files changed".
  await expect(chatWindow.getByText("1 file changed")).toBeVisible();
  await expect(
    chatWindow.getByRole("button", { name: `Disconnect ${label} from chat` }),
  ).toBeVisible();

  // Refreshing an unchanged comparison stays "Current" (no head movement to detect).
  await chatWindow.getByRole("button", { name: `Refresh ${label}` }).click();
  await expect(chatWindow.getByText("Current")).toBeVisible();
});

// #3400 browser wiring proof. Server tests exercise both real Chat transports, shared generation,
// exact snapshot binding, held-proposal approval, and the body-only apply effect. This hermetic
// browser test scripts only the provider-dependent PR connect/review/apply responses and proves
// the operator can read the exact held body before the guarded approve/apply actions are enabled.
test("reviews, approves and applies the held description through the connected pull request", async ({
  page,
  request,
}) => {
  const fixture = buildGitChangeChatFixture();
  fixtures.push(fixture);
  const chat = await createChatForFixture(request, fixture.root);
  await interceptProjectList(page, fixture.root);
  await interceptGitChangePullRequestConnect(page, {
    relationshipId: "e2e-pr-scope-1",
    comparisonLabel: "PR #42",
    baseRef: fixture.baseRef,
    headRef: fixture.headRef,
    pullRequestNumber: 42,
  });
  const lifecycle = await interceptPrDescriptionLifecycle(page);
  await seedWorkspace(page, fixture.root, chat);

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

  await chatWindow.getByTestId("git-change-description-preview").click();
  await expect(chatWindow.getByTestId("git-change-description-preview-body")).toContainText(
    "refined over chat",
  );
  await expect(chatWindow.getByTestId("git-change-description-preview-body")).toHaveText(
    lifecycle.finalBody,
    { useInnerText: false },
  );
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

  await chatWindow.getByTestId("git-change-description-approve").click();
  await chatWindow.getByTestId("git-change-description-apply").click();
  await expect(chatWindow.getByTestId("git-change-description-state")).toHaveText(
    "Current (applied)",
  );
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
  expect(lifecycle.calls).toEqual({ review: 1, approve: 1, apply: 1 });
  writePrDescriptionJourneyEvidence({
    issue: 3400,
    cases: [
      "server-held proposal reviewed before approval",
      "exact final body displayed",
      "one-use approval applied once",
    ],
    observations: {
      ...lifecycle.calls,
      exactFinalBodyDisplayed: true,
      appliedControlDisabled: true,
      appliedCapture,
    },
    sources: CHAT_VISUAL_SOURCES,
  });
});

test("qualifies the governed PR Description panel through preview, approval and apply", async ({
  page,
  request,
}) => {
  const fixture = buildGitChangeChatFixture();
  fixtures.push(fixture);
  const chat = await createChatForFixture(request, fixture.root);
  await interceptProjectList(page, fixture.root);
  const lifecycle = await interceptGovernedPrDescriptionLifecycle(page);
  await seedWorkspace(page, fixture.root, chat);
  await page.goto("/");

  const gitWindow = page.locator('[data-window-id="issue-3400-git-window"]');
  await gitWindow.getByRole("button", { name: "Create pull request" }).click();
  const description = gitWindow.getByTestId("gpr-description");
  await expect(description).toBeVisible();
  await description.getByLabel("Description pull request number").fill("42");
  await description.getByTestId("gpr-description-preview-button").click();
  await expect(description.getByTestId("gpr-description-preview")).toHaveText(lifecycle.finalBody, {
    useInnerText: false,
  });
  await expect(description).toContainText("Human context before the managed region.");
  await expect(description).toContainText("Generated by Keiko from bounded fixture evidence.");
  await expect(description).toContainText("Human footer after the managed region.");

  await capturePrDescriptionModes({
    issue: 3389,
    page,
    windowId: "issue-3400-git-window",
    surface: '[data-testid="gpr-description"]',
    state: "preview-loaded",
    sources: PR_CARD_VISUAL_SOURCES,
    keyboardTarget: '[data-testid="gpr-description-approve-button"]',
  });
  await description.getByTestId("gpr-description-approve-button").click();
  await expect(description.getByTestId("gpr-description-apply-button")).toBeEnabled();
  await description.getByTestId("gpr-description-apply-button").click();
  await expect(description.getByTestId("gpr-description-state")).toHaveAttribute(
    "data-state",
    "current",
  );
  const appliedCapture = await capturePrDescriptionState(
    page,
    3389,
    "issue-3400-git-window",
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
