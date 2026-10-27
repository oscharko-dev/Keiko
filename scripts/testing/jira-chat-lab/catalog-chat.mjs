import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { actorDetails, loadSession, requireLicense } from "./lab-client.mjs";
import { prepareChat, withLiveChat } from "./chat-read.mjs";
import { commentState, privateJson, runChatToolTurn } from "./chat-write.mjs";
import { issueState, projectState, readCases, remoteRead, verifyRead } from "./catalog-state.mjs";

function stage(operation, completed, extra = {}) {
  console.log(
    JSON.stringify({ qualification: "jira-chat-catalog", operation, completed, ...extra }),
  );
}

async function runCase(context, group, operation, args, before) {
  await requireLicense(context.session);
  const intent = {
    operation,
    arguments: args,
    clientTurnId: randomUUID(),
    mode: "governed-assist",
    transport: group.transport,
    before: { count: before.count, digest: before.digest },
  };
  group.current = intent;
  privateJson(group.pendingPath, group);
  const chat = await prepareChat(
    context.origin,
    context.cookie,
    context.session,
    context.projectPath,
    context.modelId,
  );
  const observed = await runChatToolTurn(context, chat, {
    ...intent,
    assertUnchanged: async () => assert.deepEqual(await projectState(context.session), before),
  });
  group.results.push({
    operation,
    decisions: observed.decisions,
    transcriptOutcome: observed.exchange.result.data.outcome,
  });
  privateJson(group.pendingPath, group);
  stage(operation, true, observed.decisions);
  return observed.exchange;
}

async function qualifyReads(context, group, fixture) {
  for (const [operation, args, expected] of readCases(fixture, actorDetails("assignee").name)) {
    const before = await projectState(context.session);
    verifyRead(await runCase(context, group, operation, args, before), expected);
    assert.deepEqual(await projectState(context.session), before);
  }
}

async function qualifyCreate(context, group, fixture) {
  const project = await remoteRead(context.session, "/rest/api/2/project/KEIKO");
  const before = await projectState(context.session);
  const marker = `Synthetic catalog ${group.id}`;
  assert.equal(before.issues.filter((issue) => issue.fields.summary === marker).length, 0);
  const fields = { summary: marker, [fixture.requiredFieldId]: "Synthetic required value" };
  const exchange = await runCase(
    context,
    group,
    "jira.create",
    {
      projectId: project.id,
      issueTypeId: fixture.issueTypeId,
      fields,
    },
    before,
  );
  const after = await projectState(context.session);
  const matching = after.issues.filter((issue) => issue.fields.summary === marker);
  assert.equal(after.count, before.count + 1);
  assert.equal(matching.length, 1);
  const key = matching[0].key;
  assert.ok(JSON.stringify(exchange.result.data).includes(key));
  assert.equal(
    (await issueState(context.session, key, fixture.requiredFieldId)).fields[
      fixture.requiredFieldId
    ],
    fields[fixture.requiredFieldId],
  );
  group.issueKey = key;
  privateJson(group.pendingPath, group);
  return key;
}

async function qualifyFieldMutation(context, group, fixture, key, operation, args, verify) {
  const before = await projectState(context.session);
  const original = await issueState(context.session, key, fixture.requiredFieldId);
  await runCase(context, group, operation, { issueKey: key, ...args }, before);
  const observed = await issueState(context.session, key, fixture.requiredFieldId);
  verify(observed.fields);
  assert.equal(observed.historyCount, original.historyCount + 1);
  assert.equal((await projectState(context.session)).count, before.count);
}

async function qualifyComment(context, group, key) {
  const marker = `Synthetic catalog comment ${group.id}`;
  const before = await commentState(context.session, key, marker);
  assert.equal(before.matches, 0);
  await runCase(
    context,
    group,
    "jira.comment",
    { issueKey: key, body: marker },
    await projectState(context.session),
  );
  assert.deepEqual(await commentState(context.session, key, marker), {
    total: before.total + 1,
    matches: 1,
  });
}

async function qualifyWrites(context, group, fixture) {
  const key = await qualifyCreate(context, group, fixture);
  const summary = `Synthetic edited catalog ${group.id}`;
  await qualifyFieldMutation(
    context,
    group,
    fixture,
    key,
    "jira.edit",
    { fields: { summary } },
    (fields) => assert.equal(fields.summary, summary),
  );
  const assigneeName = actorDetails("assignee").name;
  await qualifyFieldMutation(
    context,
    group,
    fixture,
    key,
    "jira.assign",
    { assigneeName },
    (fields) => assert.equal(fields.assignee?.name, assigneeName),
  );
  await qualifyComment(context, group, key);
  const metadata = await remoteRead(
    context.session,
    `/rest/api/2/issue/${key}/transitions?expand=transitions.fields`,
  );
  const transition = metadata.transitions.find((item) => item.name === "Done");
  assert.ok(transition?.fields[fixture.requiredFieldId]?.required);
  const resolutionId = transition.fields.resolution.allowedValues[0].id;
  assert.equal(typeof resolutionId, "string");
  const fields = {
    [fixture.requiredFieldId]: "Synthetic transition screen value",
    resolution: { id: resolutionId },
  };
  await qualifyFieldMutation(
    context,
    group,
    fixture,
    key,
    "jira.transition",
    { transitionId: transition.id, fields },
    (observed) => {
      assert.equal(observed.status.id, transition.to.id);
      assert.equal(observed.resolution.id, resolutionId);
      assert.equal(observed[fixture.requiredFieldId], fields[fixture.requiredFieldId]);
    },
  );
}

async function main() {
  const session = loadSession(process.argv[2]);
  const modelId = process.argv[3];
  const transport = process.argv[4] ?? "buffered";
  if (!new Set(["buffered", "stream"]).has(transport))
    throw new TypeError("Unknown Chat transport");
  await requireLicense(session);
  const fixture = JSON.parse(readFileSync(join(session.directory, "fixture.json"), "utf8"));
  const group = {
    id: randomUUID(),
    transport,
    results: [],
    pendingPath: join(session.directory, "catalog-chat.pending.json"),
  };
  privateJson(group.pendingPath, group, true);
  await withLiveChat({
    session,
    modelId,
    retainState: true,
    stateReady: (root) => {
      group.stateDirectory = root;
      privateJson(group.pendingPath, group);
    },
    run: async (context) => {
      await qualifyReads(context, group, fixture);
      await qualifyWrites(context, group, fixture);
    },
  });
  assert.equal(new Set(group.results.map((result) => result.operation)).size, 14);
  await requireLicense(session);
  privateJson(join(session.directory, `catalog-chat-${group.id}.json`), group, true);
  rmSync(group.pendingPath);
  stage("all", true, { operations: 14, transport });
}

await main().catch((error) => {
  const location =
    error instanceof Error
      ? (error.stack?.match(/catalog-(?:chat|state)\.mjs:\d+:\d+/g) ?? [])
      : [];
  console.error(JSON.stringify({ qualification: "jira-chat-catalog", completed: false, location }));
  console.error(
    "jira-chat-catalog: incomplete group retained privately; independently reconcile remote state before another group; never replay pending writes",
  );
  process.exitCode = 1;
});
