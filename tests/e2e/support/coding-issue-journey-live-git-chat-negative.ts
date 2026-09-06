// #3390 — the git-chat-negative-effects scenario. Adds two partial live observations to the
// existing route-contract proof: malformed empty bodies are rejected at the product's mounted
// effect boundaries, and the connected Chat renders no matching mutation controls. Neither claim
// establishes full session-authority isolation. The companion positive two-turn scenario binds
// each real Chat stream request to the persisted Git relationship and its correlation-scoped
// admission, gateway completion, and absence of server-side effect operations; qualification still
// requires that real journey to execute successfully.
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
import { activityEventsForRun, activityEventTree } from "./coding-issue-journey-live-flow.js";

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

const FORBIDDEN_SESSION_ACTIVITY_PREFIXES = [
  "coding-repository-handler.",
  "coding-runtime.",
  "coding-sidecar.",
  "command.",
  "gateway.tool-catalog.",
  "git.",
  "runtime.confinement.",
  "tool-catalog.",
] as const;

const CHAT_STREAM_ROUTE = "/api/desktop/chat/stream";
const STREAM_TERMINAL_OPS = new Set([
  "gateway.stream.abandoned",
  "gateway.stream.completed",
  "gateway.stream.failed",
]);

export interface ObservedGitChatStreamRequest {
  readonly chatId: string;
  readonly correlationId: string;
}

export interface GitChatSessionActivityEvidence {
  readonly chatId: string;
  readonly relationshipId: string;
  readonly expectedTurnCount: number;
  readonly requests: readonly ObservedGitChatStreamRequest[];
  readonly activityEvents: readonly Readonly<Record<string, unknown>>[];
}

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

function requestEvidence(
  request: Request,
  chatId: string,
): ObservedGitChatStreamRequest | undefined {
  if (new URL(request.url()).pathname !== CHAT_STREAM_ROUTE) return undefined;
  const body = request.postData();
  if (body === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("chatId" in parsed) ||
    parsed.chatId !== chatId
  ) {
    return undefined;
  }
  return {
    chatId,
    correlationId: request.headers()["x-keiko-correlation-id"] ?? "",
  };
}

function eventCount(events: readonly Readonly<Record<string, unknown>>[], op: string): number {
  return events.filter((event) => event.op === op).length;
}

function isForbiddenSessionActivity(event: Readonly<Record<string, unknown>>): boolean {
  const op = event.op;
  return (
    typeof op === "string" &&
    FORBIDDEN_SESSION_ACTIVITY_PREFIXES.some((prefix) => op.startsWith(prefix))
  );
}

function assertCompletedBoundTurn(
  request: ObservedGitChatStreamRequest,
  events: readonly Readonly<Record<string, unknown>>[],
  relationshipId: string,
): void {
  if (request.correlationId.length === 0) {
    throw new Error("observed Chat stream request had no correlation identity");
  }
  const turnEvents = activityEventTree(events, request.correlationId);
  const admitted = turnEvents.filter((event) => event.op === "pr-description.chat.turn.admitted");
  if (admitted.length !== 1 || admitted[0]?.relationshipId !== relationshipId) {
    throw new Error("Chat turn was not admitted for the exact connected Git relationship");
  }
  if (
    eventCount(turnEvents, "gateway.stream.started") !== 1 ||
    eventCount(turnEvents, "gateway.stream.completed") !== 1 ||
    turnEvents.filter((event) => STREAM_TERMINAL_OPS.has(String(event.op))).length !== 1
  ) {
    throw new Error("Chat turn did not produce one completed Model Gateway stream");
  }
  const forbidden = turnEvents.some(isForbiddenSessionActivity);
  if (forbidden) throw new Error("Git-connected Chat emitted forbidden server-side tool activity");
}

export function assertNoForbiddenSessionToolEvents(
  evidence: GitChatSessionActivityEvidence,
): string {
  if (evidence.requests.length !== evidence.expectedTurnCount) {
    throw new Error("did not observe the expected number of Chat stream requests");
  }
  const correlations = new Set(evidence.requests.map((request) => request.correlationId));
  if (correlations.size !== evidence.expectedTurnCount) {
    throw new Error("Chat turns did not carry distinct correlation identities");
  }
  for (const request of evidence.requests) {
    if (request.chatId !== evidence.chatId) {
      throw new Error("observed Chat stream request belonged to another Chat session");
    }
    assertCompletedBoundTurn(request, evidence.activityEvents, evidence.relationshipId);
  }
  return "no-forbidden-session-tool-events:true";
}

/** Captures only this connected Chat's stream requests, then joins their client correlation ids
 * to the synchronous production activity log. An empty UI timeline cannot satisfy this proof: all
 * expected turns must have an admitted relationship-bound server event and a completed gateway
 * stream before the absence of correlated repository/tool effects is asserted. */
export async function observeBoundGitChatSessionActivity<T>(
  page: Page,
  session: { readonly chatId: string; readonly relationshipId: string },
  expectedTurnCount: number,
  action: () => Promise<T>,
): Promise<{ readonly result: T; readonly assertion: string }> {
  const requests: ObservedGitChatStreamRequest[] = [];
  const observeRequest = (request: Request): void => {
    const evidence = requestEvidence(request, session.chatId);
    if (evidence !== undefined) requests.push(evidence);
  };
  page.on("request", observeRequest);
  try {
    const result = await action();
    const activityEvents = requests.flatMap((request) =>
      activityEventsForRun(request.correlationId),
    );
    const assertion = assertNoForbiddenSessionToolEvents({
      ...session,
      expectedTurnCount,
      requests,
      activityEvents,
    });
    return { result, assertion };
  } finally {
    page.off("request", observeRequest);
  }
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
