// #3390 — the git-chat-negative-effects scenario. Adds two partial live observations to the
// existing route-contract proof: malformed empty bodies are rejected at the product's mounted
// effect boundaries, and the connected Chat renders no matching mutation controls. Neither claim
// establishes full session-authority isolation. The companion positive two-turn scenario is
// instrumented to observe the browser request stream and rendered tool events across the actual
// model-backed session; qualification still requires that real journey to execute successfully.
// Reuses the same real
// hermetic git fixture and Chat-connect flow the `git-change-chat-3400.spec.ts` sibling already
// builds (`buildGitChangeChatFixture`) rather than a second one.

import { expect, type APIRequestContext, type Page, type Request } from "@playwright/test";
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
  "pull request",
  "run command",
  "provider",
];
// These are the product's actual mounted execution boundaries, not invented `/api/git-change/*`
// candidates. An empty, untrusted request must be rejected at every boundary before an effect can
// occur. Closing has no mounted execution route and remains pinned by the route-catalog test and
// the rendered-control assertion below.
const MOUNTED_EFFECT_BOUNDARIES = [
  "/api/git-delivery/local-branch/create",
  "/api/git-delivery/local-branch/switch",
  "/api/git-delivery/commit/execute",
  "/api/git-delivery/push/execute",
  "/api/git-delivery/pr/execute",
  "/api/git-delivery/merge/execute",
  "/api/git-delivery/pull/execute",
  "/api/commands/runs",
  "/api/coding-sidecar/gateway/chat/completions",
] as const;

const FORBIDDEN_SESSION_ROUTE_PREFIXES = [
  "/api/git-delivery/",
  "/api/commands/",
  "/api/coding-sidecar/gateway/",
] as const;

/** Observes the browser's real request stream across one connected-Chat action. Server-internal
 * gateway calls do not appear here; a browser request to one of these effect boundaries would be
 * an unauthorized UI capability expansion and fails the scenario. */
export async function observeNoForbiddenSessionRequests<T>(
  page: Page,
  action: () => Promise<T>,
): Promise<T> {
  let forbiddenRequestCount = 0;
  const observeRequest = (observed: Request): void => {
    if (observesForbiddenSessionRoute(observed)) forbiddenRequestCount += 1;
  };
  page.on("request", observeRequest);
  try {
    const result = await action();
    if (forbiddenRequestCount > 0) {
      throw new Error("Git-connected Chat invoked a forbidden effect boundary");
    }
    return result;
  } finally {
    page.off("request", observeRequest);
  }
}

export async function assertMalformedEffectRequestsRejected(
  request: APIRequestContext,
): Promise<string> {
  for (const route of MOUNTED_EFFECT_BOUNDARIES) {
    const response = await request.post(route, {
      headers: { "X-Keiko-CSRF": "1" },
      data: {},
    });
    const status = response.status();
    if (status < 400 || status >= 500 || status === 404) {
      throw new Error("malformed effect request succeeded or was not a real mounted route");
    }
  }
  return `malformed-effect-requests-rejected:${String(MOUNTED_EFFECT_BOUNDARIES.length)}`;
}

function observesForbiddenSessionRoute(request: Request): boolean {
  const path = new URL(request.url()).pathname;
  return FORBIDDEN_SESSION_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export async function assertNoForbiddenSessionToolEvents(page: Page): Promise<string> {
  const events = await page.locator('[data-timeline-kind="tool"]').allTextContents();
  const offending = events.filter((event) =>
    FORBIDDEN_KEYWORDS.some((keyword) => event.toLowerCase().includes(keyword)),
  );
  if (offending.length > 0) {
    throw new Error("Git-connected Chat emitted a forbidden effect tool event");
  }
  return "no-forbidden-session-tool-events:true";
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
 * Records two partial live observations: actual mounted effect boundaries reject a malformed empty
 * request, and no matching mutation control is rendered after a real comparison is connected.
 * Full session-authority qualification belongs to the successful model-backed two-turn journey.
 */
export async function assertGitChangeChatExposesNoMutatingAffordance(
  page: Page,
  request: APIRequestContext,
): Promise<readonly string[]> {
  const routeFinding = await assertMalformedEffectRequestsRejected(request);
  const fixture = buildGitChangeChatFixture();
  try {
    const uiFinding = await observeNoForbiddenSessionRequests(page, async () => {
      const chat = await createChatForFixture(request, fixture.root);
      await seedWorkspace(page, fixture.root, chat);
      await page.goto("/");
      await expect(page.locator(`[data-window-id="${GIT_WINDOW_ID}"]`)).toBeVisible();
      await connectFixtureToChat(page, fixture.baseRef, chat.title);
      return assertNoMutatingChatControls(page);
    });
    return [routeFinding, uiFinding];
  } finally {
    removeGitChangeChatFixture(fixture.root);
  }
}
