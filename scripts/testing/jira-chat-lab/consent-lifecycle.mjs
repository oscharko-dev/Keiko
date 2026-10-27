import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import {
  actorDetails,
  basicAuth,
  labRequest,
  loadSession,
  readPrivateFile,
  requireLicense,
} from "./lab-client.mjs";
import { jsonRequest, prepareChat, withLiveChat } from "./chat-read.mjs";
import { commentState, privateJson, runObservedChatTurn } from "./chat-write.mjs";
import { reportFaultQualificationFailure } from "./chat-lifecycle.mjs";
import { restrictedDispatchObserver } from "./restricted-cases.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
function stage(name, extra = {}) {
  console.log(
    JSON.stringify({ qualification: "jira-chat-consent-lifecycle", stage: name, ...extra }),
  );
}
function save(group) {
  privateJson(group.pendingPath, group);
}
function read(context, path) {
  return jsonRequest(
    context.origin,
    context.cookie,
    "consent-lifecycle-observe",
    path,
    undefined,
    "GET",
  );
}
async function currentChat(context, id) {
  const result = await read(
    context,
    `/api/chats?id=${encodeURIComponent(id)}&projectPath=${encodeURIComponent(context.projectPath)}`,
  );
  const chat = result.chats.find((item) => item.id === id);
  assert.ok(chat?.jiraPodBinding);
  return chat;
}
async function credential(context, podId) {
  const result = await read(context, "/api/atlassian-connectors/credentials");
  const item = result.credentials.find((candidate) => candidate.livePod?.podId === podId);
  assert.ok(item);
  return item;
}

/** Counts actual forwarded issue reads while reusing the bounded mutation observer. */
export function consentLifecycleObserver() {
  const mutation = restrictedDispatchObserver();
  let issuePath;
  let reads = 0;
  return {
    arm(key, marker, write) {
      issuePath = `/rest/api/2/issue/${key}`;
      reads = 0;
      mutation.arm({
        dispatches: write ? 1 : 0,
        target: { method: "POST", path: `${issuePath}/comment`, body: { body: marker } },
      });
    },
    snapshot: () => ({ ...mutation.snapshot(), issueReads: reads }),
    decorate: (factory) =>
      mutation.decorate((...args) => {
        const port = factory(...args);
        return (request) => {
          if (request.method === "GET" && new URL(request.url).pathname === issuePath) reads += 1;
          return port(request);
        };
      }),
  };
}

export function lifecycleTurnReceipt(group, observed, intent, dispatch) {
  const user = observed.completed.messages.find((message) => message.role === "user");
  assert.equal(user?.turnState, "completed");
  assert.equal(typeof user.id, "string");
  assert.ok(
    group.results.every(
      (result) => result.userId !== user.id && result.clientTurnId !== intent.clientTurnId,
    ),
  );
  const exchanges = user.toolTranscript.exchanges;
  assert.equal(exchanges.length, 1);
  const exchange = exchanges[0];
  const write = intent.operation === "jira.comment";
  assert.equal(exchange.call.name, write ? "jira_comment" : "jira_issue");
  assert.deepEqual(exchange.call.arguments, intent.arguments);
  assert.equal(exchange.result.status, "completed");
  assert.equal(exchange.result.data.outcome, "succeeded");
  assert.equal(exchange.mutationOutcome, write ? "succeeded" : undefined);
  assert.equal(typeof exchange.result.invocationId, "string");
  assert.ok(group.results.every((result) => result.invocationId !== exchange.result.invocationId));
  assert.deepEqual(observed.decisions, {
    grants: intent.expectedReadGrants,
    approvals: write ? 1 : 0,
  });
  assert.equal(dispatch.attempts, write ? 1 : 0);
  assert.equal(dispatch.forwarded, write ? 1 : 0);
  if (write) assert.equal(dispatch.status, 201);
  else {
    assert.equal(dispatch.issueReads, 1);
    assert.equal(exchange.result.data.items[0].key, group.key);
  }
  if (intent.transport === "stream") {
    assert.equal(observed.events.has("tool-read-consent"), intent.expectedReadGrants === 1);
    assert.equal(observed.events.has("tool-write-approval"), write);
  }
  return {
    id: intent.id,
    clientTurnId: intent.clientTurnId,
    userId: user.id,
    invocationId: exchange.result.invocationId,
    ...observed.decisions,
    ...dispatch,
  };
}

export function requireLifecycleModelConfig(context, group) {
  assert.equal(group.modelRetries, 1);
  const configured = JSON.parse(readPrivateFile(join(context.root, "keiko.config.json")));
  const provider = configured.providers.find((entry) => entry.modelId === context.modelId);
  assert.equal(provider?.maxRetries, group.modelRetries);
}

function turnIntent(group, id, expectedReadGrants, write, before) {
  return {
    id,
    clientTurnId: randomUUID(),
    operation: write ? "jira.comment" : "jira.issue",
    arguments: { issueKey: group.key, ...(write ? { body: group.marker } : {}) },
    mode: "governed-assist",
    transport: id === "initial-read" || id === "restart-read" ? "buffered" : "stream",
    expectedReadGrants,
    ...(expectedReadGrants === 0 ? { reusedReadGrantId: group.readGrant.grantId } : {}),
    before,
    key: group.key,
    marker: group.marker,
  };
}
function captureReadGrant(group, observed, chat) {
  const user = observed.completed.messages.find((message) => message.role === "user");
  const grant = user.toolTranscript.readGrant;
  assert.equal(grant.state, "granted");
  assert.equal(grant.chatId, chat.id);
  for (const field of ["podId", "bindingGeneration", "authenticationGeneration"])
    assert.equal(grant[field], chat.jiraPodBinding[field]);
  assert.notEqual(grant.grantId, group.readGrant?.grantId);
  group.readGrant = grant;
}
async function turn(context, group, observer, chat, id, expectedReadGrants, write = false) {
  requireLifecycleModelConfig(context, group);
  await requireLicense(context.session);
  const before = await commentState(context.session, group.key, group.marker);
  assert.equal(before.matches, 0);
  group.current = turnIntent(group, id, expectedReadGrants, write, before);
  group.phase = id;
  save(group);
  observer.arm(group.key, group.marker, write);
  const observed = await runObservedChatTurn(context, chat, group.current);
  const receipt = lifecycleTurnReceipt(group, observed, group.current, observer.snapshot());
  const after = await commentState(context.session, group.key, group.marker);
  assert.deepEqual(after, write ? { total: before.total + 1, matches: 1 } : before);
  if (expectedReadGrants === 1) captureReadGrant(group, observed, chat);
  group.results.push({
    ...receipt,
    grantId: group.readGrant.grantId,
    binding: chat.jiraPodBinding,
  });
  save(group);
  stage(id, {
    passed: true,
    grants: receipt.grants,
    approvals: receipt.approvals,
    effects: write ? 1 : 0,
  });
}

async function rotateAndReverify(context, group, chat) {
  const identity = await credential(context, chat.jiraPodBinding.podId);
  group.phase = "rotation-pending";
  group.rotation = {
    authRef: identity.authRef,
    expectedGeneration: identity.generation,
    oldGrantId: group.readGrant.grantId,
  };
  save(group);
  const token = readPrivateFile(join(context.session.directory, "secrets", "editor-token")).trim();
  assert.notEqual(
    token,
    readPrivateFile(join(context.session.directory, "secrets", "api-token")).trim(),
  );
  await jsonRequest(
    context.origin,
    context.cookie,
    "consent-token-rotation",
    `/api/atlassian-connectors/credentials/${encodeURIComponent(identity.authRef)}`,
    { expectedGeneration: identity.generation, apiToken: token },
    "PATCH",
  );
  const rotated = await credential(context, identity.livePod.podId);
  assert.equal(rotated.livePod.podId, identity.livePod.podId);
  assert.ok(rotated.livePod.authenticationGeneration > identity.livePod.authenticationGeneration);
  assert.equal(rotated.livePod.verificationStatus, "unverified");
  const invalidated = await globalThis.fetch(
    `${context.origin}/api/atlassian-connectors/action-approvals/${encodeURIComponent(group.readGrant.grantId)}/chat-read-consent`,
    { headers: { Cookie: context.cookie } },
  );
  assert.equal(invalidated.status, 404);
  assert.equal((await invalidated.json()).error.code, "CHAT_READ_CONSENT_UNAVAILABLE");
  group.phase = "verification-pending";
  save(group);
  const verified = await jsonRequest(
    context.origin,
    context.cookie,
    "consent-reverify",
    `/api/atlassian-connectors/credentials/${encodeURIComponent(identity.authRef)}/verify`,
    {},
  );
  assert.equal(verified.status, "ok");
  const current = await currentChat(context, chat.id);
  assert.equal(current.jiraPodBinding.podId, identity.livePod.podId);
  assert.equal(
    current.jiraPodBinding.authenticationGeneration,
    rotated.livePod.authenticationGeneration,
  );
  return current;
}

async function verifyRotatedAuthor(session, group) {
  const result = await labRequest(
    session,
    "GET",
    `/rest/api/2/issue/${group.key}/comment?maxResults=1000`,
    basicAuth(session, "api"),
  );
  assert.equal(result.status, 200);
  assert.equal(result.value.comments.length, result.value.total);
  const comments = result.value.comments.filter((item) => item.body === group.marker);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].author.name, actorDetails("editor").name);
  group.rotatedAuthorVerified = true;
}

async function resume(session, modelId, pendingPath) {
  const group = JSON.parse(readPrivateFile(pendingPath));
  assert.equal(group.phase, "restart-ready");
  assert.notEqual(group.parentProcessId, process.pid);
  assert.equal(group.parentProcessId, process.ppid);
  group.restartProcessId = process.pid;
  group.phase = "restart-started";
  save(group);
  const observer = consentLifecycleObserver();
  await withLiveChat({
    session,
    modelId,
    modelRetries: group.modelRetries,
    retainState: true,
    restoreState: group.stateDirectory,
    decorateAtlassianHttp: observer.decorate,
    run: async (context) => {
      const chat = await currentChat(context, group.chatId);
      await turn(context, group, observer, chat, "restart-read", 0);
      const current = await rotateAndReverify(context, group, chat);
      await turn(context, group, observer, current, "rotated-read", 1);
      await turn(context, group, observer, current, "rotated-write", 0, true);
      await verifyRotatedAuthor(session, group);
    },
  });
  await requireLicense(session);
  group.phase = "complete";
  save(group);
}

async function childRestart(session, modelId) {
  const child = spawn(process.execPath, [SCRIPT, session.directory, modelId, "--resume"], {
    stdio: "inherit",
  });
  const timer = globalThis.setTimeout(() => child.kill("SIGTERM"), 900_000);
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new TypeError("Lifecycle restart qualification did not complete")),
      );
    });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function finishGroup(session, group) {
  const completed = JSON.parse(readPrivateFile(group.pendingPath));
  assert.equal(completed.id, group.id);
  assert.equal(completed.phase, "complete");
  assert.equal(completed.results.length, 4);
  assert.equal(completed.rotatedAuthorVerified, true);
  assert.notEqual(completed.restartProcessId, process.pid);
  await requireLicense(session);
  privateJson(join(session.directory, `consent-lifecycle-${group.id}.json`), completed, true);
  rmSync(group.pendingPath);
  stage("complete", { passed: true, turns: 4, freshProcesses: 2, effects: 1 });
}

async function main() {
  const session = loadSession(process.argv[2]);
  const modelId = process.argv[3];
  const pendingPath = join(session.directory, "consent-lifecycle.pending.json");
  if (process.argv[4] === "--resume") return resume(session, modelId, pendingPath);
  await requireLicense(session);
  const fixture = JSON.parse(readFileSync(join(session.directory, "fixture.json"), "utf8"));
  const group = {
    id: randomUUID(),
    parentProcessId: process.pid,
    pendingPath,
    results: [],
    modelRetries: 1,
    key: fixture.issueKeys[0],
    marker: `Synthetic lifecycle ${randomUUID()}`,
    phase: "prepared",
  };
  privateJson(pendingPath, group, true);
  const observer = consentLifecycleObserver();
  await withLiveChat({
    session,
    modelId,
    modelRetries: group.modelRetries,
    retainState: true,
    decorateAtlassianHttp: observer.decorate,
    stateReady: (root) => {
      group.stateDirectory = root;
      save(group);
    },
    run: async (context) => {
      const chat = await prepareChat(
        context.origin,
        context.cookie,
        session,
        context.projectPath,
        modelId,
      );
      group.chatId = chat.id;
      await turn(context, group, observer, chat, "initial-read", 1);
      group.phase = "restart-ready";
      save(group);
    },
  });
  await childRestart(session, modelId);
  await finishGroup(session, group);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error) =>
    reportFaultQualificationFailure("jira-chat-consent-lifecycle", error),
  );
