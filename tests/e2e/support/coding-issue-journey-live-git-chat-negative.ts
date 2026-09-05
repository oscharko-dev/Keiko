// #3390 — the git-chat-negative-effects scenario. Complements the existing unit-contract proof
// (`gitChangeRoutes.test.ts`'s "exposes exactly connect and refresh — no branch/fetch/pull/push/
// PR-create/merge/close route", acceptance-evidence-map #3390 row 13) with a live-harness check
// against the RUNNING production server and the REAL Chat UI, per the descriptor's declared
// `playwright-journey` evidence class: real HTTP probes against candidate mutating paths, plus the
// absence of a matching control in the connected Chat's own rendered surface. Reuses the same real
// hermetic git fixture and Chat-connect flow the `git-change-chat-3400.spec.ts` sibling already
// builds (`buildGitChangeChatFixture`) rather than a second one.

import { expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  buildGitChangeChatFixture,
  createChatForFixture,
  removeGitChangeChatFixture,
  seedWorkspace,
} from "./git-change-chat-3400.js";

const GIT_WINDOW_ID = "issue-3400-git-window";
const CHAT_WINDOW_ID = "issue-3400-chat-window";
const FORBIDDEN_KEYWORDS = [
  "branch",
  "fetch",
  "pull",
  "push",
  "merge",
  "close",
  "checkout",
  "commit",
];
// Candidate mutating verbs a git/GitHub surface would plausibly expose; none of these are real
// mounted routes -- each must answer 404, proving the surface was never grown past connect/refresh
// plus the three description-refinement routes.
const FORBIDDEN_PATH_CANDIDATES = ["branch", "push", "merge", "close", "commit", "checkout"];

async function assertForbiddenPathsUnreachable(request: APIRequestContext): Promise<string> {
  for (const candidate of FORBIDDEN_PATH_CANDIDATES) {
    const response = await request.post(`/api/git-change/${candidate}`, {
      headers: { "X-Keiko-CSRF": "1" },
      data: {},
    });
    if (response.status() !== 404) {
      throw new Error(
        `expected /api/git-change/${candidate} to be unmounted, got ${String(response.status())}`,
      );
    }
  }
  return `live-forbidden-routes-unreachable:${String(FORBIDDEN_PATH_CANDIDATES.length)}`;
}

async function connectFixtureToChat(page: Page, baseRef: string, chatTitle: string): Promise<void> {
  const gitWindow = page.locator(`[data-window-id="${GIT_WINDOW_ID}"]`);
  await gitWindow.getByRole("button", { name: "Connect to Chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Git change to chat" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Base branch" }).click();
  await page.getByRole("option", { name: baseRef }).click();
  await dialog.getByRole("combobox", { name: "Chat" }).click();
  await page.getByRole("option", { name: chatTitle }).click();
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toBeHidden();
}

async function assertNoMutatingChatControls(page: Page): Promise<string> {
  const chatWindow = page.locator(`[data-window-id="${CHAT_WINDOW_ID}"]`);
  const buttons = await chatWindow.getByRole("button").allTextContents();
  const offending = buttons.filter((label) =>
    FORBIDDEN_KEYWORDS.some((keyword) => label.toLowerCase().includes(keyword)),
  );
  if (offending.length > 0) {
    throw new Error(`git-connected Chat exposes a mutating control: ${offending.join(", ")}`);
  }
  return `no-mutating-chat-controls-among:${String(buttons.length)}`;
}

/**
 * Proves, from the live UI and API of the running server, that a Git-connected Chat can reach no
 * branch/commit/push/merge/close effect: no such path is mounted (real HTTP probes), and no such
 * control is rendered once a real comparison is connected (real browser check).
 */
export async function assertGitChangeChatExposesNoMutatingAffordance(
  page: Page,
  request: APIRequestContext,
): Promise<readonly string[]> {
  const routeFinding = await assertForbiddenPathsUnreachable(request);
  const fixture = buildGitChangeChatFixture();
  try {
    const chat = await createChatForFixture(request, fixture.root);
    await seedWorkspace(page, fixture.root, chat);
    await page.goto("/");
    await expect(page.locator(`[data-window-id="${GIT_WINDOW_ID}"]`)).toBeVisible();
    await connectFixtureToChat(page, fixture.baseRef, chat.title);
    const uiFinding = await assertNoMutatingChatControls(page);
    return [routeFinding, uiFinding];
  } finally {
    removeGitChangeChatFixture(fixture.root);
  }
}
