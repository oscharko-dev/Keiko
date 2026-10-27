import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { pathToFileURL } from "node:url";
import { basicAuth, labRequest, loadSession, requireLicense } from "./lab-client.mjs";
import { jsonRequest, prepareChat, request, withLiveChat } from "./chat-read.mjs";
import { privateJson } from "./private-json.mjs";
export { privateJson, payload as chatToolRequest };

const MODES = new Set(["governed-assist", "supervised-coding", "autonomous-delivery"]);
const CONNECTIONS = new Set(["dropdown", "keyboard", "drag"]);
const TRANSPORTS = new Set(["buffered", "stream", "browser"]);
const WRITE_TOOLS = new Set([
  "jira_create",
  "jira_edit",
  "jira_assign",
  "jira_comment",
  "jira_transition",
]);

function stage(name, extra = {}) {
  console.log(JSON.stringify({ operation: "jira-chat-live-write", stage: name, ...extra }));
}

/** Independent read-only Jira observation, outside Chat/provider result handling. */
export async function commentState(session, key, marker) {
  let total;
  let start = 0;
  let matches = 0;
  do {
    const result = await labRequest(
      session,
      "GET",
      `/rest/api/2/issue/${key}/comment?startAt=${String(start)}&maxResults=100`,
      basicAuth(session, "api"),
    );
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.value.comments));
    assert.ok(Number.isSafeInteger(result.value.total) && result.value.total <= 2000);
    total ??= result.value.total;
    assert.equal(result.value.total, total);
    matches += result.value.comments.filter((comment) => comment.body === marker).length;
    if (start < total) assert.ok(result.value.comments.length > 0);
    start += result.value.comments.length;
  } while (start < total);
  return { total, matches };
}

async function observeMessages(context, chat, signal) {
  return jsonRequest(
    context.origin,
    context.cookie,
    "chat-observe",
    `/api/chats/messages?chatId=${encodeURIComponent(chat.id)}&projectPath=${encodeURIComponent(context.projectPath)}`,
    undefined,
    "GET",
    signal,
  );
}

async function consent(context, grant, signal) {
  const decided = await jsonRequest(
    context.origin,
    context.cookie,
    "read-consent",
    `/api/atlassian-connectors/action-approvals/${encodeURIComponent(grant.grantId)}/chat-read-consent`,
    { decision: "approve", disclosureVersion: grant.disclosureVersion },
    "POST",
    signal,
  );
  assert.equal(decided.approval.state, "granted");
}

async function approve(context, exchange, intent, signal) {
  assert.notEqual(intent.mode, "autonomous-delivery");
  assert.equal(exchange.call.name, toolName(intent));
  assert.deepEqual(exchange.call.arguments, toolArguments(intent));
  assert.equal(exchange.approval.operation, intent.operation ?? "jira.comment");
  const path = `/api/atlassian-connectors/action-approvals/${encodeURIComponent(exchange.approval.approvalId)}/chat-write-approval`;
  const current = await jsonRequest(
    context.origin,
    context.cookie,
    "write-observe",
    path,
    undefined,
    "GET",
    signal,
  );
  assert.equal(current.approval.state, "pending");
  assert.equal(current.approval.actionDigest, exchange.approval.actionDigest);
  const result = await jsonRequest(
    context.origin,
    context.cookie,
    "write-approve",
    path,
    { decision: "approve", actionDigest: current.approval.actionDigest },
    "POST",
    signal,
  );
  assert.equal(result.approval.state, "approved");
}

function toolName(intent) {
  return (intent.operation ?? "jira.comment").replaceAll(/[.-]/g, "_");
}
function toolArguments(intent) {
  return intent.arguments ?? { issueKey: intent.key, body: intent.marker };
}
async function assertUnchanged(session, intent) {
  if (intent.assertUnchanged) await intent.assertUnchanged();
  else assert.deepEqual(await commentState(session, intent.key, intent.marker), intent.before);
}

async function readDecision(context, transcript, intent, grants, signal) {
  const grant = transcript?.readGrant;
  if (grant?.state !== "pending" || grants.has(grant.grantId)) return;
  await assertUnchanged(context.session, intent);
  grants.add(grant.grantId);
  assert.equal(grants.size, 1);
  await consent(context, grant, signal);
  stage("read-consent", { approved: true });
}

async function writeDecisions(context, transcript, intent, counts, signal) {
  for (const exchange of transcript?.exchanges ?? []) {
    const approval = exchange.approval;
    if (approval?.state !== "pending" || counts.approvals.has(approval.approvalId)) continue;
    assert.equal(counts.grants.size, 1);
    await assertUnchanged(context.session, intent);
    counts.approvals.add(approval.approvalId);
    assert.equal(counts.approvals.size, 1);
    await approve(context, exchange, intent, signal);
    stage("write-approval", { approved: true });
  }
}

async function observeDecisions(context, chat, intent, signal, settled) {
  const counts = { grants: new Set(), approvals: new Set() };
  while (!settled() && !signal.aborted) {
    const observed = await observeMessages(context, chat, signal);
    const transcript = observed.messages.find((message) => message.role === "user")?.toolTranscript;
    await readDecision(context, transcript, intent, counts.grants, signal);
    await writeDecisions(context, transcript, intent, counts, signal);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
  }
  return { grants: counts.grants.size, approvals: counts.approvals.size };
}

function payload(context, chat, intent) {
  const target = toolArguments(intent).issueKey;
  const targetInstruction =
    typeof target === "string"
      ? `The requested issue key is ${target}. Copy that exact identifier. `
      : "";
  return {
    chatId: chat.id,
    projectPath: context.projectPath,
    modelId: context.modelId,
    clientTurnId: intent.clientTurnId,
    expectedGroundingScopeIdentity: chat.groundingScopeIdentity,
    content: `${targetInstruction}Call ${toolName(intent)} exactly once with this exact JSON argument object: ${JSON.stringify(toolArguments(intent))}. Do not call any other mutation tool. Wait for any requested approval. After the tool result, report its outcome briefly and do not repeat the call, even if the outcome is unknown or unconfirmed.`,
    memory: { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} },
  };
}

async function streamResult(response, events) {
  assert.ok(response.headers.get("content-type")?.includes("text/event-stream"));
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let completed;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    assert.ok(bytes <= 8_388_608);
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      const lines = frame.split("\n");
      const name = lines.find((line) => line.startsWith("event: "))?.slice(7);
      if (!name) continue;
      events.add(name);
      assert.ok(name !== "error" && name !== "cancelled");
      if (name === "done") {
        assert.equal(completed, undefined);
        completed = JSON.parse(
          lines
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n"),
        );
      }
    }
  }
  assert.ok(completed);
  return completed;
}

async function sendTurn(context, chat, intent, signal, events) {
  const path = intent.transport === "stream" ? "/api/desktop/chat/stream" : "/api/desktop/chat";
  const response = await request(
    context.origin,
    context.cookie,
    "chat-write-send",
    path,
    payload(context, chat, intent),
    "POST",
    signal,
  );
  return intent.transport === "stream" ? streamResult(response, events) : response.json();
}

function verifyTurn(completed, decisions, intent, events) {
  const user = completed.messages.find((message) => message.role === "user");
  assert.equal(user?.turnState, "completed");
  assert.equal(decisions.grants, 1);
  const mutation = WRITE_TOOLS.has(toolName(intent));
  const needsApproval = mutation && intent.mode !== "autonomous-delivery";
  assert.equal(decisions.approvals, needsApproval ? 1 : 0);
  const expected = verifyExchange(user.toolTranscript.exchanges, intent, mutation);
  if (intent.transport === "stream") {
    assert.ok(events.has("tool-read-consent"));
    assert.equal(events.has("tool-write-approval"), needsApproval);
  }
  return expected;
}

function verifyExchange(exchanges, intent, mutation) {
  const writes = exchanges.filter((exchange) => WRITE_TOOLS.has(exchange.call.name));
  assert.equal(writes.length, mutation ? 1 : 0);
  const expected = exchanges.filter((exchange) => exchange.call.name === toolName(intent));
  assert.equal(expected.length, 1);
  assert.deepEqual(expected[0].call.arguments, toolArguments(intent));
  assert.equal(expected[0].result?.status, "completed");
  if (mutation) {
    assert.equal(expected[0].result?.data?.outcome, intent.outcome ?? "succeeded");
    assert.equal(expected[0].mutationOutcome, intent.outcome ?? "succeeded");
  }
  return expected[0];
}

export async function runObservedChatTurn(context, chat, intent) {
  const controller = new globalThis.AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 240_000);
  const events = new Set();
  const turnRequest = payload(context, chat, intent);
  let settled = false;
  const pending = sendTurn(context, chat, intent, controller.signal, events);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    const decisions = await observeDecisions(
      context,
      chat,
      intent,
      controller.signal,
      () => settled,
    );
    return { completed: await pending, decisions, events, request: turnRequest };
  } finally {
    globalThis.clearTimeout(timeout);
    controller.abort();
    await pending.catch(() => undefined);
  }
}

export async function runChatToolTurn(context, chat, intent) {
  const observed = await runObservedChatTurn(context, chat, intent);
  const exchange = verifyTurn(observed.completed, observed.decisions, intent, observed.events);
  return { decisions: observed.decisions, exchange };
}

async function prepareWriteChat(context, intent) {
  const { session, modelId } = context;
  if (intent.transport === "browser") {
    const created = await jsonRequest(context.origin, context.cookie, "chat-create", "/api/chats", {
      projectPath: context.projectPath,
      title: "Synthetic Jira browser Chat",
      selectedModel: modelId,
    });
    return created.chat;
  }
  const created = await prepareChat(
    context.origin,
    context.cookie,
    session,
    context.projectPath,
    modelId,
  );
  const { chat } = await jsonRequest(
    context.origin,
    context.cookie,
    "chat-mode",
    `/api/chats?id=${encodeURIComponent(created.id)}`,
    { toolMode: intent.mode, expectedGroundingScopeIdentity: created.groundingScopeIdentity },
    "PATCH",
  );
  assert.equal(chat.toolMode, intent.mode);
  return chat;
}

async function dispatchWrite(context, chat, intent, pending) {
  if (intent.transport !== "browser")
    return (await runChatToolTurn(context, chat, intent)).decisions;
  const { runBrowserWrite } = await import("./browser-write.mjs");
  const { completed, decisions } = await runBrowserWrite({
    context,
    chat,
    intent,
    prompt: payload(context, chat, intent).content,
    beforeDecision: async () => {
      assert.deepEqual(
        await commentState(context.session, intent.key, intent.marker),
        intent.before,
      );
    },
    onIntent: (clientTurnId) => {
      intent.clientTurnId = clientTurnId;
      privateJson(pending, intent);
    },
    observe: () => observeMessages(context, chat),
  });
  verifyTurn(completed, decisions, intent, new Set());
  return decisions;
}

async function qualifyChatWrite(context, intent, pending) {
  const { session } = context;
  const chat = await prepareWriteChat(context, intent);
  intent.chatId = chat.id;
  intent.before = await commentState(session, intent.key, intent.marker);
  assert.equal(intent.before.matches, 0);
  intent.phase = "dispatch-may-have-started";
  privateJson(pending, intent);
  stage("dispatch", { mode: intent.mode, transport: intent.transport });
  intent.decisions = await dispatchWrite(context, chat, intent, pending);
  intent.after = await commentState(session, intent.key, intent.marker);
  assert.deepEqual(intent.after, { total: intent.before.total + 1, matches: 1 });
  const reloaded = await observeMessages(context, chat);
  assert.equal(
    reloaded.messages
      .find((message) => message.role === "user")
      ?.toolTranscript.exchanges.find((exchange) => exchange.call.name === "jira_comment")
      ?.mutationOutcome,
    "succeeded",
  );
  intent.phase = "verified";
  privateJson(pending, intent);
}

function scenarioArguments() {
  const modelId = process.argv[3];
  const mode = process.argv[4];
  const transport = process.argv[5];
  const connection = process.argv[6] ?? "dropdown";
  const lifecycle = process.argv[7];
  assert.ok(lifecycle === undefined || lifecycle === "lifecycle");
  assert.ok(lifecycle === undefined || transport === "browser");
  assert.ok(CONNECTIONS.has(connection));
  assert.ok(transport === "browser" || connection === "dropdown");
  if (!modelId || !MODES.has(mode) || !TRANSPORTS.has(transport))
    throw new TypeError(
      "Usage: chat-write.mjs <private-session> <model> <mode> <buffered|stream|browser> [dropdown|keyboard|drag] [lifecycle]",
    );
  return { modelId, mode, transport, connection, lifecycle };
}

async function main() {
  const session = loadSession(process.argv[2]);
  const { modelId, mode, transport, connection, lifecycle } = scenarioArguments();
  await requireLicense(session);
  const fixture = JSON.parse(readFileSync(join(session.directory, "fixture.json"), "utf8"));
  const key = fixture.issueKeys[1];
  assert.match(key, /^KEIKO-\d+$/);
  const pending = join(session.directory, "chat-write.pending.json");
  const intent = {
    schemaVersion: 1,
    mode,
    transport,
    connection,
    lifecycleRequested: lifecycle === "lifecycle",
    key,
    marker: `Synthetic Chat write ${randomUUID()}`,
    clientTurnId: randomUUID(),
    phase: "setup",
  };
  privateJson(pending, intent, true);
  await withLiveChat({
    session,
    modelId,
    browser: transport === "browser",
    retainState: true,
    stateReady: (root) => {
      intent.productState = root;
      privateJson(pending, intent);
    },
    run: (context) => qualifyChatWrite(context, intent, pending),
  });
  await requireLicense(session);
  privateJson(join(session.directory, `chat-write-${intent.clientTurnId}.json`), intent, true);
  rmSync(pending);
  stage("complete", {
    passed: true,
    mode,
    transport,
    connection,
    matchingRemoteComments: intent.after.matches,
    commentCountIncrease: intent.after.total - intent.before.total,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error) => {
    stage("failed", {
      passed: false,
      errorType: error instanceof Error ? error.name : "unknown",
      reconcileRequired: true,
    });
    process.exitCode = 1;
  });
