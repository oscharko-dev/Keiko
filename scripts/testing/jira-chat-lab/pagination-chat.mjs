import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, URL } from "node:url";
import { loadSession, requireLicense } from "./lab-client.mjs";
import { prepareChat, withLiveChat } from "./chat-read.mjs";
import { privateJson, runObservedChatTurn } from "./chat-write.mjs";
import { projectState } from "./catalog-state.mjs";
import { reportFaultQualificationFailure } from "./chat-lifecycle.mjs";

const PAGE_SIZE = 10;
const JQL = "project = KEIKO ORDER BY key";

/** Compare the actual provider page with an independent complete, ordered Jira read. */
export function verifyPaginationPage(data, { keys, startAt, maxResults, seen }) {
  assert.equal(data.outcome, "succeeded");
  assert.equal(data.startAt, startAt);
  assert.equal(data.total, keys.length);
  assert.ok(Array.isArray(data.items) && data.items.length <= maxResults);
  const observed = data.items.map((item) => item.key);
  assert.ok(startAt === keys.length || observed.length > 0);
  assert.deepEqual(observed, keys.slice(startAt, startAt + observed.length));
  assert.equal(new Set(observed).size, observed.length);
  assert.ok(observed.every((key) => !seen.includes(key)));
  const end = startAt + observed.length;
  assert.equal(data.nextStartAt, end < keys.length ? end : undefined);
  return { keys: observed, nextStartAt: data.nextStartAt };
}

/** Observe the real request unchanged; this read-only group never forwards a mutation. */
export function paginationObserver() {
  const requests = [];
  let expected;
  let mutationAttempts = 0;
  return {
    arm: (page) => {
      assert.ok(expected === undefined || expected.completed);
      expected = { ...page, forwarded: false, completed: false };
    },
    snapshot: () => ({ requests: structuredClone(requests), mutationAttempts }),
    decorate: (factory) => (metadata, correlation, lifecycle) => {
      const port = factory(metadata, correlation, lifecycle);
      return async (request) => {
        if (request.method !== "GET") mutationAttempts += 1;
        assert.equal(request.method, "GET", "Read-only qualification cannot forward a mutation");
        if (expected === undefined) return port(request);
        const page = expected;
        const url = new URL(request.url);
        assert.ok(url.pathname.endsWith("/rest/api/2/search"));
        assert.equal(url.searchParams.get("jql"), page.jql);
        assert.equal(url.searchParams.get("startAt"), String(page.startAt));
        assert.equal(url.searchParams.get("maxResults"), String(page.maxResults));
        assert.equal(page.forwarded, false, "Each page permits exactly one physical request");
        page.forwarded = true;
        const response = await port(request);
        page.completed = true;
        requests.push({
          startAt: page.startAt,
          maxResults: page.maxResults,
          status: response.status,
        });
        return response;
      };
    },
  };
}

function pageIntent(group, startAt) {
  return {
    operation: "jira.search",
    question: "Which Jira issues are on this exact bounded search page? Report only this page.",
    arguments: { jql: JQL, startAt, maxResults: PAGE_SIZE },
    clientTurnId: randomUUID(),
    mode: "governed-assist",
    transport: group.transport,
    expectedReadGrants: group.results.length === 0 ? 1 : 0,
    ...(group.readGrantId === undefined ? {} : { reusedReadGrantId: group.readGrantId }),
  };
}

function pageGrantId(transcript, intent) {
  const grant = transcript.readGrant;
  if (grant !== undefined) {
    assert.equal(grant.kind, "jira-chat-read");
    assert.equal(grant.state, "granted");
    assert.equal(typeof grant.grantId, "string");
  }
  if (intent.expectedReadGrants === 1) {
    assert.ok(grant);
    return grant.grantId;
  }
  assert.equal(typeof intent.reusedReadGrantId, "string");
  if (grant !== undefined) assert.equal(grant.grantId, intent.reusedReadGrantId);
  return intent.reusedReadGrantId;
}

export function observedPaginationPage(observed, intent) {
  const user = observed.completed.messages.find((message) => message.role === "user");
  assert.equal(user?.turnState, "completed");
  assert.deepEqual(observed.decisions, { grants: intent.expectedReadGrants, approvals: 0 });
  assert.equal(user.toolTranscript.exchanges.length, 1);
  const exchange = user.toolTranscript.exchanges[0];
  assert.equal(exchange.call.name, "jira_search");
  assert.deepEqual(exchange.call.arguments, intent.arguments);
  assert.equal(exchange.result.status, "completed");
  assert.equal(exchange.mutationOutcome, undefined);
  const grantId = pageGrantId(user.toolTranscript, intent);
  if (intent.transport === "stream") {
    assert.equal(observed.events.has("tool-read-consent"), intent.expectedReadGrants === 1);
    assert.equal(observed.events.has("tool-write-approval"), false);
  }
  return {
    userId: user.id,
    invocationId: exchange.result.invocationId,
    grantId,
    data: exchange.result.data,
  };
}

async function runPage(context, group, observer, chat, reference, seen, startAt) {
  await requireLicense(context.session);
  const intent = pageIntent(group, startAt);
  group.current = intent;
  privateJson(group.pendingPath, group);
  observer.arm(intent.arguments);
  const observed = await runObservedChatTurn(context, chat, {
    ...intent,
    assertUnchanged: async () => assert.deepEqual(await projectState(context.session), reference),
  });
  const page = observedPaginationPage(observed, intent);
  assert.ok(group.results.every((prior) => prior.invocationId !== page.invocationId));
  assert.ok(group.results.every((prior) => prior.userId !== page.userId));
  const verified = verifyPaginationPage(page.data, {
    keys: reference.issues.map((issue) => issue.key),
    startAt,
    maxResults: PAGE_SIZE,
    seen,
  });
  assert.deepEqual(await projectState(context.session), reference);
  group.readGrantId ??= page.grantId;
  assert.equal(page.grantId, group.readGrantId);
  group.results.push({
    startAt,
    count: verified.keys.length,
    nextStartAt: verified.nextStartAt,
    userId: page.userId,
    invocationId: page.invocationId,
    decisions: observed.decisions,
  });
  privateJson(group.pendingPath, group);
  return verified;
}

async function qualify(context, group, observer) {
  const reference = await projectState(context.session);
  assert.ok(reference.count > PAGE_SIZE && reference.count <= 100);
  group.reference = { count: reference.count, digest: reference.digest };
  const chat = await prepareChat(
    context.origin,
    context.cookie,
    context.session,
    context.projectPath,
    context.modelId,
  );
  group.chatId = chat.id;
  const seen = [];
  let startAt = 0;
  while (startAt !== undefined) {
    assert.ok(group.results.length < 100);
    const page = await runPage(context, group, observer, chat, reference, seen, startAt);
    seen.push(...page.keys);
    startAt = page.nextStartAt;
  }
  assert.deepEqual(
    seen,
    reference.issues.map((issue) => issue.key),
  );
  await runPage(context, group, observer, chat, reference, seen, reference.count);
  group.dispatch = observer.snapshot();
  assert.equal(group.dispatch.mutationAttempts, 0);
  assert.equal(group.dispatch.requests.length, group.results.length);
  assert.ok(group.dispatch.requests.every((request) => request.status === 200));
}

async function main() {
  const session = loadSession(process.argv[2]);
  const modelId = process.argv[3];
  const transport = process.argv[4] ?? "stream";
  assert.ok(new Set(["buffered", "stream"]).has(transport));
  await requireLicense(session);
  const group = {
    id: randomUUID(),
    transport,
    results: [],
    pendingPath: join(session.directory, "pagination-chat.pending.json"),
  };
  privateJson(group.pendingPath, group, true);
  const observer = paginationObserver();
  await withLiveChat({
    session,
    modelId,
    retainState: true,
    decorateAtlassianHttp: observer.decorate,
    stateReady: (root) => {
      group.stateDirectory = root;
      privateJson(group.pendingPath, group);
    },
    run: (context) => qualify(context, group, observer),
  });
  await requireLicense(session);
  privateJson(join(session.directory, `pagination-chat-${group.id}.json`), group, true);
  rmSync(group.pendingPath);
  console.log(
    JSON.stringify({
      qualification: "jira-chat-pagination",
      passed: true,
      transport,
      pages: group.results.length,
      items: group.reference.count,
      mutationAttempts: 0,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error) => reportFaultQualificationFailure("jira-chat-pagination", error));
