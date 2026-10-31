import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireLicense } from "./lab-client.mjs";
import { withLiveChat } from "./chat-read.mjs";
import { chatToolRequest, commentState, privateJson } from "./chat-write.mjs";
import { observedMutationFault } from "./chat-fault-transport.mjs";
import { runBrowserWrite } from "./browser-write.mjs";
import { reportFaultQualificationFailure } from "./chat-lifecycle.mjs";
import {
  browserChatHistory as history,
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
  assert.deepEqual(await commentState(context.session, intent.key, intent.marker), intent.after);
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
      await recoverBrowserTurn(page, group, "unknown", () =>
        unchangedEffect(context, intent, observer),
      );
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
  const selected = await browserQualificationArguments("browser-fault");
  if (selected === undefined) return;
  const { session, modelId, pendingPath, key } = selected;
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
