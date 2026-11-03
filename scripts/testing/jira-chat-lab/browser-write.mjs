import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { URL } from "node:url";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing";
import { mintLauncherPairingAttestation } from "../../../packages/keiko-server/dist/coding-app-session/launcherSessionPairingPort.js";
import { qualifyBrowserLifecycle } from "./browser-lifecycle.mjs";
import { requestWorkspaceJiraConnection } from "./browser-connections.mjs";
import { openBrowser, createPod } from "./browser-read.mjs";

const OUTCOME_LABELS = new Map([
  ["succeeded", "Jira change confirmed"],
  ["unknown", "Jira outcome unknown"],
]);

function stage(value) {
  console.log(JSON.stringify({ operation: "jira-chat-browser-write", stage: value }));
}

async function connectChat(page, mode, connection = "dropdown") {
  const chat = page.getByRole("region", { name: /Synthetic Jira browser Chat/ });
  let confirmEdge;
  if (connection === "dropdown") {
    await chat.getByText("Tool access", { exact: true }).click();
    await chat.getByRole("combobox", { name: /^Jira Pod/ }).selectOption({ label: "Browser Jira" });
  } else {
    confirmEdge = await requestWorkspaceJiraConnection(page, chat, connection);
  }
  const labels = {
    "governed-assist": "Ask for approval",
    "supervised-coding": "Supervised workspace",
    "autonomous-delivery": "Full access",
  };
  await chat.getByRole("combobox", { name: "Chat autonomy mode", exact: true }).click();
  await page.getByRole("option", { name: labels[mode], exact: true }).click();
  await chat.getByRole("button", { name: "Apply tool settings", exact: true }).click();
  await chat.getByText("Jira Pod connected by the server", { exact: true }).waitFor();
  await chat.getByText("Tool access", { exact: true }).click();
  await confirmEdge?.();
  stage("bound");
  return chat;
}

async function sendPrompt(page, chat, prompt, onIntent) {
  await chat.getByRole("textbox", { name: "Chat message", exact: true }).fill(prompt);
  const sent = page.waitForRequest((request) => {
    const path = new URL(request.url()).pathname;
    return (
      request.method() === "POST" &&
      (path === "/api/desktop/chat" || path === "/api/desktop/chat/stream")
    );
  });
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  const request = await sent;
  const body = request.postDataJSON();
  assert.equal(body.content, prompt);
  assert.match(body.clientTurnId, /^[0-9a-f-]{36}$/u);
  onIntent(body.clientTurnId, body);
  stage("sent");
}

async function decideRead(chat, beforeDecision) {
  const allow = chat.getByRole("button", { name: "Allow reading", exact: true });
  await allow.waitFor({ timeout: 120000 });
  await beforeDecision();
  await allow.click();
  stage("read-approved");
}

async function decideWrite(chat, intent, beforeDecision) {
  if (intent.mode === "autonomous-delivery") return 0;
  const review = chat.getByRole("region", { name: "Review Jira action", exact: true });
  await review.waitFor({ timeout: 120000 });
  const preview = await review.getByLabel("Proposed action details", { exact: true }).inputValue();
  assert.deepEqual(JSON.parse(preview), { issueKey: intent.key, body: intent.marker });
  await beforeDecision();
  await review.getByRole("button", { name: "Approve this action", exact: true }).click();
  stage("write-approved");
  return 1;
}

async function completedTurn(observe) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const completed = await observe();
    const user = completed.messages.find((message) => message.role === "user");
    if (user?.turnState === "completed") return completed;
    if (user?.turnState === "failed" || user?.turnState === "cancelled")
      throw new TypeError("Browser mutation did not complete");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  }
  throw new TypeError("Browser mutation completion timed out");
}

async function recordBrowserProof(page, region, context, chat, intent, completed) {
  await region.screenshot({
    path: join(context.session.directory, `browser-write-${intent.clientTurnId}.png`),
  });
  if (intent.lifecycleRequested) {
    intent.lifecycle = await qualifyBrowserLifecycle(
      page,
      context,
      chat,
      completed,
      intent.connection,
    );
    stage("lifecycle-complete");
  }
}

function reportFailureLocation(error) {
  const line =
    error instanceof Error
      ? Number(error.stack?.match(/browser-(?:write|connections|lifecycle)\.mjs:(\d+)/u)?.[1] ?? 0)
      : 0;
  console.log(
    JSON.stringify({
      operation: "jira-chat-browser-write",
      stage: "failed-location",
      sourceLine: line,
    }),
  );
}

/** Uses real visible controls; onIntent persists the actual browser turn before any grant. */
export async function runBrowserWrite({
  context,
  chat,
  intent,
  prompt,
  beforeDecision,
  onIntent,
  observe,
  expectedMutationOutcome = "succeeded",
  beforeOutcome,
  afterCompleted,
}) {
  const outcomeLabel = OUTCOME_LABELS.get(expectedMutationOutcome);
  assert.ok(outcomeLabel, "Unsupported browser qualification outcome");
  const { browser, page } = await openBrowser(chat);
  try {
    const fragment = encodeCodingAppSessionPairingFragment(
      mintLauncherPairingAttestation({
        secret: context.secret,
        requestId: randomUUID(),
        issuedAtMs: Date.now(),
      }),
    );
    await page.goto(context.origin + fragment);
    await createPod(page, context.session);
    const region = await connectChat(page, intent.mode, intent.connection);
    await sendPrompt(page, region, prompt, onIntent);
    await decideRead(region, beforeDecision);
    const approvals = await decideWrite(region, intent, beforeDecision);
    const completed = await completedTurn(observe);
    await beforeOutcome?.({ page, region, completed });
    await region.getByText(outcomeLabel, { exact: true }).waitFor();
    assert.equal(
      await region.getByRole("region", { name: "Review Jira action", exact: true }).count(),
      approvals,
    );
    await afterCompleted?.({ page, region, completed });
    await recordBrowserProof(page, region, context, chat, intent, completed);
    stage("complete");
    return { completed, decisions: { grants: 1, approvals } };
  } catch (error) {
    reportFailureLocation(error);
    await page.screenshot({ path: join(context.session.directory, "browser-write-failure.png") });
    throw error;
  } finally {
    await browser.close();
  }
}
