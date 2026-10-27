import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSession, requireLicense } from "./lab-client.mjs";
import { jsonRequest, prepareChat, withLiveChat } from "./chat-read.mjs";
import { privateJson, runObservedChatTurn } from "./chat-write.mjs";
import { reportFaultQualificationFailure } from "./chat-lifecycle.mjs";
import { issueState } from "./catalog-state.mjs";
import {
  adminRead,
  focusedRestrictedCases,
  restrictedDispatchObserver,
  restrictedCaseAtDispatch,
  restrictedRemoteState,
  verifyRestrictedTurn,
} from "./restricted-cases.mjs";
import { restrictedCatalogCases } from "./restricted-catalog-cases.mjs";

function stage(name, extra = {}) {
  console.log(JSON.stringify({ qualification: "jira-chat-restricted", stage: name, ...extra }));
}

async function casesFor(session, fixture, id) {
  const project = await adminRead(session, "/rest/api/2/project/KEIKO");
  const metadata = await adminRead(
    session,
    `/rest/api/2/issue/${fixture.issueKeys[2]}/transitions?expand=transitions.fields`,
  );
  const transition = metadata.transitions.find((item) => item.name === "Done");
  assert.ok(transition?.fields[fixture.requiredFieldId]?.required);
  assert.notEqual(transition.fields[fixture.requiredFieldId].hasDefaultValue, true);
  assert.equal(typeof transition.fields.resolution.allowedValues[0].id, "string");
  return focusedRestrictedCases(fixture, project.id, transition, id);
}

function privateIntent(group, testCase, before, chat) {
  group.current = {
    ...testCase,
    clientTurnId: randomUUID(),
    mode: "governed-assist",
    transport: group.transport,
    before: { count: before.count, digest: before.digest },
    chatId: chat.id,
  };
  privateJson(group.pendingPath, group);
  return group.current;
}

async function verifyRemoteEffect(context, fixture, testCase, before, original) {
  const after = await restrictedRemoteState(context.session);
  if (testCase.id !== "editor-edit") {
    assert.deepEqual(after, before);
    return 0;
  }
  assert.equal(after.count, before.count);
  const key = testCase.arguments.issueKey;
  const withoutTarget = (state) => state.issues.filter((issue) => issue.key !== key);
  assert.deepEqual(withoutTarget(after), withoutTarget(before));
  const changed = await issueState(context.session, key, fixture.requiredFieldId);
  assert.equal(changed.fields.summary, testCase.arguments.fields.summary);
  assert.equal(changed.historyCount, original.historyCount + 1);
  for (const name of ["status", "resolution", "assignee", fixture.requiredFieldId])
    assert.deepEqual(changed.fields[name], original.fields[name]);
  return 1;
}

async function verifyDeniedReplay(context, group, testCase, observed, observer) {
  if (testCase.outcome !== "unknown") return false;
  group.current.request = observed.request;
  privateJson(group.pendingPath, group);
  const replayed = await jsonRequest(
    context.origin,
    context.cookie,
    "restricted-canonical-replay",
    "/api/desktop/chat",
    observed.request,
  );
  const original = observed.completed.messages.find((message) => message.role === "user");
  const repeated = replayed.messages.find((message) => message.role === "user");
  assert.equal(repeated.id, original.id);
  const result = verifyRestrictedTurn(
    { ...observed, completed: replayed },
    testCase,
    group.transport,
    observer.snapshot(),
  );
  assert.equal(result.call.id, original.toolTranscript.exchanges[0].call.id);
  assert.equal(
    result.result.invocationId,
    original.toolTranscript.exchanges[0].result.invocationId,
  );
  return true;
}

async function runCase(context, group, fixture, testCase, observer) {
  await requireLicense(context.session);
  const before = await restrictedRemoteState(context.session);
  const original =
    testCase.id === "editor-edit"
      ? await issueState(context.session, testCase.arguments.issueKey, fixture.requiredFieldId)
      : undefined;
  const chat = await prepareChat(
    context.origin,
    context.cookie,
    context.session,
    context.projectPath,
    context.modelId,
    testCase.actor,
  );
  const intent = privateIntent(group, testCase, before, chat);
  observer.arm(testCase);
  const observed = await runObservedChatTurn(context, chat, {
    ...intent,
    assertUnchanged: async () =>
      assert.deepEqual(await restrictedRemoteState(context.session), before),
  });
  const dispatch = observer.snapshot();
  group.current.observedDispatch = dispatch;
  privateJson(group.pendingPath, group);
  const actual = restrictedCaseAtDispatch(testCase, dispatch);
  const exchange = verifyRestrictedTurn(observed, actual, group.transport, dispatch);
  const replayed = await verifyDeniedReplay(context, group, actual, observed, observer);
  const remoteEffects = await verifyRemoteEffect(context, fixture, testCase, before, original);
  group.results.push({
    canonicalReplayPreserved: replayed,
    id: testCase.id,
    actor: testCase.actor,
    operation: testCase.operation,
    decisions: observed.decisions,
    dispatch,
    remoteEffects,
    outcome: exchange.result.data.outcome,
    reason: exchange.result.data.reason,
  });
  privateJson(group.pendingPath, group);
  stage(testCase.id, { passed: true, ...dispatch, remoteEffects, ...observed.decisions });
}

async function main() {
  const session = loadSession(process.argv[2]);
  const modelId = process.argv[3];
  const transport = process.argv[4] ?? "buffered";
  const suite = process.argv[5] ?? "focused";
  if (!new Set(["focused", "catalog"]).has(suite)) throw new TypeError("Unknown restricted suite");
  if (!new Set(["buffered", "stream"]).has(transport))
    throw new TypeError("Unknown Chat transport");
  await requireLicense(session);
  const fixture = JSON.parse(readFileSync(join(session.directory, "fixture.json"), "utf8"));
  const group = {
    id: randomUUID(),
    transport,
    suite,
    results: [],
    pendingPath: join(session.directory, "restricted-chat.pending.json"),
  };
  const cases =
    suite === "catalog"
      ? await restrictedCatalogCases(session, fixture, group.id)
      : await casesFor(session, fixture, group.id);
  const observer = restrictedDispatchObserver();
  privateJson(group.pendingPath, group, true);
  await withLiveChat({
    session,
    modelId,
    retainState: true,
    decorateAtlassianHttp: observer.decorate,
    stateReady: (root) => {
      group.stateDirectory = root;
      privateJson(group.pendingPath, group);
    },
    run: async (context) => {
      for (const testCase of cases) await runCase(context, group, fixture, testCase, observer);
    },
  });
  assert.equal(group.results.length, suite === "catalog" ? 14 : 8);
  if (suite === "catalog")
    assert.equal(new Set(group.results.map((item) => item.operation)).size, 14);
  await requireLicense(session);
  privateJson(join(session.directory, `restricted-chat-${group.id}.json`), group, true);
  rmSync(group.pendingPath);
  stage("complete", { passed: true, cases: group.results.length, transport, suite });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error) => reportFaultQualificationFailure("jira-chat-restricted", error));
