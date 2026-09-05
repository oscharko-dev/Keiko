import { expect, test } from "@playwright/test";
import {
  buildGitChangeChatFixture,
  createChatForFixture,
  interceptProjectList,
  removeGitChangeChatFixture,
  seedWorkspace,
  type GitChangeChatFixture,
} from "./support/git-change-chat-3400.js";

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

  const gitWindow = page.getByRole("region", { name: "Git" });
  await expect(gitWindow).toBeVisible();
  await expect(gitWindow.getByRole("button", { name: "Connect to Chat" })).toBeVisible();

  await gitWindow.getByRole("button", { name: "Connect to Chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Git change to chat" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Head branch")).toHaveValue(fixture.headRef);

  await dialog.getByRole("combobox", { name: "Chat" }).click();
  await page.getByRole("option", { name: chat.title }).click();
  await dialog.getByRole("button", { name: "Connect" }).click();

  await expect(dialog).toBeHidden();

  const chatWindow = page.getByRole("region", { name: `Chat — ${chat.title}` });
  await expect(chatWindow).toBeVisible();
  const label = `${fixture.baseRef}...${fixture.headRef}`;
  await expect(chatWindow.getByText(label)).toBeVisible();
  await expect(chatWindow.getByText("Current")).toBeVisible();
  await expect(chatWindow.getByText("1 files changed")).toBeVisible();
  await expect(
    chatWindow.getByRole("button", { name: `Disconnect ${label} from chat` }),
  ).toBeVisible();

  // Refreshing an unchanged comparison stays "Current" (no head movement to detect).
  await chatWindow.getByRole("button", { name: `Refresh ${label}` }).click();
  await expect(chatWindow.getByText("Current")).toBeVisible();
});
