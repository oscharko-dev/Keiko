import assert from "node:assert/strict";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonRequest } from "./chat-read.mjs";
import { commentState } from "./chat-write.mjs";
import { loadSession, readPrivateFile, requireLicense } from "./lab-client.mjs";
import { privateJson } from "./private-json.mjs";

const WRITES = new Set([
  "jira_create",
  "jira_edit",
  "jira_assign",
  "jira_comment",
  "jira_transition",
]);
const LABELS = new Map([
  ["unknown", "Jira outcome unknown"],
  ["succeeded", "Jira change confirmed"],
]);

export function verifyBrowserToolTurn(completed, intent, outcome) {
  assert.ok(LABELS.has(outcome));
  const user = completed.messages.find((message) => message.role === "user");
  assert.equal(user?.turnState, "completed");
  const writes = user.toolTranscript.exchanges.filter((exchange) => WRITES.has(exchange.call.name));
  assert.equal(writes.length, 1);
  const exchange = writes[0];
  assert.equal(exchange.call.name, "jira_comment");
  assert.deepEqual(exchange.call.arguments, { issueKey: intent.key, body: intent.marker });
  assert.equal(exchange.mutationOutcome, outcome);
  assert.equal(exchange.result.data.outcome, outcome);
  const assistant = completed.messages.filter((message) => message.role === "assistant").at(-1);
  assert.ok(assistant);
  return { userId: user.id, callId: exchange.call.id, assistantId: assistant.id };
}

export function browserChatHistory(context, intent) {
  return jsonRequest(
    context.origin,
    context.cookie,
    "browser-fault-history",
    `/api/chats/messages?chatId=${encodeURIComponent(intent.chat.id)}&projectPath=${encodeURIComponent(context.projectPath)}`,
    undefined,
    "GET",
  );
}

async function duplicate(page, intent, outcome) {
  const response = await page.evaluate(async (body) => {
    const result = await globalThis.fetch("/api/desktop/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
      body: JSON.stringify(body),
    });
    return { status: result.status, body: await result.json() };
  }, intent.request);
  assert.equal(response.status, 200);
  assert.deepEqual(verifyBrowserToolTurn(response.body, intent, outcome), intent.identity);
}

/** Reuses only visible controls and the existing canonical replay endpoint; never repeats an effect. */
export async function recoverBrowserTurn(page, group, outcome, unchangedEffect) {
  const intent = group.current;
  const label = LABELS.get(outcome);
  assert.ok(label);
  await duplicate(page, intent, outcome);
  await unchangedEffect();
  intent.phase = "duplicate-preserved";
  privateJson(group.pendingPath, group);
  await page.reload();
  const region = page.getByRole("region", { name: /Synthetic Jira browser Chat/ });
  await region.getByText(label, { exact: true }).waitFor();
  await unchangedEffect();
  intent.phase = "reload-preserved";
  privateJson(group.pendingPath, group);
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/api/desktop/chat/regenerate",
      { timeout: 120000 },
    ),
    region.getByRole("button", { name: "Regenerate response", exact: true }).click(),
  ]);
  assert.equal(response.status(), 200);
  const regenerated = await response.json();
  assert.equal(regenerated.messages.length, 1);
  assert.equal(regenerated.messages[0].id, intent.identity.assistantId);
  assert.equal(regenerated.messages[0].responseVersion, 2);
  await region.getByText(label, { exact: true }).waitFor();
  const completed = await unchangedEffect();
  assert.equal(
    completed.messages.find((message) => message.role === "assistant").responseVersion,
    2,
  );
  intent.phase = "regenerate-preserved";
  privateJson(group.pendingPath, group);
}

export async function prepareBrowserWrite(context, group) {
  const intent = group.current;
  const created = await jsonRequest(context.origin, context.cookie, "chat-create", "/api/chats", {
    projectPath: context.projectPath,
    title: "Synthetic Jira browser Chat",
    selectedModel: context.modelId,
  });
  intent.chat = created.chat;
  intent.before = await commentState(context.session, intent.key, intent.marker);
  assert.equal(intent.before.matches, 0);
  intent.phase = "dispatch-may-have-started";
  privateJson(group.pendingPath, group);
}

export async function browserQualificationArguments(prefix) {
  const session = loadSession(process.argv[2]);
  const modelId = process.argv[3];
  assert.ok(modelId);
  const pendingPath = join(session.directory, `${prefix}.pending.json`);
  if (process.argv[4] === "--reconcile") {
    const group = JSON.parse(readPrivateFile(pendingPath));
    const intent = group.current;
    const state = await commentState(session, intent.key, intent.marker);
    privateJson(
      join(session.directory, `${prefix}-reconciliation-${randomUUID()}.json`),
      { groupId: group.id, phase: intent.phase, state },
      true,
    );
    console.log(JSON.stringify({ qualification: prefix, phase: "read-only-reconciliation-saved" }));
    return undefined;
  }
  assert.equal(process.argv[4], undefined);
  await requireLicense(session);
  const fixture = JSON.parse(readFileSync(join(session.directory, "fixture.json"), "utf8"));
  const key = fixture.issueKeys[1];
  assert.match(key, /^KEIKO-\d+$/u);
  return { session, modelId, pendingPath, key };
}
