import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { basicAuth, labRequest, requireLicense } from "./lab-client.mjs";
import { remoteRead } from "./catalog-state.mjs";
import { prepareFaultCase } from "./chat-fault-cases.mjs";
import { withLiveChat } from "./chat-read.mjs";
import { chatToolRequest, privateJson } from "./chat-write.mjs";
import { observedMutationFault } from "./chat-fault-transport.mjs";
import { runBrowserWrite } from "./browser-write.mjs";
import { reportFaultQualificationFailure } from "./chat-lifecycle.mjs";
import {
  browserChatHistory as history,
  browserNativeState,
  browserQualificationArguments,
  prepareBrowserWrite,
  recoverBrowserTurn,
  verifyBrowserToolTurn,
} from "./browser-recovery.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
function stage(fault, phase) {
  console.log(JSON.stringify({ qualification: "jira-browser-faults", fault, phase }));
}

export function verifyBrowserFaultTurn(completed, intent) {
  return verifyBrowserToolTurn(completed, intent, "unknown");
}

function verifyObserver(observer) {
  const observed = observer.snapshot();
  assert.equal(observed.attempts, 1);
  assert.equal(observed.forwarded, 1);
  assert.equal(observed.injected, 1);
  assert.ok(observed.actualStatus >= 200 && observed.actualStatus < 300);
}

async function unchangedEffect(context, intent, observer) {
  verifyObserver(observer);
  assert.deepEqual(await browserNativeState(context.session, intent), intent.after);
  const completed = await history(context, intent);
  assert.deepEqual(verifyBrowserFaultTurn(completed, intent), intent.identity);
  return completed;
}

async function browserCase(context, group, observer) {
  const intent = group.current;
  await prepareBrowserWrite(context, group);
  const result = await runBrowserWrite({
    context,
    chat: intent.chat,
    intent,
    prompt: chatToolRequest(context, intent.chat, intent).content,
    expectedMutationOutcome: "unknown",
    beforeDecision: async () => {
      assert.equal(observer.snapshot().attempts, 0);
      assert.deepEqual(await browserNativeState(context.session, intent), intent.before);
    },
    onIntent: (clientTurnId, request) => {
      intent.clientTurnId = clientTurnId;
      intent.request = request;
      privateJson(group.pendingPath, group);
    },
    observe: () => history(context, intent),
    afterCompleted: async ({ page, completed }) => {
      intent.identity = verifyBrowserFaultTurn(completed, intent);
      intent.after = await browserNativeState(context.session, intent);
      assert.deepEqual(intent.after, { total: intent.before.total + 1, matches: 1 });
      intent.phase = "unknown-with-one-effect";
      privateJson(group.pendingPath, group);
      await recoverBrowserTurn(page, group, "unknown", () =>
        unchangedEffect(context, intent, observer),
      );
    },
  });
  assert.deepEqual(result.decisions, { grants: 1, approvals: 1 });
  verifyObserver(observer);
  intent.decisions = result.decisions;
}

/** The two kinds of write the browser faults prove: a comment on a seeded issue and an issue creation. */
const SUBJECTS = ["comment", "create"];

/** The intent and the one request the observer admits, for a comment or a creation. */
async function faultIntent(session, subject, fault) {
  const marker = `Synthetic browser fault ${randomUUID()}`;
  const common = {
    marker,
    mode: "governed-assist",
    transport: "browser",
    connection: fault === "lost-response" ? "keyboard" : "drag",
    fault,
    phase: "prepared",
  };
  if (subject.kind === "create") {
    const prepared = await prepareFaultCase(
      session,
      subject.fixture,
      "jira.create",
      undefined,
      marker,
    );
    return {
      intent: { ...common, operation: "jira.create", arguments: prepared.arguments },
      target: prepared.target,
    };
  }
  return {
    intent: { ...common, key: subject.key },
    target: {
      method: "POST",
      path: `/rest/api/2/issue/${subject.key}/comment`,
      body: { body: marker },
    },
  };
}

/** Removes the issue a creation case made (a native admin delete), so a later run starts from the same project. */
async function removeCreated(session, marker) {
  const jql = encodeURIComponent(`project = KEIKO AND summary ~ "${marker}"`);
  const found = await remoteRead(
    session,
    `/rest/api/2/search?jql=${jql}&fields=summary&maxResults=5`,
  );
  for (const issue of found.issues.filter((item) => item.fields.summary === marker)) {
    const result = await labRequest(
      session,
      "DELETE",
      `/rest/api/2/issue/${encodeURIComponent(issue.key)}?deleteSubtasks=true`,
      basicAuth(session, "admin"),
    );
    assert.ok([204, 404].includes(result.status));
  }
}

async function qualify(session, modelId, group, fault, subject) {
  await requireLicense(session);
  const { intent, target } = await faultIntent(session, subject, fault);
  group.current = intent;
  privateJson(group.pendingPath, group);
  const observer = observedMutationFault(target, fault);
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
  if (subject.kind === "create") await removeCreated(session, intent.marker);
  await requireLicense(session);
  group.results.push({
    subject: subject.kind,
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

/** Which write kinds a run proves: all by default, or the comma-separated KEIKO_JIRA_LAB_BROWSER_FAULT_CASES. */
export function selectedSubjects(value = process.env.KEIKO_JIRA_LAB_BROWSER_FAULT_CASES) {
  const kinds = value === undefined || value === "" ? SUBJECTS : value.split(",");
  for (const kind of kinds)
    assert.ok(SUBJECTS.includes(kind), `Unknown browser fault case ${kind}`);
  return [...new Set(kinds)];
}

async function main() {
  const selected = await browserQualificationArguments("browser-fault");
  if (selected === undefined) return;
  const { session, modelId, pendingPath, key, fixture } = selected;
  const group = { id: randomUUID(), pendingPath, results: [] };
  privateJson(pendingPath, group, true);
  const subjects = selectedSubjects().map((kind) =>
    kind === "create" ? { kind, fixture } : { kind, key },
  );
  for (const subject of subjects)
    for (const fault of ["lost-response", "committed-503"])
      await qualify(session, modelId, group, fault, subject);
  assert.equal(group.results.length, subjects.length * 2);
  privateJson(join(session.directory, `browser-fault-${group.id}.json`), group, true);
  rmSync(pendingPath);
  stage("all", `${String(group.results.length)}-passed`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT)
  await main().catch((error) => reportFaultQualificationFailure("jira-browser-faults", error));
