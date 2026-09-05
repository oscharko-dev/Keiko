// #3390 — the git-to-chat-connect-refine-apply scenario. Connects the controlled repository's
// real external pull request (branch `docs/usage-section`, already open) to a real Chat through
// the Git window's own "Connect to Chat" flow (Frozen Product Decision 5: the Git window only
// connects; refinement happens afterward in normal Chat), refines it over real conversational
// turns, then applies the held description through the SAME governed body-only apply effect the
// scripted `git-change-chat-3400.spec.ts` sibling drives against a fixture -- here for real,
// against the real PR body.

import { execFileSync } from "node:child_process";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { createChatForFixture, seedWorkspace } from "./git-change-chat-3400.js";

// Matches `seedWorkspace`'s own hardcoded window ids (support/git-change-chat-3400.ts) -- these
// are arbitrary DOM window identifiers this test author chose, not scripted-server fixture data,
// so reusing the literal values here is not the "bound to a fixture id" case AGENTS.md §5 asks to
// generalize before reuse.
const GIT_WINDOW_ID = "issue-3400-git-window";
const CHAT_WINDOW_ID = "issue-3400-chat-window";

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 }).trim();
}

/**
 * Checks out the controlled repository's real remote branch locally so the Git window's own
 * "Head branch" resolves to it (it reads the checkout's current branch, not a picker). Returns a
 * restore function so the shared checkout is left exactly as found once this scenario finishes.
 */
export function ensureBranchCheckedOut(root: string, branch: string): () => void {
  const original = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  git(root, ["fetch", "origin", branch]);
  git(root, ["checkout", "-B", branch, `origin/${branch}`]);
  return (): void => {
    git(root, ["checkout", original]);
  };
}

export interface ConnectedGitChatSession {
  readonly chatId: string;
}

/** Connects the checked-out branch's real open pull request to a real Chat -- the exact real
 * routes the scripted sibling's "Open pull request for this branch" case drives, here reached
 * against the real controlled repository instead of an intercepted fixture response. */
export async function connectControlledPullRequestToChat(
  page: Page,
  request: APIRequestContext,
  repositoryRoot: string,
): Promise<ConnectedGitChatSession> {
  const chat = await createChatForFixture(request, repositoryRoot);
  await seedWorkspace(page, repositoryRoot, chat);
  await page.goto("/");
  const gitWindow = page.locator(`[data-window-id="${GIT_WINDOW_ID}"]`);
  await expect(gitWindow).toBeVisible();
  await gitWindow.getByRole("button", { name: "Connect to Chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Git change to chat" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Open pull request for this branch" }).click();
  await dialog.getByRole("combobox", { name: "Chat" }).click();
  await page.getByRole("option", { name: chat.title }).click();
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(`[data-window-id="${CHAT_WINDOW_ID}"]`)).toBeVisible();
  return { chatId: chat.id };
}

/** Sends each turn as a real Chat message and waits for the real assistant reply to finish
 * streaming before the next one -- content is nondeterministic (a real model), so only the
 * user's own authored text and the composer becoming usable again are asserted. */
export async function refineDescriptionOverChat(
  page: Page,
  turns: readonly string[],
): Promise<void> {
  const chatWindow = page.locator(`[data-window-id="${CHAT_WINDOW_ID}"]`);
  for (const message of turns) {
    const composer = chatWindow.getByRole("textbox", { name: "Chat message" });
    await composer.click();
    await composer.fill(message);
    const send = chatWindow.getByRole("button", { name: "Send message" });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(chatWindow.getByText(message)).toBeVisible();
    await expect(send).toBeEnabled({ timeout: 180_000 });
  }
}

/** Drives the real preview -> approve -> apply description sequence from the connected Chat --
 * the real `/api/git-change/review-description|approve-description|apply-description` routes,
 * ending in a real GitHub PATCH of the pull request body. */
export async function reviewApproveApplyGitChangeDescription(page: Page): Promise<void> {
  const chatWindow = page.locator(`[data-window-id="${CHAT_WINDOW_ID}"]`);
  await chatWindow.getByTestId("git-change-description-preview").click();
  await expect(chatWindow.getByTestId("git-change-description-preview-body")).toBeVisible({
    timeout: 120_000,
  });
  await chatWindow.getByTestId("git-change-description-approve").click();
  await chatWindow.getByTestId("git-change-description-apply").click();
  await expect(chatWindow.getByTestId("git-change-description-state")).toHaveText(
    "Current (applied)",
    { timeout: 60_000 },
  );
}
