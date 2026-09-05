// #3390 — the git-to-chat-connect-refine-apply scenario. Connects the controlled repository's
// real external pull request (branch `docs/usage-section`, already open) to a real Chat through
// the Git window's own "Connect to Chat" flow (Frozen Product Decision 5: the Git window only
// connects; refinement happens afterward in normal Chat), refines it over real conversational
// turns, then applies the held description through the SAME governed body-only apply effect the
// scripted `git-change-chat-3400.spec.ts` sibling drives against a fixture -- here for real,
// against the real PR body.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { grantGithubAccess } from "./coding-issue-journey-live.js";
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

function localBranchExists(root: string, branch: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: root,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

export interface DisposableBranchCheckout {
  readonly root: string;
  readonly release: () => void;
}

// Review 3941793533: the previous helper ran `checkout -B <branch> origin/<branch>` directly in
// the shared checkout, which resets an EXISTING local branch's tip to match origin (destroying an
// unpushed commit) and, for a detached original HEAD, restores only the literal string "HEAD" --
// never the original commit. A linked git worktree is a separate working directory backed by the
// SAME repository object store: attaching one never reads, resets, or overwrites the shared
// checkout's own HEAD/branch, so there is nothing about `root` to restore afterward. If a local
// branch already named `branch` exists (a genuine conflicting operator branch), this refuses
// outright rather than reusing or resetting it.
/**
 * Attaches a disposable git worktree -- checked out on a brand-new local branch tracking the
 * controlled repository's real remote branch -- so the Git window's own "Head branch" resolves to
 * it (it reads the checkout's current branch, not a picker), without ever touching the shared
 * checkout `root`.
 */
export function attachDisposableBranchCheckout(
  root: string,
  branch: string,
): DisposableBranchCheckout {
  if (localBranchExists(root, branch)) {
    throw new Error(
      `coding-issue-journey: refusing to check out ${branch} in ${root} -- a local branch with ` +
        "that name already exists; remove or rename it before running this scenario",
    );
  }
  git(root, ["fetch", "origin", branch]);
  const parent = mkdtempSync(join(tmpdir(), "keiko-e2e-git-to-chat-"));
  // `git worktree add` must create the target itself -- remove the empty dir mkdtemp left behind.
  rmSync(parent, { recursive: true, force: true });
  git(root, ["worktree", "add", "-b", branch, parent, `origin/${branch}`]);
  const worktreeRoot = realpathSync(parent);
  return {
    root: worktreeRoot,
    release: (): void => {
      execFileSync("git", ["worktree", "remove", "--force", worktreeRoot], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
      // The temporary branch this attachment created is cleaned up too, so a repeat invocation
      // never trips the conflicting-branch refusal above against its own leftover state.
      execFileSync("git", ["branch", "-D", branch], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
    },
  };
}

export interface ConnectedGitChatSession {
  readonly chatId: string;
}

/** Connects the checked-out branch's real open pull request to a real Chat -- the exact real
 * routes the scripted sibling's "Open pull request for this branch" case drives, here reached
 * against the real controlled repository instead of an intercepted fixture response. Establishes
 * the repository-reader grant itself (review 3941793542) through the same authorized route
 * `driveIssueToDraftPullRequest` uses, so this scenario does not silently depend on an earlier
 * issue-to-PR scenario having run first in the same process to create that grant. */
export async function connectControlledPullRequestToChat(
  page: Page,
  request: APIRequestContext,
  repositoryRoot: string,
): Promise<ConnectedGitChatSession> {
  const chat = await createChatForFixture(request, repositoryRoot);
  await grantGithubAccess(page, repositoryRoot);
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

const TERMINAL_SEND_STATUSES = new Set(["completed", "failed", "cancelled"]);
const IN_FLIGHT_SEND_STATUSES = new Set(["queued", "contacting", "streaming"]);

/** Waits for the chat's own `data-send-status` live region (`SendLifecycleStatus`,
 * `ChatWindow.tsx`) to leave an idle/leftover-terminal value into an in-flight one, THEN waits for
 * it to reach a terminal value again -- proving THIS click's turn is what settled, not a stale
 * "completed" left over from the previous turn (`sendStatus` never auto-resets to "idle" between
 * turns). Throws on a turn error so a failed/cancelled turn never reads as a silent success. */
async function waitForOwnTerminalSendStatus(page: Page, chatWindowId: string): Promise<void> {
  const sendStatus = page.locator(`[data-window-id="${chatWindowId}"] [data-send-status]`);
  await expect
    .poll(
      async () =>
        IN_FLIGHT_SEND_STATUSES.has((await sendStatus.getAttribute("data-send-status")) ?? ""),
      { timeout: 30_000, message: "expected this turn to leave the idle/prior-terminal state" },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        TERMINAL_SEND_STATUSES.has((await sendStatus.getAttribute("data-send-status")) ?? ""),
      { timeout: 180_000, message: "expected the assistant turn to reach a terminal state" },
    )
    .toBe(true);
  const finalStatus = await sendStatus.getAttribute("data-send-status");
  if (finalStatus === "failed" || finalStatus === "cancelled") {
    throw new Error(`chat turn ended in "${finalStatus}" state instead of completing`);
  }
}

/** Sends each turn as a real Chat message and waits for the real assistant reply to reach a
 * terminal turn state before the next one -- content is nondeterministic (a real model), so only
 * the user's own authored text and the turn's own completion are asserted. Review 3941793534: the
 * composer is aria-disabled while empty (`isComposerReadyToSend`), and sending clears the draft, so
 * waiting for "Send enabled" right after a send can never observe anything but a timeout; the next
 * message is filled in before Send is checked again, at the top of the next iteration. */
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
    await waitForOwnTerminalSendStatus(page, CHAT_WINDOW_ID);
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
