import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { loadSession, readPrivateFile, requireLicense } from "./lab-client.mjs";
import { jsonRequest, withLiveChat } from "./chat-read.mjs";
import { chatToolRequest, commentState, privateJson } from "./chat-write.mjs";
import { observedMutationFault } from "./chat-fault-transport.mjs";
import { runBrowserWrite } from "./browser-write.mjs";
import { reportFaultQualificationFailure } from "./chat-lifecycle.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const WRITE_NAMES = new Set([
  "jira_create",
  "jira_edit",
  "jira_assign",
  "jira_comment",
  "jira_transition",
]);

function stage(fault, phase) {
  console.log(JSON.stringify({ qualification: "jira-browser-faults", fault, phase }));
}

export function verifyBrowserFaultTurn(completed, intent) {
  const user = completed.messages.find((message) => message.role === "user");
  assert.equal(user?.turnState, "completed");
  const writes = user.toolTranscript.exchanges.filter((exchange) =>
    WRITE_NAMES.has(exchange.call.name),
  );
  assert.equal(writes.length, 1);
  const exchange = writes[0];
  assert.equal(exchange.call.name, "jira_comment");
  assert.deepEqual(exchange.call.arguments, { issueKey: intent.key, body: intent.marker });
  assert.equal(exchange.mutationOutcome, "unknown");
  assert.equal(exchange.result.data.outcome, "unknown");
  const assistant = completed.messages.filter((message) => message.role === "assistant").at(-1);
  assert.ok(assistant);
  return { userId: user.id, callId: exchange.call.id, assistantId: assistant.id };
}

function verifyObserver(observer) {
  const observed = observer.snapshot();
  assert.equal(observed.attempts, 1);
  assert.equal(observed.forwarded, 1);
  assert.equal(observed.injected, 1);
  assert.ok(observed.actualStatus >= 200 && observed.actualStatus < 300);
}

function history(context, intent) {
  return jsonRequest(
    context.origin,
    context.cookie,
    "browser-fault-history",
    `/api/chats/messages?chatId=${encodeURIComponent(intent.chat.id)}&projectPath=${encodeURIComponent(context.projectPath)}`,
    undefined,
    "GET",
  );
}

async function unchangedEffect(context, intent, observer) {
  verifyObserver(observer);
  assert.deepEqual(await commentState(context.session, intent.key, intent.marker), intent.after);
  const completed = await history(context, intent);
  assert.deepEqual(verifyBrowserFaultTurn(completed, intent), intent.identity);
  return completed;
}

async function browserDuplicate(page, intent) {
  const duplicate = await page.evaluate(async (body) => {
    const response = await globalThis.fetch("/api/desktop/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }, intent.request);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(verifyBrowserFaultTurn(duplicate.body, intent), intent.identity);
}

async function browserRecovery(page, context, group, observer) {
  const intent = group.current;
  await browserDuplicate(page, intent);
  await unchangedEffect(context, intent, observer);
  intent.phase = "duplicate-preserved";
  privateJson(group.pendingPath, group);
  await page.reload();
  const region = page.getByRole("region", { name: /Synthetic Jira browser Chat/ });
  await region.getByText("Jira outcome unknown", { exact: true }).waitFor();
  await unchangedEffect(context, intent, observer);
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
  await region.getByText("Jira outcome unknown", { exact: true }).waitFor();
  const completed = await unchangedEffect(context, intent, observer);
  assert.equal(
    completed.messages.find((message) => message.role === "assistant").responseVersion,
    2,
  );
  intent.phase = "regenerate-preserved";
  privateJson(group.pendingPath, group);
}

async function browserCase(context, group, observer) {
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
  const result = await runBrowserWrite({
    context,
    chat: intent.chat,
    intent,
    prompt: chatToolRequest(context, intent.chat, intent).content,
    expectedMutationOutcome: "unknown",
    beforeDecision: async () => {
      assert.equal(observer.snapshot().attempts, 0);
      assert.deepEqual(
        await commentState(context.session, intent.key, intent.marker),
        intent.before,
      );
    },
    onIntent: (clientTurnId, request) => {
      intent.clientTurnId = clientTurnId;
      intent.request = request;
      privateJson(group.pendingPath, group);
    },
    observe: () => history(context, intent),
    afterCompleted: async ({ page, completed }) => {
      intent.identity = verifyBrowserFaultTurn(completed, intent);
      intent.after = await commentState(context.session, intent.key, intent.marker);
      assert.deepEqual(intent.after, { total: intent.before.total + 1, matches: 1 });
      intent.phase = "unknown-with-one-effect";
      privateJson(group.pendingPath, group);
      await browserRecovery(page, context, group, observer);
    },
  });
  assert.deepEqual(result.decisions, { grants: 1, approvals: 1 });
  verifyObserver(observer);
  intent.decisions = result.decisions;
}

async function qualify(session, modelId, group, fault, key) {
  await requireLicense(session);
  group.current = {
    key,
    marker: `Synthetic browser fault ${randomUUID()}`,
    mode: "governed-assist",
    transport: "browser",
    connection: fault === "lost-response" ? "keyboard" : "drag",
    fault,
    phase: "prepared",
  };
  const intent = group.current;
  privateJson(group.pendingPath, group);
  const observer = observedMutationFault(
    { method: "POST", path: `/rest/api/2/issue/${key}/comment`, body: { body: intent.marker } },
    fault,
  );
  await withLiveChat({
    session,
    modelId,
    browser: true,
    retainState: true,
    decorateAtlassianHttp: observer.decorate,
    stateReady: (stateDirectory) => {
      intent.stateDirectory = stateDirectory;
      privateJson(group.pendingPath, group);
    },
    run: (context) => browserCase(context, group, observer),
  });
  verifyObserver(observer);
  await requireLicense(session);
  group.results.push({
    fault,
    connection: intent.connection,
    effects: 1,
    unknownVisible: true,
    browserDuplicatePreserved: true,
    reloadPreserved: true,
    visibleRegeneratePreserved: true,
  });
  privateJson(group.pendingPath, group);
  stage(fault, "passed");
}

async function main() {
  const session = loadSession(process.argv[2]);
  const modelId = process.argv[3];
  assert.ok(modelId);
  const pendingPath = join(session.directory, "browser-fault.pending.json");
  if (process.argv[4] === "--reconcile") {
    const group = JSON.parse(readPrivateFile(pendingPath));
    const intent = group.current;
    const state = await commentState(session, intent.key, intent.marker);
    privateJson(
      join(session.directory, `browser-fault-reconciliation-${randomUUID()}.json`),
      { groupId: group.id, phase: intent.phase, state },
      true,
    );
    return stage(intent.fault, "read-only-reconciliation-saved");
  }
  assert.equal(process.argv[4], undefined);
  const fixture = JSON.parse(readFileSync(join(session.directory, "fixture.json"), "utf8"));
  const key = fixture.issueKeys[1];
  assert.match(key, /^KEIKO-\d+$/u);
  const group = { id: randomUUID(), pendingPath, results: [] };
  privateJson(pendingPath, group, true);
  for (const fault of ["lost-response", "committed-503"])
    await qualify(session, modelId, group, fault, key);
  assert.equal(group.results.length, 2);
  privateJson(join(session.directory, `browser-fault-${group.id}.json`), group, true);
  rmSync(pendingPath);
  stage("both", "2-passed");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT)
  await main().catch((error) => reportFaultQualificationFailure("jira-browser-faults", error));
