import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing";
import { mintLauncherPairingAttestation } from "../../../packages/keiko-server/dist/coding-app-session/launcherSessionPairingPort.js";
import { jsonRequest } from "./chat-read.mjs";
import { openBrowser, createPod } from "./browser-read.mjs";
import {
  connectPodFromPanel,
  selectAccessMode,
  openConnectors,
  closeConnectors,
} from "./browser-connections.mjs";
import { consentCardCount, establishedReadGrant } from "./read-grant.mjs";

/** Reuse the existing real browser, pairing, Hub and composer owners. No seeded ready Pod. */
export async function openWorkflowBrowser(context, options = {}) {
  const { chat } = await jsonRequest(
    context.origin,
    context.cookie,
    "chat-create",
    "/api/chats",
    {
      projectPath: context.projectPath,
      title: "Synthetic Jira browser Chat",
      selectedModel: context.modelId,
    },
    "POST",
    globalThis.AbortSignal.timeout(30000),
  );
  const opened = await openBrowser(chat, context.origin);
  try {
    const fragment = encodeCodingAppSessionPairingFragment(
      mintLauncherPairingAttestation({
        secret: context.secret,
        requestId: randomUUID(),
        issuedAtMs: Date.now(),
      }),
    );
    await opened.page.goto(context.origin + fragment);
    await createPod(opened.page, context.session, options);
    const region = opened.page.getByRole("region", { name: /Synthetic Jira browser Chat/u });
    await connectPodFromPanel(opened.page, region, options.label ?? "Browser Jira");
    await selectAccessMode(opened.page, region, "governed-assist");
    if (options.administration === true) {
      const panel = await openConnectors(opened.page, region);
      const control = panel.getByRole("switch", {
        name: "Administer the Jira instance",
        exact: true,
      });
      if ((await control.getAttribute("aria-checked")) !== "true") await control.click();
      await control.and(opened.page.locator('[aria-checked="true"]')).waitFor();
      await closeConnectors(region);
    }
    return { ...opened, region, chat };
  } catch (error) {
    await opened.browser.close();
    throw error;
  }
}

export function workflowHistory(context, chatId) {
  return jsonRequest(
    context.origin,
    context.cookie,
    "workflow-observe",
    `/api/chats/messages?chatId=${encodeURIComponent(chatId)}&projectPath=${encodeURIComponent(context.projectPath)}`,
    undefined,
    "GET",
    globalThis.AbortSignal.timeout(30000),
  );
}

export function workflowUser(messages, previousIds) {
  const users = messages.filter(
    (message) => message.role === "user" && !previousIds.has(message.id),
  );
  assert.ok(users.length <= 1, "One browser submission must admit at most one user turn");
  return users[0];
}

export function reviewWorkflowExchange(exchange, operations) {
  assert.ok(
    operations.includes(exchange.approval?.operation),
    "Unexpected write needs separate review",
  );
  assert.equal(exchange.call.name, exchange.approval.operation.replaceAll(/[.-]/gu, "_"));
  assert.equal(exchange.approval.state, "pending");
  assert.equal(typeof exchange.approval.actionDigest, "string");
}

function workflowExchanges(user) {
  return user?.toolTranscript?.exchanges ?? [];
}
async function decidePending(region, user, options, decisions) {
  for (const exchange of workflowExchanges(user)) {
    if (exchange.approval?.state !== "pending" || decisions.has(exchange.approval.approvalId))
      continue;
    reviewWorkflowExchange(exchange, options.operations);
    const review = region.getByRole("region", { name: "Review Jira action", exact: true }).filter({
      has: region
        .page()
        .getByRole("button", { name: "Approve this action", exact: true })
        .filter({ visible: true }),
    });
    assert.equal(await review.count(), 1, "Only one concrete pending action is reviewed at a time");
    const details = await review
      .getByRole("group", { name: "Proposed action details", exact: true })
      .innerText();
    for (const fact of options.reviewText ?? [])
      assert.ok(details.includes(fact), "Reviewed target is visible");
    assert.equal(await review.locator("pre").count(), 0);
    await options.beforeDecision?.(exchange);
    decisions.add(exchange.approval.approvalId);
    options.persist?.({
      phase: "approval-may-have-been-sent",
      operation: exchange.approval.operation,
    });
    await review.getByRole("button", { name: "Approve this action", exact: true }).click();
  }
}

function completedWorkflowTurn(observed, user, previousIds, body, decisions) {
  const fresh = observed.messages.filter((message) => !previousIds.has(message.id));
  return {
    messages: observed.messages,
    user,
    exchanges: user.toolTranscript?.exchanges ?? [],
    answer: fresh
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)
      .join("\n"),
    clientTurnId: body.clientTurnId,
    decisions: decisions.size,
  };
}
/** A visible composer submission and visible exact approvals; observation alone uses the Chat API. */
export async function sendBrowserTurn(page, region, context, chatId, prompt, options = {}) {
  const before = await workflowHistory(context, chatId);
  const previousIds = new Set(before.messages.map((message) => message.id));
  const decisions = new Set();
  options.persist?.({ phase: "submission-may-have-started" });
  await region.getByRole("textbox", { name: "Chat message", exact: true }).fill(prompt);
  const outgoing = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new Set(["/api/desktop/chat", "/api/desktop/chat/stream"]).has(
        new URL(request.url()).pathname,
      ),
  );
  await region.getByRole("button", { name: "Send message", exact: true }).click();
  const body = (await outgoing).postDataJSON();
  assert.equal(body.chatId, chatId);
  assert.equal(body.content, prompt);
  assert.match(body.clientTurnId, /^[0-9a-f-]{36}$/u);
  options.persist?.({ phase: "submitted", clientTurnId: body.clientTurnId });
  const deadline = Date.now() + (options.timeoutMs ?? 240000);
  while (Date.now() < deadline) {
    const observed = await workflowHistory(context, chatId);
    const user = workflowUser(observed.messages, previousIds);
    assert.equal(await consentCardCount(region), 0);
    establishedReadGrant(user);
    await decidePending(
      region,
      user,
      { ...options, operations: options.operations ?? [] },
      decisions,
    );
    if (new Set(["completed", "failed", "cancelled"]).has(user?.turnState)) {
      if (options.allowFailure !== true) assert.equal(user.turnState, "completed");
      return completedWorkflowTurn(observed, user, previousIds, body, decisions);
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
  }
  throw new TypeError("Browser workflow did not settle; retain its intent and never replay");
}
