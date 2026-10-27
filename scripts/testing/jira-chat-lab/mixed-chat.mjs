import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { jsonRequest, prepareChat, withLiveChat } from "./chat-read.mjs";
import { commentState, privateJson, runChatToolTurn } from "./chat-write.mjs";
import { projectState } from "./catalog-state.mjs";
import { loadSession, requireLicense } from "./lab-client.mjs";

const QUESTION =
  "How many review steps does the synthetic Caldera release require according to the connected Data Pod? Answer this question with its Data Pod citation, then separately report the requested Jira tool outcome.";

function stage(name, facts = {}) {
  console.log(JSON.stringify({ qualification: "jira-chat-mixed", stage: name, ...facts }));
}

function api(context, name, path, body, method = "POST") {
  return jsonRequest(context.origin, context.cookie, name, path, body, method);
}

async function waitForIndex(context, path, jobId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const detail = await api(context, "data-index-observe", path, undefined, "GET");
    const job = detail.indexingJobs.find((entry) => entry.id === jobId);
    if (job?.status === "succeeded") return detail;
    assert.ok(job?.status !== "failed" && job?.status !== "cancelled");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new TypeError("Synthetic Data Pod index did not settle within its qualification budget");
}

async function prepareDataPod(context, group) {
  const directory = join(context.projectPath, "synthetic-data");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "Caldera.md"),
    "# Synthetic Caldera release\n\nThe synthetic Caldera release requires eleven review steps. Its review-step count is eleven. This document describes a synthetic laboratory release only.\n",
    { mode: 0o600, flag: "wx" },
  );
  const created = await api(context, "data-create", "/api/local-knowledge/capsules", {
    displayName: "Synthetic Caldera",
  });
  group.capsuleId = created.capsule.id;
  privateJson(group.pendingPath, group);
  const path = `/api/local-knowledge/capsules/${encodeURIComponent(group.capsuleId)}`;
  await api(context, "data-connect", `${path}/connection`, {
    scope: { kind: "folder", rootPath: directory, recursive: true },
    displayName: "Synthetic Caldera source",
  });
  const admitted = await api(context, "data-index", `${path}/index`, { confirm: true });
  assert.equal(typeof admitted.jobId, "string");
  const detail = await waitForIndex(context, path, admitted.jobId);
  assert.equal(detail.capsule.embeddingModelIdentity.modelId, group.embeddingModelId);
  stage("data-ready", { indexed: true });
}

async function bindMixedChat(context, capsuleId) {
  const chat = await prepareChat(
    context.origin,
    context.cookie,
    context.session,
    context.projectPath,
    context.modelId,
  );
  const bound = await api(
    context,
    "mixed-bind",
    `/api/chats?id=${encodeURIComponent(chat.id)}`,
    {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId, connectedAtMs: Date.now() }],
      expectedGroundingScopeIdentity: chat.groundingScopeIdentity,
    },
    "PATCH",
  );
  assert.equal(bound.chat.jiraPodBinding.podId, chat.jiraPodBinding.podId);
  assert.equal(bound.chat.localKnowledgeScopes[0].capsuleId, capsuleId);
  return bound.chat;
}

async function groundedObservation(context, chat, capsuleId) {
  const path = `/api/chats/messages?chatId=${encodeURIComponent(chat.id)}&projectPath=${encodeURIComponent(context.projectPath)}`;
  const { messages } = await api(context, "mixed-observe", path, undefined, "GET");
  const user = messages.find((message) => message.role === "user");
  const answer = messages.find((message) => message.role === "assistant")?.groundedAnswer;
  assert.equal(user?.turnState, "completed");
  assert.equal(answer?.groundingKind, "local-knowledge");
  assert.equal(answer.noEvidence, false);
  assert.ok(answer.citations.length > 0);
  for (const citation of answer.citations) {
    assert.equal(citation.lineage.capsuleId, capsuleId);
    assert.ok(answer.content.includes(citation.marker));
  }
  assert.match(answer.content, /\b(?:eleven|11)\b/iu);
  return { citationCount: answer.citations.length, completed: true };
}

async function qualifyTurn(context, group, operation, args) {
  await requireLicense(context.session);
  const chat = await bindMixedChat(context, group.capsuleId);
  const before = await projectState(context.session);
  const intent = {
    operation,
    arguments: args,
    question: QUESTION,
    mode: "governed-assist",
    transport: "buffered",
    clientTurnId: randomUUID(),
  };
  group.current = { ...intent, chatId: chat.id, before };
  privateJson(group.pendingPath, group);
  const observed = await runChatToolTurn(context, chat, {
    ...intent,
    assertUnchanged: async () => assert.deepEqual(await projectState(context.session), before),
  });
  const grounding = await groundedObservation(context, chat, group.capsuleId);
  group.results.push({ operation, ...grounding, decisions: observed.decisions });
  privateJson(group.pendingPath, group);
  return before;
}

async function qualifyMixed(context, group) {
  await prepareDataPod(context, group);
  const beforeRead = await qualifyTurn(context, group, "jira.projects", {});
  assert.deepEqual(await projectState(context.session), beforeRead);
  stage("read", { passed: true, mutations: 0 });
  const fixture = JSON.parse(readFileSync(join(context.session.directory, "fixture.json"), "utf8"));
  const key = fixture.issueKeys[1];
  assert.match(key, /^KEIKO-\d+$/u);
  const marker = `Synthetic mixed Chat ${group.id}`;
  const before = await commentState(context.session, key, marker);
  assert.equal(before.matches, 0);
  group.comment = { key, marker, before };
  privateJson(group.pendingPath, group);
  await qualifyTurn(context, group, "jira.comment", { issueKey: key, body: marker });
  group.comment.after = await commentState(context.session, key, marker);
  assert.deepEqual(group.comment.after, { total: before.total + 1, matches: 1 });
  stage("write", { passed: true, matchingRemoteComments: 1 });
}

async function main() {
  const session = loadSession(process.argv[2]);
  const modelId = process.argv[3];
  const embeddingModelId = process.argv[4];
  if (!modelId || !embeddingModelId)
    throw new TypeError("Usage: mixed-chat.mjs <private-session> <model> <embedding-model>");
  await requireLicense(session);
  const group = {
    id: randomUUID(),
    embeddingModelId,
    modelRetries: 1,
    results: [],
    pendingPath: join(session.directory, "mixed-chat.pending.json"),
  };
  privateJson(group.pendingPath, group, true);
  await withLiveChat({
    session,
    modelId,
    embeddingModelId,
    modelRetries: group.modelRetries,
    retainState: true,
    stateReady: (root) => {
      group.stateDirectory = root;
      privateJson(group.pendingPath, group);
    },
    run: (context) => qualifyMixed(context, group),
  });
  await requireLicense(session);
  assert.equal(group.results.length, 2);
  privateJson(join(session.directory, `mixed-chat-${group.id}.json`), group, true);
  rmSync(group.pendingPath);
  stage("complete", { passed: true, mixedTurns: 2, matchingRemoteComments: 1 });
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
