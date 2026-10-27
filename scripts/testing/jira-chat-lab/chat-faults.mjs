import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSession, readPrivateFile, requireLicense } from "./lab-client.mjs";
import { jsonRequest, prepareChat, withLiveChat } from "./chat-read.mjs";
import { privateJson, runObservedChatTurn } from "./chat-write.mjs";
import { projectState } from "./catalog-state.mjs";
import { observedMutationFault } from "./chat-fault-transport.mjs";
import {
  applyForeignPut,
  observeFaultEffect,
  prepareFaultCase,
  readFaultState,
} from "./chat-fault-cases.mjs";

const OPERATIONS = ["jira.create", "jira.edit", "jira.assign", "jira.comment", "jira.transition"];
const WRITE_NAMES = new Set(OPERATIONS.map((name) => name.replaceAll(/[.-]/g, "_")));
const SCRIPT = fileURLToPath(import.meta.url);

function stage(operation, fault, phase) {
  console.log(JSON.stringify({ qualification: "jira-chat-faults", operation, fault, phase }));
}

function verifyUnknown(completed, current) {
  const user = completed.messages.find((message) => message.role === "user");
  assert.equal(user?.turnState, "completed");
  const exchanges = user.toolTranscript.exchanges.filter((exchange) =>
    WRITE_NAMES.has(exchange.call.name),
  );
  assert.equal(exchanges.length, 1);
  const exchange = exchanges[0];
  assert.equal(exchange.call.name, current.operation.replaceAll(/[.-]/g, "_"));
  assert.deepEqual(exchange.call.arguments, current.arguments);
  assert.equal(exchange.mutationOutcome, "unknown");
  assert.equal(exchange.result.data.outcome, "unknown");
  if (current.operation === "jira.create") assert.equal(exchange.result.data.issueKey, undefined);
  return {
    userMessageId: user.id,
    callId: exchange.call.id,
    assistantMessageId: completed.messages.filter((message) => message.role === "assistant").at(-1)
      ?.id,
  };
}

function verifyObserver(observer) {
  const observed = observer.snapshot();
  assert.equal(observed.attempts, 1);
  assert.equal(observed.forwarded, 1);
  assert.equal(observed.injected, 1);
  assert.ok(observed.actualStatus >= 200 && observed.actualStatus < 300);
}

async function replayCanonical(context, current, observer) {
  const duplicate = await jsonRequest(
    context.origin,
    context.cookie,
    "fault-duplicate",
    "/api/desktop/chat",
    current.request,
  );
  assert.deepEqual(verifyUnknown(duplicate, current), current.identity);
  verifyObserver(observer);
  assert.deepEqual(
    await readFaultState(context.session, current, current.after.key),
    current.after,
  );
}

async function regenerate(context, current, observer) {
  assert.ok(current.identity.assistantMessageId);
  const regenerated = await jsonRequest(
    context.origin,
    context.cookie,
    "fault-regenerate",
    "/api/desktop/chat/regenerate",
    {
      chatId: current.chat.id,
      projectPath: context.projectPath,
      modelId: context.modelId,
      assistantMessageId: current.identity.assistantMessageId,
      memory: { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} },
    },
  );
  assert.equal(regenerated.messages.length, 1);
  assert.equal(regenerated.messages[0].id, current.identity.assistantMessageId);
  assert.equal(regenerated.messages[0].role, "assistant");
  assert.equal(regenerated.messages[0].responseVersion, 2);
  const history = await jsonRequest(
    context.origin,
    context.cookie,
    "fault-regenerated-history",
    `/api/chats/messages?chatId=${encodeURIComponent(current.chat.id)}&projectPath=${encodeURIComponent(context.projectPath)}`,
    undefined,
    "GET",
  );
  const identity = verifyUnknown(history, current);
  assert.equal(identity.userMessageId, current.identity.userMessageId);
  assert.equal(identity.callId, current.identity.callId);
  verifyObserver(observer);
  assert.deepEqual(
    await readFaultState(context.session, current, current.after.key),
    current.after,
  );
}

async function configureFaultChat(context) {
  const created = await prepareChat(
    context.origin,
    context.cookie,
    context.session,
    context.projectPath,
    context.modelId,
  );
  const selected = await jsonRequest(
    context.origin,
    context.cookie,
    "fault-chat-mode",
    `/api/chats?id=${encodeURIComponent(created.id)}`,
    {
      toolMode: "autonomous-delivery",
      expectedGroundingScopeIdentity: created.groundingScopeIdentity,
    },
    "PATCH",
  );
  assert.equal(selected.chat.toolMode, "autonomous-delivery");
  return selected.chat;
}

async function firstDispatch(context, group, observer) {
  const current = group.current;
  current.chat = await configureFaultChat(context);
  current.phase = "dispatching";
  privateJson(group.pendingPath, group);
  const observed = await runObservedChatTurn(context, current.chat, {
    ...current,
    assertUnchanged: async () =>
      assert.deepEqual(await projectState(context.session), current.before),
  });
  assert.equal(observed.decisions.grants, 1);
  assert.equal(observed.decisions.approvals, 0);
  current.identity = verifyUnknown(observed.completed, current);
  current.request = observed.request;
  verifyObserver(observer);
  current.observer = observer.snapshot();
  current.effect = await observeFaultEffect(context.session, current);
  current.after = current.effect;
  current.phase = "effect-observed";
  privateJson(group.pendingPath, group);
  await replayCanonical(context, current, observer);
  current.phase = "foreign-fixture-edit-or-restart";
  privateJson(group.pendingPath, group);
  current.after = await applyForeignPut(context.session, current, current.effect);
  current.phase = "restart-ready";
  privateJson(group.pendingPath, group);
}

async function childRestart(session, modelId, group) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SCRIPT, session.directory, modelId, "--restart"], {
      stdio: "inherit",
    });
    const timeout = globalThis.setTimeout(() => child.kill("SIGTERM"), 240_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      globalThis.clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new TypeError("Fresh-process restart qualification failed"));
    });
  });
  const persisted = JSON.parse(readPrivateFile(group.pendingPath));
  assert.equal(persisted.current.phase, "restarted-and-regenerated");
  assert.notEqual(persisted.current.restartProcessId, process.pid);
  group.current = persisted.current;
}

async function qualifyCase(session, modelId, fixture, group, operation, fault, key) {
  await requireLicense(session);
  const id = randomUUID();
  group.current = {
    ...(await prepareFaultCase(session, fixture, operation, key, `Synthetic fault ${id}`)),
    id,
    fault,
    clientTurnId: randomUUID(),
    mode: "autonomous-delivery",
    transport: fault === "lost-response" ? "buffered" : "stream",
    phase: "prepared",
  };
  privateJson(group.pendingPath, group);
  const observer = observedMutationFault(group.current.target, fault);
  await withLiveChat({
    session,
    modelId,
    retainState: true,
    decorateAtlassianHttp: observer.decorate,
    stateReady: (root) => {
      group.current.stateDirectory = root;
      privateJson(group.pendingPath, group);
    },
    run: (context) => firstDispatch(context, group, observer),
  });
  verifyObserver(observer);
  await childRestart(session, modelId, group);
  group.results.push({
    operation,
    fault,
    transport: group.current.transport,
    chatEffects: 1,
    independentForeignEffects: group.current.target.method === "PUT" ? 1 : 0,
    unknownOutcome: true,
    duplicatePreserved: true,
    freshProcessRestart: true,
    regeneratePreserved: true,
  });
  privateJson(group.pendingPath, group);
  stage(operation, fault, "passed");
  return group.current.after.key;
}

async function restart(session, modelId, pendingPath) {
  const group = JSON.parse(readPrivateFile(pendingPath));
  const current = group.current;
  assert.equal(current.phase, "restart-ready");
  const observer = observedMutationFault(current.target, current.fault, current.observer);
  await withLiveChat({
    session,
    modelId,
    retainState: true,
    restoreState: current.stateDirectory,
    decorateAtlassianHttp: observer.decorate,
    run: async (context) => {
      await replayCanonical(context, current, observer);
      await regenerate(context, current, observer);
      current.restartProcessId = process.pid;
      current.phase = "restarted-and-regenerated";
      privateJson(pendingPath, group);
    },
  });
  verifyObserver(observer);
}

async function reconcile(session, pendingPath) {
  const group = JSON.parse(readPrivateFile(pendingPath));
  const current = group.current;
  assert.ok(current);
  const project = await projectState(session);
  const matching = project.issues.filter((issue) => issue.fields.summary === current.marker);
  const key =
    current.after?.key ?? current.key ?? (matching.length === 1 ? matching[0].key : undefined);
  const state =
    key === undefined
      ? { project, matchingCount: matching.length }
      : await readFaultState(session, current, key);
  privateJson(
    join(session.directory, `fault-chat-reconciliation-${randomUUID()}.json`),
    { groupId: group.id, phase: current.phase, state },
    true,
  );
  stage(current.operation, current.fault, "read-only-reconciliation-saved");
}

async function main() {
  const session = loadSession(process.argv[2]);
  const modelId = process.argv[3];
  const pendingPath = join(session.directory, "fault-chat.pending.json");
  if (process.argv[4] === "--restart") return restart(session, modelId, pendingPath);
  if (process.argv[4] === "--reconcile") return reconcile(session, pendingPath);
  if (process.argv[4] !== undefined) throw new TypeError("Unknown fault qualification command");
  const fixture = JSON.parse(readFileSync(join(session.directory, "fixture.json"), "utf8"));
  const group = { id: randomUUID(), pendingPath, results: [] };
  privateJson(pendingPath, group, true);
  for (const fault of ["lost-response", "committed-503"]) {
    let key;
    for (const operation of OPERATIONS)
      key = await qualifyCase(session, modelId, fixture, group, operation, fault, key);
  }
  assert.equal(group.results.length, 10);
  privateJson(join(session.directory, `fault-chat-${group.id}.json`), group, true);
  rmSync(pendingPath);
  stage("all", "both", "10-passed");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT)
  await main().catch((error) => {
    const location =
      error instanceof Error ? (error.stack?.match(/chat-fault[^\s]*\.mjs:\d+:\d+/g) ?? []) : [];
    console.error(JSON.stringify({ qualification: "jira-chat-faults", passed: false, location }));
    console.error(
      "Incomplete group retained privately. Reconcile read-only; never replay a pending mutation.",
    );
    process.exitCode = 1;
  });
