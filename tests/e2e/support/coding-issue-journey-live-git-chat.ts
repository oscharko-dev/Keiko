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
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  closeSettingsWindow,
  openGovernedGitWindow,
  openLiveWorkbench,
  openSettingsTab,
} from "./coding-issue-journey-live.js";
import { fetchGitChangeScopes } from "./git-change-chat-3400.js";

// The Git window is a real production singleton (WindowsRegistry.ts `governedGit: {singleton:
// true}`), matched by its accessible region name like every other real-UI lookup in this lane
// (`openGovernedGitWindow`, coding-issue-journey-live.ts). The Chat window this scenario creates
// through the rail is the only one on the page for its lifetime, so the same aria-label-prefix
// pattern -- rather than a fixed `data-window-id` a seed would have hardcoded -- finds it too.
const CHAT_WINDOW = 'section[data-window-id][aria-label^="Chat"]';

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
  readonly relationshipId: string;
}

async function readExactConnectedRelationship(
  request: APIRequestContext,
  repositoryRoot: string,
  chatId: string,
): Promise<string> {
  const scopes = await fetchGitChangeScopes(request, repositoryRoot, chatId);
  if (scopes?.length !== 1 || scopes[0] === undefined) {
    throw new Error("connected Chat did not persist exactly one Git relationship");
  }
  return scopes[0].relationshipId;
}

/**
 * Grants the per-checkout GitHub issue-reader access through the real product control for a
 * repository with no bound issue: the Settings "Security" tab's `GitHubIssueAccessSettings`
 * (AutonomySettings.tsx ~line 195) -- as opposed to `CodingWorkbenchIssueIntake.tsx`'s own grant,
 * which only renders once an issue preview has actually been refused, never reached here. That
 * panel resolves its own repository as `ctx.activeRoot ?? ctx.linkedRoot ?? activeProject?.path`
 * (`SettingsPanelSessionHost`, widgets/index.tsx); with no task workspace bound and nothing else
 * naming a root, it falls through to the chat session's own active project -- which
 * `reconnectAsActiveProject` below has already made `repositoryRoot`.
 */
async function grantGithubIssueReaderAccessThroughSettings(page: Page): Promise<void> {
  const settings = await openSettingsTab(page, "Security");
  const toggle = settings.getByRole("checkbox", {
    name: /Allow reading GitHub issues for this repository/u,
  });
  if (!(await toggle.isChecked())) {
    const granted = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/api/coding-workbench/github-authorization"),
      { timeout: 30_000 },
    );
    await toggle.check();
    const response = await granted;
    expect(
      response.ok(),
      `the GitHub access grant failed with HTTP ${String(response.status())}`,
    ).toBe(true);
  }
  await closeSettingsWindow(page);
}

/**
 * The chat session resolves its ONE active project at boot, from whichever registered project was
 * most recently opened (`bootstrapSession`/`sortProjects`, useChatSession.ts / sidebar-sort.ts:
 * favorites first, then the freshest `lastOpenedAt`). A bare rail "New chat" click has no per-click
 * project picker -- `prepareNewWindowCfg` always falls back to that one session-wide active project
 * -- so `repositoryRoot` must be the freshest registered project before "New chat" is ever clicked.
 *
 * Connecting the Git window to `repositoryRoot` already bumped its `lastOpenedAt` server-side past
 * whatever the CLI registered at boot (`registerRepository`/`reconnectRepository` both upsert
 * `last_opened_at = now`, projects.ts). Reloading -- an entirely ordinary real action, and the same
 * one `reconcileLiveWorkbenchAfterModelChange` already performs elsewhere in this lane -- simply
 * re-runs that boot-time resolution, which now lands on `repositoryRoot` instead.
 */
async function reconnectAsActiveProject(page: Page, repositoryRoot: string): Promise<void> {
  await page.reload();
  await openGovernedGitWindow(page, repositoryRoot, "rail");
}

interface ConnectedRailChat {
  readonly id: string;
  readonly title: string;
}

async function readSoleChatForProject(
  request: APIRequestContext,
  projectPath: string,
): Promise<ConnectedRailChat> {
  const response = await request.get(`/api/chats?projectPath=${encodeURIComponent(projectPath)}`);
  if (!response.ok()) {
    throw new Error(`Chat list failed (${String(response.status())}): ${await response.text()}`);
  }
  const body = (await response.json()) as { readonly chats: readonly ConnectedRailChat[] };
  if (body.chats.length !== 1 || body.chats[0] === undefined) {
    throw new Error(
      `expected exactly one chat under the newly connected repository, found ${String(body.chats.length)}`,
    );
  }
  return body.chats[0];
}

/**
 * Creates a Chat through the left rail's own "New chat" control (`LeftRail.tsx`, i18n
 * "rail.newChat") -- the same one-shot action button every operator uses, never a seeded
 * `chat`-type window. The dialog's "title" field is left at its localized default so the server
 * keeps its canonical untitled default (`NewWindowDialog.tsx`'s `withChatUntitledMarker`); this
 * reads the created chat's actual id/title back from the read-only chats list rather than assuming
 * either.
 */
async function createChatThroughRail(
  page: Page,
  request: APIRequestContext,
  repositoryRoot: string,
): Promise<ConnectedRailChat> {
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New Chat window" });
  await expect(dialog).toBeVisible();
  const created = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/chats"),
    { timeout: 30_000 },
  );
  await dialog.getByRole("button", { name: "Open Chat", exact: true }).click();
  await expect(dialog).toBeHidden();
  const response = await created;
  expect(response.ok(), `chat creation failed with HTTP ${String(response.status())}`).toBe(true);
  await expect(page.locator(CHAT_WINDOW)).toBeVisible();
  return readSoleChatForProject(request, repositoryRoot);
}

/** Connects the checked-out branch's real open pull request to a real Chat -- the exact real
 * routes the scripted sibling's "Open pull request for this branch" case drives, here reached
 * against the real controlled repository instead of an intercepted fixture response. Registers and
 * binds the disposable checkout, creates the Chat and grants GitHub issue-reader access entirely
 * through the real UI (#3390): no seeded `keiko.workspace.v4` window and no direct
 * `/api/projects` / `/api/chats` / github-authorization mutation. */
export async function connectControlledPullRequestToChat(
  page: Page,
  request: APIRequestContext,
  repositoryRoot: string,
): Promise<ConnectedGitChatSession> {
  await openLiveWorkbench(page, repositoryRoot);
  await openGovernedGitWindow(page, repositoryRoot, "rail");
  await reconnectAsActiveProject(page, repositoryRoot);
  await grantGithubIssueReaderAccessThroughSettings(page);
  const chat = await createChatThroughRail(page, request, repositoryRoot);
  const gitWindow = await openGovernedGitWindow(page, repositoryRoot, "rail");
  await gitWindow.getByRole("button", { name: "Connect to Chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Git change to chat" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Open pull request for this branch" }).click();
  await dialog.getByRole("combobox", { name: "Chat" }).click();
  await page.getByRole("option", { name: chat.title }).click();
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(CHAT_WINDOW)).toBeVisible();
  const relationshipId = await readExactConnectedRelationship(request, repositoryRoot, chat.id);
  return { chatId: chat.id, relationshipId };
}

const TERMINAL_SEND_STATUSES = new Set(["completed", "failed", "cancelled"]);
const IN_FLIGHT_SEND_STATUSES = new Set(["queued", "contacting", "streaming"]);

/** Waits for the chat's own `data-send-status` live region (`SendLifecycleStatus`,
 * `ChatWindow.tsx`) to leave an idle/leftover-terminal value into an in-flight one, THEN waits for
 * it to reach a terminal value again -- proving THIS click's turn is what settled, not a stale
 * "completed" left over from the previous turn (`sendStatus` never auto-resets to "idle" between
 * turns). Throws on a turn error so a failed/cancelled turn never reads as a silent success. */
async function waitForOwnTerminalSendStatus(chatWindow: Locator): Promise<void> {
  const sendStatus = chatWindow.locator("[data-send-status]");
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
  const chatWindow = page.locator(CHAT_WINDOW);
  for (const message of turns) {
    const composer = chatWindow.getByRole("textbox", { name: "Chat message" });
    await composer.click();
    await composer.fill(message);
    const send = chatWindow.getByRole("button", { name: "Send message" });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(chatWindow.getByText(message)).toBeVisible();
    await waitForOwnTerminalSendStatus(chatWindow);
  }
}

/** Drives the real preview -> approve -> apply description sequence from the connected Chat --
 * the real `/api/git-change/review-description|approve-description|apply-description` routes,
 * ending in a real GitHub PATCH of the pull request body. */
export async function reviewApproveApplyGitChangeDescription(page: Page): Promise<void> {
  const chatWindow = page.locator(CHAT_WINDOW);
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
