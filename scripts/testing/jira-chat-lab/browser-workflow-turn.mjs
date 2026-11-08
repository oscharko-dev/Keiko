import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing";
import { mintLauncherPairingAttestation } from "../../../packages/keiko-server/dist/coding-app-session/launcherSessionPairingPort.js";
import { jsonRequest } from "./chat-read.mjs";
import { openChatComposer } from "../../../tests/e2e/support/chat-composer.ts";
import { workspaceStorageArgs } from "../../lib/workspace-storage-fixture.mjs";
import { openBrowser, createPod } from "./browser-read.mjs";
import {
  connectPodFromPanel,
  selectAccessMode,
  openConnectors,
  closeConnectors,
} from "./browser-connections.mjs";
import { consentCardCount, establishedReadGrant } from "./read-grant.mjs";

/** Redeem only the existing launcher attestation; recovery owns process lifecycle elsewhere. */
export async function redeemWorkflowBrowserSession(page, context) {
  const fragment = encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: context.secret,
      requestId: randomUUID(),
      issuedAtMs: Date.now(),
    }),
  );
  try {
    const [paired] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          url.origin === context.origin &&
          url.pathname === "/api/coding-workbench/app-session/pair"
        );
      }),
      page.goto(context.origin + fragment),
    ]);
    const completion = await paired.finished();
    if (paired.status() === 200 && completion === null) return;
  } catch {
    // Browser errors can contain the private launcher fragment; expose only this closed failure.
  }
  throw new TypeError("Browser launcher pairing failed");
}

function workflowIdentity(value) {
  assert.ok(
    typeof value === "string" && value === value.trim() && /^[A-Za-z0-9_-]{1,128}$/u.test(value),
    "An existing Chat or window identity is required",
  );
  return value;
}

async function currentWorkflowChat(page, context, chatId) {
  workflowIdentity(chatId);
  const response = await page.request.get(
    `/api/chats?projectPath=${encodeURIComponent(context.projectPath)}`,
  );
  assert.equal(response.status(), 200);
  const { chats } = await response.json();
  assert.ok(Array.isArray(chats), "The current project must expose its canonical Chat list");
  const matches = chats.filter((chat) => chat.id === chatId);
  assert.equal(
    matches.length,
    1,
    "A saved Chat must exist exactly once; never create a replacement",
  );
  assert.ok(matches[0].projectPath === context.projectPath, "The Chat belongs to this workspace");
  assert.ok(matches[0].status !== "closed", "A deleted Chat cannot be silently restored");
  return matches[0];
}

/** Read the product-owned layout; never seed, clear or rewrite browser storage. */
export async function workflowChatRegion(page, context, chatId) {
  await currentWorkflowChat(page, context, chatId);
  const { storageKeys } = await workspaceStorageArgs(page, undefined);
  const observed = await page.waitForFunction(
    ({ key, id }) => {
      const raw = globalThis.window.localStorage.getItem(key);
      if (raw === null) return false;
      const layout = JSON.parse(raw);
      if (!Array.isArray(layout)) throw new TypeError("Unreadable workspace layout");
      const matches = layout.filter((entry) => entry.type === "chat" && entry.cfg?.chatId === id);
      if (matches.length > 1) throw new TypeError("Ambiguous Chat window binding");
      return matches[0]?.id ?? false;
    },
    { key: storageKeys.workspace, id: chatId },
    { timeout: 30000 },
  );
  const windowId = workflowIdentity(await observed.jsonValue());
  await observed.dispose();
  const region = page.locator(`.window[data-window-id="${windowId}"]`);
  await region.getByRole("textbox", { name: /^(?:Chat message|Chatnachricht)$/u }).waitFor();
  return { windowId, region };
}

async function workflowHistoryPanel(page) {
  const history = page.locator(".chat-history");
  const trigger = page.getByRole("button", { name: /^(?:Chat History|Chatverlauf)$/u });
  // The rail toggles an open tool off; reopen it once to raise the actual history window.
  if (await history.isVisible()) await trigger.click();
  await trigger.click();
  await history.waitFor();
  return { history, trigger };
}

/** The history row opens or raises only the existing Chat, including after reload/recovery. */
export async function focusWorkflowChat(page, context, chatId) {
  const chat = await currentWorkflowChat(page, context, chatId);
  const { history, trigger } = await workflowHistoryPanel(page);
  const row = history.locator(`article[data-chat-id="${workflowIdentity(chatId)}"]`);
  await row.locator(".chat-history-open").click();
  await trigger.click();
  return { ...(await workflowChatRegion(page, context, chatId)), chat };
}

async function renameWorkflowChat(page, chatId, title) {
  const { history, trigger } = await workflowHistoryPanel(page);
  const row = history.locator(`article[data-chat-id="${workflowIdentity(chatId)}"]`);
  await row.getByRole("button", { name: /^Rename /u }).click();
  await row.getByRole("textbox").fill(title);
  await row.getByRole("textbox").press("Enter");
  await row.getByRole("textbox").waitFor({ state: "hidden" });
  await trigger.click();
}

// Chat History's New button creates through the desktop canvas route (`createDesktopChat`).
const UI_CHAT_CREATION_PATH = "/api/desktop/chats";

// Chat creation joins the startup model readiness check, which a large local model can hold for
// longer than the composer helper's wait. Settle it first through the UI's own bounded model read.
async function settleModelStartup(page) {
  const settled = await page.request.get("/api/models?settleStartup=1");
  assert.equal(settled.status(), 200, "The startup model readiness must settle before a Chat");
}

/** The existing ordinary UI creator owns the POST; this owner only observes its identity. */
export async function openWorkflowChat(page, context, options = {}) {
  if (options.chatId !== undefined) return focusWorkflowChat(page, context, options.chatId);
  await settleModelStartup(page);
  await options.onPhase?.({ phase: "chat-creation-may-have-started" });
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === UI_CHAT_CREATION_PATH,
    ),
    openChatComposer(page),
  ]);
  assert.ok([200, 201].includes(response.status()), "The ordinary Chat creation must succeed");
  const { chat } = await response.json();
  workflowIdentity(chat?.id);
  await options.onChat?.({ chatId: chat.id });
  assert.ok(chat.projectPath === context.projectPath, "The UI must create in this workspace");
  const opened = await workflowChatRegion(page, context, chat.id);
  await options.onChat?.({ chatId: chat.id, windowId: opened.windowId });
  if (options.title !== undefined && chat.title !== options.title)
    await renameWorkflowChat(page, chat.id, options.title);
  return focusWorkflowChat(page, context, chat.id);
}

function workflowOptions(options) {
  const actorClass = options.actorClass ?? "permitted";
  assert.ok(new Set(["permitted", "restricted"]).has(actorClass), "Unknown browser actor class");
  const mode = options.mode ?? "governed-assist";
  const label =
    options.label ?? (actorClass === "restricted" ? "Limit Run Restricted" : "Browser Jira");
  if (actorClass === "restricted") {
    assert.ok(label === "Limit Run Restricted", "The restricted Pod has its fixed label");
    assert.ok(mode === "autonomous-delivery", "The native refusal uses Full access");
    assert.ok(
      options.administration === true,
      "The native refusal needs explicit local admin scope",
    );
    assert.ok(options.jiraOnly === true, "The restricted Chat has only its Jira source");
  }
  return { ...options, actorClass, mode, label };
}

async function workflowAdministration(page, region, enabled) {
  if (enabled !== true) return;
  const panel = await openConnectors(page, region);
  const control = panel.getByRole("switch", { name: "Administer the Jira instance", exact: true });
  if ((await control.getAttribute("aria-checked")) !== "true") await control.click();
  await control.and(page.locator('[aria-checked="true"]')).waitFor();
  await closeConnectors(region);
}

function jiraOnlyWorkflowChat(chat) {
  const files = chat.connectedScopes ?? (chat.connectedScope ? [chat.connectedScope] : []);
  const knowledge =
    chat.localKnowledgeScopes ?? (chat.localKnowledgeScope ? [chat.localKnowledgeScope] : []);
  assert.ok(
    files.length === 0 && knowledge.length === 0 && (chat.gitChangeScopes ?? []).length === 0,
    "A Jira-only Chat cannot borrow other sources",
  );
}

export function assertWorkflowChatConfiguration(chat, context, podId, options) {
  assert.ok(chat.projectPath === context.projectPath, "The Chat belongs to this workspace");
  assert.ok(chat.status !== "closed", "The Chat must remain available");
  assert.ok(chat.jiraPodBinding?.podId === podId, "The observed Chat binds the requested Jira Pod");
  assert.ok(chat.toolMode === options.mode, "The observed Chat retains its explicit access mode");
  assert.ok(
    chat.effectiveToolMode === undefined || chat.effectiveToolMode === options.mode,
    "The current deployment ceiling admits the selected mode",
  );
  if (options.administration === true)
    assert.ok(chat.jiraAdministrationEnabled === true, "Administration is explicitly selected");
  if (options.jiraOnly === true) jiraOnlyWorkflowChat(chat);
  assert.ok(chat.selectedModel === context.modelId, "The Chat uses the requested actual model");
  return chat;
}

async function configuredWorkflowChat(page, context, chatId, podId, options) {
  return assertWorkflowChatConfiguration(
    await currentWorkflowChat(page, context, chatId),
    context,
    podId,
    options,
  );
}

async function selectWorkflowModel(page, region, context, chat) {
  if (chat.selectedModel === context.modelId) return;
  await region.getByRole("combobox", { name: /^(?:Models|Modelle)$/u }).click();
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return (
        candidate.request().method() === "PATCH" &&
        url.pathname === "/api/chats" &&
        url.searchParams.get("id") === chat.id
      );
    }),
    page.getByRole("option", { name: context.modelId, exact: true }).click(),
  ]);
  assert.equal(response.status(), 200);
}

function workflowHandle(opened, context, selected, podId, chat, ownsBrowser, options) {
  return {
    ...opened,
    ...selected,
    chat,
    podId,
    ownsBrowser,
    focus: async (page = opened.page) => {
      const focused = await focusWorkflowChat(page, context, chat.id);
      const current = await configuredWorkflowChat(page, context, chat.id, podId, options);
      return { ...focused, chat: current };
    },
    regionFor: async (page = opened.page) =>
      (await workflowChatRegion(page, context, chat.id)).region,
    close: async () => {
      if (ownsBrowser) await opened.browser.close();
    },
  };
}

/** One owner for launch, UI Chat creation, Pod binding and session redemption. */
export async function openWorkflowBrowser(context, provided = {}) {
  const options = workflowOptions(provided);
  const opened = options.shared ?? (await openBrowser(undefined, context.origin));
  const ownsBrowser = options.shared === undefined;
  const checkpoint = (callback) => async (facts) =>
    callback?.({ ...facts, actorClass: options.actorClass });
  try {
    if (ownsBrowser || options.redeemSession === true)
      await redeemWorkflowBrowserSession(opened.page, context);
    const selected = await openWorkflowChat(opened.page, context, {
      chatId: options.chatId,
      title: options.title ?? "Synthetic Jira browser Chat",
      onPhase: checkpoint(options.onPhase),
      onChat: checkpoint(options.onChat),
    });
    if (options.jiraOnly === true) jiraOnlyWorkflowChat(selected.chat);
    await selectWorkflowModel(opened.page, selected.region, context, selected.chat);
    const pod = await createPod(opened.page, context.session, {
      label: options.label,
      tokenFile: options.tokenFile,
      podId: options.podId,
      onPhase: checkpoint(options.onPhase),
      onPod: checkpoint(options.onPod),
    });
    await connectPodFromPanel(opened.page, selected.region, options.label);
    await selectAccessMode(opened.page, selected.region, options.mode);
    await workflowAdministration(opened.page, selected.region, options.administration);
    const chat = await configuredWorkflowChat(
      opened.page,
      context,
      selected.chat.id,
      pod.podId,
      options,
    );
    return workflowHandle(opened, context, selected, pod.podId, chat, ownsBrowser, options);
  } catch (error) {
    if (ownsBrowser) await opened.browser.close();
    throw error;
  }
}

export function workflowHistory(context, chatId, options = {}) {
  const limit = options.limit;
  if (limit !== undefined) assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500);
  const suffix = limit === undefined ? "" : `&limit=${limit}`;
  return jsonRequest(
    context.origin,
    context.cookie,
    "workflow-observe",
    `/api/chats/messages?chatId=${encodeURIComponent(chatId)}&projectPath=${encodeURIComponent(context.projectPath)}${suffix}`,
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

async function decidePending(region, user, options, decisions) {
  for (const exchange of user?.toolTranscript?.exchanges ?? []) {
    if (exchange.approval?.state !== "pending" || decisions.has(exchange.approval.approvalId))
      continue;
    await approveWorkflowExchange(region, exchange, options, decisions);
  }
}

async function approveWorkflowExchange(region, exchange, options, decisions) {
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

function completedWorkflowTurn(observed, user, previousIds, clientTurnId, decisions, allowFailure) {
  if (allowFailure !== true) assert.equal(user.turnState, "completed");
  const fresh = observed.messages.filter((message) => !previousIds.has(message.id));
  return {
    messages: observed.messages,
    user,
    exchanges: user.toolTranscript?.exchanges ?? [],
    answer: fresh
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)
      .join("\n"),
    clientTurnId,
    decisions,
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
      return completedWorkflowTurn(
        observed,
        user,
        previousIds,
        body.clientTurnId,
        decisions.size,
        options.allowFailure,
      );
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
  }
  throw new TypeError("Browser workflow did not settle; retain its intent and never replay");
}
